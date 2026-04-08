// strategies/rewards-executor/index.ts
//
// S7: Rewards Executor — v2.1
//
// FIXES respecto a v2:
//
//   FIX 1 — Guardar clobOrderId al postear órdenes reales:
//     Antes se llamaba orderQueries.insertMany sin pasar el orderId del CLOB,
//     por lo que todos los registros tenían clobOrderId=null. Esto impedía
//     detectar correctamente los fills en syncInventory.
//
//   FIX 2 — Detectar fill inmediato (status: matched) al abrir posición:
//     Si la primera orden sale con status 'matched', significa que se ejecutó
//     instantáneamente (el precio de entrada coincidió con una contraparte).
//     En ese caso cerramos la posición y cancelamos las demás órdenes para
//     evitar el loop de hedge fallido que genera errores 400 continuos.
//
//   FIX 3 — Eliminar llamada a rebalanceIfNeeded:
//     El rebalanceo activo (hedge SELL) no es compatible con la estrategia de
//     rewards porque: (a) requiere tener shares disponibles que pueden estar
//     comprometidos en otras órdenes, (b) el CLOB rechaza el SELL con error
//     400 "not enough balance" si el balance ya está asignado a otras órdenes,
//     (c) el loop de reintentos spamea el CLOB cada 5 segundos sin parar.
//     Ver inventory-manager.ts para más detalles.

import { Strategy, StrategyRunResult }                                              from '../../core/strategy.interface';
import { CooldownManager }                                                           from '../../core/cooldown';
import { calcSampleScore, calcMidprice, calcOrderPrices, ScoredOrder, PlacementStrategy } from '../../core/rewards-scoring';
import { positionQueries, orderQueries, accrualQueries }                             from '../../db/queries-paper';
import { orderBookQueries }                                                          from '../../db/queries';
import { calcTakerFee, parseCategory }                                               from '../../utils/fees';
import { logger }                                                                    from '../../utils/logger';
import { syncInventory, closeInventoryPosition, getInventoryState, rebalanceWithBreakEvenHedge, clearBreakEvenHedge } from '../../core/inventory-manager';
import { repriceIfNeeded, requeueIfNeeded, clearRepriceTracker, clearRequeueTracker } from '../../core/order-replacer';
import { postOrder, cancelAllForMarket, verifyAuth }                                 from '../../core/clob-client';
import { Side } from '@polymarket/clob-client';

// ---- Tipos ------------------------------------------------------------------

interface RewardToken  { token_id: string; outcome: string; price: number; }
interface RewardsConfig {
  id: number; asset_address: string;
  start_date: string; end_date: string;
  rate_per_day: number; total_rewards: number;
}
interface RewardsMarket {
  condition_id:         string;
  question:             string;
  market_slug?:         string;
  event_slug?:          string;
  slug?:                string;
  rewards_max_spread:   number;
  rewards_min_size:     number;
  spread:               number;
  end_date:             string;
  tokens:               RewardToken[];
  volume_24hr:          number;
  rewards_config:       RewardsConfig[];
  neg_risk?:            boolean;
  minimum_tick_size?:   number;
}
interface RewardsMarketsResponse { limit: number; count: number; next_cursor: string; data: RewardsMarket[]; }
interface BookLevel { price: string; size: string; }
interface ClobBook  { bids: BookLevel[]; asks: BookLevel[]; }
interface BookAnalysis {
  bidDepthUsdc:    number;
  askDepthUsdc:    number;
  minDepthUsdc:    number;
  maxWallUsdc:     number;
  hasMinDepth:     boolean;
  wallProtects:    boolean;
}

interface ExecutorParams {
  paperTrading:             boolean;
  maxPositions:             number;
  totalCapitalUsdc:         number;
  minRatePerDay:            number;
  minRateRetentionPct:      number;
  minScoreThreshold:        number;
  maxPriceMoveThreshold:    number;
  maxSpreadCentsThreshold:  number;
  minDepthPerSideUsdc:      number;
  minDepthLevels:           number;
  maxVolume24hUsdc:         number;
  wallProtectionThreshold:  number;
  requeueIntervalMinutes:   number;
  placementStrategy:        PlacementStrategy;
  bannedKeywords:           string[];
  saveBookSnapshots:        boolean;
  maxDaysOpen:              number;
  intervalSeconds:          number;
  clobApiBase:              string;
}

// ---- Keywords baneados por defecto ------------------------------------------
const DEFAULT_BANNED_KEYWORDS = [
  'natural gas', 'bully', 'pump',
  'bitcoin crash', 'btc crash', 'eth crash',
  'breaking', 'live', 'right now', 'today at',
  'next hour', 'next 24h', 'next 24 hours',
  'meme coin', 'memecoin', 'shitcoin',
];

// ---- Capital dinamico -------------------------------------------------------
function calcDynamicSize(totalCapital: number, liquidityUsdc: number): number {
  let pct: number;
  if (liquidityUsdc < 5_000)       pct = 0.20;
  else if (liquidityUsdc < 30_000) pct = 0.10;
  else                              pct = 0.05;
  const raw = totalCapital * pct;
  return Math.max(30, Math.min(150, raw));
}

