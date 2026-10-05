# Project Context — Polymarket Strategy Bot (krill)

Bot en TypeScript/Node.js para operar y monitorear estrategias en Polymarket. La
capacidad insignia es market making en mercados con rewards (`rewards_executor`),
con modos paper (simulado, default) y real (órdenes CLOB autenticadas).

## Facts clave (fuente de verdad para las specs)

- **Runtime**: `tsx` en desarrollo, `tsc` → `dist/` en producción. No hay tests
  automatizados en el repo; la verificación baseline es `yarn build`.
- **Estrategia activa**: solo `rewards_executor` está registrada en
  `strategies/registry.ts`. Las 5 estrategías de monitoreo están implementadas
  pero comentadas en el registry.
- **Base de datos**: MySQL/MariaDB vía Drizzle + mysql2. El schema fuente de
  verdad es `db/schema.ts`. Ver spec `persistence` para drift conocido.
- **Código muerto conocido** (comportamiento implementado pero no activo):
  - Envío de signals a Telegram comentado en `core/runner.ts` (`handleSignal`).
  - `scheduleWalletSync()` comentado en `startRunner()` (`core/auto-sync-wallet.ts`
    solo es invocable vía `scripts/sync-wallets.ts`).
  - `scheduleRewardsDailyReport()` nunca es llamado (`core/rewards-daily-report.ts`).
  - `rebalanceIfNeeded` en `core/inventory-manager.ts` deshabilitado (siempre `'ok'`).
  - Exit `score_too_low` comentado en `strategies/reward-executor/index.ts`.
  - Requeue en modo real comentado: wall break / out-of-range **cierra** la
    posición (`close_reason='manual'`) en vez de requeuear.
- **Idioma**: dominio, comments, copy de Telegram y docs en español
  (convención del repo, ver `AGENTS.md`).

## Convenciones

- Documentación de dominio en **español**.
- Las specs describen el **estado actual** del sistema (current truth). El
  comportamiento comentado/deshabilitado se documenta en la sección
  **"Deuda y divergencias conocidas"** de cada spec, no como requisito activo.
- Cada requisito referencia los archivos que lo implementan.
- Cambios de comportamiento futuros deben proponerse como deltas sobre estas
  specs (spec-first), no editando la spec directamente.

## Tech stack fijado

Ver `docs/adr/architecture-libraries.md`: `drizzle-orm@0.45.2`, `mysql2@3.20.0`,
`node-telegram-bot-api@0.67.0`, `@polymarket/clob-client-v2@1.0.2`, Express 5,
ethers 6 / viem 2.

## Capacidades especificadas

| Spec | Cobertura |
|---|---|
| `strategy-runner` | Ciclo de vida, scheduling, config, daily report |
| `rewards-executor` | Market making completo (discovery → apertura → monitoreo → salida) |
| `rewards-scoring` | Fórmulas Qmin, precios de orden, sizing dinámico, fees |
| `clob-gateway` | Cliente autenticado CLOB (órdenes, cancel, earnings, auth) |
| `inventory-management` | Sync de inventario real, detección de fills, break-even hedge |
| `order-replacement` | Reprice y requeue (paper y real) |
| `operator-interfaces` | API REST/SSE, comandos Telegram, CLI operativo |
| `market-signals` | 5 estrategías de monitoreo (deshabilitadas) + cooldowns |
| `outcome-resolution` | Resolución nocturna de signals + CLI |
| `persistence` | Schema, módulos de queries, drift de migraciones |
