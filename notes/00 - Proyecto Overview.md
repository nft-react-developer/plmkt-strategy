# plmkt-strategy — Rewards Farming en Polymarket

## Qué es esto

Bot de market-making en Polymarket orientado a capturar **rewards de liquidez**.  
La estrategia principal (`reward-executor`) coloca órdenes en mercados con recompensas activas y gestiona posiciones para maximizar el earning diario minimizando la exposición direccional.

## Cómo funciona (flujo actual)

1. **Fetch de mercados** → filtra por `rate_per_day >= minRate` y `minSize <= maxMinSize`
2. **Scoring** → evalúa liquidez, spread, competitividad, keywords baneados
3. **Placement** → coloca órdenes en ambos lados (BUY/SELL) según `PlacementStrategy`
4. **Sync inventario** → detecta fills, cierra posición si hay match inmediato
5. **Repricing / Requeue** → recoloca órdenes si el precio se mueve o expiran
6. **Earnings check** → valida ganancias reales cada N minutos via CLOB API

## Parámetros clave (`ExecutorParams`)

| Param | Rol |
|---|---|
| `minRatePerDay` | Tasa mínima de rewards para entrar |
| `maxPositions` | Máximo de posiciones abiertas simultáneas |
| `totalCapitalUsdc` | Capital total disponible |
| `minSpreadCentsThreshold` | Spread mínimo para evitar mercados muy competidos |
| `minDepthPerSideUsdc` | Profundidad mínima del book para entrar |
| `wallProtectionThreshold` | Protección contra walls que bloqueen el fill |
| `placementStrategy` | `aggressive` / `passive` / `neutral` |
| `bannedKeywords` | Mercados a ignorar (volatilidad extrema, resolución rápida) |

---

## Próximos pasos — Mejoras a la estrategia

### 1. Optimización de scoring
- [ ] Ponderar `market_competitiveness` más fuerte — mercados muy competidos reducen net APY
- [ ] Añadir score por `volume_24hr` relativo al capital a depositar (evitar mercados secos)
- [ ] Scoring dinámico por hora del día (liquidez baja en horarios off-peak)

### 2. Gestión de capital
- [ ] Capital dinámico ya implementado en `calcDynamicSize` — validar si los rangos `[30, 150]` son óptimos
- [ ] Explorar asignación de capital proporcional al `rate_per_day` (más capital = más rewards)
- [ ] Tracking de PnL neto por posición (rewards - taker fees - slippage)

### 3. Selección de mercados
- [ ] Expandir lista de `bannedKeywords` con mercados que históricamente resuelven rápido
- [ ] Filtrar por `end_date` — evitar mercados que expiran en < 48h (poco tiempo para acumular)
- [ ] Detectar mercados `neg_risk` y tratarlos de forma diferente

### 4. Ejecución y robustez
- [ ] Mejorar detección de fills parciales en `syncInventory`
- [ ] Alertas Telegram cuando se cierra una posición con pérdida
- [ ] Dashboard básico de positions abiertas + earnings acumulados

### 5. Análisis y datos
- [ ] Logging estructurado de resultados por sesión (earnings reales vs esperados)
- [ ] Script de backtesting sobre mercados históricos de rewards
- [ ] Comparar APY real vs APY teórico por mercado para ajustar filtros

---

## Archivos clave

- `strategies/reward-executor/index.ts` — lógica principal
- `strategies/reward-executor/fetch-reward-markets.ts` — fetch y filtrado de mercados
- `core/rewards-scoring.ts` — scoring y cálculo de precios
- `core/inventory-manager.ts` — gestión de posiciones e inventario
- `core/order-replacer.ts` — repricing y requeue
- `db/queries-paper.ts` — persistencia de órdenes y posiciones
