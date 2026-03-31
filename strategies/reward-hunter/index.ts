// rewards-hunter.ts
/**
 * S6: Liquidity Rewards Hunter
 *
 * Detecta mercados con programa de rewards activo donde la recompensa
 * diaria de liquidez supera el costo de las fees de taker.
 * La idea: colocar órdenes maker en el spread obtiene rebates USDC diarios
 * que pueden superar el costo de spread + fees.
 *
 * Cómo funciona el programa de rewards de Polymarket:
 *   - Los mercados con rewards pagan USDC diarios a market makers
 *   - El pago se calcula según el tiempo que las órdenes estuvieron
 *     dentro del spread máximo (maxSpread) definido por el mercado
 *   - Los fondos vienen del pool de taker fees recaudadas
 *
 * Estrategia de esta estrategia (solo monitoring, no ejecución):
 *   1. Busca mercados con rewards activos via Gamma API
 *   2. Para cada mercado, calcula si el reward diario estimado
 *      supera las fees de taker del spread actual
 *   3. Alerta cuando la oportunidad de "fee farming" es atractiva
 *
 * Parámetros configurables:
 *   intervalSeconds        — default 300 (5 min)
 *   minDailyRewardUsdc     — reward mínimo diario para alertar (default 10)
 *   minRewardFeeRatio      — cuántas veces el reward debe superar las fees (default 2)
 *   maxMarketsPerRun       — mercados a analizar por tick (default 30)
 *   cooldownMinutes        — cooldown por mercado (default 240 = 4h)
 *   minLiquidityUsdc       — liquidez mínima del mercado (default 1000)
 */

import { Strategy, StrategyRunResult } from '../../core/strategy.interface';
import { CooldownManager } from '../../core/cooldown';
import { calcTakerFee, parseCategory, isProfitable } from '../../utils/fees';
import { logger } from '../../utils/logger';

interface RewardsHunterParams {
  intervalSeconds:    number;
  minDailyRewardUsdc: number;
  minRewardFeeRatio:  number;
  maxMarketsPerRun:   number;
  cooldownMinutes:    number;
  minLiquidityUsdc:   number;
  gammaApiBase:       string;
  clobApiBase:        string;
}

// Estructura que devuelve la gamma API para mercados con rewards
interface RewardsMarket {
  conditionId:   string;
  question:      string;
  volume24hr:    string;
  volumeNum:     string;
  outcomePrices: string;
  outcomes:      string;
  clobTokenIds:  string;
  liquidity:     string;
  spread:        string;
  bestBid:       string;
  bestAsk:       string;
  active:        boolean;
  closed:        boolean;
  acceptingOrders: boolean;
  // Tags para determinar categoría y fees
  tags?: Array<{ label: string }>;
  // Datos de rewards
  clobRewards: Array<{
    id:              string;
    conditionId:     string;
    assetAddress:    string;
    rewardsAmount:   number;  // USDC diarios totales del pool
    rewardsDailyRate: number; // tasa diaria
    startDate:       string;
    endDate:         string;
    maxSpread:       number;  // spread máximo para calificar (en cents, ej 2 = 2¢)
    minSize:         number;  // tamaño mínimo de orden para calificar
  }>;
}

const cooldown = new CooldownManager('rewards_hunter');

