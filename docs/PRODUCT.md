# Product — Polymarket Strategy Bot

This product helps operate and monitor Polymarket strategies, with the current focus on reward-market making: selecting reward markets, placing liquidity orders, tracking reward accrual, and managing risk through paper/manual/real modes.

## Product summary

| Topic | Definition |
|---|---|
| Primary user | Operator/trader running a Polymarket strategy bot. |
| Main outcome | Earn/estimate liquidity rewards while avoiding unnecessary fills, fees, and out-of-range orders. |
| Current flagship capability | `rewards_executor` market-making strategy. |
| Secondary capabilities | Wallet intelligence, odds movement alerts, order-book imbalance alerts, resolution-arb alerts. |
| Interfaces | CLI, Telegram commands, REST endpoints, SSE reward-market viewer, MySQL configuration. |

## Core workflows

### 1. Run the bot

```bash
yarn dev
```

What happens:

1. Connects to MySQL.
2. Ensures registered strategies exist in `strategy_config`.
3. Starts enabled strategies.
4. Starts Telegram command polling if configured.
5. Starts the API server.

### 2. Inspect reward markets

```bash
yarn api
# then open http://localhost:3001/reward-markets/live
```

Available endpoints:

| Endpoint | Purpose |
|---|---|
| `GET /reward-markets` | Snapshot of current reward markets. |
| `GET /reward-markets/live` | Browser viewer backed by SSE. |
| `GET /reward-markets/stream` | Raw SSE feed. |
| `POST /positions/enter` | Queue a manual market entry by `condition_id`. |

### 3. Control strategy state

```bash
yarn cli status
yarn cli enable rewards_executor
yarn cli disable rewards_executor
yarn cli set-param rewards_executor paperTrading true
```

Strategy behavior is configured through `strategy_config.params`, so many changes apply on the next tick without restarting.

### 4. Use manual entry mode

Manual entry is for “wait for my signal” operation.

```sql
UPDATE strategy_config
SET params = '{"paperTrading": false, "manualEntryOnly": true}'
WHERE strategy_id = 'rewards_executor';
```

Then queue a market:

```bash
curl -X POST http://localhost:3001/positions/enter \
  -H 'Content-Type: application/json' \
  -d '{"condition_id":"0x..."}'
```

The bot processes the queued market on the next rewards executor tick.

## Rewards executor behavior

| Phase | Product behavior |
|---|---|
| Discovery | Finds current sponsored reward markets and filters by daily rate/min size. |
| Selection | Applies banned keywords, spread/depth/liquidity checks, cooldowns, position limits, and optional manual-only mode. |
| Sizing | Uses dynamic capital allocation based on liquidity, bounded by configured limits. |
| Placement | Places BUY/SELL style liquidity orders in paper or real mode. |
| Monitoring | Samples book state, computes estimated reward score, tracks in-range status, and stores accruals. |
| Maintenance | Reprices after meaningful midprice moves and requeues when orders are out of range or no wall protects queue position. |
| Exit | Closes positions on reward end, rate drop, price move, max age, or manual close reason. |

## Operator-facing metrics

| Metric | Meaning |
|---|---|
| `rewardsEarnedUsdc` | Estimated rewards accumulated by the bot. |
| `feesPaidUsdc` | Estimated or tracked fees. |
| `pnlUsdc` | Rewards minus fees at close. |
| `samplesInRange / samplesTotal` | How often a position appeared reward-eligible. |
| `totalQmin` | Accumulated score proxy for reward contribution. |
| `strategy_run_log.error` | Runtime failure signal per strategy tick. |
| `signals.outcome` | Manual/automatic resolution for strategy win-rate analysis. |

## Configuration knobs

Important `rewards_executor` params:

| Param | Product meaning |
|---|---|
| `paperTrading` | Simulated vs real CLOB trading. |
| `manualEntryOnly` | Disables automatic market opening; only queued markets are entered. |
| `maxPositions` | Maximum simultaneous open positions. |
| `totalCapitalUsdc` | Capital basis for position sizing. |
| `fetchMinRatePerDay` | Minimum daily reward rate for discovery. |
| `fetchMaxMinSize` | Maximum allowed Polymarket min-size filter for discovery. |
| `placementStrategy` | `tight`, `mid`, or `wide` order placement. |
| `earningsCheckDelayMinutes` | Delay before treating zero earnings share as out-of-range. |
| `requeueIntervalMinutes` | Cooldown between FIFO requeue attempts. |
| `maxDaysOpen` | Maximum position lifetime. |

## Product boundaries

This bot is not a fully autonomous portfolio manager. The current product assumes an operator understands market risk, wallet funding, Polymarket mechanics, and real-order consequences.

Out of scope unless explicitly designed:

- Guaranteed profitability.
- Full liquidation/risk engine across all markets.
- Multi-user permissions.
- Backtesting framework.
- Hosted UI beyond the lightweight reward-market viewer.

## Roadmap candidates

- Add automated tests around rewards scoring, order placement decisions, and inventory sync.
- Add a dedicated `last_reprice_midprice` field instead of overloading `entryMidprice`.
- Promote manual close/position controls into API/Telegram flows.
- Add clearer real-vs-estimated reward reconciliation reports.
- Reconcile stale TODO documents with current implementation state.
