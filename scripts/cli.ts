/**
 * scripts/cli.ts
 *
 * CLI de administración del bot. No necesita que el bot esté corriendo.
 * Opera directamente contra la DB.
 *
 * Uso:
 *   npm run cli -- status
 *   npm run cli -- enable whale_tracker
 *   npm run cli -- disable odds_mover
 *   npm run cli -- set-param odds_mover minDeltaPct 5.0
 *   npm run cli -- win-rates
 *   npm run cli -- win-rates --days 7
 *   npm run cli -- signals whale_tracker --limit 10
 *   npm run cli -- resolve <signal_id> correct
 *   npm run cli -- resolve <signal_id> incorrect
 *   npm run cli -- wallets --top 20
 */

import 'dotenv/config';
import { strategyQueries, signalQueries, walletQueries, dailyStatsQueries, runLogQueries } from '../db/queries';
import { STRATEGIES } from '../strategies/registry';
import { testConnection, closeDb } from '../db/connection';
import { logger } from '../utils/logger';

const [,, command, ...rest] = process.argv;

async function main() {
  const ok = await testConnection();
  if (!ok) { console.error('❌ DB connection failed'); process.exit(1); }

  switch (command) {

    // ── status ────────────────────────────────────────────────────────────
    case 'status': {
      const configs = await strategyQueries.getAll();
      console.log('\n📋 Strategy status\n');
      console.log('─'.repeat(70));
      for (const c of configs) {
        const params = JSON.parse(c.params ?? '{}');
        const status = c.enabled ? '▶  enabled ' : '⏸  disabled';
        const interval = params.intervalSeconds ? `every ${params.intervalSeconds}s` : '';
        console.log(`${status}  ${c.strategyId.padEnd(20)} ${c.name.padEnd(28)} ${interval}`);
      }
      // Estrategias registradas en código pero no en DB aún
      const inDb = new Set(configs.map(c => c.strategyId));
      const notInDb = STRATEGIES.filter(s => !inDb.has(s.id));
      if (notInDb.length) {
        console.log('\n⚠️  Registered but not yet in DB (run bot once to initialize):');
        notInDb.forEach(s => console.log(`   ${s.id}`));
      }
      console.log('─'.repeat(70) + '\n');
      break;
    }

    // ── enable / disable ──────────────────────────────────────────────────
    case 'enable':
    case 'disable': {
      const strategyId = rest[0];
      if (!strategyId) { console.error('Usage: cli enable|disable <strategy_id>'); break; }
      const enabled = command === 'enable';
      await strategyQueries.setEnabled(strategyId, enabled);
      console.log(`${enabled ? '▶' : '⏸'}  ${strategyId} ${enabled ? 'enabled' : 'disabled'}`);
      break;
    }

    // ── set-param ─────────────────────────────────────────────────────────
    case 'set-param': {
      const [strategyId, key, rawValue] = rest;
      if (!strategyId || !key || rawValue === undefined) {
        console.error('Usage: cli set-param <strategy_id> <key> <value>');
        break;
      }
      // Intentar parsear como número / boolean, si no, dejar string
      let value: unknown = rawValue;
      if (!isNaN(Number(rawValue)))     value = Number(rawValue);
      if (rawValue === 'true')          value = true;
      if (rawValue === 'false')         value = false;

      await strategyQueries.mergeParams(strategyId, { [key]: value });
      console.log(`✅ ${strategyId}.${key} = ${JSON.stringify(value)}`);
      break;
    }

    // ── win-rates ─────────────────────────────────────────────────────────
    case 'win-rates': {
      const days = Number(getFlag(rest, '--days') ?? 30);
      const since = days > 0 ? new Date(Date.now() - days * 86_400_000) : undefined;

      console.log(`\n📊 Win rates${since ? ` (last ${days} days)` : ' (all time)'}\n`);
      console.log('─'.repeat(72));
      console.log('Strategy             Correct  Incorrect  Neutral  Win rate  Pending');
      console.log('─'.repeat(72));

      for (const s of STRATEGIES) {
        const wr = await signalQueries.getWinRate(s.id, since);
        const pending = (await signalQueries.getPending(s.id)).length;
        const winRate = wr.winRatePct !== null ? `${wr.winRatePct.toFixed(1)}%` : '  N/A  ';
        console.log(
          `${s.id.padEnd(20)} ${String(wr.correct).padStart(7)}  ${String(wr.incorrect).padStart(9)}  ${String(wr.neutral).padStart(7)}  ${winRate.padStart(8)}  ${String(pending).padStart(7)}`,
        );
      }
      console.log('─'.repeat(72) + '\n');
      break;
    }

    // ── daily-stats ───────────────────────────────────────────────────────
    case 'daily-stats': {
      const strategyId = rest[0];
      const days = Number(getFlag(rest, '--days') ?? 7);

      if (strategyId) {
        const rows = await dailyStatsQueries.getForStrategy(strategyId, days);
        console.log(`\n📅 ${strategyId} — last ${days} days\n`);
        console.log('Date        Runs  Signals  Correct  Incorrect  Win rate  Errors');
        console.log('─'.repeat(65));
        for (const r of rows) {
          const wr = r.winRatePct ? `${Number(r.winRatePct).toFixed(1)}%` : ' N/A';
          console.log(
            `${r.date}  ${String(r.totalRuns).padStart(4)}  ${String(r.totalSignals).padStart(7)}  ${String(r.signalsCorrect).padStart(7)}  ${String(r.signalsIncorrect).padStart(9)}  ${wr.padStart(8)}  ${String(r.errorCount).padStart(6)}`,
          );
        }
      } else {
        const rows = await dailyStatsQueries.getLatestAll();
        // Agrupar por fecha más reciente por estrategia
        const seen = new Set<string>();
        const latest = rows.filter(r => {
          if (seen.has(r.strategyId)) return false;
          seen.add(r.strategyId);
          return true;
        });
        console.log('\n📅 Latest daily stats per strategy\n');
        for (const r of latest) {
          const wr = r.winRatePct ? `${Number(r.winRatePct).toFixed(1)}%` : 'N/A';
          console.log(`  ${r.strategyId.padEnd(22)} ${r.date}  signals: ${r.totalSignals}  win: ${wr}`);
        }
      }
      console.log('');
      break;
    }

    // ── signals ───────────────────────────────────────────────────────────
    case 'signals': {
      const strategyId = rest[0];
      const limit = Number(getFlag(rest, '--limit') ?? 10);
      const onlyPending = rest.includes('--pending');

      let rows;
      if (onlyPending) {
        rows = await signalQueries.getPending(strategyId);
        rows = rows.slice(0, limit);
      } else {
        rows = await signalQueries.getRecent(strategyId ?? 'whale_tracker', limit);
      }

      console.log(`\n📡 ${onlyPending ? 'Pending' : 'Recent'} signals${strategyId ? ` [${strategyId}]` : ''}\n`);
      for (const r of rows) {
        const outcome = r.outcome ? ` → ${r.outcome}` : ' → pending';
        const sev     = ({ low: '🔵', medium: '🟡', high: '🔴' } as Record<string, string>)[r.severity] ?? '⚪';
        console.log(`  #${r.id} ${sev} [${r.strategyId}]${outcome}`);
        console.log(`     ${r.title}`);
        console.log(`     ${r.sentAt?.toISOString().slice(0, 16)}\n`);
      }
      break;
    }

    // ── resolve ───────────────────────────────────────────────────────────
    case 'resolve': {
      const [idStr, outcome, note] = rest;
      const id = Number(idStr);
      if (!id || !['correct', 'incorrect', 'neutral'].includes(outcome)) {
        console.error('Usage: cli resolve <signal_id> correct|incorrect|neutral [note]');
        break;
      }
      await signalQueries.resolveSignal(id, outcome as 'correct' | 'incorrect' | 'neutral', note);
      console.log(`✅ Signal #${id} resolved as ${outcome}`);
      break;
    }

    // ── wallets ───────────────────────────────────────────────────────────
    case 'wallets': {
      const top = Number(getFlag(rest, '--top') ?? 20);
      const wallets = await walletQueries.getTopByScore(top);
      console.log(`\n🐋 Top ${top} wallets by smart score\n`);
      console.log('Address                                    Score    Win rate  Trades  Volume');
      console.log('─'.repeat(80));
      for (const w of wallets) {
        const addr = `${w.address.slice(0, 10)}…${w.address.slice(-6)}`;
        const wr   = w.winRatePct ? `${Number(w.winRatePct).toFixed(1)}%` : 'N/A';
        const sc   = Number(w.smartScore ?? 0).toFixed(2);
        const vol  = `$${Number(w.totalVolume).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
        console.log(`  ${addr.padEnd(22)} ${sc.padStart(8)}  ${wr.padStart(8)}  ${String(w.totalTrades).padStart(6)}  ${vol.padStart(8)}`);
      }
      console.log('─'.repeat(80) + '\n');
      break;
    }

    // ── run-log ───────────────────────────────────────────────────────────
    case 'run-log': {
      const strategyId = rest[0];
      if (!strategyId) { console.error('Usage: cli run-log <strategy_id>'); break; }
      const rows = await runLogQueries.getRecent(strategyId, 20);
      console.log(`\n⏱  Last 20 runs: ${strategyId}\n`);
      for (const r of rows) {
        const err    = r.error ? ` ❌ ${r.error.slice(0, 60)}` : '';
        const dur    = r.durationMs ? `${r.durationMs}ms` : '?ms';
        const sigs   = `${r.signalCount} signal${r.signalCount !== 1 ? 's' : ''}`;
        const ts     = r.ranAt?.toISOString().slice(0, 16) ?? '';
        console.log(`  ${ts}  ${dur.padStart(7)}  ${sigs.padStart(10)}${err}`);
      }
      console.log('');
      break;
    }

    default:
      console.log(`
Polymarket Bot CLI

Commands:
  status                              — estado de todas las estrategias
  enable   <strategy_id>             — habilitar estrategia
  disable  <strategy_id>             — deshabilitar estrategia
  set-param <id> <key> <value>       — modificar parámetro (se aplica en próximo tick)
  win-rates [--days N]               — % acierto por estrategia
  daily-stats [strategy_id] [--days N]
  signals  <strategy_id> [--limit N] [--pending]
  resolve  <signal_id> correct|incorrect|neutral [note]
  wallets  [--top N]                 — top wallets por smart score
  run-log  <strategy_id>             — últimas ejecuciones

IDs de estrategias: whale_tracker | smart_money | odds_mover | order_book
`);
  }

  await closeDb();
}

function getFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
}

main().catch(err => {
  logger.error('CLI error', err);
  process.exit(1);
});