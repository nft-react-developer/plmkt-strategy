
/**
 * S2: Smart Money Detector
 *
 * Detecta wallets que históricamente entraron temprano en mercados
 * que luego se resolvieron en su favor. Construye un "smart score"
 * ponderado y alerta cuando varias wallets top confluyen en un mercado.
 *
 * Parámetros configurables:
 *   intervalSeconds      — default 300 (5 min)
 *   minSmartScore        — score mínimo para considerar una wallet (default 5.0)
 *   minWalletsConfluence — cuántas wallets top deben coincidir (default 2)
 *   lookbackHours        — ventana de tiempo para buscar confluencia (default 6)
 *   minMarketVolume      — volumen mínimo del mercado en USDC (default 1000)
 */

import { Strategy, StrategyRunResult } from '../../core/strategy.interface';
import { walletQueries, walletTradeQueries } from '../../db/queries';
import { logger } from '../../utils/logger';

interface SmartMoneyParams {
  intervalSeconds:      number;
  minSmartScore:        number;
  minWalletsConfluence: number;
  lookbackHours:        number;
  minMarketVolume:      number;
}

// Mercados ya alertados en esta sesión (para no spamear)
const alertedMarkets: Map<string, number> = new Map();
const ALERT_COOLDOWN_MS = 2 * 3_600_000; // 2h entre alertas del mismo mercado

export const smartMoneyStrategy: Strategy = {
  id:          'smart_money',
  name:        'Smart Money Detector',
  description: 'Detecta confluencia de wallets inteligentes en un mismo mercado',

  defaultParams: {
    intervalSeconds:      300,
    minSmartScore:        5.0,
    minWalletsConfluence: 2,
    lookbackHours:        6,
    minMarketVolume:      1000,
  } satisfies SmartMoneyParams,

  async run(params): Promise<StrategyRunResult> {
    const p = params as unknown as SmartMoneyParams;
    const signals: StrategyRunResult['signals'] = [];

    const since = new Date(Date.now() - p.lookbackHours * 3_600_000);

    // Wallets con smart score suficiente
    const smartWallets = (await walletQueries.getTopByScore(100)).filter(
      w => Number(w.smartScore ?? 0) >= p.minSmartScore,
    );

    if (!smartWallets.length) {
      logger.debug('[smart_money] no wallets with sufficient smart score');
      return { signals };
    }

    // Agrupar trades recientes por mercado
    const marketCounts = new Map<string, {
      title:   string | null;
      wallets: Array<{ address: string; score: number; side: string; price: number }>;
    }>();

    for (const wallet of smartWallets) {
      const recentTrades = await walletTradeQueries.getRecentForWallet(wallet.address, 10);

      for (const trade of recentTrades) {
        if (trade.tradedAt < since) continue;

        let entry = marketCounts.get(trade.marketId);
        if (!entry) {
          entry = { title: trade.marketTitle ?? null, wallets: [] };
          marketCounts.set(trade.marketId, entry);
        }

        // Evitar duplicar la misma wallet en el mismo mercado
        if (!entry.wallets.find(w => w.address === wallet.address)) {
          entry.wallets.push({
            address: wallet.address,
            score:   Number(wallet.smartScore ?? 0),
            side:    trade.side,
            price:   Number(trade.price),
          });
        }
      }
    }

    // Filtrar mercados con suficiente confluencia
    for (const [marketId, data] of marketCounts) {
      if (data.wallets.length < p.minWalletsConfluence) continue;

      // Cooldown por mercado
      const lastAlert = alertedMarkets.get(marketId) ?? 0;
      if (Date.now() - lastAlert < ALERT_COOLDOWN_MS) continue;

      alertedMarkets.set(marketId, Date.now());

      const avgScore = data.wallets.reduce((s, w) => s + w.score, 0) / data.wallets.length;
      const sides    = data.wallets.map(w => w.side);
      const buys     = sides.filter(s => s === 'buy').length;
      const sells    = sides.filter(s => s === 'sell').length;
      const dominant = buys >= sells ? 'BUY' : 'SELL';
      const avgPrice = data.wallets.reduce((s, w) => s + w.price, 0) / data.wallets.length;

      const walletLines = data.wallets
        .map(w => `  <code>${w.address.slice(0, 10)}…</code> score: ${w.score.toFixed(2)} | ${w.side.toUpperCase()} @ ${w.price.toFixed(4)}`)
        .join('\n');

      signals.push({
        strategyId: this.id,
        severity:   data.wallets.length >= 4 ? 'high' : data.wallets.length >= 3 ? 'medium' : 'low',
        title:      `🧠 Smart money confluye: ${data.title ?? marketId.slice(0, 40)}`,
        body: [
          `<b>Mercado:</b> ${data.title ?? marketId}`,
          `<b>Confluencia:</b> ${data.wallets.length} wallets inteligentes`,
          `<b>Dirección dominante:</b> ${dominant} (${Math.max(buys, sells)}/${data.wallets.length})`,
          `<b>Precio promedio entrada:</b> ${avgPrice.toFixed(4)}`,
          `<b>Avg smart score:</b> ${avgScore.toFixed(2)}`,
          '',
          '<b>Wallets:</b>',
          walletLines,
        ].join('\n'),
        metadata: {
          marketId,
          marketTitle: data.title,
          walletCount: data.wallets.length,
          dominant,
          avgPrice,
          avgScore,
          wallets: data.wallets.map(w => w.address),
        },
      } as const);
    }

    return {
      signals,
      metrics: {
        smartWallets:     smartWallets.length,
        marketsChecked:   marketCounts.size,
        confluenceFound:  signals.length,
      },
    };
  },
};