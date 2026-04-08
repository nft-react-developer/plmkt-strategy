# Risk Management — Market Making con Rewards

## El problema original

El bot colocaba órdenes BUY y cuando se ejecutaban (fill), vendía a mercado para cerrar la posición.

**Consecuencias:**
- Pagaba taker fee (~0.1%) en cada salida
- Perdía el rebate de maker (~0.01%)
- Dejaba de hacer LP mientras cerraba y reabría

---

## Mejora implementada: Break-Even Hedge como Maker

### Lógica

Cuando una orden BUY es ejecutada (fill), en lugar de cerrar a mercado:

1. Se coloca una **LIMIT SELL al mismo precio de entrada** (break-even)
2. La posición queda **abierta** — el bot sigue haciendo LP con BID + ASK en el libro
3. Cuando el SELL se ejecuta, el P&L de la operación es ≈0 (break-even), pero se **cobró maker rebate** en ambas puntas

### Flujo

```
BUY @ 0.48 → FILL (alguien vende a tu precio)
  ↓
LIMIT SELL @ 0.48 (break-even, postOnly=false para garantizar entrada)
  ↓
LP sigue activo con BID + ASK
  ↓
SELL se ejecuta → net exposure = 0, sin pérdida, cobró rebate
```

### Código

- `core/inventory-manager.ts` → `rebalanceWithBreakEvenHedge(state)`
- `strategies/reward-executor/index.ts` → se llama después de `syncInventory` si `netExposure > 0.01`

### Tracking de órdenes activas

`breakEvenHedgeOrders` (Map en memoria) evita re-postear el SELL en cada tick.
Se limpia cuando `netExposure` vuelve a 0 o al cerrar la posición (`clearBreakEvenHedge`).

---

## Fill inmediato (status: matched al abrir)

Si una orden se ejecuta en el mismo momento en que se postea (el precio cruzó el spread):

**Antes:** se cerraba la posición a mercado (taker fee).

**Ahora:**
1. Se hace `break` del loop de órdenes LP (no postea más)
2. Se cancela el resto de órdenes del mercado
3. Se postea **LIMIT SELL @ mismo precio** (break-even)
4. La posición **sigue abierta** para el próximo tick

---

## postOnly: true — Garantía de Maker

Todas las órdenes LP se postean con `postOnly: true`:

```typescript
postOrder({ tokenId, price, size, side, postOnly: true })
```

**Efecto:** si la orden cruzaría el spread y ejecutaría como taker, el CLOB la **rechaza** en lugar de ejecutarla. Esto garantiza que siempre se entre como maker (cobrar rebate, no pagar fee).

**Excepción:** el break-even SELL no usa `postOnly` porque si se rechaza, quedás con inventario abierto sin cobertura.

### Comparación de fees

| Escenario | Fee |
|-----------|-----|
| Sin postOnly, orden cruza spread | −0.1% (taker) |
| Con postOnly, orden rechazada | $0 (reintenta próximo tick) |
| Orden entra al libro como maker | +0.01%–0.02% (rebate) |

---

## LP con dos tokens (YES + NO)

El bot no hace LP solo con BUY YES. Cuando `dualSideRequired = true` (precio < 10¢ o > 90¢) coloca:

- **BUY YES** en el tokenYes
- **BUY NO** en el tokenNo (equivalente a SELL YES en mercados neg_risk)

Esto permite hacer LP en ambos lados del libro cobrando maker rebate en ambas puntas.

En Polymarket se ven como dos órdenes BUY separadas pero pertenecen a la **misma posición** en la DB.

---

## Wall Protection

### Propósito original

Evitar cancelar órdenes cuando hay una "muralla" de liquidez en el libro que protege tu posición en la cola. Cancelar y re-postear en un libro con mucha liquidez te pone al final de la cola.

### Implementación actual

```typescript
const maxWallUsdc = Math.max(maxBidWall, maxAskWall);
const wallProtects = maxWallUsdc >= wallProtectionThreshold; // default: $300
```

Busca el nivel individual más grande (en USDC) entre los primeros 10 niveles de bids y asks.

### Limitación conocida

La función toma el máximo de BID y ASK **sin considerar de qué lado está**. Una muralla en los asks no protege tus bids. Tampoco verifica que la muralla esté entre tu precio y el midprice.

### Override por out-of-range

Si alguna orden activa quedó **fuera del rango de rewards** (`|precio_orden - midprice| > maxSpreadCents/100`), se fuerza el requeue **ignorando la wall protection**:

```typescript
const ordersOutOfRange = dbOrders.some(o =>
  Math.abs(Number(o.price) - midprice) > maxSpreadDecimal,
);

if (!bookAnalysis.wallProtects || ordersOutOfRange) {
  // requeue forzado
}
```

Una orden fuera de rango no gana rewards de todas formas, así que perder la posición en la cola no tiene costo.

---

## Reprecio vs Re-queue

| Mecanismo | Cuándo | Qué hace |
|-----------|--------|----------|
| `repriceIfNeeded` | Mid se movió > 1.5¢ desde entry | Cancela y recoloca al nuevo midprice |
| `requeueIfNeeded` | Sin muralla o fuera de rango | Cancela y recoloca en el **mismo precio** para subir en la cola FIFO |

El requeue en el mismo precio tiene sentido porque el CLOB de Polymarket es FIFO — al cancelar y reponer quedás al tope de la cola de ese precio si sos el único en ese tick.
