# Rewards Scoring Specification

## Purpose

Aproximación de la fórmula oficial de rewards de Polymarket para estimar
score y recompensa por minuto, calcular precios de colocación LP, tamaño
dinámico de posición y fees de taker. Implementado en `core/rewards-scoring.ts`,
`utils/fees.ts` y helpers en `strategies/reward-executor/index.ts`.

## Requirements

### Requirement: Score de una orden
`scoreOrder(v, s, b=1)` SHALL devolver `((v−s)/v)² × b` con `v` y `s` en
centavos, y 0 si `s >= v` o `s < 0`. Es la aproximación de la fórmula oficial.

### Requirement: Score de muestra por minuto
`calcSampleScore` SHALL computar por lado: `Qne = Σ bids-YES + asks-NO` y
`Qno = Σ asks-YES + bids-NO` (con `scoreOrder` a `maxSpreadCents` de distancia
del mid). Si el mid es extremo (`<0.10` o `>0.90`), dual-side es obligatorio:
`Qmin = min(Qne,Qno)`; si no, `Qmin = max(min(Qne,Qno), max(Qne/c, Qno/c))`
con `scalingFactorC` (3.0 al abrir).

### Requirement: Recompensa estimada por muestra
El resultado SHALL incluir `normalizedProxy = Qmin / totalLiquidityUsdc` y
`rewardUsdc = normalizedProxy × dailyRewardUsdc / 1440` (rate diario prorrateado
por minuto).

### Requirement: Midprice
`calcMidprice(bestBid, bestAsk)` SHALL devolver el punto medio, con fallback al
 lado presente si uno falta, o `null` si no hay ninguno.

### Requirement: Precios de orden LP
`calcOrderPrices(midprice, maxSpreadCents, sizePerSideUsdc, dualSideRequired, placement)`
SHALL devolver siempre pares buy/sell con distancia al mid según placement:
`tight` = 1¢, `mid` = maxSpread/2, `wide` = 0.8×maxSpread; clamp de distancia a
`[0.5, maxSpread−0.5]`¢, redondeo a tick 0.01, precios clamp a [0.01, 0.99], y
`sizeShares = usdc / price`.

### Requirement: Sizing dinámico
`calcDynamicSize(totalCapitalUsdc, liquidityUsdc)` SHALL asignar 20% / 10% / 5%
del capital para liquidez <5k / <30k / mayor, con clamp a [30, 150] USD.

### Requirement: Modelo de taker fees
`utils/fees.ts` SHALL modelar el fee de taker vigente (2026-03-30) como
`C × (p(1−p))^exp` normalizado a pico en p=0.5, con tabla de categorías:
crypto 1.8%/exp1, sports 0.75%/exp20, politics/finance/tech/culture
1.0%/exp20–25, economics 1.5%/exp0.5, weather 1.25%/exp0.5, other 1.2%/exp2,
mentions 1.5%/exp2, geopolitics 0%, unknown 1.0%/exp1/20.

### Requirement: Rentabilidad neta
`isProfitable(buy, target, category)` SHALL computar PnL neto restando el fee
total sobre el precio de compra; `netPnlPct = net / buy × 100`.
`parseCategory(tag)` SHALL matchear por substring y mapear `null` a `'unknown'`.

## Scenarios

#### Scenario: Orden en el borde del rango
- **WHEN** `s >= v` en `scoreOrder`
- **THEN** el score es 0: la orden no contribuye al Qmin de la muestra.

#### Scenario: Mid extremo obliga dual side
- **WHEN** el midprice es 0.95
- **THEN** `Qmin = min(Qne, Qno)` aunque un lado tenga mucha más profundidad.

#### Scenario: Placement wide reduce riesgo de fill
- **WHEN** `placementStrategy='wide'` con maxSpread 4¢
- **THEN** las órdenes se colocan a 3.2¢ del mid (0.8×4), clamp a 3.5¢ si
  excede `maxSpread−0.5`.

## Deuda y divergencias conocidas

- El executor estima sus fees de entrada siempre con categoría `'unknown'`
  (ignora tags del mercado).
- `minScoreThreshold` (param del executor) no se consume en el código actual.
- La fórmula es una aproximación; el sistema real de Polymarket puede discrepar
  (ver histórico en `docs/TODO-out-of-range-detection.md`).
