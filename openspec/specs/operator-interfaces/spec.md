# Operator Interfaces Specification

## Purpose

Superficies con las que el operador interactúa: API HTTP/SSE (`api/server.ts`),
comandos de Telegram (`telegram/commands.ts`), notificaciones
(`telegram/notifier.ts`) y CLI operativo (`scripts/cli.ts` + scripts de
mantenimiento).

## Requirements

### Requirement: API sin autenticación
El servidor Express (puerto 3001 por defecto; `API_PORT` en entry standalone)
SHALL exponer endpoints sin autenticación. El único endpoint de mutación es
`POST /positions/enter`.

### Requirement: Entrada manual de mercado
`POST /positions/enter` con body `{ condition_id: string }` SHALL encolar el
mercado en la tabla `manual_entry_queue` (insert idempotente) y responder
`{ queued: true, condition_id }`. Body inválido SHALL responder 400 con mensaje
en español. El rewards executor la procesa en el próximo tick.

### Requirement: Snapshot de reward markets
`GET /reward-markets?minRate&maxMinSize` SHALL devolver el fetch live de
mercados con rewards (defaults 60/500, distintos de los del executor 200/50).

### Requirement: Viewer SSE
`GET /reward-markets/live` SHALL servir una página HTML con cliente
`EventSource`; `GET /reward-markets/stream` SHALL emitir SSE con el cache de
mercados al conectar y en cada poll (`API_INTERVAL_MS`, default 60s). Clientes
desconectados SHALL limpiarse del registro.

### Requirement: Comandos Telegram
El listener de comandos (polling, filtrado a `TELEGRAM_CHAT_ID`) SHALL soportar:
`/current_rewards` (posiciones abiertas por modo + validación real de payouts
vía endpoints de rewards), `/positions`, `/status`, `/pause [id]`, `/resume
[id]`, `/help`. Comandos desconocidos se ignoran.

### Requirement: Pausa global y por estrategia
`/pause` y `/resume` sin argumento SHALL escribir `enabled=false/true` en
**todas** las filas de `strategy_config` (incluidas las de estrategias no
registradas). Con id, SHALL validar existencia de la estrategia.

### Requirement: Notificaciones send-only
`telegram/notifier.ts` SHALL ser un bot sin polling cuyos envíos nunca lancen:
si faltan token/chatId no-op con log; fallos de red se loguean. Métodos:
startup, daily strategy report, outcome resolution report, rewards executor
report, error, raw. El envío de signals individuales está comentado en el
runner.

### Requirement: CLI operativo
`scripts/cli.ts` SHALL soportar: `status`, `enable/disable <id>`, `set-param
<id> <key> <value>` (coerción number/boolean, merge parcial, aplica en próximo
tick), `win-rates [--days]`, `daily-stats [id] [--days]`, `signals <id>
[--limit] [--pending]`, `resolve <id> correct|incorrect|neutral [note]`,
`wallets [--top]`, `run-log <id>`.

### Requirement: Scripts de mantenimiento
- `scripts/sync-wallets.ts` SHALL correr el sync de wallets con flags
  `--limit`/`--min-volume`.
- `scripts/update-markets.ts` SHALL backfillea `positions.market_slug` desde
  Gamma (búsqueda por pregunta; delays de cortesía).
- `scripts/generate-api-keys.ts` SHALL derivar keys L1 e imprimir env vars con
  verificación por reintentos.
- `scripts/verify-auth.ts` SHALL imprimir credenciales y hacer health check.
- `scripts/resolve-outcomes.ts` SHALL ser el mirror CLI del resolvedor
  nocturno (`--dry-run`, `--days`, `--strategy`).

## Scenarios

#### Scenario: Encolar entrada manual
- **WHEN** llega `POST /positions/enter` con `condition_id` válido
- **THEN** responde 200 con `{queued:true}` y la fila queda en
  `manual_entry_queue` para el próximo tick del executor.

#### Scenario: Pausa global por Telegram
- **WHEN** el operador envía `/pause`
- **THEN** todas las filas de `strategy_config` quedan `enabled=false`; los
  timers continúan pero cada tick se salta.

#### Scenario: Validación de payouts reales
- **WHEN** el operador envía `/current_rewards` en modo real
- **THEN** además del estado interno, se comparan payouts reales de ayer y el
  share del pool live contra la estimación interna (factor 0.8–1.2 = OK).

## Deuda y divergencias conocidas

- La API no tiene autenticación: cualquiera en la red puede encolar entradas o
  leer snapshots. Aceptable solo en red local.
- `/pause`/`/resume` escriben DB directo sin coordinar con el runner.
- `scripts/cli.ts` no lista `rewards_executor` en su help (habla de las 4
  estrategías de señales).
- `update-markets.ts` el nombre no refleja que es un backfill de slugs.
- `package.json` referencia scripts inexistentes (`migrate.ts`, `verify-auth2.ts`).
- El resolvedor CLI y el nocturno tienen lógica casi duplicada con diffs menores.
