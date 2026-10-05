# Polymarket Bot

Monitor de mercados de predicción con múltiples estrategias configurables.

## Estructura

```text
.
├── index.ts                        ← Entry point (runner + Telegram + API)
├── api/
│   ├── index.ts                    ← Entry standalone del servidor API
│   └── server.ts                   ← REST reward-markets, SSE viewer, POST /positions/enter
├── core/
│   ├── strategy.interface.ts       ← Contrato que toda estrategia implementa
│   ├── runner.ts                   ← Orquesta estrategias: schedule, enable/disable, daily report
│   ├── clob-client.ts              ← Gateway autenticado del CLOB (órdenes reales)
│   ├── inventory-manager.ts        ← Sync de inventario real, fills, break-even hedge
│   ├── order-replacer.ts           ← Reprice y requeue FIFO
│   ├── rewards-scoring.ts          ← Fórmula Qmin de rewards de Polymarket
│   ├── cooldown.ts                 ← Cooldowns DB-backed de signals
│   ├── resolve-outcomes.ts         ← Resolución nocturna de outcomes (03:00 UTC)
│   └── rewards-daily-report.ts     ← Reporte diario de rewards (implementado, sin scheduler)
├── strategies/
│   ├── registry.ts                 ← Lista de estrategias registradas
│   ├── reward-executor/            ← Estrategia activa: market making en reward markets
│   ├── whale-tracker/              ← S1 (deshabilitada en registry)
│   ├── smart-money/                ← S2 (deshabilitada en registry)
│   ├── odds-mover/                 ← S3 (deshabilitada en registry)
│   ├── order-book/                 ← S4 (deshabilitada en registry)
│   └── resolution-arb/             ← S5 (deshabilitada en registry)
├── db/
│   ├── connection.ts               ← Pool de MariaDB + Drizzle
│   ├── schema.ts                   ← Definición de tablas (Drizzle, fuente de verdad)
│   ├── queries.ts                  ← Queries de estrategias/wallets/monitoreo
│   ├── queries-paper.ts            ← Queries de market making (positions/orders/accruals)
│   ├── migration.sql               ← DDL stage 1 (faltan tablas de market making)
│   └── update-position.sql         ← Cierre manual de emergencia (posiciones reales)
├── telegram/
│   ├── notifier.ts                 ← Envío de mensajes a Telegram (send-only)
│   └── commands.ts                 ← Comandos operativos (/pause, /positions, ...)
├── scripts/                        ← CLI operativo y scripts de mantenimiento
└── utils/
    ├── logger.ts
    ├── fees.ts                     ← Modelo de taker fees 2026
    └── polymarket.ts               ← Clientes Gamma/helpers
```

> **Estado actual del registry**: solo `rewards_executor` está activa. Las cinco
> estrategías de monitoreo están implementadas pero comentadas en
> `strategies/registry.ts`. Ver `openspec/` para las specs de capacidades al día.

## Agregar una nueva estrategia

**Solo 3 pasos:**

### 1. Crear el módulo

```
strategies/mi-estrategia/index.ts
```

```typescript
import { Strategy, StrategyRunResult } from '../../core/strategy.interface';

export const miEstrategia: Strategy = {
  id:          'mi_estrategia',         // snake_case, único
  name:        'Mi Estrategia',
  description: 'Hace algo interesante',

  defaultParams: {
    intervalSeconds: 120,
    miParametro:     42,
    // Todos los params son configurables desde DB sin tocar código
  },

  async run(params): Promise<StrategyRunResult> {
    const signals = [];

    // ... tu lógica aquí ...

    if (condicion) {
      signals.push({
        strategyId: this.id,
        severity:   'high',             // 'low' | 'medium' | 'high'
        title:      'Algo pasó',
        body:       'Descripción detallada en HTML de Telegram',
        metadata:   { cualquier: 'dato' },
      });
    }

    return {
      signals,
      metrics: { itemsChecked: 100 },  // opcional, se persiste en run_log
    };
  },

  // Opcional:
  async init(params)  { /* warmup */ },
  async teardown()    { /* cleanup */ },
};
```

### 2. Registrarla

En `strategies/registry.ts`:

```typescript
import { miEstrategia } from './mi-estrategia/index';

export const STRATEGIES: Strategy[] = [
  whaleTrackerStrategy,
  smartMoneyStrategy,
  oddsMoverStrategy,
  orderBookStrategy,
  miEstrategia,   // ← agregar acá
];
```

### 3. Listo

Al arrancar, el runner:
- Crea la fila en `strategy_config` con tus `defaultParams`
- La ejecuta cada `intervalSeconds`
- Persiste cada run en `strategy_run_log`
- Guarda los signals en `signals`
- La incluye en el daily report con su win rate

---

## Configurar parámetros sin tocar código

Cada estrategia tiene su fila en `strategy_config`. El campo `params` es un JSON
que **merge** sobre los `defaultParams`. Por ejemplo, para cambiar el intervalo
de `odds_mover` a 30 segundos y el threshold a 5%:

```sql
UPDATE strategy_config
SET params = '{"intervalSeconds": 30, "minDeltaPct": 5.0}'
WHERE strategy_id = 'odds_mover';
```

El runner toma los params frescos en cada tick, así que el cambio se aplica
en la próxima ejecución **sin reiniciar el proceso**.

## Habilitar / deshabilitar en runtime

```sql
-- Deshabilitar
UPDATE strategy_config SET enabled = FALSE WHERE strategy_id = 'whale_tracker';

-- Habilitar
UPDATE strategy_config SET enabled = TRUE WHERE strategy_id = 'whale_tracker';
```

