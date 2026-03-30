import {
  mysqlTable, int, varchar, decimal, boolean,
  timestamp, text, mysqlEnum, index, uniqueIndex, bigint,
} from 'drizzle-orm/mysql-core';

export const strategyConfig = mysqlTable('strategy_config', {
  id:         int('id').primaryKey().autoincrement(),
  strategyId: varchar('strategy_id', { length: 64 }).notNull().unique(),
  name:       varchar('name', { length: 128 }).notNull(),
  enabled:    boolean('enabled').notNull().default(true),
  params:     text('params').notNull().default('{}'),
  createdAt:  timestamp('created_at').defaultNow(),
  updatedAt:  timestamp('updated_at').defaultNow().onUpdateNow(),
});

export const strategyRunLog = mysqlTable('strategy_run_log', {
  id:          bigint('id', { mode: 'number' }).primaryKey().autoincrement(),
  strategyId:  varchar('strategy_id', { length: 64 }).notNull(),
  ranAt:       timestamp('ran_at').defaultNow(),
  durationMs:  int('duration_ms'),
  signalCount: int('signal_count').notNull().default(0),
  error:       text('error'),
  metrics:     text('metrics'),
}, t => ({
  idxStrategy: index('idx_run_strategy').on(t.strategyId),
  idxRanAt:    index('idx_run_ran_at').on(t.ranAt),
}));

export const signals = mysqlTable('signals', {
  id:          bigint('id', { mode: 'number' }).primaryKey().autoincrement(),
  strategyId:  varchar('strategy_id', { length: 64 }).notNull(),
  severity:    mysqlEnum('severity', ['low', 'medium', 'high']).notNull().default('medium'),
  title:       varchar('title', { length: 256 }).notNull(),
  body:        text('body').notNull(),
  metadata:    text('metadata').notNull().default('{}'),
  sentAt:      timestamp('sent_at').defaultNow(),
  outcome:     mysqlEnum('outcome', ['correct', 'incorrect', 'neutral']),
  outcomeNote: varchar('outcome_note', { length: 512 }),
  outcomeAt:   timestamp('outcome_at'),
}, t => ({
  idxStrategy: index('idx_signal_strategy').on(t.strategyId),
  idxSentAt:   index('idx_signal_sent_at').on(t.sentAt),
  idxOutcome:  index('idx_signal_outcome').on(t.outcome),
}));

export const strategyDailyStats = mysqlTable('strategy_daily_stats', {
  id:               int('id').primaryKey().autoincrement(),
  strategyId:       varchar('strategy_id', { length: 64 }).notNull(),
  date:             varchar('date', { length: 10 }).notNull(),
  totalRuns:        int('total_runs').notNull().default(0),
  totalSignals:     int('total_signals').notNull().default(0),
  signalsCorrect:   int('signals_correct').notNull().default(0),
  signalsIncorrect: int('signals_incorrect').notNull().default(0),
  signalsNeutral:   int('signals_neutral').notNull().default(0),
  signalsPending:   int('signals_pending').notNull().default(0),
  winRatePct:       decimal('win_rate_pct', { precision: 5, scale: 2 }),
  avgDurationMs:    int('avg_duration_ms'),
  errorCount:       int('error_count').notNull().default(0),
}, t => ({
  uniqDay: uniqueIndex('uniq_strategy_date').on(t.strategyId, t.date),
}));

export const trackedWallets = mysqlTable('tracked_wallets', {
  id:              bigint('id', { mode: 'number' }).primaryKey().autoincrement(),
  address:         varchar('address', { length: 42 }).notNull().unique(),
  label:           varchar('label', { length: 128 }),
  source:          varchar('source', { length: 32 }).notNull().default('auto_detected'),
  active:          boolean('active').notNull().default(true),
  totalTrades:     int('total_trades').notNull().default(0),
  winningTrades:   int('winning_trades').notNull().default(0),
  totalVolume:     decimal('total_volume', { precision: 18, scale: 2 }).notNull().default('0'),
  winRatePct:      decimal('win_rate_pct', { precision: 5, scale: 2 }),
  smartScore:      decimal('smart_score', { precision: 8, scale: 4 }),
  firstSeenAt:     timestamp('first_seen_at').defaultNow(),
  lastActivityAt:  timestamp('last_activity_at'),
  lastSyncAt:      timestamp('last_sync_at'),
}, t => ({
  idxScore:  index('idx_wallet_score').on(t.smartScore),
  idxActive: index('idx_wallet_active').on(t.active),
}));

