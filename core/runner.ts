import { STRATEGIES } from '../strategies/registry';
import { strategyQueries, runLogQueries, signalQueries, dailyStatsQueries } from '../db/queries';
import { telegram } from '../telegram/notifier';
import { logger } from '../utils/logger';
import { Signal } from './strategy.interface';
import { runWalletSync } from './auto-sync-wallet';

interface ActiveTimer {
  strategyId: string;
  timer:      ReturnType<typeof setInterval>;
}

const activeTimers: Map<string, ActiveTimer> = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// BOOT: registra estrategias en DB y arranca las habilitadas
// ─────────────────────────────────────────────────────────────────────────────

export async function startRunner() {
  logger.info(`🚀 Strategy runner starting — ${STRATEGIES.length} strategies registered`);

  for (const strategy of STRATEGIES) {
    // Crea fila en DB si no existe (nunca sobreescribe params existentes)
    await strategyQueries.ensureExists(strategy.id, strategy.name, strategy.defaultParams);

    const config = await strategyQueries.getById(strategy.id);
    if (!config) continue;

    const params = mergeParams(strategy.defaultParams, config.params);

    if (!config.enabled) {
      logger.info(`⏸  [${strategy.id}] disabled, skipping`);
      continue;
    }

    if (strategy.init) {
      try {
        await strategy.init(params);
      } catch (err) {
        logger.error(`[${strategy.id}] init failed`, err);
      }
    }

    scheduleStrategy(strategy.id, params);

}

  scheduleWalletSync();
  scheduleDailyReport();
  logger.info('✅ Runner started');
}

export async function stopRunner() {
  for (const { timer } of activeTimers.values()) clearInterval(timer);
  activeTimers.clear();

  for (const strategy of STRATEGIES) {
    if (strategy.teardown) {
      try { await strategy.teardown(); } catch {}
    }
  }
  logger.info('🛑 Runner stopped');
}

// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULING
// ─────────────────────────────────────────────────────────────────────────────

function scheduleStrategy(strategyId: string, params: Record<string, unknown>) {
  const intervalSec = (params.intervalSeconds as number | undefined) ?? 60;
  const strategy = STRATEGIES.find(s => s.id === strategyId);
  if (!strategy) return;

  // Ejecutar inmediatamente y luego cada intervalSec
  runStrategy(strategy.id, params);

  const timer = setInterval(() => runStrategy(strategy.id, params), intervalSec * 1000);
  activeTimers.set(strategyId, { strategyId, timer });

  logger.info(`⏱  [${strategyId}] scheduled every ${intervalSec}s`);
}

async function runStrategy(strategyId: string, params: Record<string, unknown>) {
  const strategy = STRATEGIES.find(s => s.id === strategyId);
  if (!strategy) return;

  const t0 = Date.now();
  let result: { signals: Signal[]; metrics?: Record<string, number> } = { signals: [] };
  let error: string | undefined;

  try {
    // Re-check si sigue habilitada (puede haberse deshabilitado en runtime)
    const config = await strategyQueries.getById(strategyId);
    if (!config?.enabled) {
      logger.info(`[${strategyId}] disabled at runtime, skipping tick`);
      return;
    }

    // Mergear params frescos (por si se actualizaron en DB)
    const freshParams = mergeParams(strategy.defaultParams, config.params);
    result = await strategy.run(freshParams);

  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logger.error(`[${strategyId}] run error: ${error}`);
  }

  const durationMs = Date.now() - t0;

  // Persistir en run log
  await runLogQueries.insert({
    strategyId,
    durationMs,
    signalCount: result.signals.length,
    error,
    metrics: result.metrics,
  }).catch(e => logger.error('runLog insert failed', e));

  // Persistir y notificar signals
  for (const signal of result.signals) {
    await handleSignal(signal);
  }
}

function scheduleWalletSync(intervalHours = 8) {
  const intervalMs = (Number(process.env.WALLET_SYNC_INTERVAL_HOURS) || intervalHours) * 3_600_000;

  // Correr inmediatamente al arrancar (en background, no bloquea)
  runWalletSync().catch(err => logger.error('wallet-sync initial run failed', err));

  // Luego cada N horas
  setInterval(() => {
    runWalletSync().catch(err => logger.error('wallet-sync scheduled run failed', err));
  }, intervalMs);

  logger.info(`[wallet-sync] scheduled every ${intervalHours}h`);
}

