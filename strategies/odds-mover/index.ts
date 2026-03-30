
/**
 * S3: Odds Movement Monitor
 *
 * Detecta movimientos bruscos de precio en mercados activos.
 * Compara el precio actual con el de N minutos atrás.
 * Puede comparar contra otras prediction markets si se configura.
 *
 * Parámetros configurables:
 *   intervalSeconds      — default 60
 *   windowMinutes        — ventana para medir el delta (default 15)
 *   minDeltaPct          — cambio mínimo para alertar, en % (default 8.0)
 *   minVolume24h         — volumen mínimo del mercado en USDC (default 5000)
 *   maxMarketsPerRun     — cuántos mercados analizar por tick (default 50)
 */

import { Strategy, StrategyRunResult } from '../../core/strategy.interface';
import { priceSnapshotQueries, oddsMoveQueries } from '../../db/queries';
import { logger } from '../../utils/logger';
import { GammaMarket } from '../models/gamma-market.model';

interface OddsMoverParams {
  intervalSeconds:   number;
  windowMinutes:     number;
  minDeltaPct:       number;
  minVolume24h:      number;
  maxMarketsPerRun:  number;
  /** URL base de la Polymarket gamma API */
  gammaApiBase:      string;
  /** URL base de la Polymarket CLOB API */
  clobApiBase:       string;
}

export const oddsMoverStrategy: Strategy = {
  id:          'odds_mover',
  name:        'Odds Movement Monitor',
  description: 'Alerta cuando un mercado mueve su precio más de X% en Y minutos',

  defaultParams: {
    intervalSeconds:   60,
    windowMinutes:     15,
    minDeltaPct:       8.0,
    minVolume24h:      5000,
    maxMarketsPerRun:  50,
    gammaApiBase:      'https://gamma-api.polymarket.com',
    clobApiBase:       'https://clob.polymarket.com',
  } satisfies OddsMoverParams,

  async run(params): Promise<StrategyRunResult> {
    const p  = params as unknown as OddsMoverParams;
    const signals: StrategyRunResult['signals'] = [];
    let marketsChecked = 0;
    let snapshotsSaved = 0;

    // 1. Obtener mercados activos con volumen suficiente
    const markets = await fetchActiveMarkets(p.gammaApiBase, p.minVolume24h, p.maxMarketsPerRun);
    logger.debug(`[odds_mover] fetched ${markets.length} markets`);

    for (const market of markets) {
      for (const token of market.tokens) {
        marketsChecked++;
        const currentPrice = Number(token.price);
        if (isNaN(currentPrice) || currentPrice <= 0) continue;

        // 2. Buscar snapshot de hace windowMinutes
        const old = await priceSnapshotQueries.getAtApprox(
          market.conditionId, token.token_id, p.windowMinutes,
        );

        // 3. Guardar snapshot actual
        const deltaH1Pct = old
          ? (((currentPrice - Number(old.price)) / Number(old.price)) * 100).toFixed(4)
          : null;

        await priceSnapshotQueries.insert({
          marketId:    market.conditionId,
          tokenId:     token.token_id,
          price:       currentPrice.toFixed(6),
          volume24h:   market.volume,
          priceH1Ago:  old?.price ?? null,
          deltaH1Pct:  deltaH1Pct ?? undefined,
        }).catch(() => {});
        snapshotsSaved++;

        if (!old) continue;

        const oldPrice  = Number(old.price);
        const deltaPct  = ((currentPrice - oldPrice) / oldPrice) * 100;
        if (Math.abs(deltaPct) < p.minDeltaPct) continue;

        // 4. Guardar en odds_moves
        await oddsMoveQueries.insert({
          marketId:      market.conditionId,
          marketTitle:   market.question,
          tokenId:       token.token_id,
          priceFrom:     oldPrice.toFixed(6),
          priceTo:       currentPrice.toFixed(6),
          deltaPct:      deltaPct.toFixed(4),
          windowMinutes: p.windowMinutes,
        }).catch(() => {});

        const direction = deltaPct > 0 ? '📈 subió' : '📉 bajó';
        const absDelta  = Math.abs(deltaPct);

        signals.push({
          strategyId: this.id,
          severity:   absDelta >= 20 ? 'high' : absDelta >= 12 ? 'medium' : 'low',
          title:      `${direction} ${absDelta.toFixed(1)}%: ${market.question.slice(0, 60)}`,
          body: [
            `<b>Mercado:</b> ${market.question}`,
            `<b>Outcome:</b> ${token.outcome}`,
            `<b>Precio hace ${p.windowMinutes}m:</b> ${(oldPrice * 100).toFixed(1)}¢`,
            `<b>Precio actual:</b> ${(currentPrice * 100).toFixed(1)}¢`,
            `<b>Δ:</b> ${deltaPct > 0 ? '+' : ''}${deltaPct.toFixed(2)}%`,
            `<b>Vol 24h:</b> $${Number(market.volume).toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
          ].join('\n'),
          metadata: {
            marketId:  market.conditionId,
            tokenId:   token.token_id,
            outcome:   token.outcome,
            priceFrom: oldPrice,
            priceTo:   currentPrice,
            deltaPct,
            windowMinutes: p.windowMinutes,
          },
        } as const);
      }
    }

    return {
      signals,
      metrics: { marketsChecked, snapshotsSaved, signalsFired: signals.length },
    };
  },

  async init() {
    logger.info('[odds_mover] init — will monitor price movements');
  },
};

// ─────────────────────────────────────────────────────────────────────────────

async function fetchActiveMarkets(
  base: string,
  minVolume: number,
  limit: number,
): Promise<GammaMarket[]> {
  try {
    const url = `${base}/markets?active=true&closed=false&limit=${limit}&order=volume&ascending=false`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`gamma API ${res.status}`);

    const data: GammaMarket[] = await res.json() as GammaMarket[];
    return data.filter(m => Number(m.volume ?? 0) >= minVolume && m.tokens?.length > 0);
  } catch (err) {
    logger.error('[odds_mover] fetchActiveMarkets failed', err);
    return [];
  }
}