# Outcome Resolution Specification

## Purpose

Resolver el outcome (`correct`/`incorrect`/`neutral`) de los signals para el
cálculo de win-rate: corrida nocturna automática (03:00 UTC) y mirror vía CLI.
Implementado en `core/resolve-outcomes.ts` y `scripts/resolve-outcomes.ts`.

## Requirements

### Requirement: Corrida nocturna
El runner SHALL invocar `scheduleOutcomeResolver(hourUTC=3)`. La corrida SHALL
cargar signals sin resolver de los últimos N días (default 14) y procesarlas
por estrategia según su metadata.

### Requirement: Resolución por estrategia
- `whale_tracker` / `smart_money`: si el mercado cerró, ganador por flag de
  winner o máximo precio; BUY correcto si precio del ganador ≥0.99; SELL
  correcto si <0.01.
- `odds_mover`: direccional con espera de 48h y umbral ±3% vs `priceTo`.
- `order_book`: direccional desde `direction==='bid_heavy'`, espera 24h, ±3%.
- `resolution_arb`: precio actual ≥0.99 → correct; si cerró, precio final
  ≥0.99 → correct con nota de PnL.
- `rewards_hunter`: neutral.
- `rewards_executor`: **sin lógica** — cae al default y el signal queda
  pendiente indefinidamente.

### Requirement: Persistencia y reporte
Cada resolución SHALL escribirse vía `signalQueries.resolveSignal` (outcome,
nota, timestamp). La corrida SHALL enviar reporte Telegram con resueltas,
skipeadas, errores y barras de win-rate (salvo `silent`).

### Requirement: Cache de mercados
La corrida SHALL usar un cache de mercados por ejecución para no re-fetchear
Gamma por signal.

### Requirement: Resolución manual
El operador SHALL poder resolver manualmente vía SQL o `cli resolve <id>
correct|incorrect|neutral [note]`.

## Scenarios

#### Scenario: Signal direccional dentro del umbral
- **WHEN** un `odds_mover` con `priceTo` 0.60 lleva 48h y el precio actual es
  0.615
- **THEN** se marca `correct` con nota del precio alcanzado.

#### Scenario: Mercado aún abierto
- **WHEN** el mercado del signal sigue activo
- **THEN** el signal se saltea (queda pendiente para la próxima corrida).

#### Scenario: Signal del rewards executor
- **WHEN** un signal de `rewards_executor` entra al resolvedor
- **THEN** queda con `outcome=null` para siempre (no hay lógica de resolución).

## Deuda y divergencias conocidas

- No existe resolución para `rewards_executor`: sus signals (apertura/cierre)
  se acumulan pendientes y ensucian las estadísticas de win-rate.
- El script CLI duplica la lógica del core con diffs menores (guards de
  <1h / >48h en odds_mover).
- La detección del ganador en whale/smart_money es heurística (flag winner o
  max price).
