/**
 * scripts/sync-wallets.ts
 *
 * Sincroniza wallets desde la Polymarket data API hacia la tabla tracked_wallets.
 * Calcula win rate y smart score para cada wallet.
 *
 * Uso:
 *   npm run sync-wallets
 *   npm run sync-wallets -- --limit 200
 *   npm run sync-wallets -- --min-volume 10000
 *
 * Se puede agregar a un cron para correr cada 6-12 horas:
 *   0 *6 * * * cd /app && npm run sync-wallets >> /var/log/sync-wallets.log 2>&1
 */

import 'dotenv/config';
import { walletQueries, walletTradeQueries } from '../db/queries';
import { testConnection, closeDb } from '../db/connection';
import { logger } from '../utils/logger';

// ─── CLI args ────────────────────────────────────────────────────────────────

const args  = process.argv.slice(2);
const limit = Number(getArg(args, '--limit') ?? 150);
const minVol = Number(getArg(args, '--min-volume') ?? 5000);

function getArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
}

// ─── Polymarket API types ────────────────────────────────────────────────────

const DATA_API = 'https://data-api.polymarket.com';

interface PolyLeaderboardEntry {
  rank:          string;
  proxyWallet:   string;
  userName:      string;
  vol:           number;   // ← era 'volume'
  pnl:           number;   // ← era 'profit'
  profileImage:  string;
  xUsername:     string;
  verifiedBadge: boolean;
}

interface PolyTrade {
  proxyWallet: string;
  conditionId: string;
  title:       string;
  tokenId:     string;
  side:        string;   // 'BUY' | 'SELL'
  price:       number;
  size:        number;
  usdcSize:    number;
  transactionHash: string;
  timestamp:   number;
  outcome?:    string;
  profitLoss?: number;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  logger.info(`🔄 Wallet sync starting — limit: ${limit}, minVol: $${minVol}`);

  const ok = await testConnection();
  if (!ok) { logger.error('DB connection failed'); process.exit(1); }

  // 1. Obtener leaderboard de Polymarket
  const profiles = await fetchLeaderboard(limit, minVol);
  logger.info(`📥 Fetched ${profiles.length} wallet profiles from leaderboard`);

  let updated = 0;
  let errors  = 0;

  for (const profile of profiles) {
    try {
      // 2. Calcular métricas
      const { winRate, winningTrades } = await calcWinRate(profile.proxyWallet);
      const smartScore = winRate * Math.log(winningTrades + 1);

      await walletQueries.upsert({
        address:        profile.proxyWallet,
        source:         'leaderboard',
        totalTrades:  0,  // se actualiza cuando se sincroniza el activity
        totalVolume:  profile.vol.toFixed(2),
        winningTrades,
        winRatePct:     (winRate * 100).toFixed(2),
        smartScore:     smartScore.toFixed(4),
        lastActivityAt: new Date(),
      });

      // 4. Sincronizar trades recientes
      await syncRecentTrades(profile.proxyWallet);

      updated++;
      logger.debug(`✓ ${profile.proxyWallet.slice(0, 10)}… score=${smartScore.toFixed(2)} wr=${(winRate*100).toFixed(1)}%`);

    } catch (err) {
      errors++;
      logger.error(`✗ ${profile.proxyWallet.slice(0, 10)}…`, err);
    }
  }

  logger.info(`✅ Sync complete — updated: ${updated}, errors: ${errors}`);
  await closeDb();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function fetchLeaderboard(limit: number, minVol: number): Promise<PolyLeaderboardEntry[]> {
  // El endpoint acepta: category, limit, offset, window (1d|1w|1m|all)
  const url = `${DATA_API}/v1/leaderboard?limit=${limit}&window=1m&category=OVERALL`;
  const res  = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`leaderboard API ${res.status}`);
  const data: PolyLeaderboardEntry[] = await res.json() as PolyLeaderboardEntry[];
  return data.filter(p => p.vol >= minVol);
}

/**
 * Obtiene trades históricos de la wallet y calcula win rate
 * basado en trades en mercados ya resueltos (outcome conocido).
 */
async function calcWinRate(address: string): Promise<{ winRate: number; winningTrades: number }> {
  try {
    const url = `${DATA_API}/activity?user=${address}&limit=100`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { winRate: 0, winningTrades: 0 };

    const trades: PolyTrade[] = await res.json() as PolyTrade[];
    const resolved = trades.filter(t => t.profitLoss !== undefined && t.profitLoss !== null);

    if (!resolved.length) return { winRate: 0, winningTrades: 0 };

    const winning = resolved.filter(t => (t.profitLoss ?? 0) > 0);
    return {
      winRate:       winning.length / resolved.length,
      winningTrades: winning.length,
    };
  } catch {
    return { winRate: 0, winningTrades: 0 };
  }
}

/**
 * Sincroniza los últimos N trades de una wallet a la tabla wallet_trades.
 */
async function syncRecentTrades(address: string): Promise<void> {
  try {
    const url = `${DATA_API}/activity?user=${address}&limit=20`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return;

    const trades: PolyTrade[] = await res.json() as PolyTrade[];

    for (const t of trades) {
      const side = t.side?.toLowerCase() === 'sell' ? 'sell' : 'buy';
      let outcome: 'won' | 'lost' | 'void' | undefined;
      if (t.profitLoss !== undefined && t.profitLoss !== null) {
        outcome = t.profitLoss > 0 ? 'won' : t.profitLoss < 0 ? 'lost' : 'void';
      }

      await walletTradeQueries.insertIfNotExists({
        walletAddress: address,
        marketId:      t.conditionId,
        marketTitle:   t.title,
        tokenId:       t.tokenId,
        side,
        price:         t.price.toFixed(6),
        size:          t.size.toFixed(4),
        usdcValue:     t.usdcSize?.toFixed(2),
        txHash:        t.transactionHash || undefined,
        tradedAt:      new Date(t.timestamp * 1000),
        outcome,
        pnlUsdc:       t.profitLoss?.toFixed(4),
      } as Parameters<typeof walletTradeQueries.insertIfNotExists>[0]);
    }
  } catch {
    // No critico si falla un trade individual
  }
}

/**
 * Smart score = win_rate * ln(trades + 1)
 * Penaliza wallets con pocos trades aunque tengan 100% win rate.
 * Una wallet con 60% wr y 100 trades > una con 80% wr y 5 trades.
 */
function calcSmartScore(winRate: number, totalTrades: number): number {
  return winRate * Math.log(totalTrades + 1);
}

main().catch(err => {
  logger.error('sync-wallets fatal', err);
  process.exit(1);
});