// ─────────────────────────────────────────────────────────────────────────────
// SIGNAL HANDLING
// ─────────────────────────────────────────────────────────────────────────────

async function handleSignal(signal: Signal) {
  // Guardar en DB
  await signalQueries.insert({
    strategyId: signal.strategyId,
    severity:   signal.severity,
    title:      signal.title,
    body:       signal.body,
    metadata:   signal.metadata,
  }).catch(e => logger.error('signal insert failed', e));

  // Enviar a Telegram
  await telegram.sendSignal(signal);
}

// ─────────────────────────────────────────────────────────────────────────────
// DAILY REPORT (00:00 UTC)
// ─────────────────────────────────────────────────────────────────────────────

function scheduleDailyReport() {
  const now = new Date();
  const nextMidnight = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1,
  ));
  const msUntilMidnight = nextMidnight.getTime() - Date.now();

  setTimeout(async () => {
    await runDailyReport();
    setInterval(runDailyReport, 24 * 3_600_000);
  }, msUntilMidnight);

  logger.info(`📅 Daily report in ${Math.round(msUntilMidnight / 60_000)} min`);
}

async function runDailyReport() {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const since = new Date(Date.now() - 86_400_000);

  const summaries: Array<{
    strategyId:  string;
    name:        string;
    winRatePct:  number | null;
    totalSignals: number;
    pending:     number;
  }> = [];

  for (const strategy of STRATEGIES) {
    const wr     = await signalQueries.getWinRate(strategy.id, since);
    const runSum = await runLogQueries.getSummary(strategy.id, 24);

    const entry = {
      strategyId:   strategy.id,
      name:         strategy.name,
      winRatePct:   wr.winRatePct,
      totalSignals: wr.correct + wr.incorrect + wr.neutral + wr.resolved,
      pending:      0,
    };
    summaries.push(entry);

    // Persistir stats diarias
    await dailyStatsQueries.upsert({
      strategyId:       strategy.id,
      date:             yesterday,
      totalRuns:        Number(runSum?.totalRuns ?? 0),
      totalSignals:     wr.correct + wr.incorrect + wr.neutral,
      signalsCorrect:   wr.correct,
      signalsIncorrect: wr.incorrect,
      signalsNeutral:   wr.neutral,
      signalsPending:   0,
      winRatePct:       wr.winRatePct,
      avgDurationMs:    runSum?.avgDurMs ? Math.round(Number(runSum.avgDurMs)) : null,
      errorCount:       Number(runSum?.errors ?? 0),
    }).catch(e => logger.error('dailyStats upsert failed', e));
  }

  await telegram.sendDailyStrategyReport(summaries);
}

// ─────────────────────────────────────────────────────────────────────────────
// RUNTIME CONTROL (para usarlo desde CLI o futuro HTTP endpoint)
// ─────────────────────────────────────────────────────────────────────────────

export async function enableStrategy(strategyId: string) {
  await strategyQueries.setEnabled(strategyId, true);
  const config = await strategyQueries.getById(strategyId);
  const strategy = STRATEGIES.find(s => s.id === strategyId);
  if (!strategy || !config) return;

  // Si ya tiene timer activo, no hacer nada
  if (activeTimers.has(strategyId)) return;

  const params = mergeParams(strategy.defaultParams, config.params);
  if (strategy.init) await strategy.init(params);
  scheduleStrategy(strategyId, params);
  logger.info(`▶️  [${strategyId}] enabled`);
}

export async function disableStrategy(strategyId: string) {
  await strategyQueries.setEnabled(strategyId, false);
  const entry = activeTimers.get(strategyId);
  if (entry) {
    clearInterval(entry.timer);
    activeTimers.delete(strategyId);
  }
  logger.info(`⏸  [${strategyId}] disabled`);
}

export function getActiveStrategies() {
  return [...activeTimers.keys()];
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function mergeParams(
  defaults: Record<string, unknown>,
  dbParamsJson: string,
): Record<string, unknown> {
  try {
    const dbParams = JSON.parse(dbParamsJson ?? '{}');
    return { ...defaults, ...dbParams };
  } catch {
    return { ...defaults };
  }
}