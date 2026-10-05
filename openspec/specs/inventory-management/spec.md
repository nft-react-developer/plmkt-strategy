# Inventory Management Specification

## Purpose

Sincronización de inventario real con el CLOB: estado de órdenes vivas,
detección de fills, cómputo de exposición y PnL, cobertura break-even y cierre
de posiciones reales. Implementado en `core/inventory-manager.ts`.

## Requirements

### Requirement: Sincronización por posición
`syncInventory(positionId, tokenIdYes, tokenIdNo, midprice, params)` SHALL
consultar el CLOB (órdenes abiertas y trades) y calcular: `openBid`/`openAsk`
(primera BUY/SELL live), `sharesLong`, `sharesShort`, `netExposure`,
`avgEntryPrice`, `unrealizedPnl`. El estado SHALL guardarse en un Map en
memoria (`inventoryState`) indexado por token.

### Requirement: Detección de fills
Por cada orden en DB con `clobOrderId` ausente de las órdenes live, el sistema
SHALL buscar match en el historial de trades (`order_id`/`maker_order_id`) y
actualizar su estado a `filled` o `cancelled`
(`orderQueries.updateStatusByClobId`).

### Requirement: Alerta de exposición
Si `|netExposure| × mid > maxInventoryValueUsdc`, el sistema SHALL loguear
advertencia de inventario excedido.

### Requirement: Break-even hedge
Si `netExposure >= 0.01` y no hay hedge trackeado, `rebalanceWithBreakEvenHedge`
SHALL postear LIMIT SELL al `avgEntryPrice` (sin postOnly) para cubrir la
exposición como maker. El hedge SHALL trackearse en memoria
(`breakEvenHedgeOrders`) para no repetir el posteo, y SHALL limpiarse cuando la
exposición vuelve a 0 o al cerrar la posición (`clearBreakEvenHedge`).

### Requirement: Cierre de posición real
`closeInventoryPosition(state, midprice)` SHALL cancelar `openBid`/`openAsk` y,
si `|netExposure| >= 0.01`, liquidar a mid ∓ 0.01 (SELL si long, BUY cover si
short). Los errores de liquidación se capturan y loguean (no lanzan).

## Scenarios

#### Scenario: Fill de una orden LP
- **WHEN** una orden con `clobOrderId` ya no está en órdenes live y aparece en
  trades
- **THEN** su fila en `orders` pasa a `filled` y el net exposure se recalcula
  en el próximo `syncInventory`.

#### Scenario: Inventario largo sin cobertura
- **WHEN** tras el sync `netExposure >= 0.01` y no hay hedge activo
- **THEN** se postea LIMIT SELL al precio de entrada y queda trackeado; en
  ticks siguientes no se duplica.

#### Scenario: Cierre con exposición residual
- **WHEN** se cierra una posición con `|netExposure| >= 0.01`
- **THEN** se cancelan las órdenes LP y se liquida la exposición a mercado
  (mid ∓ 0.01) con error capturado.

## Deuda y divergencias conocidas

- `rebalanceIfNeeded` está hard-deshabilitado (siempre `'ok'`): el CLOB rechaza
  el hedge SELL con balance comprometido y el PnL de rewards viene de la
  resolución, no del spread.
- `breakEvenHedgeOrders` es en memoria: un restart pierde el tracking y puede
  duplicar el SELL de cobertura.
- Órdenes reales repricadas quedan con `clobOrderId=null` en DB (ver spec
  `order-replacement`), por lo que la detección de fills no las rastrea.
- `rebalanceCooldown` (5 min) existe pero no tiene efecto con rebalance
  deshabilitado.
- Defaults internos: `maxExposureShares:50`, `hedgeThresholdShares:25`,
  `maxInventoryValueUsdc:100`.
