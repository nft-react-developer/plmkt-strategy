/**
 * scripts/resolve-outcomes.ts
 *
 * Job de resolución automática de signals.
 * Consulta la Gamma API para detectar mercados resueltos y actualiza
 * el outcome de los signals pendientes en la DB.
 *
 * Lógica por estrategia:
 *  - whale_tracker   → ¿el mercado resolvió en la dirección del trade (buy/sell)?
 *  - smart_money     → ¿resolvió en la dirección dominante (BUY/SELL)?
 *  - odds_mover      → ¿el precio del token subió/bajó en la dirección del delta?
 *  - order_book      → ¿el precio se movió en la dirección del imbalance?
 *  - resolution_arb  → ¿el token ganador llegó a ≥ 0.99?
 *  - rewards_hunter  → neutral siempre (no es una predicción direccional)
 *
 * Uso:
 *   ts-node scripts/resolve-outcomes.ts
 *   ts-node scripts/resolve-outcomes.ts --dry-run      # solo muestra, no escribe
 *   ts-node scripts/resolve-outcomes.ts --days 30      # signals de los últimos N días
 *   ts-node scripts/resolve-outcomes.ts --strategy odds_mover
 */

import 'dotenv/config';
import { and, eq, gte, isNull } from 'drizzle-orm';
import { getDb, schema, closeDb } from '../db/connection';
import { signalQueries } from '../db/queries';
import { logger } from '../utils/logger';

// ─── CLI flags ────────────────────────────────────────────────────────────────
const args        = process.argv.slice(2);
const DRY_RUN     = args.includes('--dry-run');
const DAYS        = Number(args.find(a => a.startsWith('--days='))?.split('=')[1] ?? 14);
const STRATEGY    = args.find(a => a.startsWith('--strategy='))?.split('=')[1];
const GAMMA_BASE  = process.env.GAMMA_API_BASE ?? 'https://gamma-api.polymarket.com';
const CLOB_BASE   = process.env.CLOB_API_BASE  ?? 'https://clob.polymarket.com';

// Para odds_mover / order_book: cuánto tiene que moverse el precio
// desde el momento del signal para considerarlo "correcto"
const PRICE_MOVE_THRESHOLD_PCT = 3; // 3 puntos porcentuales

// ─── Tipos de la Gamma API ────────────────────────────────────────────────────
interface GammaToken {
  token_id: string;
  outcome:  string;
  price:    string;
  winner?:  boolean;
}
interface GammaMarket {
  conditionId: string;
  question:    string;
  closed:      boolean;
  resolved?:   boolean;
  tokens:      GammaToken[];
  volumeNum?:  string;
}

// ─── Cache de mercados (evita N llamadas para el mismo conditionId) ───────────
const marketCache = new Map<string, GammaMarket | null>();

async function fetchMarket(conditionId: string): Promise<GammaMarket | null> {
  if (marketCache.has(conditionId)) return marketCache.get(conditionId)!;

  try {
    const url = `${GAMMA_BASE}/markets?conditionId=${conditionId}&limit=1`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) { marketCache.set(conditionId, null); return null; }
    const data = await res.json() as GammaMarket[];
    const market = data[0] ?? null;
    marketCache.set(conditionId, market);
    return market;
  } catch {
    marketCache.set(conditionId, null);
    return null;
  }
}

