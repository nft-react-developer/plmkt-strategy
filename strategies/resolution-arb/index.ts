/**
 * S5: Resolution Arbitrage (con filtro de fees)
 *
 * Detecta mercados resueltos donde el precio aún no llegó a 1,
 * y filtra que el descuento sea mayor que las fees de taker.
 *
 * Con las nuevas fees (30 marzo 2026), comprar a 0.97 en un mercado
 * de Crypto tiene fee ~0.02% (porque p≈1 → fee≈0), así que sigue
 * siendo muy rentable. Pero en un mercado de Economics a p=0.5
 * tendría fee ~1.5%, lo que hace que descuentos pequeños no sean
 * rentables. El filtro isProfitable() lo maneja automáticamente.
 */

import { Strategy, StrategyRunResult } from '../../core/strategy.interface';
import { fetchResolvedMarkets, parseTokens } from '../../utils/polymarket';
import { isProfitable, parseCategory } from '../../utils/fees';
import { CooldownManager } from '../../core/cooldown';
import { logger } from '../../utils/logger';

interface ResArbParams {
  intervalSeconds:  number;
  minDiscount:      number;
  minNetPnlPct:     number;
  minVolume:        number;
  maxMarketsPerRun: number;
  cooldownMinutes:  number;
  gammaApiBase:     string;
}

const cooldown = new CooldownManager('resolution_arb');

export const resolutionArbStrategy: Strategy = {
  id:          'resolution_arb',
  name:        'Resolution Arbitrage',
  description: 'Detecta mercados resueltos donde el precio aún no llegó a 1 (fee-adjusted)',

  defaultParams: {
    intervalSeconds:  90,
    minDiscount:      0.03,
    minNetPnlPct:     0.5,  // ganancia mínima neta de fees
    minVolume:        1000,
    maxMarketsPerRun: 40,
    cooldownMinutes:  30,
    gammaApiBase:     'https://gamma-api.polymarket.com',
  } satisfies ResArbParams,

  async run(params): Promise<StrategyRunResult> {
    const p         = params as unknown as ResArbParams;
    const signals: StrategyRunResult['signals'] = [];
    const cooldownMs = p.cooldownMinutes * 60_000;

    const markets = await fetchResolvedMarkets(p.gammaApiBase, p.minVolume, p.maxMarketsPerRun)
      .catch(err => { logger.error('[resolution_arb] fetchResolvedMarkets failed', err); return []; });

    logger.info(`[resolution_arb] checking ${markets.length} recently resolved markets`);

    for (const market of markets) {
      const tokens = parseTokens(market);
      if (!tokens.length) continue;

      const tags     = (market as any).tags as Array<{ label: string }> | undefined;
      const category = parseCategory(tags?.[0]?.label);

      // Heurística: el outcome ganador es el token con precio más alto (> 0.5)
      const winnerToken = tokens.reduce<typeof tokens[0] | null>((best, t) => {
        const price = Number(t.price);
        if (price < 0.5) return best;
        if (!best || price > Number(best.price)) return t;
        return best;
      }, null);

      if (!winnerToken) continue;

      const price    = Number(winnerToken.price);
      const discount = 1 - price;

      if (price >= 0.99 || discount < p.minDiscount) continue;

      // ── Filtro de fees ────────────────────────────────────────────────
      // Compras a `price`, target es 1.0 (resolución)
      // La fee de salida al redimir es 0 (resolución no tiene fee de taker)
      // Solo hay fee de entrada
      const feeCheck = isProfitable(price, 1.0, category);

      if (feeCheck.netPnlPct < p.minNetPnlPct) {
        logger.debug(`[resolution_arb] skip — net ${feeCheck.netPnlPct.toFixed(2)}% < ${p.minNetPnlPct}%`);
        continue;
      }

      const key = `${market.conditionId}:${winnerToken.token_id}`;
      if (!(await cooldown.isReady(key, cooldownMs))) continue;

      await cooldown.stamp(key);

      const discountPct = (discount * 100).toFixed(2);

      signals.push({
        strategyId: this.id,
        severity:   discount >= 0.10 ? 'high' : discount >= 0.05 ? 'medium' : 'low',
        title:      `⚡ Res. arb ${discountPct}% off: ${market.question.slice(0, 50)}`,
        body: [
          `<b>Mercado:</b> ${market.question}`,
          `<b>Outcome probable ganador:</b> ${winnerToken.outcome}`,
          `<b>Precio actual:</b> ${price.toFixed(4)} (target: 1.00)`,
          `<b>Descuento bruto:</b> ${discountPct}¢`,
          '',
          `<b>Taker fee (${category}):</b> ${feeCheck.feePct.toFixed(3)}%`,
          `<b>Net PnL estimado:</b> ${feeCheck.netPnlPct.toFixed(2)}% ✅`,
          '',
          `<b>Vol histórico:</b> $${Number(market.volumeNum ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
          '',
          `⚠️ Verificar que la resolución sea definitiva antes de operar.`,
          `⚠️ El ganador se detecta por heurística de precio, no por datos oficiales.`,
        ].join('\n'),
        metadata: {
          marketId:   market.conditionId,
          tokenId:    winnerToken.token_id,
          outcome:    winnerToken.outcome,
          price,
          discount,
          netPnlPct:  feeCheck.netPnlPct,
          feePct:     feeCheck.feePct,
          category,
        },
      });
    }

    return {
      signals,
      metrics: { marketsChecked: markets.length, oppsFound: signals.length },
    };
  },
};