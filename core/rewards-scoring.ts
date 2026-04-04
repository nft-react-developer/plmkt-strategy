// core/rewards-scoring.ts
// Implementación de la fórmula oficial de Polymarket Liquidity Rewards.
// https://docs.polymarket.com/market-makers/liquidity-rewards
//
// S(v, s)  = ((v - s) / v)² × b
// Qne      = Σ S × BidSize(YES) + Σ S × AskSize(NO)
// Qno      = Σ S × AskSize(YES) + Σ S × BidSize(NO)
// Qmin     = max(min(Qne,Qno), max(Qne/c, Qno/c))  si mid ∈ [0.10, 0.90]
//          = min(Qne, Qno)                           si mid < 0.10 o > 0.90

export interface ScoredOrder {
  tokenId:   string;
  side:      'buy' | 'sell';   // buy = bid, sell = ask
  price:     number;
  sizeShares: number;          // BidSize / AskSize de la fórmula
}

export interface ScoreResult {
  qne:             number;
  qno:             number;
  qmin:            number;
  inRange:         boolean;
  midExtreme:      boolean;    // midprice < 0.10 o > 0.90
  normalizedProxy: number;     // qmin / totalLiquidity (proxy, no el real)
  rewardUsdc:      number;     // estimación por muestra (1 minuto)
}

/**
 * Función de scoring cuadrática por orden.
 * v = max spread desde midpoint (en centavos)
 * s = distancia real de la orden al midpoint (en centavos)
 * b = in-game multiplier (actualmente 1 en todos los mercados salvo indicación)
 */
export function scoreOrder(v: number, s: number, b = 1): number {
  if (s >= v || s < 0) return 0;  // fuera del rango → no puntúa
  return Math.pow((v - s) / v, 2) * b;
}

/**
 * Calcula el score completo para una muestra (1 minuto).
 *
 * @param ordersYes  Órdenes sobre el token YES (m)
 * @param ordersNo   Órdenes sobre el token NO  (m')
 * @param midprice   Midpoint ajustado del mercado
 * @param maxSpreadCents  v: max spread del programa de rewards
 * @param scalingFactorC  c: scaling factor (actualmente 3.0)
 * @param totalLiquidityUsdc  Liquidez total del mercado (proxy denominador)
 * @param dailyRewardUsdc     Pool de rewards del día
 */
export function calcSampleScore(
  ordersYes: ScoredOrder[],
  ordersNo:  ScoredOrder[],
  midprice:  number,
  maxSpreadCents:      number,
  scalingFactorC:      number,
  totalLiquidityUsdc:  number,
  dailyRewardUsdc:     number,
): ScoreResult {
  const v = maxSpreadCents;
  const c = scalingFactorC;

  // ── Qne: bids en YES + asks en NO ────────────────────────────────────────
  let qne = 0;
  for (const o of ordersYes) {
    if (o.side !== 'buy') continue;
    const s = Math.abs(o.price - midprice) * 100;  // distancia en centavos
    qne += scoreOrder(v, s) * o.sizeShares;
  }
  for (const o of ordersNo) {
    if (o.side !== 'sell') continue;
    const s = Math.abs(o.price - midprice) * 100;
    qne += scoreOrder(v, s) * o.sizeShares;
  }

  // ── Qno: asks en YES + bids en NO ────────────────────────────────────────
  let qno = 0;
  for (const o of ordersYes) {
    if (o.side !== 'sell') continue;
    const s = Math.abs(o.price - midprice) * 100;
    qno += scoreOrder(v, s) * o.sizeShares;
  }
  for (const o of ordersNo) {
    if (o.side !== 'buy') continue;
    const s = Math.abs(o.price - midprice) * 100;
    qno += scoreOrder(v, s) * o.sizeShares;
  }

  // ── Qmin ─────────────────────────────────────────────────────────────────
  const midExtreme = midprice < 0.10 || midprice > 0.90;
  let qmin: number;

  if (midExtreme) {
    // Dual side obligatorio — sin dos lados, score = 0
    qmin = Math.min(qne, qno);
  } else {
    // Un solo lado puede puntuar, pero a 1/c
    qmin = Math.max(
      Math.min(qne, qno),
      Math.max(qne / c, qno / c),
    );
  }

  const inRange = qmin > 0;

  // ── Normalización proxy ───────────────────────────────────────────────────
  // No podemos conocer el Qmin de otros MMs en tiempo real.
  // Usamos la liquidez total del mercado como denominador aproximado.
  // El reward real puede diferir, pero la dirección es correcta.
  const normalizedProxy = totalLiquidityUsdc > 0 ? qmin / totalLiquidityUsdc : 0;

  // ── Reward por muestra (1 minuto = 1/1440 del día) ────────────────────────
  const rewardUsdc = normalizedProxy * (dailyRewardUsdc / 1440);

  return { qne, qno, qmin, inRange, midExtreme, normalizedProxy, rewardUsdc };
}

/**
 * Calcula el midprice ajustado a partir del book.
 * Si no hay bid o ask, usa el precio del último trade como fallback.
 */
export function calcMidprice(bestBid: number | null, bestAsk: number | null): number | null {
  if (bestBid !== null && bestAsk !== null) return (bestBid + bestAsk) / 2;
  if (bestBid !== null) return bestBid;
  if (bestAsk !== null) return bestAsk;
  return null;
}

/**
 * Dado un capital en USDC y un precio, calcula cuántas shares comprar
 * y a qué precio colocar bid/ask dentro del maxSpread.
 *
 * Coloca las órdenes lo más cerca posible del midpoint
 * (a 1 centavo dentro del límite para maximizar el score cuadrático).
 */
export function calcOrderPrices(
  midprice:       number,
  maxSpreadCents: number,
  sizePerSideUsdc: number,
  dualSideRequired: boolean,
): Array<{ side: 'buy' | 'sell'; price: number; sizeUsdc: number; sizeShares: number; spreadFromMidCents: number }> {
  // Colocar a 1 centavo del midpoint (máximo score posible)
  // Nunca superar maxSpreadCents - 0.5 para tener margen
  const targetSpreadCents = Math.min(1.0, maxSpreadCents - 0.5);
  const targetSpread      = targetSpreadCents / 100;

  const bidPrice = Math.max(0.01, midprice - targetSpread);
  const askPrice = Math.min(0.99, midprice + targetSpread);

  const result = [];

  // Siempre colocamos bid en YES
  const bidShares = sizePerSideUsdc / bidPrice;
  result.push({
    side:               'buy' as const,
    price:              bidPrice,
    sizeUsdc:           sizePerSideUsdc,
    sizeShares:         bidShares,
    spreadFromMidCents: targetSpreadCents,
  });

  // Ask en YES — siempre (incluso si no es dual side, suma al score)
  const askShares = sizePerSideUsdc / askPrice;
  result.push({
    side:               'sell' as const,
    price:              askPrice,
    sizeUsdc:           sizePerSideUsdc,
    sizeShares:         askShares,
    spreadFromMidCents: targetSpreadCents,
  });

  return result;
}