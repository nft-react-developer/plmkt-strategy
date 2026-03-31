/**
 * S4: Order Book Imbalance Detector
 *
 * Monitorea el CLOB de Polymarket y detecta cuando hay una asimetría
 * grande entre bid depth y ask depth.
 *
 * Parámetros configurables:
 *   intervalSeconds       — default 90
 *   imbalanceThreshold    — ratio mínimo para alertar, 0-1 (default 0.70)
 *                           > 0.70 = bid heavy | < 0.30 = ask heavy
 *   depthLevels           — cuántos niveles del book considerar (default 5)
 *   minMarketVolume24h    — volumen mínimo del mercado en USDC (default 2000)
 *   maxMarketsPerRun      — mercados a analizar por tick (default 30)
 *   cooldownMinutes       — cooldown por mercado/token/dirección (default 60)
 */

import { Strategy, StrategyRunResult } from '../../core/strategy.interface';
import { orderBookQueries } from '../../db/queries';
import { fetchActiveMarkets, parseTokens } from '../../utils/polymarket';
import { CooldownManager } from '../../core/cooldown';
import { logger } from '../../utils/logger';

interface OrderBookParams {
  intervalSeconds:    number;
  imbalanceThreshold: number;
  depthLevels:        number;
  minMarketVolume24h: number;
  maxMarketsPerRun:   number;
  cooldownMinutes:    number;
  clobApiBase:        string;
  gammaApiBase:       string;
}

interface BookLevel { price: string; size: string; }
interface ClobBook  { bids: BookLevel[]; asks: BookLevel[]; }

const cooldown = new CooldownManager('order_book');

export const orderBookStrategy: Strategy = {
  id:          'order_book',
  name:        'Order Book Imbalance',
  description: 'Detecta asimetría en el order book del CLOB de Polymarket',

  defaultParams: {
    intervalSeconds:    90,
    imbalanceThreshold: 0.70,
    depthLevels:        5,
    minMarketVolume24h: 2000,
    maxMarketsPerRun:   30,
    cooldownMinutes:    60,
    clobApiBase:        'https://clob.polymarket.com',
    gammaApiBase:       'https://gamma-api.polymarket.com',
  } satisfies OrderBookParams,

  async run(params): Promise<StrategyRunResult> {
    const p         = params as unknown as OrderBookParams;
    const signals: StrategyRunResult['signals'] = [];
    const cooldownMs  = p.cooldownMinutes * 60_000;
    let booksChecked  = 0;
    let snapshotsSaved = 0;

    const markets = await fetchActiveMarkets(p.gammaApiBase, p.minMarketVolume24h, p.maxMarketsPerRun)
      .catch(err => { logger.error('[order_book] fetchActiveMarkets failed', err); return []; });

    logger.info(`[order_book] analyzing ${markets.length} markets`);

    for (const market of markets) {
      for (const token of parseTokens(market)) {
        const book = await fetchBook(p.clobApiBase, token.token_id);
        if (!book) continue;

        booksChecked++;
        const bids = book.bids.slice(0, p.depthLevels);
        const asks = book.asks.slice(0, p.depthLevels);
        if (!bids.length && !asks.length) continue;

        const bidDepth = bids.reduce((s, l) => s + Number(l.size), 0);
        const askDepth = asks.reduce((s, l) => s + Number(l.size), 0);
        const total    = bidDepth + askDepth;
        if (total === 0) continue;

        const imbalanceRatio = bidDepth / total;
        const bestBid = bids[0]?.price ?? null;
        const bestAsk = asks[0]?.price ?? null;
        const spread  = bestBid && bestAsk
          ? (Number(bestAsk) - Number(bestBid)).toFixed(6) : null;

        // Guardar snapshot para historial
        await orderBookQueries.insertSnapshot({
          marketId:       market.conditionId,
          tokenId:        token.token_id,
          bestBid:        bestBid ?? undefined,
          bestAsk:        bestAsk ?? undefined,
          spread:         spread ?? undefined,
          bidDepth:       bidDepth.toFixed(4),
          askDepth:       askDepth.toFixed(4),
          imbalanceRatio: imbalanceRatio.toFixed(4),
        }).catch(() => {});
        snapshotsSaved++;

        const isBidHeavy = imbalanceRatio >= p.imbalanceThreshold;
        const isAskHeavy = imbalanceRatio <= (1 - p.imbalanceThreshold);
        if (!isBidHeavy && !isAskHeavy) continue;

        const direction = isBidHeavy ? 'bid_heavy' : 'ask_heavy';

        // Cooldown incluye la dirección: si cambia de bid_heavy a ask_heavy
        // en la misma hora, SÍ alerta (son señales opuestas)
        const key = `${market.conditionId}:${token.token_id}:${direction}`;
        if (!(await cooldown.isReady(key, cooldownMs))) continue;

        const emoji = isBidHeavy ? '🟢' : '🔴';
        const label = isBidHeavy ? '⬆ Presión compradora' : '⬇ Presión vendedora';

        await orderBookQueries.insertAlert({
          marketId:       market.conditionId,
          marketTitle:    market.question,
          tokenId:        token.token_id,
          imbalanceRatio: imbalanceRatio.toFixed(4),
          direction,
          bestBid:        bestBid ?? undefined,
          bestAsk:        bestAsk ?? undefined,
        }).catch(() => {});

        await cooldown.stamp(key);

        signals.push({
          strategyId: this.id,
          severity:   imbalanceRatio >= 0.80 || imbalanceRatio <= 0.20 ? 'high' : 'medium',
          title:      `${emoji} ${label}: ${market.question.slice(0, 55)}`,
          body: [
            `<b>Mercado:</b> ${market.question}`,
            `<b>Outcome:</b> ${token.outcome}`,
            `<b>Imbalance ratio:</b> ${(imbalanceRatio * 100).toFixed(1)}% bid / ${((1 - imbalanceRatio) * 100).toFixed(1)}% ask`,
            `<b>Bid depth (${p.depthLevels} niveles):</b> ${bidDepth.toFixed(2)}`,
            `<b>Ask depth (${p.depthLevels} niveles):</b> ${askDepth.toFixed(2)}`,
            bestBid ? `<b>Best bid:</b> ${bestBid}` : '',
            bestAsk ? `<b>Best ask:</b> ${bestAsk}` : '',
            spread  ? `<b>Spread:</b>   ${spread}`  : '',
          ].filter(Boolean).join('\n'),
          metadata: {
            marketId:       market.conditionId,
            tokenId:        token.token_id,
            outcome:        token.outcome,
            imbalanceRatio,
            direction,
            bidDepth,
            askDepth,
            bestBid,
            bestAsk,
          },
        });
      }
    }

    return {
      signals,
      metrics: { booksChecked, snapshotsSaved, signalsFired: signals.length },
    };
  },

  async init() { logger.info('[order_book] init — will monitor CLOB imbalances'); },
};

async function fetchBook(clobBase: string, tokenId: string): Promise<ClobBook | null> {
  try {
    const res = await fetch(`${clobBase}/book?token_id=${tokenId}`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    return res.json() as Promise<ClobBook>;
  } catch {
    return null;
  }
}
