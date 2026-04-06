// telegram/commands.ts
//
// Listener de comandos de Telegram para el bot.
// Arranca en modo polling solo para recibir comandos del usuario.
//
// Comandos disponibles:
//   /current_rewards   — PnL actual de posiciones de rewards (paper + real)
//   /status            — Estado de todas las estrategias
//   /positions         — Posiciones abiertas del rewards executor
//   /help              — Lista de comandos
//
// Integrar en index.ts:
//   import { startCommandListener } from './telegram/commands';
//   startCommandListener();

import TelegramBot from 'node-telegram-bot-api';
import { getDb }   from '../db/connection';
import { positions, rewardAccruals } from '../db/schema';
import { eq, and, desc, sql } from 'drizzle-orm';
import { strategyQueries } from '../db/queries';
import { logger } from '../utils/logger';

// ─── Bot con polling para recibir comandos ────────────────────────────────────

let _commandBot: TelegramBot | null = null;

export function startCommandListener(): void {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID ?? '';

  if (!token) {
    logger.warn('[commands] TELEGRAM_BOT_TOKEN no configurado, comandos deshabilitados');
    return;
  }

  _commandBot = new TelegramBot(token, { polling: true });

  // Filtrar solo mensajes del chat autorizado
  _commandBot.on('message', async (msg) => {
    if (String(msg.chat.id) !== chatId) return;
    const text = msg.text ?? '';
    if (!text.startsWith('/')) return;

    const command = text.split(' ')[0].toLowerCase().replace(
      '@' + ((_commandBot as any).options?.username ?? ''),
      '',
    );

    logger.info(`[commands] Comando recibido: ${command}`);

    try {
      switch (command) {
        case '/current_rewards':
          await handleCurrentRewards(chatId);
          break;
        case '/positions':
          await handlePositions(chatId);
          break;
        case '/status':
          await handleStatus(chatId);
          break;
        case '/help':
          await handleHelp(chatId);
          break;
        default:
          // Ignorar comandos desconocidos silenciosamente
          break;
      }
    } catch (err) {
      logger.error(`[commands] Error procesando ${command}`, err);
      await sendCommand(chatId, `❌ Error procesando <code>${command}</code>`);
    }
  });

  _commandBot.on('polling_error', (err) => {
    logger.error('[commands] Polling error', err);
  });

  logger.info('[commands] Listener de comandos Telegram activo');
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleCurrentRewards(chatId: string): Promise<void> {
  const db = await getDb();

  // Posiciones abiertas paper
  const paperPositions = await db!
    .select()
    .from(positions)
    .where(and(eq(positions.status, 'open'), eq(positions.paperTrading, true)))
    .orderBy(desc(positions.rewardsEarnedUsdc));

  // Posiciones abiertas real
  const realPositions = await db!
    .select()
    .from(positions)
    .where(and(eq(positions.status, 'open'), eq(positions.paperTrading, false)))
    .orderBy(desc(positions.rewardsEarnedUsdc));

  const buildSection = (
    rows: typeof paperPositions,
    label: string,
    emoji: string,
  ): string => {
    if (!rows.length) return '';

    const totalRewards = rows.reduce((s, p) => s + Number(p.rewardsEarnedUsdc ?? 0), 0);
    const totalFees    = rows.reduce((s, p) => s + Number(p.feesPaidUsdc ?? 0), 0);
    const netPnl       = totalRewards - totalFees;
    const netSign      = netPnl >= 0 ? '+' : '';

    const posLines = rows.map((p, i) => {
      const rewards    = Number(p.rewardsEarnedUsdc ?? 0);
      const fees       = Number(p.feesPaidUsdc ?? 0);
      const net        = rewards - fees;
      const netS       = net >= 0 ? '+' : '';
      const inRangePct = p.samplesTotal > 0
        ? Math.round((p.samplesInRange / p.samplesTotal) * 100) : 0;
      const daysOpen   = ((Date.now() - (p.openedAt?.getTime() ?? 0)) / 86_400_000).toFixed(1);
      const question   = (p.marketQuestion ?? p.marketId).slice(0, 38);
      const bar        = buildBar(inRangePct);

      const link = `<a href="https://polymarket.com/event/${p.marketId}">${question}</a>`;

      return [
        `  <b>${i + 1}. ${link}</b>`,
        `  ${bar} ${inRangePct}% | net: <b>${netS}$${net.toFixed(4)}</b> | pool: $${Number(p.dailyRewardUsdc).toFixed(0)}/d | ${daysOpen}d`,
      ].join('\n');
    }).join('\n\n');

    return [
      `${emoji} <b>${label} — ${rows.length} posicion${rows.length !== 1 ? 'es' : ''}</b>`,
      `  Rewards:  <b>$${totalRewards.toFixed(4)}</b>`,
      `  Fees:    -$${totalFees.toFixed(4)}`,
      `  Net PnL:  <b>${netSign}$${netPnl.toFixed(4)}</b>`,
      '',
      posLines,
    ].join('\n');
  };

  const ts        = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const paperSec  = buildSection(paperPositions, 'Paper Trading', '📋');
  const realSec   = buildSection(realPositions,  'Real Trading',  '💵');
  const noData    = !paperPositions.length && !realPositions.length;

  const msg = [
    `💰 <b>Rewards — Estado actual</b>`,
    `<i>${ts}</i>`,
    '',
    noData ? '<i>Sin posiciones abiertas</i>' : [paperSec, realSec].filter(Boolean).join('\n\n'),
  ].join('\n');

  await sendCommand(chatId, msg);
}

async function handlePositions(chatId: string): Promise<void> {
  const db = await getDb();

  const allOpen = await db!
    .select()
    .from(positions)
    .where(eq(positions.status, 'open'))
    .orderBy(desc(positions.openedAt));

  if (!allOpen.length) {
    await sendCommand(chatId, '📋 Sin posiciones abiertas');
    return;
  }

  const lines = allOpen.map((p, i) => {
    const mode       = p.paperTrading ? 'PAPER' : 'REAL';
    const rewards    = Number(p.rewardsEarnedUsdc ?? 0);
    const fees       = Number(p.feesPaidUsdc ?? 0);
    const net        = rewards - fees;
    const inRangePct = p.samplesTotal > 0
      ? Math.round((p.samplesInRange / p.samplesTotal) * 100) : 0;
    const daysOpen   = ((Date.now() - (p.openedAt?.getTime() ?? 0)) / 86_400_000).toFixed(1);

    const question = (p.marketQuestion ?? '').slice(0, 40);
    const link     = `<a href="https://polymarket.com/event/${p.marketId}">${question}</a>`;

    return [
      `<b>${i + 1}. [${mode}]</b> ${link}`,
      `   net: ${net >= 0 ? '+' : ''}$${net.toFixed(4)} | rango: ${inRangePct}% | ${daysOpen}d | pool: $${Number(p.dailyRewardUsdc).toFixed(0)}/d`,
    ].join('\n');
  });

  const msg = [
    `📋 <b>Posiciones abiertas (${allOpen.length})</b>`,
    '',
    ...lines,
  ].join('\n');

  await sendCommand(chatId, msg);
}

async function handleStatus(chatId: string): Promise<void> {
  const configs = await strategyQueries.getAll();

  const lines = configs.map(c => {
    const icon   = c.enabled ? '▶' : '⏸';
    const params = JSON.parse(c.params ?? '{}');
    const interval = params.intervalSeconds ? `${params.intervalSeconds}s` : '';
    return `${icon} <code>${c.strategyId}</code> ${interval}`;
  });

  const msg = [
    `📊 <b>Estado de estrategias</b>`,
    '',
    ...lines,
  ].join('\n');

  await sendCommand(chatId, msg);
}

async function handleHelp(chatId: string): Promise<void> {
  const msg = [
    `🤖 <b>Comandos disponibles</b>`,
    '',
    `/current_rewards — PnL actual de rewards (paper + real)`,
    `/positions       — Lista de posiciones abiertas`,
    `/status          — Estado de todas las estrategias`,
    `/help            — Este mensaje`,
  ].join('\n');

  await sendCommand(chatId, msg);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function sendCommand(chatId: string, text: string): Promise<void> {
  if (!_commandBot) return;
  try {
    await _commandBot.sendMessage(chatId, text, { parse_mode: 'HTML' });
  } catch (err) {
    logger.error('[commands] Error enviando respuesta', err);
  }
}

function buildBar(pct: number, width = 6): string {
  const filled = Math.round((pct / 100) * width);
  return '█'.repeat(Math.max(0, filled)) + '░'.repeat(Math.max(0, width - filled));
}