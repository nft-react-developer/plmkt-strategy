/**
 * core/outcome-resolver.ts  (versión con Telegram integrado)
 *
 * Cambios respecto a la versión anterior:
 *  - Al terminar cada ejecución, llama a telegram.sendOutcomeResolutionReport()
 *  - Recoge los signals recién resueltos para incluirlos en el mensaje
 *  - Expone runOutcomeResolver() y scheduleOutcomeResolver()
 *
 * Integrar en runner.ts:
 *   import { scheduleOutcomeResolver } from './outcome-resolver';
 *   scheduleOutcomeResolver();   // en el bootstrap, junto a scheduleWalletSync()
 */

import { and, eq, gte, isNull } from 'drizzle-orm';
import { getDb, schema } from '../db/connection';
import { signalQueries } from '../db/queries';
import { telegram } from '../telegram/notifier';
import { logger } from '../utils/logger';
import { STRATEGIES } from '../strategies/registry';

const GAMMA_BASE = process.env.GAMMA_API_BASE ?? 'https://gamma-api.polymarket.com';
const CLOB_BASE  = process.env.CLOB_API_BASE  ?? 'https://clob.polymarket.com';
const PRICE_MOVE_THRESHOLD_PCT = 3;

// ─── Tipos API ────────────────────────────────────────────────────────────────
interface GammaToken { token_id: string; outcome: string; price: string; winner?: boolean; }
interface GammaMarket { conditionId: string; closed: boolean; tokens: GammaToken[]; }

const _marketCache = new Map<string, GammaMarket | null>();

async function fetchMarket(id: string): Promise<GammaMarket | null> {
  if (_marketCache.has(id)) return _marketCache.get(id)!;
  try {
    const res = await fetch(`${GAMMA_BASE}/markets?conditionId=${id}&limit=1`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) { _marketCache.set(id, null); return null; }
    const data = await res.json() as GammaMarket[];
    _marketCache.set(id, data[0] ?? null);
    return data[0] ?? null;
  } catch { _marketCache.set(id, null); return null; }
}

