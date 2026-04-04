// core/rewards-daily-report.ts
//
// Calcula el PnL diario del rewards executor y lo envía por Telegram.
// Se ejecuta a las 00:00 UTC — mismo momento que Polymarket paga rewards.
//
// Integrar en runner.ts:
//   import { scheduleRewardsDailyReport } from './rewards-daily-report';
//   scheduleRewardsDailyReport();

import { eq, and, desc, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/connection';
import { positions, rewardAccruals, dailyPnl } from '../db/schema';
import { positionQueries, dailyPnlQueries } from '../db/queries-paper';
import { telegram } from '../telegram/notifier';
import { logger } from '../utils/logger';

export async function runRewardsDailyReport(paperTrading = true): Promise<void> {
  const db   = await getDb();
  const date = new Date();
  // Usamos el día anterior porque el report corre a 00:00 UTC
  // y cubre las 24h que acaban de terminar
  date.setUTCDate(date.getUTCDate() - 1);
  const dateStr = date.toISOString().slice(0, 10);

  logger.info(`[rewards-report] generando reporte ${dateStr} (paper: ${paperTrading})`);

  const since = new Date(`${dateStr}T00:00:00Z`);
  const until = new Date(`${dateStr}T23:59:59Z`);

  // ── Posiciones abiertas actualmente ──────────────────────────────────────
  const openPositions = await positionQueries.getOpen(paperTrading);

  // ── Posiciones abiertas hoy ───────────────────────────────────────────────
  const openedTodayRows = (await db!
    .select({ id: positions.id })
    .from(positions)
    .where(and(
      eq(positions.paperTrading, paperTrading),
      sql`opened_at BETWEEN ${since} AND ${until}`,
    ))) as Array<{ id: number }>;

  // ── Posiciones cerradas hoy con su motivo ─────────────────────────────────
  const closedTodayRows = (await db!
    .select({
      closeReason:       positions.closeReason,
      rewardsEarnedUsdc: positions.rewardsEarnedUsdc,
      feesPaidUsdc:      positions.feesPaidUsdc,
    })
    .from(positions)
    .where(and(
      eq(positions.paperTrading, paperTrading),
      eq(positions.status, 'closed'),
      sql`closed_at BETWEEN ${since} AND ${until}`,
    ))) as Array<{
      closeReason: string | null;
      rewardsEarnedUsdc: string;
      feesPaidUsdc: string;
    }>;

  // ── PnL acumulado de accruals de hoy ─────────────────────────────────────
  const accrualRows = (await db!
    .select({
      totalRewards: sql<number>`SUM(reward_usdc)`,
      samplesTotal: sql<number>`COUNT(*)`,
      samplesInRange: sql<number>`SUM(in_range)`,
      avgQmin:      sql<number>`AVG(score_qmin)`,
    })
    .from(rewardAccruals)
    .where(and(
      eq(rewardAccruals.paperTrading, paperTrading),
      sql`sampled_at BETWEEN ${since} AND ${until}`,
    ))) as Array<{
      totalRewards: number;
      samplesTotal: number;
      samplesInRange: number;
      avgQmin: number;
    }>;

  const accrual = accrualRows[0];
  const rewardsEarnedUsdc = Number(accrual?.totalRewards  ?? 0);
  const samplesTotal      = Number(accrual?.samplesTotal  ?? 0);
  const samplesInRange    = Number(accrual?.samplesInRange ?? 0);
  const avgQmin           = Number(accrual?.avgQmin       ?? 0);
  const avgTimeInRangePct = samplesTotal > 0 ? (samplesInRange / samplesTotal) * 100 : null;

  // Fees del día (de posiciones abiertas y cerradas hoy)
  const feesPaidUsdc = closedTodayRows.reduce(
    (sum, r) => sum + Number(r.feesPaidUsdc ?? 0), 0,
  ) + openPositions.reduce(
    (sum, p) => sum + Number(p.feesPaidUsdc ?? 0), 0,
  );

  const netPnlUsdc = rewardsEarnedUsdc - feesPaidUsdc;

  // ── Desglose de motivos de cierre ────────────────────────────────────────
  const closedByReason = closedTodayRows.reduce<Record<string, number>>((acc, r) => {
    const key = r.closeReason ?? 'manual';
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  // ── Top posiciones abiertas por rewards acumulados ────────────────────────
  const topPositions = [...openPositions]
    .sort((a, b) => Number(b.rewardsEarnedUsdc) - Number(a.rewardsEarnedUsdc))
    .slice(0, 5)
    .map(p => {
      const daysOpen = (Date.now() - (p.openedAt?.getTime() ?? 0)) / 86_400_000;
      const inRangePct = p.samplesTotal > 0
        ? (p.samplesInRange / p.samplesTotal) * 100
        : 0;
      return {
        marketQuestion:    p.marketQuestion ?? p.marketId,
        rewardsEarnedUsdc: Number(p.rewardsEarnedUsdc),
        feesPaidUsdc:      Number(p.feesPaidUsdc),
        inRangePct,
        daysOpen,
        dailyRewardUsdc:   Number(p.dailyRewardUsdc),
      };
    });

  // ── Persistir en daily_pnl ────────────────────────────────────────────────
  await dailyPnlQueries.upsert({
    paperTrading,
    date:                 dateStr,
    positionsOpened:      openedTodayRows.length,
    positionsClosed:      closedTodayRows.length,
    positionsOpenEod:     openPositions.length,
    rewardsEarnedUsdc,
    feesPaidUsdc,
    netPnlUsdc,
    avgCapitalDeployed:   openPositions.reduce((s, p) => s + Number(p.sizeUsdc), 0),
    avgTimeInRangePct:    avgTimeInRangePct ?? undefined,
    avgQmin:              avgQmin || undefined,
    closedRewardEnded:    closedByReason['reward_ended']  ?? 0,
    closedScoreTooLow:    closedByReason['score_too_low'] ?? 0,
    closedPriceMoved:     closedByReason['price_moved']   ?? 0,
    closedExpired:        closedByReason['expired']       ?? 0,
    closedManual:         closedByReason['manual']        ?? 0,
  });

  // ── Enviar a Telegram ─────────────────────────────────────────────────────
  await telegram.sendRewardsExecutorReport({
    date:              dateStr,
    paperTrading,
    positionsOpen:     openPositions.length,
    positionsOpened:   openedTodayRows.length,
    positionsClosed:   closedTodayRows.length,
    rewardsEarnedUsdc,
    feesPaidUsdc,
    netPnlUsdc,
    avgTimeInRangePct: avgTimeInRangePct ?? null,
    avgQmin:           avgQmin || null,
    closedRewardEnded: closedByReason['reward_ended']  ?? 0,
    closedScoreTooLow: closedByReason['score_too_low'] ?? 0,
    closedPriceMoved:  closedByReason['price_moved']   ?? 0,
    closedExpired:     closedByReason['expired']       ?? 0,
    topPositions,
  });

  logger.info(`[rewards-report] enviado — net: $${netPnlUsdc.toFixed(4)} | posiciones: ${openPositions.length}`);
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

export function scheduleRewardsDailyReport(paperTrading = true, hourUTC = 0): void {
  function msUntilNextRun(): number {
    const now  = new Date();
    const next = new Date();
    next.setUTCHours(hourUTC, 1, 0, 0);  // 00:01 UTC (1 min después del pago)
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next.getTime() - now.getTime();
  }

  function schedule() {
    const ms = msUntilNextRun();
    logger.info(`[rewards-report] próximo reporte en ${(ms / 3_600_000).toFixed(1)}h`);
    setTimeout(async () => {
      try {
        await runRewardsDailyReport(paperTrading);
      } catch (err) {
        logger.error('[rewards-report] error en ejecución programada', err);
      }
      schedule();
    }, ms);
  }

  schedule();
}