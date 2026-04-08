// telegram/commands.ts
//
// Listener de comandos de Telegram para el bot.
// Arranca en modo polling solo para recibir comandos del usuario.
//
// Comandos disponibles:
//   /current_rewards   — PnL actual de posiciones de rewards (paper + real)
//   /status            — Estado de todas las estrategias
//   /positions         — Posiciones abiertas del rewards executor
//   /pause [id]        — Pausa una estrategia (o todas si no se especifica)
//   /resume [id]       — Reactiva una estrategia (o todas si no se especifica)
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

const CLOB_BASE = process.env.CLOB_API_BASE ?? 'https://clob.polymarket.com';
const FUNDER    = process.env.POLY_FUNDER;


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

    const command = text.split(' ')[0].toLowerCase().replace('@' + ((_commandBot as any).options?.username ?? ''), '');

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
        case '/pause':
          await handlePauseResume(chatId, text, false);
          break;
        case '/resume':
          await handlePauseResume(chatId, text, true);
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

// ─── Tipos de las APIs de validación ──────────────────────────────────────────

interface PolyEarning {
  asset_address: string;   // condition_id del mercado
  amount: string;          // USDC ganado ese día
}

interface PolyPctEntry {
  condition_id: string;
  percentage:   number;    // tu % real del pool ahora mismo (0-1)
  rate_per_day: number;    // rate del mercado en este momento
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleCurrentRewards(chatId: string): Promise<void> {
  const db = await getDb();

  // ── 1. Datos de DB (igual que antes) ───────────────────────────────────────
  const paperPositions = await db
    .select()
    .from(positions)
    .where(and(eq(positions.status, 'open'), eq(positions.paperTrading, true)))
    .orderBy(desc(positions.rewardsEarnedUsdc));

  const realPositions = await db
    .select()
    .from(positions)
    .where(and(eq(positions.status, 'open'), eq(positions.paperTrading, false)))
    .orderBy(desc(positions.rewardsEarnedUsdc));

  // ── 2. APIs de Polymarket en paralelo (solo si hay posiciones reales) ───────
  const yesterday = new Date(Date.now() - 86_400_000)
    .toISOString().slice(0, 10);  // YYYY-MM-DD

  const [realEarnings, realPercentages] = realPositions.length > 0
    ? await Promise.all([
        fetchRealEarnings(yesterday),
        fetchRealPercentages(),
      ])
    : [new Map<string, number>(), new Map<string, PolyPctEntry>()];

  // ── 3. Sección de posiciones (igual que antes, sin cambios) ─────────────────
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

      const ms  = (p as any).marketSlug;
      const es  = (p as any).eventSlug;
      const url = ms && es ? `https://polymarket.com/event/${es}/${ms}`
                : ms       ? `https://polymarket.com/event/${ms}`
                : null;
      const link = url ? `<a href="${url}">${question}</a>` : `<b>${question}</b>`;

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

  // ── 4. Sección de validación contra Polymarket real ─────────────────────────
  const buildValidationSection = (): string => {
    if (!realPositions.length) return '';

    const lines: string[] = [
      '',
      '🔍 <b>Validación vs Polymarket real</b>',
    ];

    // 4a. Earnings reales de ayer vs estimado de DB del mismo período
    const totalRealEarned = [...realEarnings.values()].reduce((s, v) => s + v, 0);

    if (totalRealEarned > 0) {
      // Estimado de DB para ayer: tomamos rewards_earned_usdc / daysOpen como proxy diario
      const estimatedYesterday = realPositions.reduce((s, p) => {
        const daysOpen = Math.max(1, (Date.now() - (p.openedAt?.getTime() ?? 0)) / 86_400_000);
        return s + Number(p.rewardsEarnedUsdc ?? 0) / daysOpen;
      }, 0);

      const ratio       = estimatedYesterday > 0 ? totalRealEarned / estimatedYesterday : null;
      const ratioLabel  = ratio !== null
        ? (ratio >= 0.8 && ratio <= 1.2
            ? `✅ ${ratio.toFixed(2)}x`
            : `⚠️ ${ratio.toFixed(2)}x`)
        : 'N/A';

      lines.push(
        `  Pagado ayer por Poly: <b>$${totalRealEarned.toFixed(4)}</b>`,
        `  Estimado DB (≈diario): $${estimatedYesterday.toFixed(4)}`,
        `  Factor calibración: <b>${ratioLabel}</b>`,
      );
    } else {
      lines.push(`  Earnings ayer: <i>sin datos (primer día o API no responde)</i>`);
    }

    // 4b. % real actual del pool por posición abierta
    if (realPercentages.size > 0) {
      lines.push('', '  <b>Share real del pool ahora:</b>');

      for (const pos of realPositions) {
        const pct = realPercentages.get(pos.marketId);
        if (!pct) continue;

        const realPctLabel  = (pct.percentage * 100).toFixed(2);
        const realRateDay   = (pct.percentage * pct.rate_per_day).toFixed(4);

        // Estimación interna: rewards_earned_usdc / samples_total * 1440
        const estimatedPerMin = pos.samplesTotal > 0
          ? Number(pos.rewardsEarnedUsdc) / pos.samplesTotal
          : 0;
        const estimatedPerDay  = (estimatedPerMin * 1440).toFixed(4);

        const question = (pos.marketQuestion ?? pos.marketId).slice(0, 30);

        lines.push(
          `  • <i>${question}</i>`,
          `    Share: <b>${realPctLabel}%</b> → $${realRateDay}/d real vs $${estimatedPerDay}/d est.`,
        );
      }
    } else {
      lines.push(`  <i>Share del pool: sin datos (API rewards/percentages)</i>`);
    }

    return lines.join('\n');
  };

  // ── 5. Ensamblar mensaje ────────────────────────────────────────────────────
  const ts       = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const paperSec = buildSection(paperPositions, 'Paper Trading', '📋');
  const realSec  = buildSection(realPositions,  'Real Trading',  '💵');
  const valSec   = buildValidationSection();
  const noData   = !paperPositions.length && !realPositions.length;

  const msg = [
    `💰 <b>Rewards — Estado actual</b>`,
    `<i>${ts}</i>`,
    '',
    noData
      ? '<i>Sin posiciones abiertas</i>'
      : [paperSec, realSec].filter(Boolean).join('\n\n'),
    valSec,
  ].join('\n');

  await sendCommand(chatId, msg);
}

async function handlePositions(chatId: string): Promise<void> {
  const db = await getDb();

  const allOpen = await db
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
    const ms   = (p as any).marketSlug;
    const es   = (p as any).eventSlug;
    const url  = ms && es ? `https://polymarket.com/event/${es}/${ms}`
               : ms       ? `https://polymarket.com/event/${ms}`
               : null;
    const link = url ? `<a href="${url}">${question}</a>` : `<b>${question}</b>`;

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

async function handlePauseResume(chatId: string, text: string, enable: boolean): Promise<void> {
  const args       = text.trim().split(/\s+/);
  const strategyId = args[1] ?? null;
  const action     = enable ? 'activada' : 'pausada';
  const icon       = enable ? '▶' : '⏸';

  if (strategyId) {
    const existing = await strategyQueries.getById(strategyId);
    if (!existing) {
      await sendCommand(chatId, `❌ Estrategia <code>${strategyId}</code> no encontrada`);
      return;
    }
    await strategyQueries.setEnabled(strategyId, enable);
    await sendCommand(chatId, `${icon} Estrategia <code>${strategyId}</code> ${action}`);
  } else {
    const all = await strategyQueries.getAll();
    await Promise.all(all.map(s => strategyQueries.setEnabled(s.strategyId, enable)));
    await sendCommand(chatId, `${icon} Todas las estrategias (${all.length}) ${action}`);
  }
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
    `/current_rewards   — PnL actual de rewards (paper + real)`,
    `/positions         — Lista de posiciones abiertas`,
    `/status            — Estado de todas las estrategias`,
    `/pause [id]        — Pausa una estrategia (o todas)`,
    `/resume [id]       — Reactiva una estrategia (o todas)`,
    `/help              — Este mensaje`,
    '',
    `<i>Ejemplo: /pause rewards_executor</i>`,
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

async function fetchRealEarnings(dateStr: string): Promise<Map<string, number>> {
  // Lo que Polymarket realmente pagó ayer por mercado
  try {
    const res = await fetch(
      `${CLOB_BASE}/rewards/earnings/markets?user=${FUNDER}&date=${dateStr}`,
      { signal: AbortSignal.timeout(8_000) },
    );
    if (!res.ok) return new Map();
    const data = await res.json() as PolyEarning[];
    return new Map(data.map(e => [e.asset_address, Number(e.amount)]));
  } catch {
    return new Map();
  }
}

async function fetchRealPercentages(): Promise<Map<string, PolyPctEntry>> {
  // Tu % actual del pool por mercado en tiempo real
  try {
    const res = await fetch(
      `${CLOB_BASE}/rewards/percentages?user=${FUNDER}`,
      { signal: AbortSignal.timeout(8_000) },
    );
    if (!res.ok) return new Map();
    const data = await res.json() as PolyPctEntry[];
    return new Map(data.map(e => [e.condition_id, e]));
  } catch {
    return new Map();
  }
}