async function fetchCurrentPrice(tokenId: string): Promise<number | null> {
  try {
    const res = await fetch(`${CLOB_BASE}/price?token_id=${tokenId}&side=buy`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const d = await res.json() as { price: string };
    return Number(d.price);
  } catch { return null; }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
type Outcome = 'correct' | 'incorrect' | 'neutral' | null;
type ResolveResult = { outcome: Outcome; note: string };

function getWinner(market: GammaMarket): GammaToken | null {
  return market.tokens.find(t => t.winner) ??
    market.tokens.reduce<GammaToken | null>((best, t) =>
      !best || Number(t.price) > Number(best.price) ? t : best, null);
}

async function resolveDirectional(
  marketId: string, tokenId: string | undefined,
  predictedUp: boolean, priceAtSignal: number,
  sentAt: Date, waitHours = 24,
): Promise<ResolveResult> {
  const market = await fetchMarket(marketId);
  if (market?.closed) {
    const token = tokenId
      ? market.tokens.find(t => t.token_id === tokenId) ?? getWinner(market)
      : getWinner(market);
    if (!token) return { outcome: null, note: 'ganador indeterminado' };
    const fp = Number(token.price);
    const actuallyUp   = fp > priceAtSignal + 0.01;
    const actuallyDown = fp < priceAtSignal - 0.01;
    const outcome: Outcome = predictedUp
      ? (actuallyUp ? 'correct' : actuallyDown ? 'incorrect' : 'neutral')
      : (actuallyDown ? 'correct' : actuallyUp  ? 'incorrect' : 'neutral');
    return { outcome, note: `cerrado: ${priceAtSignal.toFixed(3)} → ${fp.toFixed(3)}` };
  }
  const ageH = (Date.now() - sentAt.getTime()) / 3_600_000;
  if (ageH < waitHours) return { outcome: null, note: `esperando ${waitHours}h (age: ${ageH.toFixed(1)}h)` };
  if (!tokenId) return { outcome: null, note: 'sin tokenId para precio actual' };
  const cp = await fetchCurrentPrice(tokenId);
  if (!cp || priceAtSignal === 0) return { outcome: 'neutral', note: 'sin precio de referencia' };
  const d = ((cp - priceAtSignal) / priceAtSignal) * 100;
  let outcome: Outcome = 'neutral';
  if (predictedUp  && d >= PRICE_MOVE_THRESHOLD_PCT)  outcome = 'correct';
  if (predictedUp  && d <= -PRICE_MOVE_THRESHOLD_PCT) outcome = 'incorrect';
  if (!predictedUp && d <= -PRICE_MOVE_THRESHOLD_PCT) outcome = 'correct';
  if (!predictedUp && d >= PRICE_MOVE_THRESHOLD_PCT)  outcome = 'incorrect';
  return { outcome, note: `${ageH.toFixed(0)}h | ${priceAtSignal.toFixed(3)}→${cp.toFixed(3)} (Δ${d.toFixed(1)}%)` };
}

// ─── Dispatcher por estrategia ────────────────────────────────────────────────
async function dispatch(
  strategyId: string, meta: Record<string, unknown>, sentAt: Date,
): Promise<ResolveResult> {
  const mid = meta.marketId as string;
  const tid = meta.tokenId  as string | undefined;

  switch (strategyId) {
    case 'whale_tracker': {
      const side = (meta.side as string ?? '').toLowerCase();
      const market = await fetchMarket(mid);
      if (!market?.closed) return { outcome: null, note: 'aún abierto' };
      const winner = getWinner(market);
      if (!winner) return { outcome: null, note: 'ganador indeterminado' };
      const wp = Number(winner.price);
      const outcome: Outcome = side === 'buy'
        ? (wp >= 0.99 ? 'correct' : 'incorrect')
        : side === 'sell'
          ? (wp < 0.01 ? 'correct' : 'incorrect')
          : 'neutral';
      return { outcome, note: `ganador: ${winner.outcome} (${wp.toFixed(3)}) | side: ${side}` };
    }

    case 'smart_money': {
      const dominant = (meta.dominant as string ?? '').toUpperCase();
      const market = await fetchMarket(mid);
      if (!market?.closed) return { outcome: null, note: 'aún abierto' };
      const winner = getWinner(market);
      if (!winner) return { outcome: null, note: 'ganador indeterminado' };
      const wp = Number(winner.price);
      const outcome: Outcome = dominant === 'BUY'
        ? (wp >= 0.99 ? 'correct' : 'incorrect')
        : dominant === 'SELL'
          ? (wp < 0.01 ? 'correct' : 'incorrect')
          : 'neutral';
      return { outcome, note: `dominante: ${dominant} | ganador: ${winner.outcome} (${wp.toFixed(3)})` };
    }

    case 'odds_mover': {
      const deltaPct = Number(meta.deltaPct ?? 0);
      const priceTo  = Number(meta.priceTo ?? meta.priceFrom ?? 0);
      return resolveDirectional(mid, tid, deltaPct > 0, priceTo, sentAt, 48);
    }

    case 'order_book': {
      const direction = meta.direction as string;
      const ref       = Number(meta.bestBid ?? meta.bestAsk ?? 0);
      return resolveDirectional(mid, tid, direction === 'bid_heavy', ref, sentAt, 24);
    }

    case 'resolution_arb': {
      const entryPrice = Number(meta.price ?? 0);
      const market = await fetchMarket(mid);
      if (tid) {
        const cp = await fetchCurrentPrice(tid);
        if (cp && cp >= 0.99) return { outcome: 'correct', note: `precio actual: ${cp.toFixed(3)}` };
      }
      if (!market?.closed) return { outcome: null, note: 'mercado aún abierto' };
      const token = tid ? market.tokens.find(t => t.token_id === tid) : getWinner(market);
      const fp = token ? Number(token.price) : null;
      if (fp === null) return { outcome: 'neutral', note: 'token no encontrado' };
      const pnl = ((fp - entryPrice) / entryPrice * 100).toFixed(2);
      return {
        outcome: fp >= 0.99 ? 'correct' : 'incorrect',
        note: `entrada: ${entryPrice.toFixed(3)} → final: ${fp.toFixed(3)} | PnL: ${pnl}%`,
      };
    }

    case 'rewards_hunter':
      return { outcome: 'neutral', note: 'rewards_hunter: no aplica resolución binaria' };

    default:
      return { outcome: null, note: `estrategia desconocida: ${strategyId}` };
  }
}

// ─── Runner principal ─────────────────────────────────────────────────────────
export async function runOutcomeResolver(options: {
  dryRun?:    boolean;
  daysBack?:  number;
  strategy?:  string;
  silent?:    boolean; // no mandar Telegram (útil para CLI)
} = {}): Promise<void> {
  const { dryRun = false, daysBack = 14, strategy, silent = false } = options;
  const db    = await getDb();
  const since = new Date(Date.now() - daysBack * 86_400_000);

  const conditions = [
    isNull(schema.signals.outcome),
    gte(schema.signals.sentAt, since),
  ];
  if (strategy) conditions.push(eq(schema.signals.strategyId, strategy));

  const pending = await db!
    .select()
    .from(schema.signals)
    .where(and(...conditions));

  logger.info(`[outcome-resolver] ${pending.length} signals pendientes (últimos ${daysBack} días)`);

  let resolved = 0, skipped = 0, errors = 0;
  const newlyResolved: Array<{
    id: number; strategyId: string; title: string;
    outcome: 'correct' | 'incorrect' | 'neutral'; note: string;
  }> = [];

  for (const signal of pending) {
    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(signal.metadata ?? '{}') as Record<string, unknown>; } catch {}

    let result: ResolveResult;
    try {
      result = await dispatch(signal.strategyId, meta, signal.sentAt ?? new Date());
    } catch (err) {
      logger.error(`[outcome-resolver] error signal #${signal.id}`, err);
      errors++;
      continue;
    }

    if (result.outcome === null) { skipped++; continue; }

    logger.info(`[outcome-resolver] #${signal.id} [${signal.strategyId}] → ${result.outcome} | ${result.note}`);

    if (!dryRun) {
      await signalQueries.resolveSignal(signal.id, result.outcome, result.note);
      newlyResolved.push({
        id:         signal.id,
        strategyId: signal.strategyId,
        title:      signal.title,
        outcome:    result.outcome,
        note:       result.note,
      });
    }
    resolved++;
  }

  _marketCache.clear();

  // ── Recolectar win rates actuales ─────────────────────────────────────────
  const winRates = await Promise.all(
    (strategy ? [strategy] : STRATEGIES.map(s => s.id)).map(async sid => {
      const wr      = await signalQueries.getWinRate(sid);
      const pending = (await signalQueries.getPending(sid)).length;
      return { strategyId: sid, ...wr, pending };
    }),
  );

  logger.info(
    `[outcome-resolver] resueltos: ${resolved} | pendientes: ${skipped} | errores: ${errors}${dryRun ? ' [DRY RUN]' : ''}`,
  );

  // ── Enviar resumen a Telegram ─────────────────────────────────────────────
  if (!silent && (resolved > 0 || errors > 0 || !dryRun)) {
    await telegram.sendOutcomeResolutionReport({
      resolved, skipped, errors, dryRun, winRates, newlyResolved,
    }).catch(err => logger.error('[outcome-resolver] telegram report failed', err));
  }
}

// ─── Scheduler ───────────────────────────────────────────────────────────────
export function scheduleOutcomeResolver(hourUTC = 3): void {
  function msUntilNextRun(): number {
    const now  = new Date();
    const next = new Date();
    next.setUTCHours(hourUTC, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next.getTime() - now.getTime();
  }

  function schedule() {
    const ms = msUntilNextRun();
    logger.info(`[outcome-resolver] próxima resolución en ${(ms / 3_600_000).toFixed(1)}h`);
    setTimeout(async () => {
      try { await runOutcomeResolver({ daysBack: 14 }); }
      catch (err) { logger.error('[outcome-resolver] error en ejecución programada', err); }
      schedule();
    }, ms);
  }

  schedule();
}