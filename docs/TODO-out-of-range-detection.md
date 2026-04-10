# TODO: Detección confiable de órdenes fuera del rango de rewards

## Estado: SIN RESOLVER

## Síntoma

El bot muestra `[OK]` y `HOLD` en posiciones donde visualmente la orden parece estar
fuera del rango de rewards en la UI de Polymarket.

Ejemplo real (posición #62, IPL KKR):
```
CLOB liveOrders YES: (ninguna)
CLOB liveOrders NO:  BUY@48.0c
[OK][W] #62 mid=50.0c maxSpread=2.5c
outOfRange: liveNO=[@52.0c(≡YES) dist=2.00c] outOfRange=false
HOLD #62 — muralla protege, ordenes en rango
```

## Análisis realizado

### Lo que está funcionando
- `syncInventory` consulta el CLOB real en cada tick → `liveOrders` tiene precios reales
- La conversión NO→YES (`1 - price`) es correcta: BUY NO @48¢ ≡ SELL YES @52¢
- El cálculo de distancia es correcto: `|52 - 50| = 2.0¢`

### El problema no resuelto
`rewards_max_spread` viene de la API de Polymarket ya en centavos (ej: `2.5`).
La UI de Polymarket muestra `±2¢` para ese mercado.

**Discrepancia detectada:**
- API devuelve: `rewards_max_spread = 2.5`
- UI muestra: `±2¢`

Con `maxSpread = 2.5¢` y distancia `2.0¢` → matemáticamente en rango.
Pero la orden visualmente aparece fuera del área sombreada de rewards en la UI.

### Hipótesis pendientes de investigar
1. La UI de Polymarket usa un cálculo diferente al de la API (`rewards_max_spread`)
2. El campo correcto puede ser otro (ej: `spread` del mercado, no `rewards_max_spread`)
3. El midprice que usa el bot puede diferir del que usa Polymarket para el scoring
4. `scoreOrder` usa `s >= v` (estricto) pero Polymarket puede usar `s > v` (o viceversa)
5. El rango de rewards se calcula sobre el **last trade price**, no el midpoint bid/ask

## Código relevante

- `strategies/reward-executor/index.ts` línea ~540: `Number(market.rewards_max_spread ?? 3)`
- `strategies/reward-executor/index.ts` línea ~410: `ordersOutOfRange` check
- `core/rewards-scoring.ts` línea 35: `scoreOrder` → `if (s >= v) return 0`
- `core/inventory-manager.ts`: `liveOrders` en `InventoryState`

## Alternativas a explorar

1. **Consultar el score real de Polymarket vía API** en vez de calcularlo internamente
   - Endpoint: posiblemente `GET /rewards/percentages?user=...` ya usado en Telegram
   - Si devuelve score = 0 → orden fuera de rango → forzar requeue

2. **Bajar el `maxSpreadCents` artificialmente** al guardar en DB
   - Guardar `rewards_max_spread * 0.8` como margen de seguridad
   - Ejemplo: API dice 2.5¢ → guardar 2.0¢ → orden @52¢ queda fuera

3. **Investigar qué midprice usa Polymarket** para el scoring
   - Puede ser el midprice del último sample, no el actual

4. **Revisar la documentación oficial** de la fórmula de rewards de Polymarket
   - https://docs.polymarket.com/#rewards

## Impacto

Mientras no esté resuelto, el bot puede mantener órdenes que no ganan rewards
sin detectarlo, perdiendo tiempo y oportunidad de reposicionarse.