// ---- Analisis de book -------------------------------------------------------
function analyzeBookDepth(
  book:                    ClobBook,
  minLevels:               number,
  wallProtectionThreshold: number,
): BookAnalysis {
  const levels = 10;
  const bids   = book.bids.slice(0, levels);
  const asks   = book.asks.slice(0, levels);

  const bidDepthUsdc = bids.reduce((s, l) => s + Number(l.size) * Number(l.price), 0);
  const askDepthUsdc = asks.reduce((s, l) => s + Number(l.size) * (1 - Number(l.price)), 0);
  const minDepthUsdc = Math.min(bidDepthUsdc, askDepthUsdc);

  const maxBidWall  = bids.reduce((m, l) => Math.max(m, Number(l.size) * Number(l.price)), 0);
  const maxAskWall  = asks.reduce((m, l) => Math.max(m, Number(l.size) * (1 - Number(l.price))), 0);
  const maxWallUsdc = Math.max(maxBidWall, maxAskWall);

  const hasMinDepth  = bids.length >= minLevels && asks.length >= minLevels;
  const wallProtects = maxWallUsdc >= wallProtectionThreshold;

  return { bidDepthUsdc, askDepthUsdc, minDepthUsdc, maxWallUsdc, hasMinDepth, wallProtects };
}

// ---- Keyword ban ------------------------------------------------------------
function isBannedMarket(question: string, bannedKeywords: string[]): string | null {
  const q = question.toLowerCase();
  for (const kw of bannedKeywords) {
    if (q.includes(kw.toLowerCase())) return kw;
  }
  return null;
}

// -----------------------------------------------------------------------------

const cooldown = new CooldownManager('rewards_executor');

