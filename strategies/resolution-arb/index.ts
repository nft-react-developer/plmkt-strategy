/**
 * strategies/resolution-arb/index.ts
 *
 * S5 (ejemplo): Resolution Arbitrage
 *
 * Detecta mercados que ya resolvieron en Polymarket pero donde el precio
 * todavía no llegó a 0 o 1 (lag entre resolución y redemption).
 * En esa ventana se puede comprar el outcome ganador a precio < 1
 * antes de que todos rediman.
 *
 * Este archivo sirve de TEMPLATE para agregar nuevas estrategias.
 * Ver README.md para instrucciones de registro.
 *
 * Parámetros configurables:
 *   intervalSeconds    — default 90
 *   minDiscount        — descuento mínimo respecto a 1.0 para alertar (default 0.03 = 3¢)
 *   minVolume24h       — volumen mínimo del mercado (default 1000)
 *   maxMarketsPerRun   — mercados a revisar por tick (default 40)
 */

import { Strategy, StrategyRunResult } from '../../core/strategy.interface';
import { logger } from '../../utils/logger';
import { GammaMarket } from '../models/gamma-market.model';


interface ResArbParams {
  intervalSeconds:  number;
  minDiscount:      number;
  minVolume24h:     number;
  maxMarketsPerRun: number;
  gammaApiBase:     string;
}

// Cooldown para no re-alertar el mismo mercado
const alertedMarkets = new Map<string, number>();
const COOLDOWN_MS = 30 * 60_000; // 30 min

export const resolutionArbStrategy: Strategy = {
  id:          'resolution_arb',
  name:        'Resolution Arbitrage',
  description: 'Detecta mercados resueltos donde el precio aún no llegó a 1',

  defaultParams: {
    intervalSeconds:  90,
    minDiscount:      0.03,
    minVolume24h:     1000,
    maxMarketsPerRun: 40,
    gammaApiBase:     'https://gamma-api.polymarket.com',
  } satisfies ResArbParams,

  async run(params): Promise<StrategyRunResult> {
    const p = params as unknown as ResArbParams;
    const signals: StrategyRunResult['signals'] = [];

    const markets = await fetchResolvedMarkets(p.gammaApiBase, p.minVolume24h, p.maxMarketsPerRun);
    logger.debug(`[resolution_arb] checking ${markets.length} recently resolved markets`);

    for (const market of markets) {
      const winnerToken = market.tokens.find(t => t.winner === true);
      if (!winnerToken) continue;

      const price = Number(winnerToken.price);
      if (isNaN(price) || price >= 1) continue;

      const discount = 1 - price;
      if (discount < p.minDiscount) continue;

      const key = `${market.conditionId}:${winnerToken.token_id}`;
      const lastAlert = alertedMarkets.get(key) ?? 0;
      if (Date.now() - lastAlert < COOLDOWN_MS) continue;
      alertedMarkets.set(key, Date.now());

      const discountPct = (discount * 100).toFixed(2);
      const roiPct      = ((1 / price - 1) * 100).toFixed(2);

      signals.push({
        strategyId: this.id,
        severity:   discount >= 0.10 ? 'high' : discount >= 0.05 ? 'medium' : 'low',
        title:      `⚡ Res. arb ${discountPct}% off: ${market.question.slice(0, 50)}`,
        body: [
          `<b>Mercado:</b> ${market.question}`,
          `<b>Outcome ganador:</b> ${winnerToken.outcome}`,
          `<b>Precio actual:</b> ${price.toFixed(4)} (debería ser 1.00)`,
          `<b>Descuento:</b> ${discountPct}¢ → ROI potencial: +${roiPct}%`,
          `<b>Vol 24h:</b> $${Number(market.volume).toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
          '',
          `⚠️ Verificar que la resolución sea definitiva antes de operar.`,
        ].join('\n'),
        metadata: {
          marketId:   market.conditionId,
          tokenId:    winnerToken.token_id,
          outcome:    winnerToken.outcome,
          price,
          discount,
          roiPct: Number(roiPct),
        },
      });
    }

    return { signals, metrics: { marketsChecked: markets.length, oppsFound: signals.length } };
  },
};

async function fetchResolvedMarkets(base: string, minVol: number, limit: number): Promise<GammaMarket[]> {
  try {
    const url = `${base}/markets?closed=true&limit=${limit}&order=volume&ascending=false`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`gamma API ${res.status}`);
    const data: GammaMarket[] = await res.json() as GammaMarket[];
    return data.filter(m => Number(m.volume ?? 0) >= minVol && m.tokens?.length > 0);
  } catch (err) {
    logger.error('[resolution_arb] fetchResolvedMarkets failed', err);
    return [];
  }
}