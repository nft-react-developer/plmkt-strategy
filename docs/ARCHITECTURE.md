# Architecture — Polymarket Strategy Bot

The system is a Node.js/TypeScript trading bot with a strategy runner, MySQL persistence through Drizzle, Telegram operations, an Express API, and Polymarket CLOB/Gamma integrations.

## Quick path

1. `index.ts` boots the DB, runner, Telegram command listener, and API server.
2. `core/runner.ts` registers strategies in DB, merges DB params over defaults, and runs enabled strategies sequentially.
3. `strategies/registry.ts` controls which strategies are active in code. Currently only `rewards_executor` is registered.
4. `db/schema.ts` is the source of truth for tables; `db/queries.ts` and `db/queries-paper.ts` wrap persistence.
5. `core/clob-client.ts` is the authenticated gateway for real CLOB orders.

## Runtime topology

```text
index.ts
  ├─ db/connection.ts              MySQL pool + Drizzle singleton
  ├─ core/runner.ts                strategy lifecycle and schedules
  │   ├─ strategies/registry.ts    registered strategy list
  │   ├─ db/queries.ts             strategy config, runs, signals, wallet/order-book data
  │   └─ telegram/notifier.ts      startup, report, signal messages
  ├─ telegram/commands.ts          Telegram operational commands
  └─ api/server.ts                 reward market API, SSE viewer, manual entry endpoint
```

## Strategy lifecycle

| Step | Component | Responsibility |
|---|---|---|
| Register | `core/runner.ts` | Ensures each `Strategy` has a `strategy_config` row. |
| Configure | DB `strategy_config.params` | JSON overrides `defaultParams`; runner refreshes params each tick. |
| Schedule | `scheduleStrategy()` | Uses recursive `setTimeout` to avoid overlapping ticks. |
| Execute | `strategy.run(params)` | Produces signals and metrics. |
| Persist | `runLogQueries`, `signalQueries` | Saves run duration, errors, signal count, and generated signals. |
| Report | `telegram/notifier.ts` | Sends startup/daily/outcome/PnL messages when configured. |

## Core domains

### Strategy monitoring

The historical monitoring strategies are implemented but mostly disabled in the registry:

| Strategy | Purpose | Main storage |
|---|---|---|
| `whale_tracker` | Alerts on large recent trades by high-score wallets. | `tracked_wallets`, `wallet_trades`, `signals` |
| `smart_money` | Detects confluence across top wallets. | `tracked_wallets`, `wallet_trades`, `signals` |
| `odds_mover` | Detects fee-adjusted price moves. | `market_price_snapshots`, `odds_moves`, `signals` |
| `order_book` | Detects CLOB depth imbalance. | `order_book_snapshots`, `order_book_alerts`, `signals` |
| `resolution_arb` | Detects resolved markets trading below 1.0 after fees. | `signals` |

### Rewards executor

`strategies/reward-executor/index.ts` is the current primary runtime path. It manages market making on Polymarket reward markets.

```text
fetch reward markets / manual queue
  → filter market risk and liquidity
  → open position
  → place paper or real CLOB orders
  → sample book + score rewards each tick
  → sync inventory and fills
  → reprice/requeue/hedge when needed
  → close on exit conditions
```

Important collaborators:

| File | Role |
|---|---|
| `core/rewards-scoring.ts` | Polymarket rewards scoring approximation: `Qne`, `Qno`, `Qmin`, order placement prices. |
| `core/clob-client.ts` | Authenticated order posting/canceling, open orders, trades, user earnings health checks. |
| `core/inventory-manager.ts` | Real-order inventory sync, fill detection via `clobOrderId`, break-even hedge tracking. |
| `core/order-replacer.ts` | Reprice and FIFO requeue logic. |
| `strategies/reward-executor/fetch-reward-markets.ts` | Reward market discovery and single-market fetch. |
| `strategies/reward-executor/manual-queue.ts` | DB-backed manual entry queue. |
| `db/queries-paper.ts` | Position, order, reward accrual, and daily PnL persistence. |

## Persistence model

| Table group | Tables | Purpose |
|---|---|---|
| Strategy runtime | `strategy_config`, `strategy_run_log`, `signals`, `strategy_daily_stats` | Config, execution logs, signals, win-rate reporting. |
| Wallet intelligence | `tracked_wallets`, `wallet_trades` | Smart wallet discovery and confluence strategies. |
| Market monitoring | `market_price_snapshots`, `odds_moves`, `order_book_snapshots`, `order_book_alerts` | Historical market/order-book observations. |
| Market making | `positions`, `orders`, `reward_accruals`, `daily_pnl`, `manual_entry_queue` | Rewards executor state, CLOB order tracking, reward estimates, manual queue. |

## External integrations

| Integration | Used by | Notes |
|---|---|---|
| Polymarket CLOB API | Rewards executor, order-book strategy, auth scripts | Real trading requires `PRIVATE_KEY`, `POLY_API_*`, `POLY_FUNDER`, and signature type. |
| Polymarket Gamma API | Monitoring strategies, outcome resolver | Reads market metadata and resolution state. |
| Polymarket Data API | Wallet sync | Reads leaderboard/activity for wallet intelligence. |
| Telegram Bot API | Notifications and commands | Uses `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. |
| MySQL/MariaDB | Entire app | Accessed through Drizzle + mysql2 pool. |

## Risk controls

| Control | Where | Why it matters |
|---|---|---|
| Sequential ticks | `core/runner.ts` | Prevents duplicated positions from overlapping strategy executions. |
| `paperTrading` default | `rewards_executor.defaultParams` | Keeps default behavior simulated. |
| `postOnly` LP orders | `core/clob-client.ts`, reward executor | Avoids crossing the spread as taker for liquidity-providing orders. |
| Break-even hedge | `core/inventory-manager.ts` | Covers filled BUY exposure with a limit SELL at entry price. |
| Earnings health check | `fetchUserEarningsForMarkets()` | Detects orders not earning rewards and can force requeue. |
| DB-backed manual queue | `manual_entry_queue` | Manual entries survive process restarts better than in-memory queues. |

## Known architecture debt

- `core/clob-client.ts` logs wallet/funder debug information during client initialization; avoid expanding this and consider reducing operational exposure.
- `core/order-replacer.ts` reuses `entryMidprice` as the last-reprice reference; a dedicated `last_reprice_midprice` column would be cleaner.
- Several implemented strategies are commented out in `strategies/registry.ts`; behavior in production is therefore narrower than the codebase suggests.
- Tests are not defined in `package.json`; `yarn build` is currently the baseline automated verification.
- Some TODO documents are stale versus implementation state; verify code before trusting TODO status.
