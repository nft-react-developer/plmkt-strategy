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

export const positions = mysqlTable('positions', {
  id:                  bigint('id', { mode: 'number' }).primaryKey().autoincrement(),

  paperTrading:        boolean('paper_trading').notNull().default(true),

  marketId:            varchar('market_id',      { length: 128 }).notNull(),
  marketQuestion:      varchar('market_question', { length: 512 }),
  tokenIdYes:          varchar('token_id_yes',    { length: 128 }).notNull(),
  tokenIdNo:           varchar('token_id_no',     { length: 128 }),

  rewardId:            varchar('reward_id',       { length: 128 }).notNull(),
  dailyRewardUsdc:     decimal('daily_reward_usdc',  { precision: 12, scale: 4 }).notNull(),
  maxSpreadCents:      decimal('max_spread_cents',    { precision: 6,  scale: 2 }).notNull(),
  minSizeShares:       decimal('min_size_shares',     { precision: 14, scale: 6 }).notNull().default('0'),
  rewardEndDate:       timestamp('reward_end_date').notNull(),
  scalingFactorC:      decimal('scaling_factor_c',   { precision: 6,  scale: 2 }).notNull().default('3.0'),

  sizeUsdc:            decimal('size_usdc',         { precision: 12, scale: 2 }).notNull(),
  sizePerSideUsdc:     decimal('size_per_side_usdc', { precision: 12, scale: 2 }).notNull(),

  entryMidprice:       decimal('entry_midprice',    { precision: 10, scale: 6 }).notNull(),
  entryBid:            decimal('entry_bid',          { precision: 10, scale: 6 }),
  entryAsk:            decimal('entry_ask',          { precision: 10, scale: 6 }),
  entrySpreadCents:    decimal('entry_spread_cents', { precision: 8,  scale: 4 }),

  dualSideRequired:    boolean('dual_side_required').notNull().default(false),
  totalLiquidityUsdc:  decimal('total_liquidity_usdc', { precision: 18, scale: 2 }),

  status:              mysqlEnum('status', ['open', 'closed']).notNull().default('open'),
  closeReason:         mysqlEnum('close_reason', [
    'reward_ended', 'score_too_low', 'price_moved', 'expired', 'manual',
  ]),

  rewardsEarnedUsdc:   decimal('rewards_earned_usdc', { precision: 12, scale: 4 }).notNull().default('0'),
  feesPaidUsdc:        decimal('fees_paid_usdc',       { precision: 12, scale: 4 }).notNull().default('0'),
  pnlUsdc:             decimal('pnl_usdc',             { precision: 12, scale: 4 }),

  totalQmin:           decimal('total_qmin',       { precision: 18, scale: 6 }).notNull().default('0'),
  samplesInRange:      int('samples_in_range').notNull().default(0),
  samplesTotal:        int('samples_total').notNull().default(0),

  openedAt:            timestamp('opened_at').defaultNow(),
  lastCheckedAt:       timestamp('last_checked_at'),
  closedAt:            timestamp('closed_at'),
}, t => ({
  idxMarket: index('idx_pos_market').on(t.marketId),
  idxStatus: index('idx_pos_status').on(t.status),
  idxPaper:  index('idx_pos_paper').on(t.paperTrading),
  idxOpened: index('idx_pos_opened').on(t.openedAt),
}));

export const orders = mysqlTable('orders', {
  id:                   bigint('id', { mode: 'number' }).primaryKey().autoincrement(),
  positionId:           bigint('position_id', { mode: 'number' }).notNull(),

  paperTrading:         boolean('paper_trading').notNull().default(true),

  tokenId:              varchar('token_id', { length: 128 }).notNull(),
  side:                 mysqlEnum('side', ['buy', 'sell']).notNull(),

  price:                decimal('price',       { precision: 10, scale: 6 }).notNull(),
  sizeUsdc:             decimal('size_usdc',   { precision: 12, scale: 2 }).notNull(),
  sizeShares:           decimal('size_shares', { precision: 14, scale: 6 }).notNull(),
  spreadFromMidCents:   decimal('spread_from_mid_cents', { precision: 8, scale: 4 }),

  status:               mysqlEnum('status', ['simulated', 'open', 'filled', 'cancelled']).notNull().default('simulated'),

  filledPrice:          decimal('filled_price',  { precision: 10, scale: 6 }),
  filledAt:             timestamp('filled_at'),
  feePaidUsdc:          decimal('fee_paid_usdc', { precision: 10, scale: 4 }),

  clobOrderId:          varchar('clob_order_id', { length: 128 }),
  placedAt:             timestamp('placed_at').defaultNow(),
}, t => ({
  idxPosition: index('idx_ord_position').on(t.positionId),
  idxToken:    index('idx_ord_token').on(t.tokenId),
  idxPaper:    index('idx_ord_paper').on(t.paperTrading),
}));

