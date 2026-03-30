/**
 * S3: Odds Movement Monitor
 */

import { Strategy, StrategyRunResult } from '../../core/strategy.interface';
import { priceSnapshotQueries, oddsMoveQueries } from '../../db/queries';
import { fetchActiveMarkets, parseTokens } from '../../utils/polymarket';
import { CooldownManager } from '../../core/cooldown';
import { logger } from '../../utils/logger';

interface OddsMoverParams {
  intervalSeconds:  number;
  windowMinutes:    number;
  minDeltaPct:      number;
  minVolume24h:     number;
  maxMarketsPerRun: number;
  cooldownMinutes:  number;
  gammaApiBase:     string;
}

const cooldown = new CooldownManager('odds_mover');

export const oddsMoverStrategy: Strategy = {
  id:          'odds_mover',
  name:        'Odds Movement Monitor',
  description: 'Alerta cuando un mercado mueve su precio más de X% en Y minutos',

  defaultParams: {
    intervalSeconds:  60,
    windowMinutes:    15,
    minDeltaPct:      8.0,
    minVolume24h:     5000,
    maxMarketsPerRun: 50,
    cooldownMinutes:  60,
    gammaApiBase:     'https://gamma-api.polymarket.com',
  } satisfies OddsMoverParams,

  async run(params): Promise<StrategyRunResult> {
    const p       = params as unknown as OddsMoverParams;
    const signals: StrategyRunResult['signals'] = [];
    const cooldownMs = p.cooldownMinutes * 60_000;
    let marketsChecked = 0;
    let snapshotsSaved = 0;

    const markets = await fetchActiveMarkets(p.gammaApiBase, p.minVolume24h, p.maxMarketsPerRun)
      .catch(err => { logger.error('[odds_mover] fetchActiveMarkets failed', err); return []; });

    logger.info(`[odds_mover] fetched ${markets.length} markets`);

    for (const market of markets) {
      for (const token of parseTokens(market)) {
        marketsChecked++;
        const currentPrice = Number(token.price);
        if (isNaN(currentPrice) || currentPrice <= 0) continue;

        const old = await priceSnapshotQueries.getAtApprox(
          market.conditionId, token.token_id, p.windowMinutes,
        );

        await priceSnapshotQueries.insert({
          marketId:   market.conditionId,
          tokenId:    token.token_id,
          price:      currentPrice.toFixed(6),
          volume24h:  market.volume24hr,
          priceH1Ago: old?.price ?? null,
          deltaH1Pct: old
            ? (((currentPrice - Number(old.price)) / Number(old.price)) * 100).toFixed(4)
            : undefined,
        }).catch(() => {});
        snapshotsSaved++;

        if (!old) continue;

        const oldPrice = Number(old.price);
        const deltaPct = ((currentPrice - oldPrice) / oldPrice) * 100;
        if (Math.abs(deltaPct) < p.minDeltaPct) continue;

        const key = `${market.conditionId}:${token.token_id}`;
        if (!(await cooldown.isReady(key, cooldownMs))) continue;

        await oddsMoveQueries.insert({
          marketId: market.conditionId, marketTitle: market.question,
          tokenId: token.token_id, priceFrom: oldPrice.toFixed(6),
          priceTo: currentPrice.toFixed(6), deltaPct: deltaPct.toFixed(4),
          windowMinutes: p.windowMinutes,
        }).catch(() => {});

        await cooldown.stamp(key);

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
            `<b>Vol 24h:</b> $${Number(market.volume24hr).toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
          ].join('\n'),
          metadata: {
            marketId: market.conditionId, tokenId: token.token_id,
            outcome: token.outcome, priceFrom: oldPrice, priceTo: currentPrice,
            deltaPct, windowMinutes: p.windowMinutes,
          },
        });
      }
    }

    return { signals, metrics: { marketsChecked, snapshotsSaved, signalsFired: signals.length } };
  },

  async init() { logger.info('[odds_mover] init'); },
};