export const rewardsExecutorStrategy: Strategy = {
  id:          'rewards_executor',
  name:        'Rewards Executor',
  description: 'Market making en mercados con rewards. Capital dinamico, anti-fill, sin cancelaciones innecesarias.',

  defaultParams: {
    paperTrading:            true,
    maxPositions:            5,
    totalCapitalUsdc:        400,
    minRatePerDay:           1,
    minRateRetentionPct:     50,
    minScoreThreshold:       0.001,
    maxPriceMoveThreshold:   0.15,
    maxSpreadCentsThreshold: 10,
    minDepthPerSideUsdc:     800,
    minDepthLevels:          5,
    maxVolume24hUsdc:        50_000,
    wallProtectionThreshold: 300,
    requeueIntervalMinutes:  45,
    placementStrategy:       'mid' as PlacementStrategy,
    bannedKeywords:          DEFAULT_BANNED_KEYWORDS,
    saveBookSnapshots:       true,
    maxDaysOpen:             7,
    intervalSeconds:         60,
    clobApiBase:             'https://clob.polymarket.com',
  } satisfies ExecutorParams,

  async run(params): Promise<StrategyRunResult> {
    const p      = params as unknown as ExecutorParams;
    const bannedKws = Array.isArray(p.bannedKeywords) ? p.bannedKeywords : DEFAULT_BANNED_KEYWORDS;

    const signals: StrategyRunResult['signals'] = [];
    let positionsOpened  = 0;
    let positionsClosed  = 0;
    let samplesProcessed = 0;
    let totalRewardUsdc  = 0;

    const mode = p.paperTrading ? 'PAPER' : 'REAL';
    console.log(`\n[rewards_executor] -- tick ${new Date().toISOString()} [${mode}] --`);

    // ---- 1. Monitorear posiciones abiertas ----------------------------------
    const openPositions = await positionQueries.getOpen(p.paperTrading);
    console.log(`[rewards_executor] posiciones abiertas: ${openPositions.length}`);

    for (const pos of openPositions) {
      samplesProcessed++;

      const book = await fetchBook(p.clobApiBase, pos.tokenIdYes);
      if (!book) {
        console.log(`[rewards_executor]   WARNING #${pos.id} sin book`);
        continue;
      }

      const bestBid  = book.bids[0] ? Number(book.bids[0].price) : null;
      const bestAsk  = book.asks[0] ? Number(book.asks[0].price) : null;
      const midprice = calcMidprice(bestBid, bestAsk);
      if (!midprice) continue;

      const spreadCents = bestBid && bestAsk ? (bestAsk - bestBid) * 100 : null;

      const bookAnalysis = analyzeBookDepth(book, p.minDepthLevels, p.wallProtectionThreshold);

      // Guardar snapshot historico
      if (p.saveBookSnapshots) {
        const total = bookAnalysis.bidDepthUsdc + bookAnalysis.askDepthUsdc;
        await orderBookQueries.insertSnapshot({
          marketId:       pos.marketId,
          tokenId:        pos.tokenIdYes,
          bestBid:        bestBid?.toFixed(6),
          bestAsk:        bestAsk?.toFixed(6),
          spread:         spreadCents?.toFixed(6),
          bidDepth:       bookAnalysis.bidDepthUsdc.toFixed(4),
          askDepth:       bookAnalysis.askDepthUsdc.toFixed(4),
          imbalanceRatio: total > 0 ? (bookAnalysis.bidDepthUsdc / total).toFixed(4) : undefined,
        }).catch(() => {});
      }

      const posOrders  = await orderQueries.getOpenForPosition(pos.id);
      const ordersYes: ScoredOrder[] = posOrders
        .filter(o => o.tokenId === pos.tokenIdYes)
        .map(o => ({ tokenId: o.tokenId, side: o.side, price: Number(o.price), sizeShares: Number(o.sizeShares) }));
      const ordersNo: ScoredOrder[] = posOrders
        .filter(o => o.tokenId === pos.tokenIdNo)
        .map(o => ({ tokenId: o.tokenId, side: o.side, price: Number(o.price), sizeShares: Number(o.sizeShares) }));

      const score = calcSampleScore(
        ordersYes, ordersNo, midprice,
        Number(pos.maxSpreadCents),
        Number(pos.scalingFactorC),
        Number(pos.totalLiquidityUsdc ?? 1000),
        Number(pos.dailyRewardUsdc),
      );

      await accrualQueries.insert({
        positionId: pos.id, paperTrading: pos.paperTrading, midprice,
        bestBid: bestBid ?? undefined, bestAsk: bestAsk ?? undefined,
        spreadCents: spreadCents ?? undefined, midExtreme: score.midExtreme,
        scoreQne: score.qne, scoreQno: score.qno, scoreQmin: score.qmin,
        normalizedProxy: score.normalizedProxy, rewardUsdc: score.rewardUsdc,
        inRange: score.inRange,
      }).catch(() => {});

      await positionQueries.addReward(pos.id, score.rewardUsdc, score.qmin, score.inRange);
      totalRewardUsdc += score.rewardUsdc;

      const wallIcon = bookAnalysis.wallProtects ? 'W' : ' ';
      const icon     = score.inRange ? 'OK' : 'OUT';
      console.log(
        `[rewards_executor]   [${icon}][${wallIcon}] #${pos.id}` +
        ` mid=${(midprice * 100).toFixed(1)}c` +
        ` spread=${spreadCents?.toFixed(1) ?? '?'}c` +
        ` depth=${bookAnalysis.minDepthUsdc.toFixed(0)}$ wall=${bookAnalysis.maxWallUsdc.toFixed(0)}$` +
        ` Qmin=${score.qmin.toFixed(4)} +$${score.rewardUsdc.toFixed(6)}` +
        ` | ${(pos.marketQuestion ?? '').slice(0, 35)}`,
      );

      // ---- Condiciones de salida -------------------------------------------

      // Reward expirado
      if (new Date() > new Date(pos.rewardEndDate)) {
        console.log(`[rewards_executor]   #${pos.id} CERRADA: reward expirado`);
        await positionQueries.close(pos.id, 'reward_ended');
        if (!p.paperTrading) await closeRealPosition(pos.id, pos.tokenIdYes, midprice);
        else { clearRepriceTracker(pos.id); clearRequeueTracker(pos.id); }
        positionsClosed++;
        signals.push(buildCloseSignal(pos, 'reward_ended', midprice, score, bookAnalysis));
        continue;
      }

      // Caida de rewards
      if (p.minRateRetentionPct > 0) {
        const currentRate = await fetchCurrentRewardRate(p.clobApiBase, pos.marketId).catch(() => null);
        if (currentRate !== null) {
          const entryRate    = Number(pos.dailyRewardUsdc);
          const retentionPct = entryRate > 0 ? (currentRate / entryRate) * 100 : 100;
          if (retentionPct < p.minRateRetentionPct) {
            console.log(`[rewards_executor]   #${pos.id} CERRADA: rate caido ${retentionPct.toFixed(0)}% ($${currentRate.toFixed(2)}/d era $${entryRate.toFixed(2)}/d)`);
            await positionQueries.close(pos.id, 'reward_ended');
            if (!p.paperTrading) await closeRealPosition(pos.id, pos.tokenIdYes, midprice);
            else { clearRepriceTracker(pos.id); clearRequeueTracker(pos.id); }
            positionsClosed++;
            signals.push(buildCloseSignal(pos, 'reward_ended', midprice, score, bookAnalysis));
            continue;
          }
        }
      }

      // Score bajo
      if (!score.inRange && score.qmin < p.minScoreThreshold) {
        console.log(`[rewards_executor]   #${pos.id} CERRADA: score_too_low Qmin=${score.qmin.toFixed(6)}`);
        await positionQueries.close(pos.id, 'score_too_low');
        if (!p.paperTrading) await closeRealPosition(pos.id, pos.tokenIdYes, midprice);
        else { clearRepriceTracker(pos.id); clearRequeueTracker(pos.id); }
        positionsClosed++;
        signals.push(buildCloseSignal(pos, 'score_too_low', midprice, score, bookAnalysis));
        continue;
      }

      // Precio movido
      const entryMid   = Number(pos.entryMidprice);
      const priceMoved = Math.abs(midprice - entryMid) / entryMid;
      if (priceMoved > p.maxPriceMoveThreshold) {
        console.log(`[rewards_executor]   #${pos.id} CERRADA: price_moved ${(priceMoved * 100).toFixed(1)}%`);
        await positionQueries.close(pos.id, 'price_moved');
        if (!p.paperTrading) await closeRealPosition(pos.id, pos.tokenIdYes, midprice);
        else { clearRepriceTracker(pos.id); clearRequeueTracker(pos.id); }
        positionsClosed++;
        signals.push(buildCloseSignal(pos, 'price_moved', midprice, score, bookAnalysis));
        continue;
      }

      // Expirada por tiempo
      const daysOpen = (Date.now() - (pos.openedAt?.getTime() ?? 0)) / 86_400_000;
      if (daysOpen > p.maxDaysOpen) {
        console.log(`[rewards_executor]   #${pos.id} CERRADA: expired ${daysOpen.toFixed(1)}d`);
        await positionQueries.close(pos.id, 'expired');
        if (!p.paperTrading) await closeRealPosition(pos.id, pos.tokenIdYes, midprice);
        else { clearRepriceTracker(pos.id); clearRequeueTracker(pos.id); }
        positionsClosed++;
        signals.push(buildCloseSignal(pos, 'expired', midprice, score, bookAnalysis));
        continue;
      }

      // ---- Gestion de ordenes (real trading) ---------------------------------
      if (!p.paperTrading) {
        const invState = await syncInventory(
          pos.id, pos.tokenIdYes, pos.tokenIdNo, midprice,
          { maxInventoryValueUsdc: Number(pos.sizeUsdc) * 2 },
        ).catch(() => null);

        // Si hay exposición neta (fills de BUY sin cubrir), colocar LIMIT SELL
        // al break-even en vez de cerrar a mercado → cobrar maker rebate, no pagar taker fee.
        // La posición sigue abierta y las LP orders (BID + ASK) se recolocan abajo.
        if (invState && invState.netExposure > 0.01) {
          const hedgeResult = await rebalanceWithBreakEvenHedge(invState);
          if (hedgeResult === 'hedged') {
            console.log(
              `[rewards_executor]   BREAK-EVEN SELL #${pos.id} | ` +
              `SELL ${invState.netExposure.toFixed(2)} @ ${invState.avgEntryPrice.toFixed(4)} (maker rebate)`,
            );
          }
        }

        // Reprecio si el precio se movio mucho
        const reprice = await repriceIfNeeded(
          pos.id, pos.tokenIdYes, midprice,
          Number(pos.maxSpreadCents), Number(pos.sizePerSideUsdc),
          pos.dualSideRequired ?? false,
          { paperTrading: false, repricingThresholdCents: 1.5 },
        ).catch(() => null);

        // Detectar si alguna orden activa quedó fuera del rango de rewards.
        // Si es así, hay que moverla aunque la muralla proteja — una orden fuera
        // de rango no gana rewards, así que la wall protection no aporta nada.
        const dbOrders = await orderQueries.getOpenForPosition(pos.id);
        const maxSpreadDecimal = Number(pos.maxSpreadCents) / 100;
        const ordersOutOfRange = dbOrders.some(o =>
          Math.abs(Number(o.price) - midprice) > maxSpreadDecimal,
        );

        if (reprice?.action === 'repriced') {
          console.log(`[rewards_executor]   REPRICED #${pos.id} ${(reprice.oldMidprice! * 100).toFixed(1)}c -> ${(reprice.newMidprice! * 100).toFixed(1)}c`);
        } else if (!bookAnalysis.wallProtects || ordersOutOfRange) {
          const requeue = await requeueIfNeeded(
            pos.id, pos.tokenIdYes,
            Number(pos.maxSpreadCents), Number(pos.sizePerSideUsdc),
            pos.dualSideRequired ?? false, midprice,
            { requeueIntervalMinutes: p.requeueIntervalMinutes, paperTrading: false },
          ).catch(() => null);
          if (requeue?.action === 'requeued') {
            const reason = ordersOutOfRange && bookAnalysis.wallProtects
              ? 'ordenes fuera de rango (muralla ignorada)'
              : 'sin muralla';
            console.log(`[rewards_executor]   REQUEUE #${pos.id} (${reason})`);
          }
        } else {
          console.log(`[rewards_executor]   HOLD #${pos.id} — muralla $${bookAnalysis.maxWallUsdc.toFixed(0)} protege, ordenes en rango`);
        }

      } else {
        // Paper: reprecio + re-queue periodico solo si sin muralla
        const reprice = await repriceIfNeeded(
          pos.id, pos.tokenIdYes, midprice,
          Number(pos.maxSpreadCents), Number(pos.sizePerSideUsdc),
          pos.dualSideRequired ?? false,
          { paperTrading: true, repricingThresholdCents: 1.5 },
        ).catch(() => null);

        if (reprice?.action !== 'repriced' && !bookAnalysis.wallProtects) {
          await requeueIfNeeded(
            pos.id, pos.tokenIdYes,
            Number(pos.maxSpreadCents), Number(pos.sizePerSideUsdc),
            pos.dualSideRequired ?? false, midprice,
            { requeueIntervalMinutes: p.requeueIntervalMinutes, paperTrading: true },
          ).catch(() => {});
        }
      }
    }

    // ---- 2. Abrir nuevas posiciones -----------------------------------------
    const currentOpen    = openPositions.length - positionsClosed;
    const slotsAvailable = p.maxPositions - currentOpen;
    console.log(`[rewards_executor] slots disponibles: ${slotsAvailable}/${p.maxPositions}`);

    if (slotsAvailable > 0) {
      const markets = await fetchRewardMarkets(p.clobApiBase).catch(err => {
        logger.error('[rewards_executor] fetchRewardMarkets failed', err);
        return [];
      });
      console.log(`[rewards_executor] mercados con rewards: ${markets.length}`);

      for (const market of markets) {
        if (positionsOpened >= slotsAvailable) break;

        if (!market.rewards_config?.length) continue;
        if (!market.tokens?.length || market.tokens.length < 2) continue;
        if (new Date() > new Date(market.end_date)) continue;

        const banned = isBannedMarket(market.question, bannedKws);
        if (banned) {
          console.log(`[rewards_executor]   skip "${market.question.slice(0, 40)}" — keyword ban: "${banned}"`);
          continue;
        }

        const config     = market.rewards_config[0];
        const ratePerDay = Number(config.rate_per_day ?? 0);

        if (ratePerDay < p.minRatePerDay) {
          console.log(`[rewards_executor]   skip ${market.question.slice(0, 40)} — rate $${ratePerDay}/d < min $${p.minRatePerDay}`);
          continue;
        }

        if (p.maxVolume24hUsdc > 0 && market.volume_24hr > p.maxVolume24hUsdc) {
          console.log(`[rewards_executor]   skip ${market.question.slice(0, 40)} — vol24h $${market.volume_24hr.toFixed(0)} > max $${p.maxVolume24hUsdc}`);
          continue;
        }

        const spreadCents = Number(market.spread ?? 0) * 100;
        if (spreadCents > p.maxSpreadCentsThreshold) {
          console.log(`[rewards_executor]   skip ${market.question.slice(0, 40)} — spread ${spreadCents.toFixed(1)}c > max ${p.maxSpreadCentsThreshold}c`);
          continue;
        }

        if (await positionQueries.hasOpen(market.condition_id, p.paperTrading)) continue;

        const cooldownKey = `${market.condition_id}:${p.paperTrading}`;
        if (!(await cooldown.isReady(cooldownKey, 30 * 60_000))) continue;

        const tokenYes = market.tokens.find(t => t.outcome === 'YES') ?? market.tokens[0];
        const tokenNo  = market.tokens.find(t => t.outcome === 'NO')  ?? market.tokens[1];
        if (!tokenYes) continue;

        const book = await fetchBook(p.clobApiBase, tokenYes.token_id);
        if (!book) continue;

        const bestBid  = book.bids[0] ? Number(book.bids[0].price) : null;
        const bestAsk  = book.asks[0] ? Number(book.asks[0].price) : null;
        const midprice = calcMidprice(bestBid, bestAsk);
        if (!midprice) continue;

        const bookAnalysis = analyzeBookDepth(book, p.minDepthLevels, p.wallProtectionThreshold);

        if (!bookAnalysis.hasMinDepth) {
          console.log(`[rewards_executor]   skip ${market.question.slice(0, 40)} — menos de ${p.minDepthLevels} niveles`);
          continue;
        }
        if (bookAnalysis.minDepthUsdc < p.minDepthPerSideUsdc) {
          console.log(`[rewards_executor]   skip ${market.question.slice(0, 40)} — depth $${bookAnalysis.minDepthUsdc.toFixed(0)} < min $${p.minDepthPerSideUsdc}`);
          continue;
        }

        const liquidityUsdc    = Number(market.volume_24hr ?? 0);
        const sizeUsdc         = calcDynamicSize(p.totalCapitalUsdc, liquidityUsdc);
        const sizePerSide      = sizeUsdc / 2;
        const maxSpreadCents   = Number(market.rewards_max_spread ?? 3);
        const minSizeShares    = Number(market.rewards_min_size   ?? 0);
        const dualSideRequired = midprice < 0.10 || midprice > 0.90;

        const plannedOrders = calcOrderPrices(midprice, maxSpreadCents, sizePerSide, dualSideRequired, p.placementStrategy);

        const category  = parseCategory(null);
        const feeEntry  = plannedOrders.reduce((s, o) => s + calcTakerFee(o.price, category) * o.sizeUsdc, 0);
        const entrySpreadCents = bestBid && bestAsk ? (bestAsk - bestBid) * 100 : null;

        const totalDepth     = bookAnalysis.bidDepthUsdc + bookAnalysis.askDepthUsdc;
        const estimatedShare = totalDepth > 0 ? (sizeUsdc / totalDepth) * 100 : 0;

        const positionId = await positionQueries.open({
          paperTrading: p.paperTrading, marketId: market.condition_id,
          marketQuestion: market.question, marketSlug: market.market_slug ?? market.slug ?? undefined,
          eventSlug: market.event_slug ?? undefined, tokenIdYes: tokenYes.token_id,
          tokenIdNo: tokenNo?.token_id, rewardId: String(config.id),
          dailyRewardUsdc: ratePerDay, maxSpreadCents, minSizeShares,
          rewardEndDate: new Date(config.end_date), scalingFactorC: 3.0,
          sizeUsdc, sizePerSideUsdc: sizePerSide,
          entryMidprice: midprice, entryBid: bestBid ?? undefined,
          entryAsk: bestAsk ?? undefined, entrySpreadCents: entrySpreadCents ?? undefined,
          dualSideRequired, totalLiquidityUsdc: liquidityUsdc,
        });

        // Insertar órdenes planificadas en DB (sin clobOrderId aún, se actualizan abajo)
        await orderQueries.insertMany(
          plannedOrders.map(o => ({
            positionId, paperTrading: p.paperTrading, tokenId: tokenYes.token_id,
            side: o.side, price: o.price, sizeUsdc: o.sizeUsdc,
            sizeShares: o.sizeShares, spreadFromMidCents: o.spreadFromMidCents,
          })),
        );

        // Real trading: colocar ordenes en el CLOB
        if (!p.paperTrading) {
          const tickSizeStr = String(market.minimum_tick_size ?? 0.01) as '0.1' | '0.01' | '0.001' | '0.0001';

          // Rastrear órdenes filladas inmediatamente (status: matched)
          let immediatelyFilled = false;
          const filledOrders: { tokenId: string; price: number; size: number }[] = [];

          for (const o of plannedOrders) {
            const isSell  = o.side === 'sell';
            const tokenId = isSell ? tokenNo.token_id  : tokenYes.token_id;
            const price   = isSell ? Math.round((1 - o.price) * 100) / 100 : o.price;
            const size    = isSell ? o.sizeUsdc / price : o.sizeShares;

            const posted = await postOrder({
              tokenId, price, size, side: Side.BUY,
              negRisk:  market.neg_risk ?? false,
              tickSize: tickSizeStr,
              postOnly: true,  // garantiza entrada como maker → cobra rebate, no paga taker fee
            }).catch(err => { logger.error('[rewards_executor] postOrder failed', err); return null; });

            if (posted) {
              const label = isSell
                ? `BUY NO @ ${price.toFixed(2)} (≡ SELL YES @ ${o.price.toFixed(2)})`
                : `BUY YES @ ${price.toFixed(2)}`;
              const marketLink = market.event_slug
                ? `https://polymarket.com/event/${market.event_slug}`
                : market.market_slug ? `https://polymarket.com/market/${market.market_slug}` : null;
              logger.info(
                `[rewards_executor] Orden colocada | id: ${posted.orderId} | status: ${posted.status} | ${label}` +
                ` | "${market.question.slice(0, 50)}"` +
                (marketLink ? ` | ${marketLink}` : ''),
              );

              await orderQueries.insertMany([{
                positionId,
                paperTrading:       false,
                tokenId,
                side:               'buy',
                price,
                sizeUsdc:           o.sizeUsdc,
                sizeShares:         size,
                spreadFromMidCents: o.spreadFromMidCents,
                clobOrderId:        posted.orderId,
                status:             posted.status === 'matched' ? 'filled' : 'open',
              }]);

              if (posted.status === 'matched') {
                const marketLink = market.event_slug
                  ? `https://polymarket.com/event/${market.event_slug}`
                  : market.market_slug ? `https://polymarket.com/market/${market.market_slug}` : null;
                logger.warn(
                  `[rewards_executor] ⚠️ Orden fillada inmediatamente (status: matched)` +
                  ` — colocando LIMIT SELL break-even @ ${price.toFixed(4)}` +
                  ` | "${market.question.slice(0, 50)}"` +
                  (marketLink ? ` | ${marketLink}` : ''),
                );
                immediatelyFilled = true;
                filledOrders.push({ tokenId, price, size });
                // Salir del loop: no tiene sentido postear más LP si ya hubo fill
                break;
              }
            }
          }

          // Fill inmediato: en vez de cerrar a mercado (pagar taker fee),
          // colocar LIMIT SELL al precio de break-even (cobrar maker rebate).
          // La posición queda ABIERTA para seguir haciendo LP con BID + ASK.
          if (immediatelyFilled) {
            // 1. Cancelar órdenes LP restantes (las filladas ya no están en el libro)
            await cancelAllForMarket(tokenYes.token_id).catch(err =>
              logger.error(`[rewards_executor] Error cancelando ordenes tras fill inmediato`, err),
            );
            if (tokenNo?.token_id) {
              await cancelAllForMarket(tokenNo.token_id).catch(() => {});
            }

            // 2. Colocar LIMIT SELL al break-even para cada orden fillada
            for (const filled of filledOrders) {
              const breakEvenResult = await postOrder({
                tokenId:  filled.tokenId,
                price:    filled.price,
                size:     filled.size,
                side:     Side.SELL,
                negRisk:  market.neg_risk ?? false,
                tickSize: tickSizeStr,
              }).catch(err => {
                logger.error('[rewards_executor] Error colocando break-even sell', err);
                return null;
              });

              if (breakEvenResult) {
                const marketLink = market.event_slug
                  ? `https://polymarket.com/event/${market.event_slug}`
                  : market.market_slug ? `https://polymarket.com/market/${market.market_slug}` : null;
                logger.info(
                  `[rewards_executor] Break-even SELL colocado | id: ${breakEvenResult.orderId} | ` +
                  `SELL ${filled.size.toFixed(2)} @ ${filled.price.toFixed(4)} (maker rebate) | ` +
                  `"${market.question.slice(0, 50)}"` +
                  (marketLink ? ` | ${marketLink}` : ''),
                );
              }
            }

            // 3. La posición SIGUE ABIERTA — el próximo tick recoloca LP y monitorea
            console.log(
              `[rewards_executor]   #${positionId} — fill inmediato | ` +
              `break-even SELL @ ${filledOrders.map(f => f.price.toFixed(4)).join(', ')} | posicion sigue abierta`,
            );
          }
        }

        await positionQueries.addFee(positionId, feeEntry);
        await cooldown.stamp(cooldownKey);
        positionsOpened++;

        console.log(
          `[rewards_executor]   ABIERTA #${positionId} — ${market.question.slice(0, 45)}` +
          ` | $${sizeUsdc.toFixed(0)} USDC (${estimatedShare.toFixed(1)}% share)` +
          ` | rate=$${ratePerDay}/d | mid=${(midprice * 100).toFixed(1)}c` +
          ` | maxSpread=${maxSpreadCents}c | wall=$${bookAnalysis.maxWallUsdc.toFixed(0)}` +
          ` | depth=$${bookAnalysis.minDepthUsdc.toFixed(0)}` +
          ` | placement=${p.placementStrategy}`,
        );

        signals.push({
          strategyId: this.id,
          severity:   'low',
          title:      `${p.paperTrading ? 'PAPER' : 'REAL'} Nueva posicion: ${market.question.slice(0, 50)}`,
          body: [
            `<b>Mercado:</b> ${market.question}`,
            `<b>Rate rewards:</b> $${ratePerDay}/dia`,
            `<b>Capital:</b> $${sizeUsdc.toFixed(0)} USDC (share estimado: ${estimatedShare.toFixed(1)}%)`,
            `<b>Depth minimo lado:</b> $${bookAnalysis.minDepthUsdc.toFixed(0)}`,
            `<b>Muralla maxima:</b>    $${bookAnalysis.maxWallUsdc.toFixed(0)}`,
            `<b>Max spread:</b> ${maxSpreadCents}c | Placement: ${p.placementStrategy}`,
            `<b>Spread actual:</b> ${spreadCents.toFixed(1)}c`,
            `<b>Midprice:</b> ${(midprice * 100).toFixed(1)}c`,
            `<b>Dual side:</b> ${dualSideRequired ? 'Si' : 'No'}`,
            `<b>Fee entrada:</b> $${feeEntry.toFixed(4)}`,
            `<b>Modo:</b> ${p.paperTrading ? 'Paper' : 'Real'}`,
          ].join('\n'),
          metadata: {
            positionId, marketId: market.condition_id, rewardId: config.id,
            ratePerDay, maxSpread: maxSpreadCents, midprice, sizeUsdc,
            estimatedSharePct: estimatedShare, paperTrading: p.paperTrading,
          },
        });
      }
    }

    console.log(
      `[rewards_executor] -- fin tick | abiertas: ${positionsOpened} | cerradas: ${positionsClosed}` +
      ` | reward tick: +$${totalRewardUsdc.toFixed(6)} --\n`,
    );

    return {
      signals,
      metrics: {
        positionsOpened, positionsClosed,
        positionsActive: openPositions.length - positionsClosed + positionsOpened,
        samplesProcessed,
        totalRewardUsdcThisTick: Number(totalRewardUsdc.toFixed(6)),
      },
    };
  },

  async init(params) {
    const p = params as unknown as ExecutorParams;
    logger.info(
      `[rewards_executor] init | modo: ${p.paperTrading ? 'PAPER' : 'REAL'}` +
      ` | capital: $${p.totalCapitalUsdc} | maxPos: ${p.maxPositions}` +
      ` | minDepth: $${p.minDepthPerSideUsdc} | wall: $${p.wallProtectionThreshold}`,
    );
    if (!p.paperTrading) {
      const ok = await verifyAuth();
      if (!ok) throw new Error('CLOB auth failed — rewards_executor no puede arrancar en modo REAL');
      logger.info('[rewards_executor] Auth CLOB OK');
    }
  },
};

