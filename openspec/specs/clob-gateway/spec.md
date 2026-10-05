# CLOB Gateway Specification

## Purpose

Wrapper autenticado sobre el CLOB de Polymarket (`@polymarket/clob-client-v2`):
posteo y cancelación de órdenes, consultas de órdenes/trades, health check de
earnings y verificación de autenticación. Implementado en `core/clob-client.ts`
(singleton `getClobClient()`).

## Requirements

### Requirement: Credenciales
El cliente SHALL requerir las env vars `PRIVATE_KEY`, `POLY_API_KEY`,
`POLY_API_SECRET`, `POLY_API_PASSPHRASE`, `POLY_FUNDER` y `POLY_SIGNATURE_TYPE`
(default 2 = Gnosis Safe en este repo).

### Requirement: Posteo de órdenes
`postOrder({tokenId, price, size, side, tickSize?, negRisk?, postOnly?})` SHALL
postear orden GTC vía `createAndPostOrder`. SHALL lanzar excepción si el
resultado trae `status===400` o `error`. SHALL devolver
`{orderId, status, tokenId, price, size, side}`. Precios en [0.01, 0.99].

### Requirement: Post-only para LP
Las órdenes de liquidity provision SHALL postearse con `postOnly:true` para
garantizar ejecución como maker: el CLOB rechaza la orden si cruzaría el
spread. La excepción es el break-even SELL del hedge (ver spec
`inventory-management`), que no usa postOnly para no quedar sin cobertura.

### Requirement: Cancelación
`cancelOrder(orderId)` SHALL cancelar una orden; `cancelAllForMarket(tokenId)`
SHALL cancelar todas las órdenes abiertas del token (método
`cancelMarketOrders`).

### Requirement: Consultas
`getOpenOrders(tokenId?)` y `getMyTrades(tokenId?)` SHALL exponer el estado
live del CLOB para inventario y detección de fills.

### Requirement: Earnings del usuario
`fetchUserEarningsForMarkets()` SHALL devolver `[{condition_id,
earning_percentage}]` para el día vía `getUserEarningsAndMarketsConfig`, o
`null` ante error. El rewards executor lo usa como fuente oficial de
out-of-range.

### Requirement: Verificación de autenticación
`verifyAuth()` SHALL hacer health check vía `getOpenOrders()` y devolver
boolean. El executor lo invoca en `init()` en modo real (falla logueada por el
runner, no aborta el schedule).

## Scenarios

#### Scenario: Orden que cruzaría el spread
- **WHEN** se postea con `postOnly:true` a precio que ejecutaría como taker
- **THEN** el CLOB rechaza la orden, `postOrder` lanza, y el caller decide
  (el executor cierra la posición como `manual` si el fallo es en apertura).

#### Scenario: API de earnings caída
- **WHEN** `fetchUserEarningsForMarkets()` falla
- **THEN** devuelve `null` y el executor continúa el tick con chequeo por
  distancia de orden únicamente.

## Deuda y divergencias conocidas

- `console.log` de wallet/funder/sigType en cada inicialización (resto de
  debug pendiente de limpieza).
- Sin rate limiting client-side explícito; los topes de reprice/requeue viven
  en `order-replacer.ts`.
- `scripts/generate-api-keys.ts` defaultea `POLY_SIGNATURE_TYPE=1` (EOA) vs 2
  en el cliente: hay que alinearlo con la wallet real antes de usarlo.
- `package.json` referencia `scripts/migrate.ts` y `verify-auth2.ts` que no
  existen en el repo.
