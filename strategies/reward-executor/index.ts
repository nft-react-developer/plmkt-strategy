// strategies/rewards-executor/index.ts
//
// S7: Rewards Executor
//
// Ejecuta market making simulado (paper) o real en mercados con rewards activos.
// Endpoint correcto: GET clob.polymarket.com/rewards/markets/multi
//
// Campos reales del API (distintos a lo que devuelve Gamma):
//   rewards_max_spread  — centavos max desde midpoint (v en la formula)
//   rewards_min_size    — shares minimas para calificar
//   rewards_config[].rate_per_day    — USDC/dia del pool
//   rewards_config[].total_rewards   — rewards totales del programa
//   spread              — spread actual del mercado (decimal: 0.02 = 2c)
//   tokens[]            — tokens YES/NO con precios
//
// Parametros configurables (strategy_config):
//   paperTrading             TRUE = paper, FALSE = real (default: true)
//   maxPositions             max posiciones simultaneas (default: 5)
//   sizeUsdcPerPosition      capital por posicion en USDC (default: 30)
//   minRatePerDay            rate_per_day minimo para entrar (default: 1)
//   minScoreThreshold        Qmin minimo para no cerrar (default: 0.001)
//   maxPriceMoveThreshold    % movimiento de precio para salir (default: 0.15)
//   maxSpreadCentsThreshold  spread maximo del book para entrar (default: 10)
//   maxDaysOpen              dias maximos abierta (default: 7)
//   intervalSeconds          tick (default: 60)

import { Strategy, StrategyRunResult } from '../../core/strategy.interface';
import { CooldownManager } from '../../core/cooldown';
import { calcSampleScore, calcMidprice, calcOrderPrices, ScoredOrder } from '../../core/rewards-scoring';
import { positionQueries, orderQueries, accrualQueries } from '../../db/queries-paper';
import { calcTakerFee, parseCategory } from '../../utils/fees';
import { logger } from '../../utils/logger';

// ---- Tipos del CLOB API /rewards/markets/multi ------------------------------

interface RewardToken {
  token_id: string;
  outcome:  string;
  price:    number;
}

interface RewardsConfig {
  id:            number;
  asset_address: string;
  start_date:    string;
  end_date:      string;
  rate_per_day:  number;
  total_rewards: number;
}

interface RewardsMarket {
  condition_id:          string;
  question:              string;
  rewards_max_spread:    number;
  rewards_min_size:      number;
  spread:                number;
  end_date:              string;
  tokens:                RewardToken[];
  volume_24hr:           number;
  rewards_config:        RewardsConfig[];
  market_competitiveness?: number;
  one_day_price_change?:   number;
}

interface RewardsMarketsResponse {
  limit:       number;
  count:       number;
  next_cursor: string;
  data:        RewardsMarket[];
}

interface ExecutorParams {
  paperTrading:            boolean;
  maxPositions:            number;
  sizeUsdcPerPosition:     number;
  minRatePerDay:           number;
  minScoreThreshold:       number;
  maxPriceMoveThreshold:   number;
  maxSpreadCentsThreshold: number;
  maxDaysOpen:             number;
  intervalSeconds:         number;
  clobApiBase:             string;
}

interface BookLevel { price: string; size: string; }
interface ClobBook  { bids: BookLevel[]; asks: BookLevel[]; }

// -----------------------------------------------------------------------------

const cooldown = new CooldownManager('rewards_executor');

