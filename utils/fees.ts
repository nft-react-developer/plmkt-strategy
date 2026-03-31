/**
 * utils/fees.ts
 *
 * Calcula las taker fees dinámicas de Polymarket según la estructura
 * lanzada el 30 de marzo de 2026.
 *
 * Fórmula oficial:
 *   fee = C × p × feeRate × (p × (1 – p))^exponent
 *   donde p = precio del token (0-1), C = constante de normalización
 *
 * La fee es máxima cuando p = 0.5 (50% de probabilidad) y se acerca
 * a 0 cuando p → 0 o p → 1.
 *
 * Parámetros por categoría (peak fee en p=0.5):
 *   Crypto:                  1.80% peak, exponent 1
 *   Sports:                  0.75% peak, exponent 1
 *   Finance/Politics/Tech:   1.00% peak, exponent 1
 *   Culture:                 1.00% peak, exponent 1
 *   Economics:               1.50% peak, exponent 0.5
 *   Weather:                 1.25% peak, exponent 0.5
 *   Other/General:           1.20% peak, exponent 2
 *   Mentions:                1.50% peak, exponent 2
 *   Geopolitics:             0.00% (sin fees)
 *
 * Maker rebates (no aplican en esta estrategia de monitoring, solo info):
 *   Crypto: 50%, Sports/Culture: 20%, Finance/Politics/Tech: 25%
 */

export type MarketCategory =
  | 'crypto'
  | 'sports'
  | 'politics'
  | 'finance'
  | 'tech'
  | 'culture'
  | 'economics'
  | 'weather'
  | 'other'
  | 'mentions'
  | 'geopolitics'
  | 'unknown';

interface FeeParams {
  /** Peak fee en p=0.5, expresado como decimal (ej. 0.018 = 1.8%) */
  peakRate:  number;
  /** Exponent de la curva: 0.5 = más plana, 1 = estándar, 2 = más aguda */
  exponent:  number;
  /** % del maker rebate (0-1) */
  makerRebate: number;
}

const FEE_CONFIG: Record<MarketCategory, FeeParams> = {
  crypto:      { peakRate: 0.018, exponent: 1,   makerRebate: 0.50 },
  sports:      { peakRate: 0.0075, exponent: 1,  makerRebate: 0.20 },
  politics:    { peakRate: 0.010, exponent: 1,   makerRebate: 0.25 },
  finance:     { peakRate: 0.010, exponent: 1,   makerRebate: 0.25 },
  tech:        { peakRate: 0.010, exponent: 1,   makerRebate: 0.25 },
  culture:     { peakRate: 0.010, exponent: 1,   makerRebate: 0.20 },
  economics:   { peakRate: 0.015, exponent: 0.5, makerRebate: 0.25 },
  weather:     { peakRate: 0.0125, exponent: 0.5, makerRebate: 0.20 },
  other:       { peakRate: 0.012, exponent: 2,   makerRebate: 0.20 },
  mentions:    { peakRate: 0.015, exponent: 2,   makerRebate: 0.20 },
  geopolitics: { peakRate: 0.000, exponent: 1,   makerRebate: 0.00 },
  unknown:     { peakRate: 0.010, exponent: 1,   makerRebate: 0.20 },
};

/**
 * Calcula la taker fee efectiva para un precio dado y categoría.
 * La constante C se normaliza para que el peak en p=0.5 sea exactamente peakRate.
 *
 * @param price     Precio del token (0-1)
 * @param category  Categoría del mercado
 * @returns         Fee como decimal (ej. 0.009 = 0.9%)
 */
export function calcTakerFee(price: number, category: MarketCategory): number {
  const cfg = FEE_CONFIG[category];
  if (cfg.peakRate === 0) return 0;

  // Normalización: C tal que fee(0.5) = peakRate
  // fee(p) = C × (p × (1-p))^exponent
  // fee(0.5) = C × (0.25)^exponent = peakRate
  // → C = peakRate / (0.25)^exponent
  const peakInput = Math.pow(0.25, cfg.exponent);
  const C         = cfg.peakRate / peakInput;

  const variance = price * (1 - price);
  return C * Math.pow(variance, cfg.exponent);
}

/**
 * Calcula el break-even spread mínimo necesario para cubrir las fees
 * de entrada Y salida (dos operaciones de taker).
 *
 * Para que una operación sea rentable:
 *   ganancia > fee_entrada + fee_salida
 *   (sellPrice - buyPrice) > fee(buyPrice) + fee(sellPrice)
 *
 * @param buyPrice   Precio de compra (0-1)
 * @param category   Categoría del mercado
 * @returns          Spread mínimo necesario como decimal
 */
export function minProfitableSpread(buyPrice: number, category: MarketCategory): number {
  const feeIn  = calcTakerFee(buyPrice, category);
  // Estimamos fee de salida al precio actual (conservador)
  const feeOut = calcTakerFee(buyPrice, category);
  return feeIn + feeOut;
}

/**
 * Determina si una oportunidad es rentable considerando las fees.
 *
 * @param buyPrice    Precio de compra
 * @param targetPrice Precio objetivo de venta (o 1.0 si es arb de resolución)
 * @param category    Categoría del mercado
 * @returns           { profitable, netPnlPct, feePct }
 */
export function isProfitable(
  buyPrice:    number,
  targetPrice: number,
  category:    MarketCategory,
): { profitable: boolean; netPnlPct: number; feePct: number } {
  const feeIn    = calcTakerFee(buyPrice,    category);
  const feeOut   = calcTakerFee(targetPrice, category);
  const totalFee = feeIn + feeOut;
  const gross    = targetPrice - buyPrice;
  const net      = gross - totalFee * buyPrice; // fee se aplica sobre el capital

  return {
    profitable: net > 0,
    netPnlPct:  (net / buyPrice) * 100,
    feePct:     totalFee * 100,
  };
}

/**
 * Convierte una tag/categoría de la gamma API al tipo MarketCategory.
 */
export function parseCategory(tag?: string | null): MarketCategory {
  if (!tag) return 'unknown';
  const t = tag.toLowerCase();
  if (t.includes('crypto') || t.includes('bitcoin') || t.includes('eth'))  return 'crypto';
  if (t.includes('sport') || t.includes('nba') || t.includes('nfl') ||
      t.includes('soccer') || t.includes('nhl') || t.includes('mlb'))      return 'sports';
  if (t.includes('politic') || t.includes('election') || t.includes('gov')) return 'politics';
  if (t.includes('financ') || t.includes('stock') || t.includes('market'))  return 'finance';
  if (t.includes('tech') || t.includes('ai') || t.includes('software'))    return 'tech';
  if (t.includes('cultur') || t.includes('entertain') || t.includes('music')) return 'culture';
  if (t.includes('econom') || t.includes('gdp') || t.includes('fed'))      return 'economics';
  if (t.includes('weather') || t.includes('climate'))                       return 'weather';
  if (t.includes('geopolit') || t.includes('war') || t.includes('conflict')) return 'geopolitics';
  if (t.includes('mention'))                                                 return 'mentions';
  return 'other';
}