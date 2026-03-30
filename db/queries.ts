import { eq, and, gte, lte, desc, sql, isNull, isNotNull, lt } from 'drizzle-orm';
import { getDb, schema } from './connection';

// ─────────────────────────────────────────────────────────────────────────────
// STRATEGY CONFIG
// ─────────────────────────────────────────────────────────────────────────────

export const strategyQueries = {
  /** Devuelve todas las estrategias (enabled o no) */
  async getAll() {
    const db = await getDb();
    return db.select().from(schema.strategyConfig);
  },

  /** Solo las habilitadas */
  async getEnabled() {
    const db = await getDb();
    return db
      .select()
      .from(schema.strategyConfig)
      .where(eq(schema.strategyConfig.enabled, true));
  },

  async getById(strategyId: string) {
    const db = await getDb();
    const rows = await db
      .select()
      .from(schema.strategyConfig)
      .where(eq(schema.strategyConfig.strategyId, strategyId))
      .limit(1);
    return rows[0] ?? null;
  },

  /**
   * Upsert: crea la fila si no existe, no toca params si ya existe.
   * Se llama al arrancar el runner por cada estrategia registrada.
   */
  async ensureExists(strategyId: string, name: string, defaultParams: Record<string, unknown>) {
    const db = await getDb();
    const existing = await strategyQueries.getById(strategyId);
    if (existing) return existing;

    await db.insert(schema.strategyConfig).values({
      strategyId,
      name,
      enabled: true,
      params:  JSON.stringify(defaultParams),
    });
    return strategyQueries.getById(strategyId);
  },

  async setEnabled(strategyId: string, enabled: boolean) {
    const db = await getDb();
    await db
      .update(schema.strategyConfig)
      .set({ enabled })
      .where(eq(schema.strategyConfig.strategyId, strategyId));
  },

  async updateParams(strategyId: string, params: Record<string, unknown>) {
    const db = await getDb();
    await db
      .update(schema.strategyConfig)
      .set({ params: JSON.stringify(params) })
      .where(eq(schema.strategyConfig.strategyId, strategyId));
  },

  /** Merge parcial de params (solo sobreescribe las keys enviadas) */
  async mergeParams(strategyId: string, partial: Record<string, unknown>) {
    const existing = await strategyQueries.getById(strategyId);
    if (!existing) return;
    const current = JSON.parse(existing.params ?? '{}');
    await strategyQueries.updateParams(strategyId, { ...current, ...partial });
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// RUN LOG
// ─────────────────────────────────────────────────────────────────────────────

export const runLogQueries = {
  async insert(entry: {
    strategyId:  string;
    durationMs:  number;
    signalCount: number;
    error?:      string;
    metrics?:    Record<string, number>;
  }) {
    const db = await getDb();
    await db.insert(schema.strategyRunLog).values({
      strategyId:  entry.strategyId,
      durationMs:  entry.durationMs,
      signalCount: entry.signalCount,
      error:       entry.error,
      metrics:     entry.metrics ? JSON.stringify(entry.metrics) : null,
    });
  },

  async getRecent(strategyId: string, limit = 50) {
    const db = await getDb();
    return db
      .select()
      .from(schema.strategyRunLog)
      .where(eq(schema.strategyRunLog.strategyId, strategyId))
      .orderBy(desc(schema.strategyRunLog.ranAt))
      .limit(limit);
  },

  /** Stats de la última N horas */
  async getSummary(strategyId: string, hoursBack = 24) {
    const db = await getDb();
    const since = new Date(Date.now() - hoursBack * 3_600_000);
    const rows = await db
      .select({
        totalRuns:    sql<number>`COUNT(*)`,
        totalSignals: sql<number>`SUM(${schema.strategyRunLog.signalCount})`,
        errors:       sql<number>`SUM(CASE WHEN ${schema.strategyRunLog.error} IS NOT NULL THEN 1 ELSE 0 END)`,
        avgDurMs:     sql<number>`AVG(${schema.strategyRunLog.durationMs})`,
      })
      .from(schema.strategyRunLog)
      .where(
        and(
          eq(schema.strategyRunLog.strategyId, strategyId),
          gte(schema.strategyRunLog.ranAt, since),
        ),
      );
    return rows[0] ?? null;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// SIGNALS
// ─────────────────────────────────────────────────────────────────────────────

export const signalQueries = {
  async insert(signal: {
    strategyId: string;
    severity:   'low' | 'medium' | 'high';
    title:      string;
    body:       string;
    metadata:   Record<string, unknown>;
  }) {
    const db = await getDb();
    const result = await db.insert(schema.signals).values({
      strategyId: signal.strategyId,
      severity:   signal.severity,
      title:      signal.title,
      body:       signal.body,
      metadata:   JSON.stringify(signal.metadata),
    });
    return result;
  },

  async getRecent(strategyId: string, limit = 20) {
    const db = await getDb();
    return db
      .select()
      .from(schema.signals)
      .where(eq(schema.signals.strategyId, strategyId))
      .orderBy(desc(schema.signals.sentAt))
      .limit(limit);
  },

  /** Signals pendientes de resolución (para mostrar en summary) */
  async getPending(strategyId?: string) {
    const db = await getDb();
    const where = strategyId
      ? and(eq(schema.signals.strategyId, strategyId), isNull(schema.signals.outcome))
      : isNull(schema.signals.outcome);
    return db
      .select()
      .from(schema.signals)
      .where(where)
      .orderBy(desc(schema.signals.sentAt));
  },

  async resolveSignal(
    signalId: number,
    outcome: 'correct' | 'incorrect' | 'neutral',
    note?: string,
  ) {
    const db = await getDb();
    await db
      .update(schema.signals)
      .set({ outcome, outcomeNote: note, outcomeAt: new Date() })
      .where(eq(schema.signals.id, signalId));
  },

  /**
   * Win rate por estrategia sobre signals con outcome.
   * Retorna un objeto { correct, incorrect, neutral, winRatePct }
   */
  async getWinRate(strategyId: string, since?: Date) {
    const db = await getDb();
    const conditions = [
      eq(schema.signals.strategyId, strategyId),
      isNotNull(schema.signals.outcome),
    ];
    if (since) conditions.push(gte(schema.signals.sentAt, since));

    const rows = await db
      .select({
        outcome: schema.signals.outcome,
        count:   sql<number>`COUNT(*)`,
      })
      .from(schema.signals)
      .where(and(...conditions))
      .groupBy(schema.signals.outcome);

    const byOutcome = Object.fromEntries(rows.map(r => [r.outcome, r.count]));
    const correct   = byOutcome['correct']   ?? 0;
    const incorrect = byOutcome['incorrect'] ?? 0;
    const neutral   = byOutcome['neutral']   ?? 0;
    const resolved  = correct + incorrect;
    return {
      correct,
      incorrect,
      neutral,
      resolved,
      winRatePct: resolved > 0 ? (correct / resolved) * 100 : null,
    };
  },

  /** Win rate de TODAS las estrategias de un tirón */
  async getAllWinRates(since?: Date) {
    const db = await getDb();
    const conditions = [isNotNull(schema.signals.outcome)];
    if (since) conditions.push(gte(schema.signals.sentAt, since));

    return db
      .select({
        strategyId: schema.signals.strategyId,
        outcome:    schema.signals.outcome,
        count:      sql<number>`COUNT(*)`,
      })
      .from(schema.signals)
      .where(and(...conditions))
      .groupBy(schema.signals.strategyId, schema.signals.outcome);
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// DAILY STATS
// ─────────────────────────────────────────────────────────────────────────────

export const dailyStatsQueries = {
  async upsert(data: {
    strategyId:       string;
    date:             string;
    totalRuns:        number;
    totalSignals:     number;
    signalsCorrect:   number;
    signalsIncorrect: number;
    signalsNeutral:   number;
    signalsPending:   number;
    winRatePct:       number | null;
    avgDurationMs:    number | null;
    errorCount:       number;
  }) {
    const db = await getDb();
    await db
      .insert(schema.strategyDailyStats)
      .values({
        ...data,
        winRatePct: data.winRatePct?.toFixed(2) ?? null,
      })
      .onDuplicateKeyUpdate({
        set: {
          totalRuns:         data.totalRuns,
          totalSignals:      data.totalSignals,
          signalsCorrect:    data.signalsCorrect,
          signalsIncorrect:  data.signalsIncorrect,
          signalsNeutral:    data.signalsNeutral,
          signalsPending:    data.signalsPending,
          winRatePct:        data.winRatePct?.toFixed(2) ?? null,
          avgDurationMs:     data.avgDurationMs,
          errorCount:        data.errorCount,
        },
      });
  },

  async getForStrategy(strategyId: string, lastNDays = 30) {
    const db = await getDb();
    const since = new Date(Date.now() - lastNDays * 86_400_000);
    const dateStr = since.toISOString().slice(0, 10);
    return db
      .select()
      .from(schema.strategyDailyStats)
      .where(
        and(
          eq(schema.strategyDailyStats.strategyId, strategyId),
          gte(schema.strategyDailyStats.date, dateStr),
        ),
      )
      .orderBy(desc(schema.strategyDailyStats.date));
  },

  async getLatestAll() {
    const db = await getDb();
    // Última fila por estrategia
    return db
      .select()
      .from(schema.strategyDailyStats)
      .orderBy(desc(schema.strategyDailyStats.date));
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// WALLETS (S1 + S2)
// ─────────────────────────────────────────────────────────────────────────────

export const walletQueries = {
  async upsert(data: {
    address:       string;
    label?:        string;
    source?:       string;
    totalTrades?:  number;
    winningTrades?: number;
    totalVolume?:  string;
    winRatePct?:   string;
    smartScore?:   string;
    lastActivityAt?: Date;
  }) {
    const db = await getDb();
    await db
      .insert(schema.trackedWallets)
      .values({
        address:        data.address,
        label:          data.label,
        source:         data.source ?? 'auto_detected',
        totalTrades:    data.totalTrades ?? 0,
        winningTrades:  data.winningTrades ?? 0,
        totalVolume:    data.totalVolume ?? '0',
        winRatePct:     data.winRatePct,
        smartScore:     data.smartScore,
        lastActivityAt: data.lastActivityAt,
        lastSyncAt:     new Date(),
      })
      .onDuplicateKeyUpdate({
        set: {
          totalTrades:    data.totalTrades,
          winningTrades:  data.winningTrades,
          totalVolume:    data.totalVolume,
          winRatePct:     data.winRatePct,
          smartScore:     data.smartScore,
          lastActivityAt: data.lastActivityAt,
          lastSyncAt:     new Date(),
        },
      });
  },

  async getTopByScore(limit = 50) {
    const db = await getDb();
    return db
      .select()
      .from(schema.trackedWallets)
      .where(eq(schema.trackedWallets.active, true))
      .orderBy(desc(schema.trackedWallets.smartScore))
      .limit(limit);
  },

  async getActive() {
    const db = await getDb();
    return db
      .select()
      .from(schema.trackedWallets)
      .where(eq(schema.trackedWallets.active, true));
  },

  async setActive(address: string, active: boolean) {
    const db = await getDb();
    await db
      .update(schema.trackedWallets)
      .set({ active })
      .where(eq(schema.trackedWallets.address, address));
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// WALLET TRADES (S1 + S2)
// ─────────────────────────────────────────────────────────────────────────────

export const walletTradeQueries = {
  async insertIfNotExists(trade: {
    walletAddress: string;
    marketId:      string;
    marketTitle?:  string;
    tokenId?:      string;
    side:          'buy' | 'sell';
    price:         string;
    size:          string;
    usdcValue?:    string;
    txHash?:       string;
    tradedAt:      Date;
  }) {
    const db = await getDb();
    // Ignora duplicados por txHash
    await db
      .insert(schema.walletTrades)
      .values(trade)
      .onDuplicateKeyUpdate({ set: { walletAddress: trade.walletAddress } });
  },

  async getRecentForWallet(address: string, limit = 20) {
    const db = await getDb();
    return db
      .select()
      .from(schema.walletTrades)
      .where(eq(schema.walletTrades.walletAddress, address))
      .orderBy(desc(schema.walletTrades.tradedAt))
      .limit(limit);
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// MARKET PRICE SNAPSHOTS (S3)
// ─────────────────────────────────────────────────────────────────────────────

export const priceSnapshotQueries = {
  async insert(data: {
    marketId:    string;
    tokenId:     string;
    price:       string;
    volume24h?:  string;
    priceH1Ago?: string;
    deltaH1Pct?: string;
  }) {
    const db = await getDb();
    await db.insert(schema.marketPriceSnapshots).values(data);
  },

  /** Último snapshot de un token */
  async getLatest(marketId: string, tokenId: string) {
    const db = await getDb();
    const rows = await db
      .select()
      .from(schema.marketPriceSnapshots)
      .where(
        and(
          eq(schema.marketPriceSnapshots.marketId, marketId),
          eq(schema.marketPriceSnapshots.tokenId, tokenId),
        ),
      )
      .orderBy(desc(schema.marketPriceSnapshots.snapshotAt))
      .limit(1);
    return rows[0] ?? null;
  },

  /** Snapshot de hace N minutos (para calcular delta) */
  async getAtApprox(marketId: string, tokenId: string, minutesAgo: number) {
    const db = await getDb();
    const target = new Date(Date.now() - minutesAgo * 60_000);
    const window = new Date(target.getTime() - 5 * 60_000); // ±5 min
    const rows = await db
      .select()
      .from(schema.marketPriceSnapshots)
      .where(
        and(
          eq(schema.marketPriceSnapshots.marketId, marketId),
          eq(schema.marketPriceSnapshots.tokenId, tokenId),
          gte(schema.marketPriceSnapshots.snapshotAt, window),
          lte(schema.marketPriceSnapshots.snapshotAt, target),
        ),
      )
      .orderBy(desc(schema.marketPriceSnapshots.snapshotAt))
      .limit(1);
    return rows[0] ?? null;
  },

  /** Limpieza: borra snapshots viejos */
  async deleteOlderThan(days: number) {
    const db = await getDb();
    const cutoff = new Date(Date.now() - days * 86_400_000);
    await db
      .delete(schema.marketPriceSnapshots)
      .where(lt(schema.marketPriceSnapshots.snapshotAt, cutoff));
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// ODDS MOVES (S3)
// ─────────────────────────────────────────────────────────────────────────────

export const oddsMoveQueries = {
  async insert(data: {
    marketId:      string;
    marketTitle?:  string;
    tokenId:       string;
    priceFrom:     string;
    priceTo:       string;
    deltaPct:      string;
    windowMinutes: number;
  }) {
    const db = await getDb();
    await db.insert(schema.oddsMoves).values(data);
  },

  async getRecent(limit = 50) {
    const db = await getDb();
    return db
      .select()
      .from(schema.oddsMoves)
      .orderBy(desc(schema.oddsMoves.detectedAt))
      .limit(limit);
  },

  async resolve(id: number, resolvedCorrect: boolean) {
    const db = await getDb();
    await db
      .update(schema.oddsMoves)
      .set({ resolvedCorrect })
      .where(eq(schema.oddsMoves.id, id));
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// ORDER BOOK (S4)
// ─────────────────────────────────────────────────────────────────────────────

export const orderBookQueries = {
  async insertSnapshot(data: {
    marketId:       string;
    tokenId:        string;
    bestBid?:       string;
    bestAsk?:       string;
    spread?:        string;
    bidDepth?:      string;
    askDepth?:      string;
    imbalanceRatio?: string;
  }) {
    const db = await getDb();
    await db.insert(schema.orderBookSnapshots).values(data);
  },

  async insertAlert(data: {
    marketId:       string;
    marketTitle?:   string;
    tokenId:        string;
    imbalanceRatio: string;
    direction:      string;
    bestBid?:       string;
    bestAsk?:       string;
  }) {
    const db = await getDb();
    await db.insert(schema.orderBookAlerts).values(data);
  },

  async getRecentAlerts(limit = 50) {
    const db = await getDb();
    return db
      .select()
      .from(schema.orderBookAlerts)
      .orderBy(desc(schema.orderBookAlerts.detectedAt))
      .limit(limit);
  },

  async resolveAlert(id: number, resolvedCorrect: boolean) {
    const db = await getDb();
    await db
      .update(schema.orderBookAlerts)
      .set({ resolvedCorrect })
      .where(eq(schema.orderBookAlerts.id, id));
  },

  async deleteSnapshotsOlderThan(days: number) {
    const db = await getDb();
    const cutoff = new Date(Date.now() - days * 86_400_000);
    await db
      .delete(schema.orderBookSnapshots)
      .where(lt(schema.orderBookSnapshots.snapshotAt, cutoff));
  },
};