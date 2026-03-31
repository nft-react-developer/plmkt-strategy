import { getDb, testConnection } from '../db/connection';
import { walletQueries, walletTradeQueries } from '../db/queries';
import { logger } from '../utils/logger';

const DATA_API = 'https://data-api.polymarket.com';

interface PolyLeaderboardEntry {
  rank:          string;
  proxyWallet:   string;
  userName:      string;
  vol:           number;
  pnl:           number;
  profileImage:  string;
  xUsername:     string;
  verifiedBadge: boolean;
}

interface PolyTrade {
  conditionId:     string;
  title:           string;
  tokenId:         string;
  side:            string;
  price:           number;
  size:            number;
  usdcSize:        number;
  transactionHash: string;
  timestamp:       number;
  profitLoss?:     number;
}

export async function runWalletSync(limit = 150, minVol = 5000) {
  logger.info(`[wallet-sync] starting — limit: ${limit}, minVol: $${minVol}`);

  // Inicializar DB antes de comprobar conexión
  await getDb();
  const ok = await testConnection();
  if (!ok) {
    logger.error('[wallet-sync] DB connection failed, skipping sync');
    return;
  }

  const profiles = await fetchLeaderboard(limit, minVol);
  logger.info(`[wallet-sync] fetched ${profiles.length} wallets`);

  let updated = 0;
  let errors  = 0;

  for (const profile of profiles) {
    try {
      const { winRate, winningTrades } = await calcWinRate(profile.proxyWallet);
      // Smart score: win_rate * ln(winningTrades + 1)
      // Usa winningTrades en lugar de totalTrades (no disponible en leaderboard)
      const smartScore = winRate * Math.log(winningTrades + 1);

      await walletQueries.upsert({
        address:        profile.proxyWallet,
        source:         'leaderboard',
        totalTrades:    0, // se actualiza al sincronizar actividad
        totalVolume:    profile.vol.toFixed(2),
        winningTrades,
        winRatePct:     (winRate * 100).toFixed(2),
        smartScore:     smartScore.toFixed(4),
        lastActivityAt: new Date(),
      });

      await syncRecentTrades(profile.proxyWallet);
      updated++;
    } catch (err) {
      errors++;
      logger.error(`[wallet-sync] failed for ${profile.proxyWallet.slice(0, 10)}…`, err);
    }
  }

  logger.info(`[wallet-sync] done — updated: ${updated}, errors: ${errors}`);
}

async function fetchLeaderboard(limit: number, minVol: number): Promise<PolyLeaderboardEntry[]> {
  const url = `${DATA_API}/v1/leaderboard?limit=${limit}&window=1m&category=OVERALL`;
  const res  = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`leaderboard API ${res.status}`);
  const data = await res.json() as PolyLeaderboardEntry[];
  return data.filter(p => p.vol >= minVol);
}

/**
 * Calcula win rate basado en trades con profitLoss conocido.
 * Solo cuenta mercados ya resueltos.
 */
async function calcWinRate(address: string): Promise<{ winRate: number; winningTrades: number }> {
  try {
    const url = `${DATA_API}/activity?user=${address}&limit=100`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { winRate: 0, winningTrades: 0 };

    const trades = await res.json() as PolyTrade[];
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
 * Sincroniza los últimos 20 trades de una wallet.
 * Filtra trades recientes (últimas 48h) para no alertar sobre operaciones viejas.
 */
async function syncRecentTrades(address: string): Promise<void> {
  try {
    const url = `${DATA_API}/activity?user=${address}&limit=20`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return;

    const trades = await res.json() as PolyTrade[];

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
      });
    }
  } catch {
    // No critico si falla un trade individual
  }
}
