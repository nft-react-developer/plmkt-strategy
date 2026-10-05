# Persistence Specification

## Purpose

Modelo de datos y acceso: schema Drizzle (`db/schema.ts`), conexión
(`db/connection.ts`), queries (`db/queries.ts`, `db/queries-paper.ts`) y
migraciones SQL (`db/migration.sql`).

## Requirements

### Requirement: Schema fuente de verdad
`db/schema.ts` SHALL ser la fuente de verdad del modelo. Tablas:
`strategy_config`, `strategy_run_log`, `signals`, `strategy_daily_stats`,
`tracked_wallets`, `wallet_trades`, `market_price_snapshots`, `odds_moves`,
`order_book_snapshots`, `order_book_alerts`, `positions`, `orders`,
`reward_accruals`, `daily_pnl`, `manual_entry_queue`.

### Requirement: Grupos de tablas
- **Runtime de estrategias**: `strategy_config`, `strategy_run_log`, `signals`,
  `strategy_daily_stats`.
- **Inteligencia de wallets**: `tracked_wallets`, `wallet_trades`.
- **Monitoreo**: `market_price_snapshots`, `odds_moves`,
  `order_book_snapshots`, `order_book_alerts`.
- **Market making**: `positions`, `orders`, `reward_accruals`, `daily_pnl`,
  `manual_entry_queue`.

### Requirement: Campos clave de market making
`positions` SHALL llevar: modo (`paper_trading`), mercado (ids, slugs, tokens
YES/NO), config de rewards (`dailyRewardUsdc`, `maxSpreadCents`,
`minSizeShares`, `rewardEndDate`, `scalingFactorC`), sizing (`sizeUsdc`,
`sizePerSideUsdc`), entrada (`entryMidprice`, bid/ask/spread,
`dualSideRequired`, `totalLiquidityUsdc`), estado (`status`, `close_reason`,
timestamps) y métricas acumuladas (`rewardsEarnedUsdc`, `feesPaidUsdc`,
`pnlUsdc`, `totalQmin`, `samplesInRange/Total`).

`orders` SHALL llevar: posición, modo, token, lado, precio, tamaños,
`spreadFromMidCents`, `status` (`simulated|open|filled|cancelled`), datos de
fill, `feePaidUsdc` y `clobOrderId` (null en paper y en repricados reales).

### Requirement: Módulos de queries
`db/queries.ts` SHALL agrupar: `strategyQueries` (incluye `ensureExists`
insert-if-missing que jamás pisa params), `runLogQueries`, `signalQueries`,
`dailyStatsQueries`, `walletQueries`, `walletTradeQueries`,
`priceSnapshotQueries`, `oddsMoveQueries`, `orderBookQueries`.
`db/queries-paper.ts` SHALL agrupar: `positionQueries`, `orderQueries`,
`accrualQueries`, `dailyPnlQueries`.

### Requirement: Conexión
`getDb()` SHALL ser un singleton de pool mysql2 (env `DATABASE_HOST_NAME`,
`DB_PORT`, `DATABASE_USER_NAME`, `DATABASE_USER_PASSWORD`,
`DATABASE_DB_NAME` default `polymarket_strategies`; límite 10 con keepAlive).
`testConnection()` SHALL requerir pool inicializado (por eso `index.ts` llama
`getDb()` antes).

### Requirement: Modo paper y real coexisten
Todas las tablas de market making SHALL llevar `paper_trading`, permitiendo
ambos modos en la misma DB. `hasOpen` y `getOpen` SHALL filtrar por modo.

## Scenarios

#### Scenario: Apertura y cierre de posición
- **WHEN** se abre y luego cierra una posición
- **THEN** la fila conserva entrada, métricas acumuladas y `close_reason`; el
  cierre fija `pnlUsdc = rewardsEarned − feesPaid`.

#### Scenario: Config de estrategia preexistente
- **WHEN** `ensureExists` corre sobre una estrategia ya configurada
- **THEN** no modifica `params` ni `enabled` existentes.

## Deuda y divergencias conocidas

- **Drift de migraciones**: `db/migration.sql` solo cubre las 8 tablas "stage
  1" (runtime + wallets + monitoreo). Faltan DDL versionados para `positions`,
  `orders`, `reward_accruals`, `daily_pnl`, `manual_entry_queue` (las tablas de
  market making se crearon out-of-band).
- `signal_cooldowns` (usada por SQL crudo en `core/cooldown.ts`) no está ni en
  schema ni en migration: debe existir en la DB real.
- `db/update-position.sql` es un cierre manual de emergencia (todas las
  posiciones reales abiertas → `closed`/`manual`).
- Escrituras con `.catch(() => {})` pervasivas: inserts de accruals/snapshots
  pueden fallar silenciosamente.
- `walletQueries.upsert` escribe `totalTrades:0` en conflicto, lo que
  inutiliza el filtro de whale_tracker (ver spec `market-signals`).