export const rewardAccruals = mysqlTable('reward_accruals', {
  id:              bigint('id', { mode: 'number' }).primaryKey().autoincrement(),
  positionId:      bigint('position_id', { mode: 'number' }).notNull(),

  paperTrading:    boolean('paper_trading').notNull().default(true),

  sampledAt:       timestamp('sampled_at').defaultNow(),

  midprice:        decimal('midprice',     { precision: 10, scale: 6 }).notNull(),
  bestBid:         decimal('best_bid',     { precision: 10, scale: 6 }),
  bestAsk:         decimal('best_ask',     { precision: 10, scale: 6 }),
  spreadCents:     decimal('spread_cents', { precision: 8,  scale: 4 }),

  midExtreme:      boolean('mid_extreme').notNull().default(false),

  scoreQne:        decimal('score_qne',  { precision: 18, scale: 6 }).notNull().default('0'),
  scoreQno:        decimal('score_qno',  { precision: 18, scale: 6 }).notNull().default('0'),
  scoreQmin:       decimal('score_qmin', { precision: 18, scale: 6 }).notNull().default('0'),

  normalizedProxy: decimal('normalized_proxy', { precision: 18, scale: 8 }).notNull().default('0'),
  rewardUsdc:      decimal('reward_usdc',      { precision: 12, scale: 6 }).notNull().default('0'),

  inRange:         boolean('in_range').notNull().default(false),
}, t => ({
  idxPosition: index('idx_acc_position').on(t.positionId),
  idxSampled:  index('idx_acc_sampled').on(t.sampledAt),
  idxPaper:    index('idx_acc_paper').on(t.paperTrading),
}));

export const dailyPnl = mysqlTable('daily_pnl', {
  id:                   int('id').primaryKey().autoincrement(),

  paperTrading:         boolean('paper_trading').notNull().default(true),
  date:                 varchar('date', { length: 10 }).notNull(),

  positionsOpened:      int('positions_opened').notNull().default(0),
  positionsClosed:      int('positions_closed').notNull().default(0),
  positionsOpenEod:     int('positions_open_eod').notNull().default(0),

  rewardsEarnedUsdc:    decimal('rewards_earned_usdc', { precision: 12, scale: 4 }).notNull().default('0'),
  feesPaidUsdc:         decimal('fees_paid_usdc',      { precision: 12, scale: 4 }).notNull().default('0'),
  netPnlUsdc:           decimal('net_pnl_usdc',        { precision: 12, scale: 4 }).notNull().default('0'),

  avgCapitalDeployed:   decimal('avg_capital_deployed',  { precision: 12, scale: 2 }),
  avgTimeInRangePct:    decimal('avg_time_in_range_pct', { precision: 6,  scale: 2 }),
  avgQmin:              decimal('avg_qmin',              { precision: 18, scale: 6 }),

  closedRewardEnded:    int('closed_reward_ended').notNull().default(0),
  closedScoreTooLow:    int('closed_score_too_low').notNull().default(0),
  closedPriceMoved:     int('closed_price_moved').notNull().default(0),
  closedExpired:        int('closed_expired').notNull().default(0),
  closedManual:         int('closed_manual').notNull().default(0),
}, t => ({
  uniqDateMode: uniqueIndex('uniq_date_mode').on(t.date, t.paperTrading),
  idxDate:      index('idx_dpnl_date').on(t.date),
  idxPaper:     index('idx_dpnl_paper').on(t.paperTrading),
}));