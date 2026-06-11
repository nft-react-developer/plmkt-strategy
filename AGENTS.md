# Agent Guide — Polymarket Strategy Bot

This repository is a TypeScript bot for monitoring and executing Polymarket strategies. Treat it as financial automation: small code changes can place, cancel, or mis-track real orders.

## Quick path

1. Read `README.md`, `docs/ARCHITECTURE.md`, and `docs/PRODUCT.md` before changing behavior.
2. Check current git state before edits:
   ```bash
   git status --short
   ```
3. Use the TypeScript compiler as the baseline verification:
   ```bash
   yarn build
   ```
4. For runtime checks, prefer paper/manual modes unless the user explicitly authorizes real trading.

## Project shape

| Area | Purpose |
|---|---|
| `index.ts` | Main process: DB connection, strategy runner, Telegram commands, API server. |
| `core/` | Strategy orchestration, CLOB client, rewards scoring, inventory, order replacement, outcome resolution. |
| `strategies/` | Pluggable strategy implementations registered in `strategies/registry.ts`. |
| `db/` | Drizzle schema, connection, strategy queries, and market-making queries. |
| `api/` | Express API and SSE viewer for reward markets/manual entry. |
| `telegram/` | Telegram notifications and command listener. |
| `scripts/` | Operational scripts for API keys, auth, wallet sync, market updates, CLI, and outcome resolution. |
| `docs/` | Architecture, product notes, ADRs, risk notes, and implementation TODOs. |

## Operating rules

- Never commit secrets or `.env` files.
- Never add AI attribution or `Co-Authored-By` trailers to commits.
- Do not run real-trading flows unless the user explicitly asks and the relevant `.env` values are intentionally configured.
- Preserve user work: inspect `git status --short` before editing and do not revert unrelated changes.
- Prefer small, reviewable changes with conventional commit messages.
- Keep generated UI copy, comments, and docs consistent with the existing repo language. This repo currently documents most domain behavior in Spanish.

## Trading safety

| Action | Safety expectation |
|---|---|
| Changing `core/clob-client.ts` | Verify auth/order semantics carefully; this wraps authenticated CLOB actions. |
| Changing `strategies/reward-executor/index.ts` | Treat as high-risk; it opens/closes/requeues positions and can place real orders. |
| Changing `core/inventory-manager.ts` | Verify fill detection, exposure calculation, and CLOB order IDs. |
| Changing `core/order-replacer.ts` | Verify cancel/repost behavior, rate limits, and DB order tracking. |
| Changing DB schema | Update `db/migration.sql` and Drizzle schema together. |

## Strategy conventions

A strategy must implement `Strategy` from `core/strategy.interface.ts` and be registered in `strategies/registry.ts`.

Minimum contract:

- `id`: unique `snake_case` identifier.
- `defaultParams`: safe defaults; DB `strategy_config.params` overrides these at runtime.
- `run(params)`: returns `signals` and optional numeric `metrics`.
- Optional `init()` and `teardown()` for lifecycle hooks.

The runner merges DB params on every tick, so parameter changes can apply without restart.

## Runtime modes

| Mode | How it is controlled | Notes |
|---|---|---|
| Paper trading | `rewards_executor.params.paperTrading=true` | Simulates market-making state in DB. |
| Real trading | `paperTrading=false` + CLOB credentials | Places/cancels real CLOB orders. Requires explicit care. |
| Manual entry | `manualEntryOnly=true` + `POST /positions/enter` | Waits for user-selected `condition_id` before opening. |
| Strategy enablement | `strategy_config.enabled` | Can be changed via DB or CLI. |

## Verification checklist

- [ ] `git status --short` reviewed before and after changes.
- [ ] `yarn build` passes, or failure is documented with exact reason.
- [ ] New strategy params are documented in README/product docs when user-facing.
- [ ] Trading changes are checked in paper mode first when possible.
- [ ] DB changes include schema + migration updates.
