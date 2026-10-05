# Market Signals Specification

## Purpose

Las cinco estrategías de monitoreo de mercado/wallets. Están **implementadas
pero deshabilitadas**: comentadas en `strategies/registry.ts`, por lo que no
corren en el bot. Se especifican para preservar su contrato y facilitar su
rehabilitación. Comparten el `CooldownManager` (`core/cooldown.ts`).

## Requirements

### Requirement: Whale tracker
`whale_tracker` SHALL alertar trades recientes (≤30 min, ≥$500) de wallets
calificadas (winRate ≥60%, ≥20 trades, top-N por score) con cooldown por
`address:txHash` (2h). Severidad por tamaño (≥$5k high, ≥$1k medium).
Default: `intervalSeconds:120, topN:30, minWinRate:0.60, minTrades:20,
alertThresholdUsdc:500, cooldownMinutes:120, maxTradeAgeMinutes:30`.

### Requirement: Smart money
`smart_money` SHALL agrupar trades de 6h de wallets con smartScore ≥5.0 por
mercado y alertar cuando ≥2 wallets distintas confluyen, con cooldown por
mercado (2h). El filtro `minMarketVolume` se aplica por trade (`usdcValue`), no
por volumen de mercado. Default: `intervalSeconds:300, minSmartScore:5.0,
minWalletsConfluence:2, lookbackHours:6, minMarketVolume:1000,
cooldownMinutes:120`.

### Requirement: Odds mover
`odds_mover` SHALL comparar precio por token contra snapshot de ~N minutos
(ventana ±5 min) y alertar si `|Δ| >= minDeltaPct` (8%) y el movimiento es
rentable tras taker fee (`isProfitable(...).netPnlPct >= minNetPnlPct` 1%).
Debe persistir snapshot + fila en `odds_moves` y hacer cooldown por
`market:token` (1h). Default: `intervalSeconds:60, windowMinutes:15,
minDeltaPct:8.0, minNetPnlPct:1.0, minVolume24h:5000, maxMarketsPerRun:50,
cooldownMinutes:60`.

### Requirement: Order book imbalance
`order_book` SHALL medir el ratio de imbalance sobre 5 niveles de profundidad
del CLOB y alertar si ≥0.70 (`bid_heavy`) o ≤0.30 (`ask_heavy`), con cooldown
por `market:direction` (los cambios de dirección sí alertan). Persiste
`order_book_snapshots` + `order_book_alerts`. Default: `intervalSeconds:90,
imbalanceThreshold:0.70, depthLevels:5, minMarketVolume24h:2000,
maxMarketsPerRun:30, cooldownMinutes:60`.

### Requirement: Resolution arb
`resolution_arb` SHALL escanear mercados cerrados (Gamma) y alertar si el
token ganador heuristico (precio ≥0.5, máximo precio) cotiza ≤0.99 con
descuento ≥3% y neto fee-adjusted ≥0.5%. La detección del ganador es
heurística y el propio código lo advierte. Default: `intervalSeconds:90,
minDiscount:0.03, minNetPnlPct:0.5, minVolume:1000, maxMarketsPerRun:40,
cooldownMinutes:30`.

### Requirement: Cooldowns con respaldo DB
`CooldownManager` SHALL chequear primero memoria y luego la tabla
`signal_cooldowns` (SQL crudo), con `stamp()` para persistir y `cleanup()` para
purgar entradas viejas (7d).

## Scenarios

#### Scenario: Doble alerta del mismo trade
- **WHEN** un trade de whale ya alertado vuelve a aparecer en el lookback
- **THEN** el cooldown por `address:txHash` lo suprime.

#### Scenario: Confluencia de wallets
- **WHEN** 3 wallets con score ≥5.0 operaron el mismo mercado en 6h
- **THEN** `smart_money` emite un signal con severidad según cantidad de
  wallets.

## Deuda y divergencias conocidas

- **Ninguna corre hoy**: el registry solo activa `rewards_executor`.
- `whale_tracker` es ineffectivo aunque se reactive: el sync de wallets escribe
  `totalTrades:0` siempre, y el filtro exige ≥20.
- `signal_cooldowns` no existe ni en `db/schema.ts` ni en `db/migration.sql`:
  la tabla debe existir out-of-band o `CooldownManager` falla.
- `CooldownManager.isReady` pre-sella memoria cuando la DB dice ready; si el
  caller nunca hace `stamp()`, la key queda bloqueada en memoria un cooldown
  completo aunque la DB no la registró.
- `core/auto-sync-wallet.ts` está implementado pero desconectado del runner;
  `scripts/sync-wallets.ts` duplica su lógica casi verbatim.
