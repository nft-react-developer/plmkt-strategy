# Order Replacement Specification

## Purpose

Lógica de repricing (cancelar y recolocar al nuevo mid) y requeue FIFO
(cancelar y recolocar al mismo precio para ganar cola) de las órdenes LP de una
posición. Implementado en `core/order-replacer.ts`, invocado desde
`strategies/reward-executor/index.ts`.

## Requirements

### Requirement: Repricing por movimiento de mid
`repriceIfNeeded(positionId, tokenIdYes, currentMidprice, maxSpreadCents,
sizePerSideUsdc, dualSideRequired, params)` SHALL repricingar cuando
`|mid − referencia| > threshold` (default 1.5¢), con tope de 10 reprices por
hora por posición (ventana en memoria). Los nuevos precios SHALL calcularse con
`calcOrderPrices` y acumularse la estimación de taker fee en la posición.

### Requirement: Reprice en modo real
En modo real, un reprice SHALL cancelar todas las órdenes del mercado
(`cancelAllForMarket`), repostear cada lado con `postOnly:true` e insertar las
nuevas filas en `orders`.

### Requirement: Reprice en modo paper
En paper, un reprice SHALL insertar las nuevas órdenes en DB con
`status='simulated'` sin tocar el CLOB.

### Requirement: Requeue FIFO con cooldown
`requeueIfNeeded` SHALL cancelar y recolocar al **mismo precio** (ganar cola
FIFO del CLOB), gated por `requeueIntervalMinutes` (default 45) por posición
(timestamps en memoria). `forceIfOutOfRange=true` SHALL saltear el gate.

### Requirement: Requeue en modo paper
En paper, el requeue SHALL ser solo inserción de filas en DB (no toca el CLOB),
con el mismo gate de intervalo.

### Requirement: Limpieza de trackers
`clearRepriceTracker` / `clearRequeueTracker` SHALL existir para resetear los
estados en memoria al cerrar posiciones.

## Scenarios

#### Scenario: Mid se mueve 2¢
- **WHEN** `|mid − referencia| = 2¢` (> 1.5¢)
- **THEN** se cancelan las órdenes actuales y se recolocan al nuevo mid con
  `calcOrderPrices`.

#### Scenario: Requeue dentro del cooldown
- **WHEN** se invoca requeue antes de cumplir `requeueIntervalMinutes`
- **THEN** no se ejecuta (salvo `forceIfOutOfRange`).

#### Scenario: Tope de reprices por hora
- **WHEN** una posición ya repricingó 10 veces en la hora
- **THEN** `repriceIfNeeded` no hace nada hasta que caiga una ventana.

## Deuda y divergencias conocidas

- La "referencia" de reprice es `pos.entryMidprice`: el código nunca la
  actualiza tras repricingar, así que todo reprice mide contra el mid original
  de entrada. En la práctica, un movimiento >15% cierra la posición primero.
- En paper, las órdenes viejas nunca se marcan canceladas (comentario
  pendiente): el requeue inserta filas nuevas cada 45 min por posición — la
  tabla `orders` crece sin bound en modo paper.
- `cancelAndRequeueOnWallBreak` (variante sin gate) no tiene callers activos.
- En reprice real, las nuevas filas quedan con `clobOrderId=null`: la detección
  de fills y el inventario pierden el rastro de esas órdenes.
- Trackers en memoria: un restart resetea topes y cooldowns.
