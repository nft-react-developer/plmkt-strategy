import * as dotenv from 'dotenv';
dotenv.config();
import TelegramBot from 'node-telegram-bot-api';
import { Signal } from '../core/strategy.interface';
import { logger } from '../utils/logger';

let bot: TelegramBot | null = null;
const chatId = process.env.TELEGRAM_CHAT_ID ?? '';

function getBot(): TelegramBot | null {
  if (!process.env.TELEGRAM_BOT_TOKEN) return null;
  if (!bot) bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
  return bot;
}

async function send(message: string): Promise<void> {
  const b = getBot();
  if (!b || !chatId) {
    logger.info('Telegram not configured, skipping');
    return;
  }
  try {
    await b.sendMessage(chatId, message, { parse_mode: 'HTML' });
  } catch (err) {
    logger.error('Telegram send failed', err);
  }
}

const SEVERITY_EMOJI: Record<string, string> = {
  low:    '🔵',
  medium: '🟡',
  high:   '🔴',
};

export const telegram = {

  async sendSignal(signal: Signal) {
    const emoji = SEVERITY_EMOJI[signal.severity] ?? '⚪';
    const msg = `
${emoji} <b>${signal.title}</b>
<i>[${signal.strategyId}]</i>

${signal.body}
`.trim();
    await send(msg);
  },

  async sendDailyStrategyReport(summaries: Array<{
    strategyId:   string;
    name:         string;
    winRatePct:   number | null;
    totalSignals: number;
    pending:      number;
  }>) {
    const date = new Date().toISOString().slice(0, 10);
    const lines = summaries.map(s => {
      const wr = s.winRatePct !== null ? `${s.winRatePct.toFixed(1)}%` : 'N/A';
      return `• <b>${s.name}</b>: ${wr} acierto — ${s.totalSignals} signals`;
    }).join('\n');

    const msg = `
📊 <b>Daily Strategy Report</b>
📅 ${date}

${lines}

<i>Signals pendientes de resolución no incluidos en win rate.</i>
`.trim();
    await send(msg);
  },

  async sendStartup(activeStrategies: string[]) {
    const list = activeStrategies.map(s => `  • ${s}`).join('\n');
    const msg = `
🟢 <b>Polymarket Bot started</b>

<b>Estrategias activas:</b>
${list}
`.trim();
    await send(msg);
  },

  async sendError(context: string, err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await send(`❌ <b>Error</b> [${context}]\n<code>${message}</code>`);
  },

  async sendRaw(message: string) {
    await send(message);
  },

  /**
 * Añadir estos métodos al objeto `telegram` en telegram/notifier.ts
 *
 * ─── PEGAR dentro del objeto `telegram = { ... }` ────────────────────────────
 */

  /**
   * Resumen del job de resolución automática de outcomes.
   * Se llama desde core/outcome-resolver.ts al terminar cada ejecución nocturna.
   */
  async sendOutcomeResolutionReport(report: {
    resolved:  number;
    skipped:   number;
    errors:    number;
    dryRun:    boolean;
    winRates:  Array<{
      strategyId:   string;
      correct:      number;
      incorrect:    number;
      neutral:      number;
      pending:      number;
      winRatePct:   number | null;
    }>;
    newlyResolved: Array<{
      id:         number;
      strategyId: string;
      title:      string;
      outcome:    'correct' | 'incorrect' | 'neutral';
      note:       string;
    }>;
  }) {
    const date     = new Date().toISOString().slice(0, 10);
    const dryLabel = report.dryRun ? ' <i>[DRY RUN]</i>' : '';

    // Resumen numérico
    const header = [
      `🔍 <b>Outcome Resolution Report</b>${dryLabel}`,
      `📅 ${date}`,
      '',
      `✅ Resueltos: <b>${report.resolved}</b>  ⏳ Pendientes: <b>${report.skipped}</b>  ❌ Errores: <b>${report.errors}</b>`,
    ].join('\n');

    // Win rate por estrategia
    const winRateLines = report.winRates.map(wr => {
      const pct   = wr.winRatePct !== null ? `${wr.winRatePct.toFixed(1)}%` : 'N/A';
      const bar   = buildMiniBar(wr.winRatePct);
      const total = wr.correct + wr.incorrect + wr.neutral;
      return `• <b>${wr.strategyId}</b>: ${bar} ${pct}  <i>(${total} resueltos, ${wr.pending} pend.)</i>`;
    }).join('\n');

    const winRateSection = [
      '',
      '📊 <b>Win Rate acumulado</b>',
      winRateLines || '<i>Sin datos aún</i>',
    ].join('\n');

    // Últimas resoluciones (máx 5 para no saturar)
    let newlySection = '';
    if (report.newlyResolved.length > 0) {
      const items = report.newlyResolved.slice(0, 5).map(r => {
        const icon = r.outcome === 'correct' ? '✅' : r.outcome === 'incorrect' ? '❌' : '⚪';
        return `${icon} <i>[${r.strategyId}]</i> ${r.title.slice(0, 50)}`;
      });
      if (report.newlyResolved.length > 5) {
        items.push(`<i>... y ${report.newlyResolved.length - 5} más</i>`);
      }
      newlySection = ['', '🆕 <b>Recién resueltos</b>', ...items].join('\n');
    }

    await send([header, winRateSection, newlySection].filter(Boolean).join('\n'));
  },

  /**
   * Resumen on-demand del track record (se puede llamar desde CLI o bot command).
   * Útil para pedir un update en cualquier momento sin esperar el reporte nocturno.
   */
  async sendWinRateSummary(winRates: Array<{
    strategyId:  string;
    correct:     number;
    incorrect:   number;
    neutral:     number;
    pending:     number;
    winRatePct:  number | null;
  }>) {
    const date  = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const lines = winRates.map(wr => {
      const pct  = wr.winRatePct !== null ? `${wr.winRatePct.toFixed(1)}%` : 'N/A';
      const bar  = buildMiniBar(wr.winRatePct);
      const tot  = wr.correct + wr.incorrect + wr.neutral;
      return [
        `<b>${wr.strategyId}</b>`,
        `  ${bar} ${pct}  (✅${wr.correct} ❌${wr.incorrect} ⚪${wr.neutral} | pend: ${wr.pending})`,
      ].join('\n');
    });

    const msg = [
      `📊 <b>Track Record</b>  <i>${date}</i>`,
      '',
      lines.join('\n\n'),
    ].join('\n');

    await send(msg);
  },
};

// ─── Helper (fuera del objeto, añadir al final del archivo) ──────────────────

/**
 * Barra visual de win rate: ████░░░░ 62%
 */
function buildMiniBar(pct: number | null, width = 8): string {
  if (pct === null) return '░'.repeat(width);
  const filled = Math.round((pct / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}
  
