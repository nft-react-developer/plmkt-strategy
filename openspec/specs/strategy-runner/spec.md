# Strategy Runner Specification

## Purpose

Orquestar el ciclo de vida de las estrategias registradas: asegurar su fila de
configuración en DB, schedulear su ejecución secuencial sin solapamiento,
fusionar parámetros de DB sobre defaults, persistir resultados y producir
reportes. Implementado en `core/runner.ts`, contrato en
`core/strategy.interface.ts`, registro en `strategies/registry.ts`.

## Requirements

### Requirement: Contrato de estrategía
Toda estrategia SHALL implementar la interfaz `Strategy`
(`core/strategy.interface.ts`): `id` (snake_case único), `name`,
`description`, `defaultParams`, `run(params)`, y opcionalmente `init(params)` y
`teardown()`. `run` SHALL devolver `{ signals, metrics? }`.

### Requirement: Registro activo
El sistema SHALL ejecutar únicamente las estrategías listadas en
`strategies/registry.ts`. Hoy solo `rewards_executor` está activa; las cinco
estrategías de monitoreo están comentadas en el registry.

### Requirement: Auto-registro en DB
Al arrancar, el runner SHALL asegurar una fila en `strategy_config` por cada
estrategía registrada (`strategyQueries.ensureExists`). La operación SHALL ser
insert-if-missing: jamás SHALL sobreescribir `params` de una fila existente.

### Requirement: Scheduling secuencial anti-solapamiento
Cada estrategia SHALL ejecutarse con `setTimeout` recursivo (no `setInterval`):
el próximo tick se agenda solo al terminar el anterior. El primer tick SHALL
disparar inmediatamente. El intervalo SHALL ser `params.intervalSeconds ?? 60`.
Esto previene ejecuciones solapadas que duplicarían posiciones.

### Requirement: Merge de parámetros por tick
En cada tick el runner SHALL releer `strategy_config` desde DB, saltear el tick
si `enabled=false`, y fusionar `{...defaultParams, ...dbParams}` (DB gana).
JSON inválido en `params` SHALL lanzar error logueado en `strategy_run_log`.

### Requirement: Persistencia de ejecución
Cada tick SHALL registrarse en `strategy_run_log` (duración, cantidad de
signals, error si lo hubo, metrics JSON). Los signals SHALL persistirse en la
tabla `signals` vía `handleSignal`.

### Requirement: Signals sin envío a Telegram
`handleSignal` SHALL persistir el signal en DB pero NO enviarlo a Telegram:
la línea `telegram.sendSignal` está comentada. Los reportes de Telegram que
existen hoy son: startup, daily strategy report, outcome resolution report y
los que `rewards_executor` empuja por su cuenta (apertura/cierre de posición).

### Requirement: Reporte diario de estrategias
El runner SHALL correr un reporte diario a las 00:00 UTC
(`scheduleDailyReport`): por cada estrategia registrada calcula win-rate de las
últimas 24h sobre `signals` resueltas, resume `strategy_run_log`, hace upsert en
`strategy_daily_stats` (para "ayer" UTC) y envía `sendDailyStrategyReport` por
Telegram.

### Requirement: Resolución nocturna de outcomes
El runner SHALL invocar `scheduleOutcomeResolver()` (03:00 UTC) de
`core/resolve-outcomes.ts`. Ver spec `outcome-resolution`.

### Requirement: Control de enable/disable en runtime
El runner SHALL exportar `enableStrategy` / `disableStrategy` /
`getActiveStrategies`. El flag `enabled` en DB SHALL ser releído en cada tick,
por lo que cambios por SQL o CLI aplican sin reiniciar (el timer sigue
disparando pero el tick se salta).

### Requirement: Shutdown limpio
En SIGINT/SIGTERM (`index.ts`) el runner SHALL limpiar timers y llamar
`teardown()` de cada estrategia registrada, y cerrar el pool de DB.

## Scenarios

#### Scenario: Alta de estrategia nueva sin tocar datos existentes
- **WHEN** arranca el proceso con una estrategía nueva registrada
- **THEN** se inserta `strategy_config` con sus `defaultParams`; las filas
  existentes conservan sus `params` modificados por operador.

#### Scenario: Cambio de parámetro sin reiniciar
- **WHEN** el operador actualiza `strategy_config.params` por SQL/CLI
- **THEN** el cambio aplica en el próximo tick sin reiniciar el proceso.

#### Scenario: Estrategia deshabilitada en runtime
- **WHEN** `enabled=false` para una estrategia con timer activo
- **THEN** el timer sigue disparando pero cada tick se saltea hasta volver a
  habilitarla.

#### Scenario: Tick con error
- **WHEN** `strategy.run()` lanza
- **THEN** el error se persiste en `strategy_run_log.error` y el schedule
  continúa en el próximo intervalo.

## Deuda y divergencias conocidas

- Envío de signals a Telegram comentado (`handleSignal`).
- `scheduleWalletSync()` comentado: el sync de wallets no corre dentro del bot.
- `scheduleRewardsDailyReport()` nunca se invoca (reporte diario de rewards
  implementado pero huérfano).
- `/pause` y `/resume` de Telegram escriben `enabled` directo en DB sin pasar
  por el runner (efectivo vía skip de tick, pero los timers no se destruyen).
- Ninguna estrategia implementa `teardown()` hoy.
- `init()` que lanza (p.ej. `verifyAuth` fallido en modo real) es capturado por
  el runner: loguea y schedulea igualmente la estrategia.
