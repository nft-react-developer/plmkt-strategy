# TODO: Endpoint para entrada manual de mercado

## Estado: SIN IMPLEMENTAR

## Objetivo

Permitir al bot correr en real trading pero **sin abrir posiciones automáticamente**.
El usuario indica via HTTP qué `condition_id` entrar. El bot entra y desde ese punto
monitorea la posición en cada tick normal.

---

## Flujo esperado

```
1. Bot arranca con manualEntryOnly=true, paperTrading=false
2. Cada 60s: monitorea posiciones abiertas (ninguna al inicio)
3. Usuario: POST /positions/enter { "condition_id": "0xabc..." }
4. API responde: { queued: true }
5. Próximo tick: abre posición en CLOB real (sin filtros de rate/spread/keywords)
6. Ticks siguientes: monitor normal (repricing, accruals, exit conditions)
```

---

## Archivos a crear/modificar

### Nuevo: `strategies/reward-executor/manual-queue.ts`

Singleton queue para condition_ids pendientes:

```ts
const queue: string[] = [];

export function enqueueMarket(conditionId: string): void {
  if (!queue.includes(conditionId)) queue.push(conditionId);
}

export function drainQueue(): string[] {
  return queue.splice(0, queue.length);
}
```

---

### Modificar: `strategies/reward-executor/fetch-reward-markets.ts`

Añadir función para fetch de un solo mercado sin filtros de rate/minSize:

```ts
export async function fetchSingleMarket(
  clobBase: string,
  conditionId: string,
): Promise<RewardsMarket | null>
```

Lógica:
- Llamar `GET /markets/{conditionId}` para datos del mercado
- Llamar `GET /rewards/markets/current?sponsored=true` y buscar el condition_id para obtener rewards config
- Si no tiene rewards activos, igual devolver el mercado con `rate_per_day: 0` (el usuario ya decidió entrar)
- Devolver `null` si el mercado no existe o tiene tokens resueltos

---

### Modificar: `strategies/reward-executor/index.ts`

**1. Añadir `manualEntryOnly` a `ExecutorParams`:**

```ts
interface ExecutorParams {
  // ... params existentes ...
  manualEntryOnly: boolean;  // si true, salta auto-discovery de mercados
}
```

**2. Añadir en `defaultParams`:**

```ts
manualEntryOnly: false,
```

**3. Extraer `openPositionForMarket` como función privada:**

Mover el bloque de apertura de posición (actualmente inline en `run()`) a:

```ts
async function openPositionForMarket(
  market: RewardsMarket,
  p: ExecutorParams,
  onOpened: () => void,
): Promise<void>
```

Refs código actual:
- [strategies/reward-executor/index.ts:568](../strategies/reward-executor/index.ts#L568) — inicio del bloque de apertura
- [strategies/reward-executor/index.ts:750](../strategies/reward-executor/index.ts#L750) — fin del bloque aprox.

**4. En `run()`, al inicio del bloque "Abrir nuevas posiciones":**

```ts
// ---- 2a. Entradas manuales (queue de endpoint) -------------------------
const pendingIds = drainQueue();
for (const conditionId of pendingIds) {
  if (positionsOpened >= slotsAvailable) break;
  const market = await fetchSingleMarket(p.clobApiBase, conditionId);
  if (!market) { logger.warn(`[manual] no se encontró ${conditionId}`); continue; }
  if (await positionQueries.hasOpen(conditionId, p.paperTrading)) {
    logger.info(`[manual] ya existe posición abierta para ${conditionId}`); continue;
  }
  await openPositionForMarket(market, p, () => { positionsOpened++; });
}

// ---- 2b. Auto-discovery (salta si manualEntryOnly=true) ----------------
if (!p.manualEntryOnly && slotsAvailable > 0) {
  // ... código actual de fetchRewardMarkets + filtros ...
}
```

---

### Modificar: `api/server.ts`

Añadir middleware JSON y nuevo endpoint:

```ts
import { enqueueMarket } from '../strategies/reward-executor/manual-queue';

app.use(express.json());

// POST /positions/enter
// Body: { condition_id: string }
app.post('/positions/enter', (req, res) => {
  const { condition_id } = req.body ?? {};
  if (!condition_id || typeof condition_id !== 'string') {
    return res.status(400).json({ error: 'condition_id requerido' });
  }
  enqueueMarket(condition_id);
  res.json({ queued: true, condition_id });
});
```

---

## Activar modo manual en DB

Para modo "espera mi señal" (real trading):
```sql
UPDATE strategy_config
SET params = '{"paperTrading": false, "manualEntryOnly": true}'
WHERE strategy_id = 'rewards_executor';
```

Para volver al modo automático:
```sql
UPDATE strategy_config
SET params = '{"paperTrading": false, "manualEntryOnly": false}'
WHERE strategy_id = 'rewards_executor';
```

---

## Verificación

1. Arrancar bot con `npm run dev` y `manualEntryOnly=true` en DB
2. Observar logs: debe decir "slots disponibles" pero no abrir nada
3. Llamar endpoint:
   ```bash
   curl -X POST http://localhost:3001/positions/enter \
     -H 'Content-Type: application/json' \
     -d '{"condition_id":"0x..."}'
   ```
4. Verificar respuesta: `{ "queued": true, "condition_id": "0x..." }`
5. En el próximo tick (~60s), verificar logs de apertura de posición
6. Confirmar fila en tabla `positions` con `status='open'`
7. En ticks subsiguientes, verificar logs de monitoreo del mercado

---

## Notas

- La respuesta del endpoint es **inmediata** — el bot lo procesa en el siguiente tick (máx 60s de delay)
- Las entradas manuales **saltan todos los filtros** (rate, spread, depth, keywords, cooldown) porque el usuario ya tomó la decisión
- El parámetro `manualEntryOnly` se puede cambiar en DB sin reiniciar el bot (se lee en cada tick)
- Si el bot no está corriendo, la queue se pierde (vive en memoria) — el endpoint requiere bot activo