// ---- Helpers -----------------------------------------------------------------

async function closeRealPosition(positionId: number, tokenIdYes: string, midprice: number): Promise<void> {
  try {
    const inventory = getInventoryState(tokenIdYes);
    if (inventory) await closeInventoryPosition(inventory, midprice);
    else            await cancelAllForMarket(tokenIdYes);
    clearRepriceTracker(positionId);
    clearRequeueTracker(positionId);
    clearBreakEvenHedge(tokenIdYes);
  } catch (err) {
    logger.error(`[rewards_executor] Error cerrando posicion real #${positionId}`, err);
  }
}

function buildCloseSignal(
  pos: Awaited<ReturnType<typeof positionQueries.getById>>,
  reason: string,
  currentMid: number,
  score: ReturnType<typeof calcSampleScore>,
  book?: BookAnalysis,
) {
  if (!pos) return null!;
  const rewards    = Number(pos.rewardsEarnedUsdc ?? 0);
  const fees       = Number(pos.feesPaidUsdc      ?? 0);
  const net        = rewards - fees;
  const inRangePct = pos.samplesTotal > 0
    ? ((pos.samplesInRange / pos.samplesTotal) * 100).toFixed(1) : 'N/A';
  const labels: Record<string, string> = {
    reward_ended:  'Reward expirado/caido',
    score_too_low: 'Score bajo',
    price_moved:   'Precio movido',
    expired:       'Expirada por tiempo',
    manual:        'Cierre manual',
  };

  return {
    strategyId: 'rewards_executor',
    severity:   net >= 0 ? 'low' as const : 'medium' as const,
    title:      `${labels[reason] ?? reason}: ${(pos.marketQuestion ?? '').slice(0, 50)}`,
    body: [
      `<b>Mercado:</b> ${pos.marketQuestion}`,
      `<b>Motivo:</b> ${labels[reason] ?? reason}`,
      `<b>Modo:</b> ${pos.paperTrading ? 'Paper' : 'Real'}`,
      '',
      `<b>Rewards:</b>  $${rewards.toFixed(4)}`,
      `<b>Fees:</b>    -$${fees.toFixed(4)}`,
      `<b>Net PnL:</b>  ${net >= 0 ? '+' : ''}$${net.toFixed(4)}`,
      '',
      `<b>Tiempo en rango:</b> ${inRangePct}%`,
      `<b>Qmin ultimo:</b>     ${score.qmin.toFixed(4)}`,
      book ? `<b>Muralla al cerrar:</b> $${book.maxWallUsdc.toFixed(0)}` : '',
      `<b>Mid actual:</b> ${(currentMid * 100).toFixed(1)}c | entrada: ${(Number(pos.entryMidprice) * 100).toFixed(1)}c`,
    ].filter(Boolean).join('\n'),
    metadata: {
      positionId: pos.id, marketId: pos.marketId, reason,
      rewardsUsdc: rewards, feesUsdc: fees, netPnl: net,
      paperTrading: pos.paperTrading,
    },
  };
}