export const rewardsHunterStrategy: Strategy = {
  id:          'rewards_hunter',
  name:        'Liquidity Rewards Hunter',
  description: 'Detecta mercados con rewards donde hacer market making es rentable vs las fees',

  defaultParams: {
    intervalSeconds:    300,
    minDailyRewardUsdc: 10,
    minRewardFeeRatio:  2,
    maxMarketsPerRun:   30,
    cooldownMinutes:    240,
    minLiquidityUsdc:   1000,
    gammaApiBase:       'https://gamma-api.polymarket.com',
    clobApiBase:        'https://clob.polymarket.com',
  } satisfies RewardsHunterParams,

  async run(params): Promise<StrategyRunResult> {
    const p         = params as unknown as RewardsHunterParams;
    const signals: StrategyRunResult['signals'] = [];
    const cooldownMs = p.cooldownMinutes * 60_000;
    let marketsChecked = 0;
    let opportunitiesFound = 0;

    const markets = await fetchRewardMarkets(p.gammaApiBase, p.maxMarketsPerRun)
      .catch(err => { logger.error('[rewards_hunter] fetch failed', err); return []; });

    logger.info(`[rewards_hunter] checking ${markets.length} reward markets`);

    for (const market of markets) {
      if (!market.active || market.closed || market.acceptingOrders === false) continue;
      if (Number(market.liquidity ?? 0) < p.minLiquidityUsdc) continue;

      for (const reward of market.clobRewards) {
        marketsChecked++;

        // Validar que el reward esté activo
        const now     = Date.now();
        const endDate = new Date(reward.endDate).getTime();
        if (now > endDate) continue;

        const dailyReward = reward.rewardsAmount;
        if (dailyReward < p.minDailyRewardUsdc) continue;

        // Calcular fees para este mercado
        const tag      = market.tags?.[0]?.label ?? null;
        const category = parseCategory(tag);
        const prices   = safeParseJson<string[]>(market.outcomePrices, []);
        const midPrice = prices.length >= 2
          ? (Number(prices[0]) + Number(prices[1])) / 2
          : 0.5;

        const takerFeePct = calcTakerFee(midPrice, category) * 100;
        const spread      = Number(market.spread ?? 0);
        const bestBid     = Number(market.bestBid ?? 0);
        const bestAsk     = Number(market.bestAsk ?? 0);

        // ¿Es el spread actual lo suficientemente estrecho para calificar?
        // maxSpread del reward está en centavos (ej. 2 = 0.02)
        const maxSpreadDec = reward.maxSpread / 100;
        const currentSpread = bestAsk - bestBid;
        const spreadOk      = currentSpread <= maxSpreadDec;

        // Estimar reward por $100 USDC de liquidez provista
        // Simplificación: si tenés $100 en órdenes activas durante 1 día
        // y el pool total es N USDC, tu share = 100/N * dailyReward
        const liquidityUsdc   = Number(market.liquidity ?? 1);
        const estimatedShare  = (100 / Math.max(liquidityUsdc, 100)) * dailyReward;

        // Costo de fees para hacer market making con $100 (entrada + salida)
        // Asumimos que la posición da vuelta una vez por día
        const feesCostPer100 = takerFeePct * 2; // entrada y salida

        // Ratio: cuántas veces el reward cubre las fees
        const ratio = feesCostPer100 > 0
          ? estimatedShare / feesCostPer100
          : estimatedShare > 0 ? 99 : 0;

        if (ratio < p.minRewardFeeRatio) continue;

        opportunitiesFound++;

        const key = `${market.conditionId}:${reward.id}`;
        if (!(await cooldown.isReady(key, cooldownMs))) continue;

        await cooldown.stamp(key);

        const endDateStr    = new Date(reward.endDate).toISOString().slice(0, 10);
        const outcomes      = safeParseJson<string[]>(market.outcomes, ['Yes', 'No']);
        const spreadPctStr  = (currentSpread * 100).toFixed(2);

        signals.push({
          strategyId: this.id,
          severity:   ratio >= 5 ? 'high' : ratio >= 3 ? 'medium' : 'low',
          title:      `💰 Rewards: ${dailyReward.toFixed(0)} USDC/día — ${market.question.slice(0, 50)}`,
          body: [
            `<b>Mercado:</b> ${market.question}`,
            `<b>Categoría:</b> ${category} (taker fee peak: ${(calcTakerFee(0.5, category) * 100).toFixed(2)}%)`,
            '',
            `<b>Pool rewards:</b> $${dailyReward.toFixed(2)} USDC/día`,
            `<b>Reward estimado (por $100):</b> $${estimatedShare.toFixed(4)}/día`,
            `<b>Costo fees estimado (por $100):</b> ${feesCostPer100.toFixed(3)}%`,
            `<b>Ratio reward/fee:</b> ${ratio.toFixed(1)}x ${ratio >= p.minRewardFeeRatio ? '✅' : '❌'}`,
            '',
            `<b>Spread actual:</b> ${spreadPctStr}¢`,
            `<b>Max spread para calificar:</b> ${reward.maxSpread}¢`,
            `<b>Spread OK:</b> ${spreadOk ? '✅' : '⚠️ spread muy ancho'}`,
            `<b>Min size:</b> ${reward.minSize} USDC`,
            `<b>Precio mid:</b> ${(midPrice * 100).toFixed(1)}¢ (${outcomes[0]})`,
            `<b>Liquidez total:</b> $${Number(market.liquidity).toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
            `<b>Reward termina:</b> ${endDateStr}`,
            '',
            spreadOk
              ? `✅ Podés calificar para rewards con spread ≤ ${reward.maxSpread}¢`
              : `⚠️ El spread actual (${spreadPctStr}¢) supera el máximo (${reward.maxSpread}¢). Monitorear.`,
          ].join('\n'),
          metadata: {
            marketId:      market.conditionId,
            rewardId:      reward.id,
            dailyReward,
            estimatedShare,
            feesCostPer100,
            ratio,
            spreadOk,
            currentSpread,
            maxSpread: reward.maxSpread,
            category,
            midPrice,
            endDate: reward.endDate,
          },
        });
      }
    }

    return {
      signals,
      metrics: { marketsChecked, opportunitiesFound, signalsFired: signals.length },
    };
  },

  async init() {
    logger.info('[rewards_hunter] init — will monitor liquidity reward markets');
  },
};

// ─────────────────────────────────────────────────────────────────────────────

async function fetchRewardMarkets(base: string, limit: number): Promise<RewardsMarket[]> {
  // La gamma API tiene un endpoint específico para mercados con rewards
  const url = `${base}/markets?closed=false&limit=${limit}&order=volume24hr&ascending=false&rewards=true`;
  const res  = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`gamma API ${res.status}`);
  const data = await res.json() as RewardsMarket[];
  // Filtrar solo los que tienen clobRewards activos y no vacíos
  return data.filter(m =>
    m.clobTokenIds &&
    Array.isArray(m.clobRewards) &&
    m.clobRewards.length > 0,
  );
}

function safeParseJson<T>(raw: string | null | undefined, fallback: T): T {
  try {
    return raw ? JSON.parse(raw) as T : fallback;
  } catch {
    return fallback;
  }
}