// db/queries-paper.ts
// Queries tipadas para las tablas de market making (paper + real).
// Importar en rewards_executor y en el reporte de Telegram.

import { eq, and, desc, sql, isNull, gte } from 'drizzle-orm';
import { getDb } from './connection';
import {
  positions, orders, rewardAccruals, dailyPnl,
} from './schema';

// ─────────────────────────────────────────────────────────────────────────────
// POSITIONS
// ─────────────────────────────────────────────────────────────────────────────

export const positionQueries = {

  async open(data: {
    paperTrading:        boolean;
    marketId:            string;
    marketQuestion?:     string;
    marketSlug?:         string;
    eventSlug?:          string;
    tokenIdYes:          string;
    tokenIdNo?:          string;
    rewardId:            string;
    dailyRewardUsdc:     number;
    maxSpreadCents:      number;
    minSizeShares:       number;
    rewardEndDate:       Date;
    scalingFactorC:      number;
    sizeUsdc:            number;
    sizePerSideUsdc:     number;
    entryMidprice:       number;
    entryBid?:           number;
    entryAsk?:           number;
    entrySpreadCents?:   number;
    dualSideRequired:    boolean;
    totalLiquidityUsdc?: number;
  }): Promise<number> {
    const db = await getDb();
    const result = await db.insert(positions).values({
      paperTrading:       data.paperTrading,
      marketId:           data.marketId,
      marketQuestion:     data.marketQuestion,
      marketSlug:         data.marketSlug,
      eventSlug:          data.eventSlug,
      tokenIdYes:         data.tokenIdYes,
      tokenIdNo:          data.tokenIdNo,
      rewardId:           data.rewardId,
      dailyRewardUsdc:    data.dailyRewardUsdc.toFixed(4),
      maxSpreadCents:     data.maxSpreadCents.toFixed(2),
      minSizeShares:      data.minSizeShares.toFixed(6),
      rewardEndDate:      data.rewardEndDate,
      scalingFactorC:     data.scalingFactorC.toFixed(2),
      sizeUsdc:           data.sizeUsdc.toFixed(2),
      sizePerSideUsdc:    data.sizePerSideUsdc.toFixed(2),
      entryMidprice:      data.entryMidprice.toFixed(6),
      entryBid:           data.entryBid?.toFixed(6),
      entryAsk:           data.entryAsk?.toFixed(6),
      entrySpreadCents:   data.entrySpreadCents?.toFixed(4),
      dualSideRequired:   data.dualSideRequired,
      totalLiquidityUsdc: data.totalLiquidityUsdc?.toFixed(2),
    });
    const res = result as unknown as [{ insertId: number }, unknown];
    return res[0].insertId;
  },

  async close(
    positionId: number,
    reason: 'reward_ended' | 'score_too_low' | 'price_moved' | 'expired' | 'manual',
  ): Promise<void> {
    const db  = await getDb();
    const pos = await positionQueries.getById(positionId);
    if (!pos) return;

    const rewards = Number(pos.rewardsEarnedUsdc ?? 0);
    const fees    = Number(pos.feesPaidUsdc ?? 0);

    await db
      .update(positions)
      .set({
        status:      'closed',
        closeReason: reason,
        pnlUsdc:     (rewards - fees).toFixed(4),
        closedAt:    new Date(),
      })
      .where(eq(positions.id, positionId));
  },

  async addReward(positionId: number, rewardUsdc: number, qmin: number, inRange: boolean): Promise<void> {
    const db = await getDb();
    await db
      .update(positions)
      .set({
        rewardsEarnedUsdc: sql`rewards_earned_usdc + ${rewardUsdc.toFixed(6)}`,
        totalQmin:         sql`total_qmin + ${qmin.toFixed(6)}`,
        samplesInRange:    sql`samples_in_range + ${inRange ? 1 : 0}`,
        samplesTotal:      sql`samples_total + 1`,
        lastCheckedAt:     new Date(),
      })
      .where(eq(positions.id, positionId));
  },

  async addFee(positionId: number, feeUsdc: number): Promise<void> {
    const db = await getDb();
    await db
      .update(positions)
      .set({ feesPaidUsdc: sql`fees_paid_usdc + ${feeUsdc.toFixed(6)}` })
      .where(eq(positions.id, positionId));
  },

  async getById(id: number) {
    const db   = await getDb();
    const rows = await db.select().from(positions).where(eq(positions.id, id)).limit(1);
    return rows[0] ?? null;
  },

  async getOpen(paperTrading?: boolean) {
    const db = await getDb();
    const where = paperTrading !== undefined
      ? and(eq(positions.status, 'open'), eq(positions.paperTrading, paperTrading))
      : eq(positions.status, 'open');
    return db.select().from(positions).where(where).orderBy(desc(positions.openedAt));
  },

  /** ¿Ya tenemos una posición abierta en este mercado+modo? */
  async hasOpen(marketId: string, paperTrading: boolean): Promise<boolean> {
    const db   = await getDb();
    const rows = await db
      .select({ id: positions.id })
      .from(positions)
      .where(and(
        eq(positions.marketId,    marketId),
        eq(positions.paperTrading, paperTrading),
        eq(positions.status,      'open'),
      ))
      .limit(1);
    return rows.length > 0;
  },

  async getRecent(paperTrading: boolean, limit = 20) {
    const db = await getDb();
    return db
      .select()
      .from(positions)
      .where(eq(positions.paperTrading, paperTrading))
      .orderBy(desc(positions.openedAt))
      .limit(limit);
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// ORDERS
// ─────────────────────────────────────────────────────────────────────────────

export const orderQueries = {

  async insertMany(items: Array<{
    positionId:          number;
    paperTrading:        boolean;
    tokenId:             string;
    side:                'buy' | 'sell';
    price:               number;
    sizeUsdc:            number;
    sizeShares:          number;
    spreadFromMidCents?: number;
  }>): Promise<void> {
    const db = await getDb();
    await db.insert(orders).values(
      items.map(o => ({
        positionId:         o.positionId,
        paperTrading:       o.paperTrading,
        tokenId:            o.tokenId,
        side:               o.side,
        price:              o.price.toFixed(6),
        sizeUsdc:           o.sizeUsdc.toFixed(2),
        sizeShares:         o.sizeShares.toFixed(6),
        spreadFromMidCents: o.spreadFromMidCents?.toFixed(4),
        status:             o.paperTrading ? 'simulated' as const : 'open' as const,
      })),
    );
  },

  async getForPosition(positionId: number) {
    const db = await getDb();
    return db
      .select()
      .from(orders)
      .where(eq(orders.positionId, positionId))
      .orderBy(orders.placedAt);
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// REWARD ACCRUALS
// ─────────────────────────────────────────────────────────────────────────────

export const accrualQueries = {

  async insert(data: {
    positionId:      number;
    paperTrading:    boolean;
    midprice:        number;
    bestBid?:        number;
    bestAsk?:        number;
    spreadCents?:    number;
    midExtreme:      boolean;
    scoreQne:        number;
    scoreQno:        number;
    scoreQmin:       number;
    normalizedProxy: number;
    rewardUsdc:      number;
    inRange:         boolean;
  }): Promise<void> {
    const db = await getDb();
    await db.insert(rewardAccruals).values({
      positionId:      data.positionId,
      paperTrading:    data.paperTrading,
      midprice:        data.midprice.toFixed(6),
      bestBid:         data.bestBid?.toFixed(6),
      bestAsk:         data.bestAsk?.toFixed(6),
      spreadCents:     data.spreadCents?.toFixed(4),
      midExtreme:      data.midExtreme,
      scoreQne:        data.scoreQne.toFixed(6),
      scoreQno:        data.scoreQno.toFixed(6),
      scoreQmin:       data.scoreQmin.toFixed(6),
      normalizedProxy: data.normalizedProxy.toFixed(8),
      rewardUsdc:      data.rewardUsdc.toFixed(6),
      inRange:         data.inRange,
    });
  },

  /** Últimas N muestras de una posición — para debugging */
  async getRecent(positionId: number, limit = 60) {
    const db = await getDb();
    return db
      .select()
      .from(rewardAccruals)
      .where(eq(rewardAccruals.positionId, positionId))
      .orderBy(desc(rewardAccruals.sampledAt))
      .limit(limit);
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// DAILY PNL
// ─────────────────────────────────────────────────────────────────────────────

export const dailyPnlQueries = {

  async upsert(data: {
    paperTrading:         boolean;
    date:                 string;       // YYYY-MM-DD
    positionsOpened:      number;
    positionsClosed:      number;
    positionsOpenEod:     number;
    rewardsEarnedUsdc:    number;
    feesPaidUsdc:         number;
    netPnlUsdc:           number;
    avgCapitalDeployed?:  number;
    avgTimeInRangePct?:   number;
    avgQmin?:             number;
    closedRewardEnded:    number;
    closedScoreTooLow:    number;
    closedPriceMoved:     number;
    closedExpired:        number;
    closedManual:         number;
  }): Promise<void> {
    const db = await getDb();
    await db
      .insert(dailyPnl)
      .values({
        paperTrading:         data.paperTrading,
        date:                 data.date,
        positionsOpened:      data.positionsOpened,
        positionsClosed:      data.positionsClosed,
        positionsOpenEod:     data.positionsOpenEod,
        rewardsEarnedUsdc:    data.rewardsEarnedUsdc.toFixed(4),
        feesPaidUsdc:         data.feesPaidUsdc.toFixed(4),
        netPnlUsdc:           data.netPnlUsdc.toFixed(4),
        avgCapitalDeployed:   data.avgCapitalDeployed?.toFixed(2),
        avgTimeInRangePct:    data.avgTimeInRangePct?.toFixed(2),
        avgQmin:              data.avgQmin?.toFixed(6),
        closedRewardEnded:    data.closedRewardEnded,
        closedScoreTooLow:    data.closedScoreTooLow,
        closedPriceMoved:     data.closedPriceMoved,
        closedExpired:        data.closedExpired,
        closedManual:         data.closedManual,
      })
      .onDuplicateKeyUpdate({
        set: {
          positionsOpened:    data.positionsOpened,
          positionsClosed:    data.positionsClosed,
          positionsOpenEod:   data.positionsOpenEod,
          rewardsEarnedUsdc:  data.rewardsEarnedUsdc.toFixed(4),
          feesPaidUsdc:       data.feesPaidUsdc.toFixed(4),
          netPnlUsdc:         data.netPnlUsdc.toFixed(4),
          avgCapitalDeployed: data.avgCapitalDeployed?.toFixed(2),
          avgTimeInRangePct:  data.avgTimeInRangePct?.toFixed(2),
          avgQmin:            data.avgQmin?.toFixed(6),
          closedRewardEnded:  data.closedRewardEnded,
          closedScoreTooLow:  data.closedScoreTooLow,
          closedPriceMoved:   data.closedPriceMoved,
          closedExpired:      data.closedExpired,
          closedManual:       data.closedManual,
        },
      });
  },

  async getLast(days = 30, paperTrading?: boolean) {
    const db    = await getDb();
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const where = paperTrading !== undefined
      ? and(eq(dailyPnl.paperTrading, paperTrading), gte(dailyPnl.date, since))
      : gte(dailyPnl.date, since);
    return db
      .select()
      .from(dailyPnl)
      .where(where)
      .orderBy(desc(dailyPnl.date));
  },
};