-- ─────────────────────────────────────────────────────────────────────────────
-- Polymarket Bot — Schema SQL
-- Ejecutar en orden. Compatible con MariaDB / MySQL 8+
-- ─────────────────────────────────────────────────────────────────────────────

-- ============================================================
-- 01_setup.sql — todas las tablas de las tres etapas
-- ============================================================

CREATE DATABASE IF NOT EXISTS polymarket_strategies
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE polymarket_strategies;


CREATE TABLE IF NOT EXISTS strategy_config (
  id           INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  strategy_id  VARCHAR(64)  NOT NULL UNIQUE,
  name         VARCHAR(128) NOT NULL,
  enabled      BOOLEAN      NOT NULL DEFAULT TRUE,
  -- JSON con parámetros que sobreescriben los defaultParams de la estrategia
  -- Ejemplo: { "intervalSeconds": 60, "minDeltaPct": 10.0 }
  params       TEXT         NOT NULL DEFAULT '{}',
  created_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS strategy_run_log (
  id           BIGINT    NOT NULL AUTO_INCREMENT PRIMARY KEY,
  strategy_id  VARCHAR(64) NOT NULL,
  ran_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  duration_ms  INT,
  signal_count INT       NOT NULL DEFAULT 0,
  error        TEXT,
  metrics      TEXT,  -- JSON: métricas opcionales por estrategia
  INDEX idx_run_strategy (strategy_id),
  INDEX idx_run_ran_at   (ran_at)
);

CREATE TABLE IF NOT EXISTS signals (
  id           BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  strategy_id  VARCHAR(64)  NOT NULL,
  severity     ENUM('low','medium','high') NOT NULL DEFAULT 'medium',
  title        VARCHAR(256) NOT NULL,
  body         TEXT         NOT NULL,
  metadata     TEXT         NOT NULL DEFAULT '{}',  -- JSON metadata específica
  sent_at      TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  -- Outcome: se actualiza cuando el mercado resuelve
  outcome      ENUM('correct','incorrect','neutral'),
  outcome_note VARCHAR(512),
  outcome_at   TIMESTAMP,
  INDEX idx_signal_strategy (strategy_id),
  INDEX idx_signal_sent_at  (sent_at),
  INDEX idx_signal_outcome  (outcome)
);

-- Stats diarias precalculadas, un row por (strategy, date)
CREATE TABLE IF NOT EXISTS strategy_daily_stats (
  id                 INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  strategy_id        VARCHAR(64)  NOT NULL,
  date               VARCHAR(10)  NOT NULL,  -- YYYY-MM-DD
  total_runs         INT          NOT NULL DEFAULT 0,
  total_signals      INT          NOT NULL DEFAULT 0,
  signals_correct    INT          NOT NULL DEFAULT 0,
  signals_incorrect  INT          NOT NULL DEFAULT 0,
  signals_neutral    INT          NOT NULL DEFAULT 0,
  signals_pending    INT          NOT NULL DEFAULT 0,
  -- (correct / (correct + incorrect)) * 100, NULL si no hay resueltos
  win_rate_pct       DECIMAL(5,2),
  avg_duration_ms    INT,
  error_count        INT          NOT NULL DEFAULT 0,
  UNIQUE KEY uniq_strategy_date (strategy_id, date)
);

-- ─── S1 + S2: Wallets ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tracked_wallets (
  id               BIGINT        NOT NULL AUTO_INCREMENT PRIMARY KEY,
  address          VARCHAR(42)   NOT NULL UNIQUE,
  label            VARCHAR(128),
  source           VARCHAR(32)   NOT NULL DEFAULT 'auto_detected',
  active           BOOLEAN       NOT NULL DEFAULT TRUE,
  total_trades     INT           NOT NULL DEFAULT 0,
  winning_trades   INT           NOT NULL DEFAULT 0,
  total_volume     DECIMAL(18,2) NOT NULL DEFAULT 0,
  win_rate_pct     DECIMAL(5,2),
  -- score = win_rate * log(total_trades + 1), para rankear
  smart_score      DECIMAL(8,4),
  first_seen_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  last_activity_at TIMESTAMP,
  last_sync_at     TIMESTAMP,
  INDEX idx_wallet_score  (smart_score),
  INDEX idx_wallet_active (active)
);

CREATE TABLE IF NOT EXISTS wallet_trades (
  id             BIGINT        NOT NULL AUTO_INCREMENT PRIMARY KEY,
  wallet_address VARCHAR(42)   NOT NULL,
  market_id      VARCHAR(128)  NOT NULL,
  market_title   VARCHAR(512),
  token_id       VARCHAR(128),
  side           ENUM('buy','sell') NOT NULL,
  price          DECIMAL(10,6) NOT NULL,
  size           DECIMAL(18,4) NOT NULL,
  usdc_value     DECIMAL(18,2),
  tx_hash        VARCHAR(66),
  traded_at      TIMESTAMP     NOT NULL,
  outcome        ENUM('won','lost','void'),
  pnl_usdc       DECIMAL(18,4),
  created_at     TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_trade_wallet     (wallet_address),
  INDEX idx_trade_market     (market_id),
  INDEX idx_trade_traded_at  (traded_at),
  UNIQUE KEY uniq_trade_tx   (tx_hash)
);

-- ─── S3: Prices ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS market_price_snapshots (
  id           BIGINT        NOT NULL AUTO_INCREMENT PRIMARY KEY,
  market_id    VARCHAR(128)  NOT NULL,
  token_id     VARCHAR(128)  NOT NULL,
  price        DECIMAL(10,6) NOT NULL,
  volume_24h   DECIMAL(18,2),
  price_h1_ago DECIMAL(10,6),
  delta_h1_pct DECIMAL(8,4),
  snapshot_at  TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_snap_market (market_id),
  INDEX idx_snap_at     (snapshot_at)
);

CREATE TABLE IF NOT EXISTS odds_moves (
  id               BIGINT        NOT NULL AUTO_INCREMENT PRIMARY KEY,
  market_id        VARCHAR(128)  NOT NULL,
  market_title     VARCHAR(512),
  token_id         VARCHAR(128)  NOT NULL,
  price_from       DECIMAL(10,6) NOT NULL,
  price_to         DECIMAL(10,6) NOT NULL,
  delta_pct        DECIMAL(8,4)  NOT NULL,
  window_minutes   INT           NOT NULL,
  detected_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  resolved_correct BOOLEAN,
  INDEX idx_move_market   (market_id),
  INDEX idx_move_detected (detected_at)
);

-- ─── S4: Order Book ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS order_book_snapshots (
  id               BIGINT        NOT NULL AUTO_INCREMENT PRIMARY KEY,
  market_id        VARCHAR(128)  NOT NULL,
  token_id         VARCHAR(128)  NOT NULL,
  best_bid         DECIMAL(10,6),
  best_ask         DECIMAL(10,6),
  spread           DECIMAL(10,6),
  bid_depth        DECIMAL(18,4),
  ask_depth        DECIMAL(18,4),
  -- bid_depth / (bid_depth + ask_depth)
  imbalance_ratio  DECIMAL(6,4),
  snapshot_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ob_market   (market_id),
  INDEX idx_ob_snap_at  (snapshot_at)
);

CREATE TABLE IF NOT EXISTS order_book_alerts (
  id               BIGINT        NOT NULL AUTO_INCREMENT PRIMARY KEY,
  market_id        VARCHAR(128)  NOT NULL,
  market_title     VARCHAR(512),
  token_id         VARCHAR(128)  NOT NULL,
  imbalance_ratio  DECIMAL(6,4)  NOT NULL,
  direction        VARCHAR(16)   NOT NULL,  -- 'bid_heavy' | 'ask_heavy'
  best_bid         DECIMAL(10,6),
  best_ask         DECIMAL(10,6),
  detected_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  resolved_correct BOOLEAN,
  INDEX idx_oba_market   (market_id),
  INDEX idx_oba_detected (detected_at)
);

-- ─── Queries de consulta útiles ───────────────────────────────────────────────

-- Win rate por estrategia (sobre signals resueltos):
-- SELECT strategy_id,
--        SUM(outcome = 'correct')   AS correct,
--        SUM(outcome = 'incorrect') AS incorrect,
--        ROUND(SUM(outcome='correct') / NULLIF(SUM(outcome IN ('correct','incorrect')), 0) * 100, 2) AS win_rate_pct
-- FROM signals
-- WHERE outcome IS NOT NULL
-- GROUP BY strategy_id;

-- Performance diaria de todas las estrategias:
-- SELECT * FROM strategy_daily_stats ORDER BY date DESC, strategy_id;

-- Signals recientes pendientes de resolución:
-- SELECT * FROM signals WHERE outcome IS NULL ORDER BY sent_at DESC LIMIT 50;