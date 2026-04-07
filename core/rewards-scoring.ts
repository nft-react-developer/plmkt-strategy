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

// Estrategia de colocacion de ordenes:
//   tight — 1c del mid (max score, mas riesgo de fill)
//   mid   — mitad del maxSpread (balance score/riesgo) <- recomendada
//   wide  — cerca del maxSpread (min fill risk, menor score)
export type PlacementStrategy = 'tight' | 'mid' | 'wide';

/**
 * Calcula los precios de las ordenes bid/ask segun la estrategia de colocacion.
 *
 * tight: 1c del mid — maximiza score cuadratico, mas expuesto a fills
 * mid:   mitad del maxSpread — balance entre score y seguridad
 * wide:  80% del maxSpread — minimo riesgo de fill, menor score
 */
export function calcOrderPrices(
  midprice:          number,
  maxSpreadCents:    number,
  sizePerSideUsdc:   number,
  dualSideRequired:  boolean,
  placement:         PlacementStrategy = 'mid',
): Array<{ side: 'buy' | 'sell'; price: number; sizeUsdc: number; sizeShares: number; spreadFromMidCents: number }> {

  let targetSpreadCents: number;
  switch (placement) {
    case 'tight': targetSpreadCents = Math.min(1.0, maxSpreadCents - 0.5); break;
    case 'mid':   targetSpreadCents = maxSpreadCents / 2; break;
    case 'wide':  targetSpreadCents = maxSpreadCents * 0.80; break;
    default:      targetSpreadCents = maxSpreadCents / 2;
  }

  targetSpreadCents = Math.max(0.5, Math.min(targetSpreadCents, maxSpreadCents - 0.5));
  const targetSpread = targetSpreadCents / 100;

  const rawBid = midprice - targetSpread;
  const rawAsk = midprice + targetSpread;

  // ← AÑADIR: redondear al tick size (0.01)
  const tick    = 0.01;
  const bidPrice = Math.max(0.01, Math.round(rawBid / tick) * tick);
  const askPrice = Math.min(0.99, Math.round(rawAsk / tick) * tick);

  const bidShares = sizePerSideUsdc / bidPrice;
  const askShares = sizePerSideUsdc / askPrice;

  return [
    { side: 'buy',  price: bidPrice, sizeUsdc: sizePerSideUsdc, sizeShares: bidShares, spreadFromMidCents: targetSpreadCents },
    { side: 'sell', price: askPrice, sizeUsdc: sizePerSideUsdc, sizeShares: askShares, spreadFromMidCents: targetSpreadCents },
  ];
}