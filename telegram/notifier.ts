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
    logger.debug('Telegram not configured, skipping');
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
};