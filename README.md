# Polymarket Bot

Monitor de mercados de predicción con múltiples estrategias configurables.

## Estructura

```
.
├── index.ts                        ← Entry point
├── core/
│   ├── strategy.interface.ts       ← Contrato que toda estrategia implementa
│   └── runner.ts                   ← Orquesta estrategias: schedule, enable/disable, daily report
├── strategies/
│   ├── registry.ts                 ← Lista de estrategias registradas
│   ├── whale-tracker/index.ts      ← S1: Wallets con alto win-rate
│   ├── smart-money/index.ts        ← S2: Confluencia de wallets inteligentes
│   ├── odds-mover/index.ts         ← S3: Movimientos bruscos de precio
│   └── order-book/index.ts         ← S4: Imbalance en CLOB
├── db/
│   ├── connection.ts               ← Pool de MariaDB + Drizzle
│   ├── schema.ts                   ← Definición de tablas (Drizzle)
│   ├── queries.ts                  ← Todas las queries tipadas
│   └── migrations.sql              ← DDL para ejecutar en la DB
├── telegram/
│   └── notifier.ts                 ← Envío de mensajes a Telegram
└── utils/
    └── logger.ts
```

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
```