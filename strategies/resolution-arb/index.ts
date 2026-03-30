/**
 * S5: Resolution Arbitrage
 */

import { Strategy, StrategyRunResult } from '../../core/strategy.interface';
import { fetchResolvedMarkets, parseTokens } from '../../utils/polymarket';
import { CooldownManager } from '../../core/cooldown';
import { logger } from '../../utils/logger';

interface ResArbParams {
  intervalSeconds:  number;
  minDiscount:      number;
  minVolume24h:     number;
  maxMarketsPerRun: number;
  cooldownMinutes:  number;
  gammaApiBase:     string;
}

const cooldown = new CooldownManager('resolution_arb');

export const resolutionArbStrategy: Strategy = {
  id:          'resolution_arb',
  name:        'Resolution Arbitrage',
  description: 'Detecta mercados resueltos donde el precio aún no llegó a 1',

  defaultParams: {
    intervalSeconds:  90,
    minDiscount:      0.03,
    minVolume24h:     1000,
    maxMarketsPerRun: 40,
    cooldownMinutes:  30,
    gammaApiBase:     'https://gamma-api.polymarket.com',
  } satisfies ResArbParams,

  async run(params): Promise<StrategyRunResult> {
    const p         = params as unknown as ResArbParams;
    const signals: StrategyRunResult['signals'] = [];
    const cooldownMs = p.cooldownMinutes * 60_000;

    const markets = await fetchResolvedMarkets(p.gammaApiBase, p.minVolume24h, p.maxMarketsPerRun)
      .catch(err => { logger.error('[resolution_arb] fetchResolvedMarkets failed', err); return []; });

    logger.info(`[resolution_arb] checking ${markets.length} recently resolved markets`);

    for (const market of markets) {
      const tokens = parseTokens(market);

      const winnerToken = tokens.reduce<typeof tokens[0] | null>((best, t) => {
        const price = Number(t.price);
        if (price < 0.5) return best;
        if (!best || price > Number(best.price)) return t;
        return best;
      }, null);

      if (!winnerToken) continue;

      const price    = Number(winnerToken.price);
      const discount = 1 - price;
      if (discount < p.minDiscount || price >= 1) continue;

      const key = `${market.conditionId}:${winnerToken.token_id}`;
      if (!(await cooldown.isReady(key, cooldownMs))) continue;

      await cooldown.stamp(key);

      const discountPct = (discount * 100).toFixed(2);
      const roiPct      = ((1 / price - 1) * 100).toFixed(2);

      signals.push({
        strategyId: this.id,
        severity:   discount >= 0.10 ? 'high' : discount >= 0.05 ? 'medium' : 'low',
        title:      `⚡ Res. arb ${discountPct}% off: ${market.question.slice(0, 50)}`,
        body: [
          `<b>Mercado:</b> ${market.question}`,
          `<b>Outcome probable ganador:</b> ${winnerToken.outcome}`,
          `<b>Precio actual:</b> ${price.toFixed(4)} (debería ser 1.00)`,
          `<b>Descuento:</b> ${discountPct}¢ → ROI potencial: +${roiPct}%`,
          `<b>Vol 24h:</b> $${Number(market.volume24hr).toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
          '',
          `⚠️ Verificar que la resolución sea definitiva antes de operar.`,
        ].join('\n'),
        metadata: {
          marketId: market.conditionId, tokenId: winnerToken.token_id,
          outcome: winnerToken.outcome, price, discount, roiPct: Number(roiPct),
        },
      });
    }

    return { signals, metrics: { marketsChecked: markets.length, oppsFound: signals.length } };
  },
};