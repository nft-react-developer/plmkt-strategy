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
 *   minMarketVolume      — volumen mínimo USDC del mercado (default 1000)
 *   cooldownMinutes      — cooldown por mercado (default 120)
 */

import { Strategy, StrategyRunResult } from '../../core/strategy.interface';
import { walletQueries, walletTradeQueries } from '../../db/queries';
import { CooldownManager } from '../../core/cooldown';
import { logger } from '../../utils/logger';

interface SmartMoneyParams {
  intervalSeconds:      number;
  minSmartScore:        number;
  minWalletsConfluence: number;
  lookbackHours:        number;
  minMarketVolume:      number;
  cooldownMinutes:      number;
}

const cooldown = new CooldownManager('smart_money');

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
    cooldownMinutes:      120,
  } satisfies SmartMoneyParams,

  async run(params): Promise<StrategyRunResult> {
    const p          = params as unknown as SmartMoneyParams;
    const signals: StrategyRunResult['signals'] = [];
    const cooldownMs = p.cooldownMinutes * 60_000;
    const since      = new Date(Date.now() - p.lookbackHours * 3_600_000);

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

        // Filtrar por volumen mínimo del mercado (evita mercados sin liquidez)
        // Nota: usdcValue puede ser null si el trade viene del leaderboard sin datos completos
        const tradeValue = Number(trade.usdcValue ?? 0);
        if (tradeValue > 0 && tradeValue < p.minMarketVolume) continue;

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
      const key = marketId;
      if (!(await cooldown.isReady(key, cooldownMs))) continue;

      await cooldown.stamp(key);

      const avgScore = data.wallets.reduce((s, w) => s + w.score, 0) / data.wallets.length;
      const buys     = data.wallets.filter(w => w.side === 'buy').length;
      const sells    = data.wallets.length - buys;
      const dominant = buys >= sells ? 'BUY' : 'SELL';
      const avgPrice = data.wallets.reduce((s, w) => s + w.price, 0) / data.wallets.length;

      const walletLines = data.wallets
        .map(w => `  <code>${w.address.slice(0, 10)}…</code> score: ${w.score.toFixed(2)} | ${w.side.toUpperCase()} @ ${w.price.toFixed(4)}`)
        .join('\n');

      // Nota: "SELL" en Polymarket puede ser toma de ganancias, no necesariamente bajista
      const dominantNote = dominant === 'SELL'
        ? 'SELL (puede ser toma de ganancias)'
        : 'BUY';

      signals.push({
        strategyId: this.id,
        severity:   data.wallets.length >= 4 ? 'high' : data.wallets.length >= 3 ? 'medium' : 'low',
        title:      `🧠 Smart money confluye: ${data.title ?? marketId.slice(0, 40)}`,
        body: [
          `<b>Mercado:</b> ${data.title ?? marketId}`,
          `<b>Confluencia:</b> ${data.wallets.length} wallets inteligentes`,
          `<b>Dirección dominante:</b> ${dominantNote} (${Math.max(buys, sells)}/${data.wallets.length})`,
          `<b>Precio promedio entrada:</b> ${avgPrice.toFixed(4)}`,
          `<b>Avg smart score:</b> ${avgScore.toFixed(2)}`,
          '',
          '<b>Wallets:</b>',
          walletLines,
        ].join('\n'),
        metadata: {
          marketId,
          marketTitle:  data.title,
          walletCount:  data.wallets.length,
          dominant,
          avgPrice,
          avgScore,
          wallets: data.wallets.map(w => w.address),
        },
      });
    }

    return {
      signals,
      metrics: {
        smartWallets:    smartWallets.length,
        marketsChecked:  marketCounts.size,
        confluenceFound: signals.length,
      },
    };
  },
};
