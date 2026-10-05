# Rewards Executor Specification

## Purpose

Estrategia de market making en mercados de Polymarket con rewards de
liquidez: descubre mercados, abre posiciones (paper o real), coloca órdenes LP,
muestrea score/accruals en cada tick y cierra por condiciones de salida.
Implementada en `strategies/reward-executor/index.ts` (v2.1), con
`fetch-reward-markets.ts`, `manual-queue.ts` y colaboradores en `core/`.

## Requirements

### Requirement: Parámetros
El executor SHALL exponer sus `defaultParams` (ver README para la tabla
completa) y aceptar overrides vía `strategy_config.params`. Los parámetros
operativos clave: `paperTrading` (default `true`), `manualEntryOnly`,
`maxPositions`, `totalCapitalUsdc`, `placementStrategy` (`tight|mid|wide`),
`requeueIntervalMinutes`, `maxDaysOpen`, `fetchMinRatePerDay`,
`fetchMaxMinSize`, `earningsCheckDelayMinutes`, `bannedKeywords`.

### Requirement: Health check de earnings (solo real)
Al inicio de cada tick en modo real, el executor SHALL refrescar el mapa
`earning_percentage` por `condition_id` vía `fetchUserEarningsForMarkets()`
(`core/clob-client.ts`). Un valor 0 posterior a `earningsCheckDelayMinutes`
desde la apertura SHALL considerarse out-of-range a efectos de decisión.

### Requirement: Monitoreo de posiciones abiertas
Cada tick SHALL iterar `positionQueries.getOpen(paperTrading)` y por posición:
1. Fetch de book y last-trade price (timeouts 5s).
2. Análisis de profundidad a 10 niveles: `minDepthUsdc`, `hasMinDepth`,
   `maxWallUsdc`, `wallProtects` (`maxWall >= wallProtectionThreshold`).
3. Cálculo de score por minuto con `calcSampleScore` (ver spec
   `rewards-scoring`), usando órdenes live del CLOB (real) o filas de `orders`
   en DB (paper), con override de `inRange` por distancia de cada orden al
   `lastTradePrice ?? midprice`.
4. Persistencia de `reward_accruals` y acumulación en la posición
   (`addReward`: `rewardsEarnedUsdc`, `totalQmin`, `samplesInRange/Total`).

### Requirement: Condiciones de salida (en orden)
El executor SHALL cerrar la posición por la primera condición que cumpla, en
este orden, con `close_reason` correspondiente:
1. `reward_endDate` pasado → `reward_ended`.
2. Tasa actual de rewards por debajo de `minRateRetentionPct` % de la tasa de
   entrada → `reward_ended`.
3. `|mid − entryMid| / entryMid > maxPriceMoveThreshold` → `price_moved`.
4. `días abierta > maxDaysOpen` → `expired`.
El cierre SHALL calcular `pnl = rewardsEarned − feesPaid`, persistir estado y,
en modo real, cancelar órdenes vivas del mercado. La condición `score_too_low`
está comentada y no SHALL aplicar.

### Requirement: Apertura vía cola manual
El tick SHALL drenar la cola `manual_entry_queue` (ver spec
`operator-interfaces`), fetchear cada mercado con `fetchSingleMarket` (sin
filtros de rate/spread/keywords) y abrir posición salvo que ya exista una
abierta para ese `condition_id`. Fallos SHALL dejar la entrada en cola para el
próximo tick. La apertura manual SHALL aplicar el mismo chequeo de capital de
`minSizeShares` (skip si el tamaño requerido excede `totalCapital/2`).

### Requirement: Apertura vía auto-discovery
Salvo que `manualEntryOnly=true` y mientras haya slots
(`maxPositions − abiertas`), el executor SHALL fetchear mercados con
`fetchRewardMarkets(clob, fetchMinRatePerDay, fetchMaxMinSize)` y aplicar los
filtros en orden: rewards_config presente, ≥2 tokens, no terminado, banned
keywords (substring case-insensitive), `ratePerDay >= minRatePerDay`,
`market_competitiveness <= maxCompetitiveness` (si definido),
`volume_24hr <= maxVolume24hUsdc`, `spread >= minSpreadCentsThreshold`, sin
posición abierta, cooldown de mercado de 30 min. NOTA: el fetcher deja
`volume_24hr=0`, por lo que el filtro de volumen nunca dispara hoy.

### Requirement: Gates de libro al abrir
Un mercado candidato SHALL tener `hasMinDepth` (≥ `minDepthLevels` niveles por
lado) y `minDepthUsdc >= minDepthPerSideUsdc` para abrir posición.

### Requirement: Sizing dinámico y minSize
El tamaño SHALL calcularse con `calcDynamicSize(totalCapital, liquidityUsdc)`
(ver spec `rewards-scoring`) y `sizePerSide = sizeUsdc/2`. Si
`rewards_min_size` exige más, el executor SHALL subir `sizePerSide` al mínimo
requerido (`minSizeShares × max(mid, 1−mid)`) y SHALL saltear el mercado si
ese mínimo excede `totalCapitalUsdc/2`.