async function fetchBook(clobBase: string, tokenId: string): Promise<ClobBook | null> {
  try {
    const res = await fetch(`${clobBase}/book?token_id=${tokenId}`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return null;
    return res.json() as Promise<ClobBook>;
  } catch { return null; }
}

async function fetchCurrentRewardRate(clobBase: string, conditionId: string): Promise<number | null> {
  try {
    const res  = await fetch(`${clobBase}/rewards/markets/multi?page_size=500`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const data = await res.json() as RewardsMarketsResponse;
    const mkt  = (data.data ?? []).find(m => m.condition_id === conditionId);
    return mkt?.rewards_config?.[0] ? Number(mkt.rewards_config[0].rate_per_day) : null;
  } catch { return null; }
}

async function fetchRewardMarkets(clobBase: string): Promise<RewardsMarket[]> {
  const res  = await fetch(`${clobBase}/rewards/markets/multi?order_by=rate_per_day&position=DESC&page_size=100`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`CLOB rewards API ${res.status}`);
  const data = await res.json() as RewardsMarketsResponse;
  const markets = (data.data ?? []).filter(m => m.rewards_config?.length > 0 && m.tokens?.length >= 2);

  const ids = markets.map(m => m.condition_id).join(',');
  try {
    const detailRes = await fetch(`${clobBase}/markets?condition_ids=${ids}`, { signal: AbortSignal.timeout(10_000) });
    if (detailRes.ok) {
      const detailData = await detailRes.json() as { data: Array<{ condition_id: string; neg_risk: boolean; minimum_tick_size: number }> };
      const detailMap = new Map((detailData.data ?? []).map(d => [d.condition_id, d]));
      for (const m of markets) {
        const d = detailMap.get(m.condition_id);
        if (d) {
          m.neg_risk          = d.neg_risk ?? false;
          m.minimum_tick_size = d.minimum_tick_size ?? 0.01;
        }
      }
    }
  } catch { /* si falla el enrich, seguimos con defaults */ }

  return markets;
}