async function fetchCurrentPrice(tokenId: string): Promise<number | null> {
  try {
    const res = await fetch(`${CLOB_BASE}/price?token_id=${tokenId}&side=buy`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { price: string };
    return Number(data.price);
  } catch {
    return null;
  }
}

// ─── Lógica de resolución por estrategia ──────────────────────────────────────

type Outcome = 'correct' | 'incorrect' | 'neutral' | null;
type ResolveResult = { outcome: Outcome; note: string };

async function resolveWhaleTracker(meta: Record<string, unknown>): Promise<ResolveResult> {
  const marketId = meta.marketId as string;
  const side     = (meta.side as string ?? '').toLowerCase(); // 'buy' | 'sell'

  const market = await fetchMarket(marketId);
  if (!market?.closed) return { outcome: null, note: 'mercado aún abierto' };

  // El token ganador es el que tiene winner=true, o bien el de precio más alto
  const winner = market.tokens.find(t => t.winner) ??
    market.tokens.reduce<GammaToken | null>((best, t) =>
      !best || Number(t.price) > Number(best.price) ? t : best, null);

  if (!winner) return { outcome: null, note: 'no se pudo determinar ganador' };

  // Si la whale compró (BUY) y el mercado resolvió YES (price→1): correcto
  // Si la whale vendió (SELL) y el mercado resolvió NO (price→0): correcto
  const winnerPrice = Number(winner.price);
  const marketResolvedYes = winnerPrice >= 0.99;

  let outcome: Outcome;
  if (side === 'buy')  outcome = marketResolvedYes ? 'correct' : 'incorrect';
  else if (side === 'sell') outcome = !marketResolvedYes ? 'correct' : 'incorrect';
  else outcome = 'neutral';

  return {
    outcome,
    note: `mercado cerrado — ganador: ${winner.outcome} (${winnerPrice.toFixed(3)}) | side: ${side}`,
  };
}

async function resolveSmartMoney(meta: Record<string, unknown>): Promise<ResolveResult> {
  const marketId = meta.marketId as string;
  const dominant = (meta.dominant as string ?? '').toUpperCase(); // 'BUY' | 'SELL'

  const market = await fetchMarket(marketId);
  if (!market?.closed) return { outcome: null, note: 'mercado aún abierto' };

  const winner = market.tokens.find(t => t.winner) ??
    market.tokens.reduce<GammaToken | null>((best, t) =>
      !best || Number(t.price) > Number(best.price) ? t : best, null);

  if (!winner) return { outcome: null, note: 'no se pudo determinar ganador' };

  const winnerPrice     = Number(winner.price);
  const marketResolvedYes = winnerPrice >= 0.99;

  let outcome: Outcome;
  if (dominant === 'BUY')  outcome = marketResolvedYes  ? 'correct' : 'incorrect';
  else if (dominant === 'SELL') outcome = !marketResolvedYes ? 'correct' : 'incorrect';
  else outcome = 'neutral';

  return {
    outcome,
    note: `dominante: ${dominant} | ganador: ${winner.outcome} (${winnerPrice.toFixed(3)})`,
  };
}

async function resolveOddsMover(
  meta: Record<string, unknown>,
  signalSentAt: Date,
): Promise<ResolveResult> {
  const marketId    = meta.marketId as string;
  const tokenId     = meta.tokenId  as string;
  const deltaPct    = Number(meta.deltaPct ?? 0);
  const priceAtSignal = Number(meta.priceTo ?? meta.priceFrom ?? 0);

  if (!tokenId) return { outcome: null, note: 'sin tokenId en metadata' };

  // Primero: ¿el mercado resolvió?
  const market = await fetchMarket(marketId);
  if (market?.closed) {
    const token = market.tokens.find(t => t.token_id === tokenId);
    if (token) {
      const finalPrice = Number(token.price);
      const predictedUp = deltaPct > 0;
      const actuallyUp  = finalPrice > priceAtSignal + 0.01;
      const actuallyDown = finalPrice < priceAtSignal - 0.01;
      const outcome: Outcome = predictedUp
        ? (actuallyUp   ? 'correct' : actuallyDown ? 'incorrect' : 'neutral')
        : (actuallyDown ? 'correct' : actuallyUp   ? 'incorrect' : 'neutral');
      return {
        outcome,
        note: `mercado cerrado | precio signal: ${priceAtSignal.toFixed(3)} → final: ${finalPrice.toFixed(3)} | dirección predicha: ${deltaPct > 0 ? '↑' : '↓'}`,
      };
    }
  }

  // Si no cerró, ver si el precio actual se movió suficiente en la dirección predicha
  // (ventana: máx 48h desde el signal)
  const ageHours = (Date.now() - signalSentAt.getTime()) / 3_600_000;
  if (ageHours < 1) return { outcome: null, note: 'signal muy reciente (<1h), esperando' };
  if (ageHours > 48) {
    // Signal expirado sin mercado cerrado — marcar neutral si no hubo movimiento claro
    const currentPrice = await fetchCurrentPrice(tokenId);
    if (!currentPrice) return { outcome: 'neutral', note: 'signal expirado (>48h), sin datos de precio' };
    const actualDeltaPct = ((currentPrice - priceAtSignal) / priceAtSignal) * 100;
    const predictedUp    = deltaPct > 0;
    let outcome: Outcome = 'neutral';
    if (predictedUp && actualDeltaPct >= PRICE_MOVE_THRESHOLD_PCT)  outcome = 'correct';
    if (predictedUp && actualDeltaPct <= -PRICE_MOVE_THRESHOLD_PCT) outcome = 'incorrect';
    if (!predictedUp && actualDeltaPct <= -PRICE_MOVE_THRESHOLD_PCT) outcome = 'correct';
    if (!predictedUp && actualDeltaPct >= PRICE_MOVE_THRESHOLD_PCT)  outcome = 'incorrect';
    return {
      outcome,
      note: `>48h | precio signal: ${priceAtSignal.toFixed(3)} → actual: ${currentPrice.toFixed(3)} (Δ${actualDeltaPct.toFixed(1)}%)`,
    };
  }

  return { outcome: null, note: `mercado abierto, age: ${ageHours.toFixed(1)}h — esperando cierre` };
}

async function resolveOrderBook(
  meta: Record<string, unknown>,
  signalSentAt: Date,
): Promise<ResolveResult> {
  const marketId       = meta.marketId  as string;
  const tokenId        = meta.tokenId   as string;
  const direction      = meta.direction as string; // 'bid_heavy' | 'ask_heavy'
  const priceAtSignal  = Number(meta.bestBid ?? meta.bestAsk ?? 0);

  // bid_heavy → predicción alcista (precio debería subir)
  // ask_heavy → predicción bajista (precio debería bajar)
  const predictedUp = direction === 'bid_heavy';

  const market = await fetchMarket(marketId);
  if (market?.closed) {
    const token = market.tokens.find(t => t.token_id === tokenId);
    if (token) {
      const finalPrice  = Number(token.price);
      const actuallyUp  = finalPrice > priceAtSignal + 0.01;
      const actuallyDown = finalPrice < priceAtSignal - 0.01;
      const outcome: Outcome = predictedUp
        ? (actuallyUp    ? 'correct' : actuallyDown ? 'incorrect' : 'neutral')
        : (actuallyDown  ? 'correct' : actuallyUp   ? 'incorrect' : 'neutral');
      return {
        outcome,
        note: `cerrado | precio signal: ${priceAtSignal.toFixed(3)} → final: ${finalPrice.toFixed(3)} | ${direction}`,
      };
    }
  }

  // Si no cerró: evaluar después de 24h con precio actual
  const ageHours = (Date.now() - signalSentAt.getTime()) / 3_600_000;
  if (ageHours < 1) return { outcome: null, note: 'signal muy reciente' };
  if (ageHours < 24) return { outcome: null, note: `esperando 24h (age: ${ageHours.toFixed(1)}h)` };

  const currentPrice = await fetchCurrentPrice(tokenId);
  if (!currentPrice || priceAtSignal === 0) {
    return { outcome: 'neutral', note: 'sin precio de referencia' };
  }

  const actualDeltaPct = ((currentPrice - priceAtSignal) / priceAtSignal) * 100;
  let outcome: Outcome = 'neutral';
  if (predictedUp && actualDeltaPct >= PRICE_MOVE_THRESHOLD_PCT)   outcome = 'correct';
  if (predictedUp && actualDeltaPct <= -PRICE_MOVE_THRESHOLD_PCT)  outcome = 'incorrect';
  if (!predictedUp && actualDeltaPct <= -PRICE_MOVE_THRESHOLD_PCT) outcome = 'correct';
  if (!predictedUp && actualDeltaPct >= PRICE_MOVE_THRESHOLD_PCT)  outcome = 'incorrect';

  return {
    outcome,
    note: `24h+ | precio signal: ${priceAtSignal.toFixed(3)} → actual: ${currentPrice.toFixed(3)} (Δ${actualDeltaPct.toFixed(1)}%) | ${direction}`,
  };
}

async function resolveResolutionArb(meta: Record<string, unknown>): Promise<ResolveResult> {
  const marketId = meta.marketId as string;
  const tokenId  = meta.tokenId  as string;
  const entryPrice = Number(meta.price ?? 0);

  const market = await fetchMarket(marketId);
  if (!market?.closed) {
    // Incluso si no cerró, chequear precio actual
    if (tokenId) {
      const currentPrice = await fetchCurrentPrice(tokenId);
      if (currentPrice && currentPrice >= 0.99) {
        return { outcome: 'correct', note: `token llegó a ${currentPrice.toFixed(3)} (mercado aún sin cerrar oficialmente)` };
      }
    }
    return { outcome: null, note: 'mercado aún abierto y precio < 0.99' };
  }

  const token = market.tokens.find(t => t.token_id === tokenId);
  const finalPrice = token ? Number(token.price) : null;

  if (finalPrice === null) return { outcome: 'neutral', note: 'token no encontrado en mercado cerrado' };

  // Correcto si el token subió hasta cerca de 1 (redención completa)
  const outcome: Outcome = finalPrice >= 0.99 ? 'correct' : 'incorrect';
  const pnl = finalPrice >= 0.99
    ? ((1 / entryPrice - 1) * 100).toFixed(2)
    : (((finalPrice - entryPrice) / entryPrice) * 100).toFixed(2);

  return {
    outcome,
    note: `entrada: ${entryPrice.toFixed(3)} → final: ${finalPrice.toFixed(3)} | PnL real: ${pnl}%`,
  };
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

async function resolveSignal(
  strategyId: string,
  meta: Record<string, unknown>,
  sentAt: Date,
): Promise<ResolveResult> {
  switch (strategyId) {
    case 'whale_tracker':   return resolveWhaleTracker(meta);
    case 'smart_money':     return resolveSmartMoney(meta);
    case 'odds_mover':      return resolveOddsMover(meta, sentAt);
    case 'order_book':      return resolveOrderBook(meta, sentAt);
    case 'resolution_arb':  return resolveResolutionArb(meta);
    case 'rewards_hunter':  return { outcome: 'neutral', note: 'rewards_hunter: no aplica resolución binaria' };
    default:                return { outcome: null, note: `estrategia desconocida: ${strategyId}` };
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔍 resolve-outcomes — ${new Date().toISOString()}`);
  console.log(`   DRY_RUN: ${DRY_RUN} | DAYS: ${DAYS} | STRATEGY: ${STRATEGY ?? 'all'}\n`);

  const db    = await getDb();
  const since = new Date(Date.now() - DAYS * 86_400_000);

  // Obtener todos los signals pendientes dentro de la ventana
  const conditions = [
    isNull(schema.signals.outcome),
    gte(schema.signals.sentAt, since),
  ];
  if (STRATEGY) conditions.push(eq(schema.signals.strategyId, STRATEGY));

  const pending = await db!
    .select()
    .from(schema.signals)
    .where(and(...conditions))
    .orderBy(schema.signals.sentAt);

  console.log(`📋 Signals pendientes: ${pending.length}\n`);

  const stats = { resolved: 0, skipped: 0, errors: 0 };

  for (const signal of pending) {
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(signal.metadata ?? '{}') as Record<string, unknown>;
    } catch {}

    let result: ResolveResult;
    try {
      result = await resolveSignal(
        signal.strategyId,
        meta,
        signal.sentAt ?? new Date(),
      );
    } catch (err) {
      logger.error(`[resolve] error en signal #${signal.id}`, err);
      stats.errors++;
      continue;
    }

    const ageH = ((Date.now() - (signal.sentAt?.getTime() ?? 0)) / 3_600_000).toFixed(1);
    const icon  = result.outcome === 'correct'   ? '✅'
                : result.outcome === 'incorrect' ? '❌'
                : result.outcome === 'neutral'   ? '⚪'
                : '⏳';

    console.log(`  ${icon} #${signal.id} [${signal.strategyId}] (${ageH}h) ${result.outcome ?? 'skip'}`);
    console.log(`     ${signal.title.slice(0, 70)}`);
    console.log(`     ${result.note}\n`);

    if (result.outcome === null) {
      stats.skipped++;
      continue;
    }

    if (!DRY_RUN) {
      await signalQueries.resolveSignal(signal.id, result.outcome, result.note);
    }
    stats.resolved++;
  }

  console.log('─'.repeat(60));
  console.log(`✅ Resueltos: ${stats.resolved}  ⏳ Pendientes: ${stats.skipped}  ❌ Errores: ${stats.errors}`);
  if (DRY_RUN) console.log('\n⚠️  DRY RUN — no se escribió nada en la DB');

  // Win rate actual por estrategia
  console.log('\n📊 Win rate actual (signals resueltos):\n');
  const strategies = ['whale_tracker', 'smart_money', 'odds_mover', 'order_book', 'resolution_arb'];
  for (const sid of (STRATEGY ? [STRATEGY] : strategies)) {
    const wr = await signalQueries.getWinRate(sid);
    const pct = wr.winRatePct !== null ? `${wr.winRatePct.toFixed(1)}%` : 'N/A';
    console.log(`  ${sid.padEnd(20)} ${pct.padStart(6)}  (${wr.correct}✅ / ${wr.incorrect}❌ / ${wr.neutral}⚪ pending: ${wr.resolved} resueltos)`);
  }
  console.log('');

  await closeDb();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});