O desde código:
```typescript
import { enableStrategy, disableStrategy } from './core/runner';
await disableStrategy('whale_tracker');
await enableStrategy('whale_tracker');
```

## Resolver outcomes (para el win rate)

El win rate se calcula sobre signals con `outcome` definido.
Para resolverlos:

```sql
-- Marcar un signal como correcto
UPDATE signals SET outcome = 'correct', outcome_at = NOW()
WHERE id = 42;

-- Ver win rate actual por estrategia
SELECT
  strategy_id,
  SUM(outcome = 'correct')   AS correct,
  SUM(outcome = 'incorrect') AS incorrect,
  ROUND(
    SUM(outcome = 'correct') /
    NULLIF(SUM(outcome IN ('correct','incorrect')), 0) * 100,
  2) AS win_rate_pct
FROM signals
WHERE outcome IS NOT NULL
GROUP BY strategy_id;
```

## rewards_executor — Parámetros de configuración

Estrategia de market making en mercados con rewards de Polymarket. Coloca órdenes BUY en ambos lados (YES y NO) para ganar rewards por proveer liquidez.

| Parámetro | Default | Descripción |
|-----------|---------|-------------|
| `paperTrading` | `true` | Modo simulado. En `false` postea órdenes reales al CLOB |
| `maxPositions` | `5` | Posiciones abiertas simultáneas máximas |
| `totalCapitalUsdc` | `400` | Capital total disponible. El tamaño por posición se calcula dinámicamente según la liquidez del mercado |
| `minRatePerDay` | `1` | Tasa mínima de rewards (USDC/día) para mantener una posición abierta |
| `minRateRetentionPct` | `50` | Si la tasa actual cae por debajo de este % de la tasa de entrada, cierra la posición |
| `minScoreThreshold` | `0.001` | Score Qmin mínimo para no cerrar por `score_too_low` |
| `maxPriceMoveThreshold` | `0.15` | Movimiento máximo de precio desde la entrada (15%) antes de cerrar |
| `minSpreadCentsThreshold` | `3` | Spread mínimo del mercado en centavos para abrir una nueva posición |
| `minDepthPerSideUsdc` | `800` | Profundidad mínima por lado (USDC) en el order book para abrir |
| `minDepthLevels` | `5` | Niveles mínimos en el order book para abrir |
| `maxVolume24hUsdc` | `50000` | Volumen máximo 24h. Mercados más líquidos tienen más competencia en rewards |
| `wallProtectionThreshold` | `300` | Tamaño mínimo de muralla (USDC). Si existe una muralla de ese tamaño, no se hace requeue |
| `requeueIntervalMinutes` | `45` | Minutos mínimos entre requeueues. Evita spamear el CLOB cancelando y recolocando continuamente |
| `placementStrategy` | `'mid'` | Dónde colocar las órdenes: `tight` (1¢ del mid, score máximo), `mid` (50% del maxSpread), `wide` (80% del maxSpread, menos riesgo de fill) |
| `bannedKeywords` | `[...]` | Keywords en el título del mercado para excluir automáticamente |
| `saveBookSnapshots` | `true` | Guardar snapshot del order book en DB en cada tick |
| `maxDaysOpen` | `7` | Días máximos antes de cerrar una posición por expiración |
| `intervalSeconds` | `60` | Intervalo en segundos entre ticks |
| `clobApiBase` | `https://clob.polymarket.com` | URL base del CLOB de Polymarket |
| `maxCompetitiveness` | `undefined` | Si se define, excluye mercados con `market_competitiveness` mayor a este valor |
| `fetchMinRatePerDay` | `200` | Filtro al buscar mercados: solo trae los con rate ≥ este valor (USDC/día) |
| `fetchMaxMinSize` | `50` | Filtro al buscar mercados: excluye los con `min_size` mayor a este valor (shares) |
| `earningsCheckDelayMinutes` | `5` | Minutos desde apertura antes de considerar `earning_percentage=0` como fuera de rango. El endpoint `/rewards/user/markets` de Polymarket devuelve 0 al inicio aunque las órdenes estén bien posicionadas |

### Ejemplo de configuración en DB

```sql
UPDATE strategy_config
SET params = '{
  "paperTrading": false,
  "maxPositions": 3,
  "totalCapitalUsdc": 300,
  "fetchMinRatePerDay": 100,
  "placementStrategy": "tight",
  "earningsCheckDelayMinutes": 10
}'
WHERE strategy_id = 'rewards_executor';
```

---

## Variables de entorno

```env
DATABASE_HOST_NAME=localhost
DATABASE_USER_NAME=root
DATABASE_USER_PASSWORD=secret
DATABASE_DB_NAME=polymarket_bot
DB_PORT=3306

TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_CHAT_ID=-100123456789

LOG_LEVEL=info   # debug | info | warn | error

# API (opcional; default 3001)
API_PORT=3001

# CLOB — solo necesarias para real trading (paper no las usa)
# Generar con: yarn generate-api-key
PRIVATE_KEY=0x...
POLY_API_KEY=...
POLY_API_SECRET=...
POLY_API_PASSPHRASE=...
POLY_FUNDER=0x...          # address del funder (proxy/Gnosis Safe)
POLY_SIGNATURE_TYPE=2     # 1=EOA, 2=Gnosis Safe (default del cliente)
```

> ⚠️ `POLY_SIGNATURE_TYPE` debe coincidir con el tipo de la wallet real. El
> script `generate-api-keys.ts` defaultea a 1 (EOA) mientras el cliente
> defaultea a 2 — verificar antes de operar en real.