### Requirement: Ancla de colocación y dual side
Los precios de orden SHALL calcularse con `calcOrderPrices` usando ancla
`lastTradePrice ?? midprice` y `dualSideRequired = mid < 0.10 || mid > 0.90`.
Al abrir, `maxSpreadCents` SHALL guardarse con `Math.floor(rewards_max_spread)`
(alineación con la UI de Polymarket).

### Requirement: Apertura paper
En paper el executor SHALL insertar la posición y las órdenes planificadas en
DB (`status='simulated'`) sin tocar el CLOB, y estimar fees de entrada.

### Requirement: Apertura real
En modo real el executor SHALL postear ambos lados LP como `Side.BUY` con
`postOnly:true` — el lado "venta" es un BUY NO a `1−price` — con tamaño
`>= rewards_min_size` y `tickSize` del mercado. Cada orden posteada SHALL
registrarse en `orders` con su `clobOrderId` y estado `open` o `filled`.
Cualquier fallo de posteo SHALL cerrar la posición como `manual` y abortar.

### Requirement: Fill inmediato (status matched)
Si una orden LP se postea con estado `matched` (fill inmediato pese a
postOnly), el executor SHALL: cancelar el resto de órdenes del mercado, postear
LIMIT SELL al precio del fill (break-even), y mantener la posición abierta.

### Requirement: Gestión de órdenes — modo real
Tras monitorear, en modo real: si `netExposure > 0.01` SHALL aplicar
break-even hedge (ver spec `inventory-management`); luego `repriceIfNeeded`
(ver spec `order-replacement`). Si no hubo reprice y (`!wallProtects` u
out-of-range), el executor SHALL **cerrar la posición** con
`close_reason='manual'` y cancelar todas las órdenes del mercado. El requeue
FIFO en modo real está comentado.

### Requirement: Gestión de órdenes — modo paper
En paper: `repriceIfNeeded`; si no hubo reprice y `!wallProtects`, SHALL
`requeueIfNeeded` (FIFO cada `requeueIntervalMinutes`, solo DB). Si la muralla
protege y las órdenes están en rango, SHALL mantener (HOLD).

### Requirement: Señales de apertura/cierre
Aperturas y cierres SHALL emitir signals (severidad `low`, body HTML) con
metadata incluyendo `positionId`. Quedan persistidos en `signals`; el envío a
Telegram está comentado en el runner.

## Scenarios

#### Scenario: Modo "espera mi señal"
- **WHEN** `manualEntryOnly=true` y el operador hace `POST /positions/enter`
- **THEN** ningún mercado se descubre automáticamente; el mercado encolado se
  abre en el próximo tick saltando filtros de rate/spread/keywords.

#### Scenario: Requote por movimiento de mid
- **WHEN** el mid se movió >1.5¢ desde el último reprice (modo real)
- **THEN** se cancelan las órdenes del mercado y se recolocan al nuevo mid,
  con tope de 10 reprices/hora por posición.

#### Scenario: Muralla rota en modo real
- **WHEN** `maxWallUsdc < wallProtectionThreshold` o una orden queda fuera de
  rango y no hubo reprice (modo real)
- **THEN** la posición se cierra con `close_reason='manual'` y se cancelan
  todas las órdenes del mercado (no se requeuea).

#### Scenario: Muralla rota en modo paper
- **WHEN** `!wallProtects` tras el reprice (modo paper)
- **THEN** se ejecuta requeue FIFO si pasó `requeueIntervalMinutes` desde el
  último requeue de esa posición.

#### Scenario: Mercado con minSize excesivo
- **WHEN** `rewards_min_size` requiere más de `totalCapitalUsdc/2` por lado
- **THEN** se saltea el mercado con log explicando el capital requerido.

## Deuda y divergencias conocidas

- `minScoreThreshold` existe en params pero no se usa; `score_too_low`
  comentado.
- `volume_24hr` siempre 0 desde el fetcher: filtro `maxVolume24hUsdc` es no-op y
  `calcDynamicSize` siempre usa el tramo <5k (20% del capital, clamp $30–150).
- Órdenes planificadas se insertan en `orders` antes de postear y las reales se
  vuelven a insertar por orden posteada: acumulan filas fantasma `simulated`.
- En reprice real, las nuevas órdenes quedan con `clobOrderId=null` → la
  detección de fills no las rastrea.
- Estimación de fees siempre usa categoría `'unknown'` (`parseCategory(null)`);
  los tags del mercado se ignoran.
- Trackers de hedge/reprice/requeue son en memoria: un restart puede duplicar
  comportamiento (p.ej. doble post del break-even SELL).
- `console.log` de debug en apertura (`postOrder`) y en `clob-client`
  (wallet/funder) pendientes de limpieza.
- `fetchCurrentRewardRate` escanea el endpoint `multi` completo por posición
  por tick (costo de API a considerar).
