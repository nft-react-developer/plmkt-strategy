# TODO: Validar minSizeShares antes de entrar a un mercado

## Estado: SIN IMPLEMENTAR

## Problema

`minSizeShares` se lee de la API (`market.rewards_min_size`) y se guarda en la posición,
pero **nunca se usa como filtro** para decidir si entrar o no al mercado.

Si el tamaño de orden calculado (`sizePerSide / price`) es menor que `minSizeShares`,
Polymarket no otorgará rewards por esas órdenes. Entrar en ese mercado es inútil
(o incluso costoso por fees) sin recibir recompensa a cambio.

## Código relevante

- [strategies/reward-executor/index.ts:558](../strategies/reward-executor/index.ts#L558) — `minSizeShares` se calcula pero no se usa como gate
- [strategies/reward-executor/index.ts:555](../strategies/reward-executor/index.ts#L555) — `sizeUsdc` y `sizePerSide` se calculan justo antes

```ts
// Línea ~555-561 (estado actual)
const sizeUsdc         = calcDynamicSize(p.totalCapitalUsdc, liquidityUsdc);
const sizePerSide      = sizeUsdc / 2;
const maxSpreadCents   = Number(market.rewards_max_spread ?? 3);
const minSizeShares    = Number(market.rewards_min_size   ?? 0);  // ← se lee pero no se valida
const dualSideRequired = midprice < 0.10 || midprice > 0.90;

const plannedOrders = calcOrderPrices(...);  // ← ya entra sin validar minSizeShares
```

## Implementación propuesta

Después de calcular `sizePerSide` y `minSizeShares`, estimar el tamaño en shares
de la orden y compararlo contra el mínimo requerido:

```ts
// Convertir sizePerSide (USDC) a shares estimados usando el midprice
// shares ≈ sizeUsdc / price  (para YES @ midprice)
const estimatedSharesYes = sizePerSide / midprice;
const estimatedSharesNo  = sizePerSide / (1 - midprice);
const minEstimatedShares = Math.min(estimatedSharesYes, estimatedSharesNo);

if (minSizeShares > 0 && minEstimatedShares < minSizeShares) {
  console.log(
    `[rewards_executor]   skip ${market.question.slice(0, 60)} — shares estimados ${minEstimatedShares.toFixed(1)} < minSizeShares ${minSizeShares}`
  );
  continue;
}
```

Colocar este check justo después de calcular `minSizeShares` (línea ~558),
antes de `calcOrderPrices`.

## Notas

- `minSizeShares` es el mínimo de shares por orden que exige Polymarket para
  computar la orden en el cálculo de rewards. Órdenes más pequeñas son ignoradas.
- El cálculo de shares es una estimación usando `midprice`. El precio real de la
  orden puede variar ligeramente (spread de placement), pero es suficiente como
  gate de entrada.
- Si `minSizeShares` es 0 o nulo, no hay mínimo → no filtrar.
- Considerar también logear el valor en el resumen de entrada para diagnóstico.

## Impacto

Sin este filtro, el bot puede abrir posiciones en mercados donde nunca recibirá
rewards porque sus órdenes son demasiado pequeñas, consumiendo capital y fees
sin retorno.