export const walletTrades = mysqlTable('wallet_trades', {
  id:            bigint('id', { mode: 'number' }).primaryKey().autoincrement(),
  walletAddress: varchar('wallet_address', { length: 42 }).notNull(),
  marketId:      varchar('market_id', { length: 128 }).notNull(),
  marketTitle:   varchar('market_title', { length: 512 }),
  tokenId:       varchar('token_id', { length: 128 }),
  side:          mysqlEnum('side', ['buy', 'sell']).notNull(),
  price:         decimal('price', { precision: 10, scale: 6 }).notNull(),
  size:          decimal('size', { precision: 18, scale: 4 }).notNull(),
  usdcValue:     decimal('usdc_value', { precision: 18, scale: 2 }),
  txHash:        varchar('tx_hash', { length: 66 }),
  tradedAt:      timestamp('traded_at').notNull(),
  outcome:       mysqlEnum('outcome', ['won', 'lost', 'void']),
  pnlUsdc:       decimal('pnl_usdc', { precision: 18, scale: 4 }),
  createdAt:     timestamp('created_at').defaultNow(),
}, t => ({
  idxWallet:   index('idx_trade_wallet').on(t.walletAddress),
  idxMarket:   index('idx_trade_market').on(t.marketId),
  idxTradedAt: index('idx_trade_traded_at').on(t.tradedAt),
  uniqTx:      uniqueIndex('uniq_trade_tx').on(t.txHash),
}));

export const marketPriceSnapshots = mysqlTable('market_price_snapshots', {
  id:          bigint('id', { mode: 'number' }).primaryKey().autoincrement(),
  marketId:    varchar('market_id', { length: 128 }).notNull(),
  tokenId:     varchar('token_id', { length: 128 }).notNull(),
  price:       decimal('price', { precision: 10, scale: 6 }).notNull(),
  volume24h:   decimal('volume_24h', { precision: 18, scale: 2 }),
  priceH1Ago:  decimal('price_h1_ago', { precision: 10, scale: 6 }),
  deltaH1Pct:  decimal('delta_h1_pct', { precision: 8, scale: 4 }),
  snapshotAt:  timestamp('snapshot_at').defaultNow(),
}, t => ({
  idxMarket: index('idx_snap_market').on(t.marketId),
  idxSnap:   index('idx_snap_at').on(t.snapshotAt),
}));

export const oddsMoves = mysqlTable('odds_moves', {
  id:              bigint('id', { mode: 'number' }).primaryKey().autoincrement(),
  marketId:        varchar('market_id', { length: 128 }).notNull(),
  marketTitle:     varchar('market_title', { length: 512 }),
  tokenId:         varchar('token_id', { length: 128 }).notNull(),
  priceFrom:       decimal('price_from', { precision: 10, scale: 6 }).notNull(),
  priceTo:         decimal('price_to', { precision: 10, scale: 6 }).notNull(),
  deltaPct:        decimal('delta_pct', { precision: 8, scale: 4 }).notNull(),
  windowMinutes:   int('window_minutes').notNull(),
  detectedAt:      timestamp('detected_at').defaultNow(),
  resolvedCorrect: boolean('resolved_correct'),
}, t => ({
  idxMarket:   index('idx_move_market').on(t.marketId),
  idxDetected: index('idx_move_detected').on(t.detectedAt),
}));

export const orderBookSnapshots = mysqlTable('order_book_snapshots', {
  id:              bigint('id', { mode: 'number' }).primaryKey().autoincrement(),
  marketId:        varchar('market_id', { length: 128 }).notNull(),
  tokenId:         varchar('token_id', { length: 128 }).notNull(),
  bestBid:         decimal('best_bid', { precision: 10, scale: 6 }),
  bestAsk:         decimal('best_ask', { precision: 10, scale: 6 }),
  spread:          decimal('spread', { precision: 10, scale: 6 }),
  bidDepth:        decimal('bid_depth', { precision: 18, scale: 4 }),
  askDepth:        decimal('ask_depth', { precision: 18, scale: 4 }),
  imbalanceRatio:  decimal('imbalance_ratio', { precision: 6, scale: 4 }),
  snapshotAt:      timestamp('snapshot_at').defaultNow(),
}, t => ({
  idxMarket: index('idx_ob_market').on(t.marketId),
  idxSnap:   index('idx_ob_snap_at').on(t.snapshotAt),
}));

export const orderBookAlerts = mysqlTable('order_book_alerts', {
  id:              bigint('id', { mode: 'number' }).primaryKey().autoincrement(),
  marketId:        varchar('market_id', { length: 128 }).notNull(),
  marketTitle:     varchar('market_title', { length: 512 }),
  tokenId:         varchar('token_id', { length: 128 }).notNull(),
  imbalanceRatio:  decimal('imbalance_ratio', { precision: 6, scale: 4 }).notNull(),
  direction:       varchar('direction', { length: 16 }).notNull(),
  bestBid:         decimal('best_bid', { precision: 10, scale: 6 }),
  bestAsk:         decimal('best_ask', { precision: 10, scale: 6 }),
  detectedAt:      timestamp('detected_at').defaultNow(),
  resolvedCorrect: boolean('resolved_correct'),
}, t => ({
  idxMarket:   index('idx_oba_market').on(t.marketId),
  idxDetected: index('idx_oba_detected').on(t.detectedAt),
}));