# TODO: Reprecio manual de órdenes vía Telegram

## Estado: SIN IMPLEMENTAR

## Objetivo

Poder reajustar órdenes activas desde Telegram sin detener el bot.
El usuario envía el ID de posición (de la BD) y los nuevos valores,
y el bot cancela las órdenes actuales en el CLOB y coloca nuevas con los parámetros indicados.

## Comando propuesto

```
/reprice <positionId> <bidPrice> <askPrice> [sizeUsdc]
```

Ejemplo:
```
/reprice 62 0.48 0.52 50
```

## Flujo esperado

1. Telegram recibe el comando con los parámetros
2. Buscar la posición en BD por `positionId`
3. Validar que la posición esté abierta y no sea paper trading
4. Cancelar todas las órdenes vivas del CLOB para ese mercado (`cancelAllForMarket`)
5. Recalcular `sizeShares` desde el `sizeUsdc` indicado y los precios
6. Postear nuevas órdenes BUY y SELL con los precios y tamaño indicados
7. Actualizar registros en BD (orders table)
8. Responder confirmación con los detalles de las nuevas órdenes

## Validaciones necesarias

- `bidPrice < askPrice`
- `bidPrice` y `askPrice` dentro del rango de rewards del mercado (`rewards_max_spread`)
- `sizeShares` resultante ≥ `minSizeShares` de la posición
- Posición existe y está en estado `open`
- No interferir con el ciclo normal del bot (el siguiente tick puede repricing de nuevo → ver nota)

## Nota importante

El bot tiene su propio ciclo de reprice automático. Si el tick corre justo después
del reprice manual, podría sobreescribir las órdenes recién colocadas.
Opciones a evaluar:
- Añadir un flag `manualOverride` en la posición que pause el reprice automático por N minutos
- O simplemente documentar que el reprice manual es best-effort y el bot puede ajustar en el siguiente tick

## Archivos relevantes

- `telegram/commands.ts` — donde añadir el handler del comando
- `core/clob-client.ts` — `cancelAllForMarket`, `postOrder`
- `core/order-replacer.ts` — lógica de reprice existente (referencia)
- `db/queries-paper.ts` — `positionQueries.getOpen`, `orderQueries.insertMany`