export const rewardsExecutorStrategy: Strategy = {
  id:          'rewards_executor',
  name:        'Rewards Executor',
  description: 'Market making en mercados con rewards via CLOB API. Paper trading por defecto.',

  defaultParams: {
    paperTrading:            true,
    maxPositions:            5,
    sizeUsdcPerPosition:     30,
    minRatePerDay:           1,
    minScoreThreshold:       0.001,
    maxPriceMoveThreshold:   0.15,
    maxSpreadCentsThreshold: 10,
    maxDaysOpen:             7,
    intervalSeconds:         60,
    clobApiBase:             'https://clob.polymarket.com',
  } satisfies ExecutorParams,

  async run(params): Promise<StrategyRunResult> {
    const p      = params as unknown as ExecutorParams;
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

      const posOrders = await orderQueries.getForPosition(pos.id);
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
        positionId:      pos.id,
        paperTrading:    pos.paperTrading,
        midprice,
        bestBid:         bestBid ?? undefined,
        bestAsk:         bestAsk ?? undefined,
        spreadCents:     spreadCents ?? undefined,
        midExtreme:      score.midExtreme,
        scoreQne:        score.qne,
        scoreQno:        score.qno,
        scoreQmin:       score.qmin,
        normalizedProxy: score.normalizedProxy,
        rewardUsdc:      score.rewardUsdc,
        inRange:         score.inRange,
      }).catch(() => {});

      await positionQueries.addReward(pos.id, score.rewardUsdc, score.qmin, score.inRange);
      totalRewardUsdc += score.rewardUsdc;

      const icon = score.inRange ? 'OK' : 'OUT';
      console.log(
        `[rewards_executor]   [${icon}] #${pos.id}` +
        ` mid=${(midprice * 100).toFixed(1)}c` +
        ` spread=${spreadCents?.toFixed(1) ?? '?'}c` +
        ` Qmin=${score.qmin.toFixed(4)}` +
        ` reward=+$${score.rewardUsdc.toFixed(6)}` +
        ` | ${(pos.marketQuestion ?? '').slice(0, 40)}`,
      );

      // Condiciones de salida
      if (new Date() > new Date(pos.rewardEndDate)) {
        console.log(`[rewards_executor]   #${pos.id} CERRADA: reward expirado`);
        await positionQueries.close(pos.id, 'reward_ended');
        positionsClosed++;
        signals.push(buildCloseSignal(pos, 'reward_ended', midprice, score));
        continue;
      }

      if (!score.inRange && score.qmin < p.minScoreThreshold) {
        console.log(`[rewards_executor]   #${pos.id} CERRADA: score_too_low Qmin=${score.qmin.toFixed(6)}`);
        await positionQueries.close(pos.id, 'score_too_low');
        positionsClosed++;
        signals.push(buildCloseSignal(pos, 'score_too_low', midprice, score));
        continue;
      }

      const entryMid   = Number(pos.entryMidprice);
      const priceMoved = Math.abs(midprice - entryMid) / entryMid;
      if (priceMoved > p.maxPriceMoveThreshold) {
        console.log(`[rewards_executor]   #${pos.id} CERRADA: price_moved ${(priceMoved * 100).toFixed(1)}%`);
        await positionQueries.close(pos.id, 'price_moved');
        positionsClosed++;
        signals.push(buildCloseSignal(pos, 'price_moved', midprice, score));
        continue;
      }

      const daysOpen = (Date.now() - (pos.openedAt?.getTime() ?? 0)) / 86_400_000;
      if (daysOpen > p.maxDaysOpen) {
        console.log(`[rewards_executor]   #${pos.id} CERRADA: expired ${daysOpen.toFixed(1)}d`);
        await positionQueries.close(pos.id, 'expired');
        positionsClosed++;
        signals.push(buildCloseSignal(pos, 'expired', midprice, score));
        continue;
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

        const config     = market.rewards_config[0];
        const ratePerDay = Number(config.rate_per_day ?? 0);

        if (ratePerDay < p.minRatePerDay) {
          console.log(`[rewards_executor]   skip ${market.question.slice(0, 40)} — $${ratePerDay}/dia < min $${p.minRatePerDay}`);
          continue;
        }

        // spread viene como decimal (0.02 = 2 centavos)
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

        const maxSpreadCents   = Number(market.rewards_max_spread ?? 3);
        const minSizeShares    = Number(market.rewards_min_size   ?? 0);
        const dualSideRequired = midprice < 0.10 || midprice > 0.90;
        const sizePerSide      = p.sizeUsdcPerPosition / 2;

        const plannedOrders = calcOrderPrices(midprice, maxSpreadCents, sizePerSide, dualSideRequired);

        const category = parseCategory(null);
        const feeEntry = plannedOrders.reduce((sum, o) => sum + calcTakerFee(o.price, category) * o.sizeUsdc, 0);

        const entrySpreadCents   = bestBid && bestAsk ? (bestAsk - bestBid) * 100 : null;
        const totalLiquidityUsdc = Number(market.volume_24hr ?? 0);

        const positionId = await positionQueries.open({
          paperTrading:       p.paperTrading,
          marketId:           market.condition_id,
          marketQuestion:     market.question,
          tokenIdYes:         tokenYes.token_id,
          tokenIdNo:          tokenNo?.token_id,
          rewardId:           String(config.id),
          dailyRewardUsdc:    ratePerDay,
          maxSpreadCents,
          minSizeShares,
          rewardEndDate:      new Date(config.end_date),
          scalingFactorC:     3.0,
          sizeUsdc:           p.sizeUsdcPerPosition,
          sizePerSideUsdc:    sizePerSide,
          entryMidprice:      midprice,
          entryBid:           bestBid ?? undefined,
          entryAsk:           bestAsk ?? undefined,
          entrySpreadCents:   entrySpreadCents ?? undefined,
          dualSideRequired,
          totalLiquidityUsdc,
        });

        await orderQueries.insertMany(
          plannedOrders.map(o => ({
            positionId,
            paperTrading:       p.paperTrading,
            tokenId:            tokenYes.token_id,
            side:               o.side,
            price:              o.price,
            sizeUsdc:           o.sizeUsdc,
            sizeShares:         o.sizeShares,
            spreadFromMidCents: o.spreadFromMidCents,
          })),
        );

        await positionQueries.addFee(positionId, feeEntry);
        await cooldown.stamp(cooldownKey);
        positionsOpened++;

        console.log(
          `[rewards_executor]   ABIERTA #${positionId} — ${market.question.slice(0, 45)}` +
          ` | rate=$${ratePerDay}/dia | mid=${(midprice * 100).toFixed(1)}c` +
          ` | maxSpread=${maxSpreadCents}c | dual=${dualSideRequired} | fee=$${feeEntry.toFixed(4)}`,
        );

        signals.push({
          strategyId: this.id,
          severity:   'low',
          title:      `${p.paperTrading ? 'PAPER' : 'REAL'} Nueva posicion: ${market.question.slice(0, 55)}`,
          body: [
            `<b>Mercado:</b> ${market.question}`,
            `<b>Rate rewards:</b> $${ratePerDay}/dia`,
            `<b>Max spread:</b> ${maxSpreadCents}c`,
            `<b>Spread actual:</b> ${spreadCents.toFixed(1)}c`,
            `<b>Capital:</b> $${p.sizeUsdcPerPosition} USDC`,
            `<b>Midprice entrada:</b> ${(midprice * 100).toFixed(1)}c`,
            `<b>Dual side:</b> ${dualSideRequired ? 'Si (mid extremo)' : 'No'}`,
            `<b>Fee entrada estimada:</b> $${feeEntry.toFixed(4)}`,
            `<b>Modo:</b> ${p.paperTrading ? 'Paper Trading' : 'Real'}`,
          ].join('\n'),
          metadata: {
            positionId,
            marketId:    market.condition_id,
            rewardId:    config.id,
            ratePerDay,
            maxSpread:   maxSpreadCents,
            midprice,
            paperTrading: p.paperTrading,
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
        positionsOpened,
        positionsClosed,
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
      ` | maxPositions: ${p.maxPositions} | sizeUsdc: $${p.sizeUsdcPerPosition}` +
      ` | minRatePerDay: $${p.minRatePerDay}`,
    );
  },
};

// ---- Helpers -----------------------------------------------------------------

function buildCloseSignal(
  pos: Awaited<ReturnType<typeof positionQueries.getById>>,
  reason: string,
  currentMid: number,
  score: ReturnType<typeof calcSampleScore>,
) {
  if (!pos) return null!;
  const rewards    = Number(pos.rewardsEarnedUsdc ?? 0);
  const fees       = Number(pos.feesPaidUsdc ?? 0);
  const net        = rewards - fees;
  const inRangePct = pos.samplesTotal > 0
    ? ((pos.samplesInRange / pos.samplesTotal) * 100).toFixed(1) : 'N/A';
  const labels: Record<string, string> = {
    reward_ended:  'Reward expirado',
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
      `<b>Qmin ultimo:</b> ${score.qmin.toFixed(4)}`,
      `<b>Mid actual:</b> ${(currentMid * 100).toFixed(1)}c  entrada: ${(Number(pos.entryMidprice) * 100).toFixed(1)}c`,
    ].join('\n'),
    metadata: {
      positionId:   pos.id,
      marketId:     pos.marketId,
      reason,
      rewardsUsdc:  rewards,
      feesUsdc:     fees,
      netPnl:       net,
      paperTrading: pos.paperTrading,
    },
  };
}

async function fetchBook(clobBase: string, tokenId: string): Promise<ClobBook | null> {
  try {
    const res = await fetch(`${clobBase}/book?token_id=${tokenId}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    return res.json() as Promise<ClobBook>;
  } catch { return null; }
}

async function fetchRewardMarkets(clobBase: string): Promise<RewardsMarket[]> {
  const url = `${clobBase}/rewards/markets/multi?order_by=rate_per_day&position=DESC&page_size=100`;
  const res  = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`CLOB rewards API ${res.status}: ${await res.text()}`);
  const data = await res.json() as RewardsMarketsResponse;
  return (data.data ?? []).filter(m =>
    m.rewards_config?.length > 0 &&
    m.tokens?.length >= 2,
  );
}