/**
 * S1: Whale Tracker
 */

import { Strategy, StrategyRunResult } from '../../core/strategy.interface';
import { walletQueries, walletTradeQueries } from '../../db/queries';
import { CooldownManager } from '../../core/cooldown';
import { logger } from '../../utils/logger';

interface WhaleParams {
  intervalSeconds:      number;
  topN:                 number;
  minWinRate:           number;
  minTrades:            number;
  alertThresholdUsdc:   number;
  cooldownMinutes:      number;
}

const cooldown = new CooldownManager('whale_tracker');

export const whaleTrackerStrategy: Strategy = {
  id:          'whale_tracker',
  name:        'Whale Tracker',
  description: 'Sigue wallets con alto win-rate y alerta cuando hacen trades grandes',

  defaultParams: {
    intervalSeconds:    120,
    topN:               30,
    minWinRate:         0.60,
    minTrades:          20,
    alertThresholdUsdc: 500,
    cooldownMinutes:    120,
  } satisfies WhaleParams,

  async run(params): Promise<StrategyRunResult> {
    const p          = params as unknown as WhaleParams;
    const signals: StrategyRunResult['signals'] = [];
    const cooldownMs = p.cooldownMinutes * 60_000;

    const topWallets = await walletQueries.getTopByScore(p.topN);
    const qualified  = topWallets.filter(w =>
      Number(w.winRatePct ?? 0) >= p.minWinRate * 100 &&
      w.totalTrades >= p.minTrades,
    );

    logger.info(`[whale_tracker] checking ${qualified.length} wallets`);

    for (const wallet of qualified) {
      const recentTrades = await walletTradeQueries.getRecentForWallet(wallet.address, 5);
      if (!recentTrades.length) continue;

      const latest    = recentTrades[0];
      const usdcValue = Number(latest.usdcValue ?? 0);
      if (usdcValue < p.alertThresholdUsdc) continue;

      // Key incluye el txHash para que cada trade único solo alerte una vez
      const key = `${wallet.address}:${latest.txHash ?? latest.tradedAt.toISOString()}`;
      if (!(await cooldown.isReady(key, cooldownMs))) continue;

      await cooldown.stamp(key);

      const label = wallet.label ?? wallet.address.slice(0, 10) + '…';
      const wr    = Number(wallet.winRatePct ?? 0).toFixed(1);

      signals.push({
        strategyId: this.id,
        severity:   usdcValue >= 5000 ? 'high' : usdcValue >= 1000 ? 'medium' : 'low',
        title:      `🐋 Whale move: ${label}`,
        body: [
          `<b>Wallet:</b> <code>${wallet.address}</code>`,
          `<b>Win rate:</b> ${wr}% (${wallet.totalTrades} trades)`,
          `<b>Smart score:</b> ${Number(wallet.smartScore ?? 0).toFixed(2)}`,
          `<b>Mercado:</b> ${latest.marketTitle ?? latest.marketId}`,
          `<b>Lado:</b> ${latest.side.toUpperCase()} @ ${Number(latest.price).toFixed(4)}`,
          `<b>Tamaño:</b> $${usdcValue.toFixed(2)} USDC`,
        ].join('\n'),
        metadata: {
          walletAddress: wallet.address, marketId: latest.marketId,
          side: latest.side, price: latest.price, usdcValue, txHash: latest.txHash,
        },
      });
    }

    return { signals, metrics: { walletsChecked: qualified.length, signalsFired: signals.length } };
  },

  async init(params) {
    logger.info(`[whale_tracker] init — tracking top ${(params as unknown as WhaleParams).topN} wallets`);
  },
};