// ─────────────────────────────────────────────────────────────────────────────
// Tipos compartidos de la Gamma API de Polymarket
// ─────────────────────────────────────────────────────────────────────────────

export interface GammaMarket {
  id:            string;
  conditionId:   string;
  question:      string;
  volume24hr:    string;
  volumeNum:     string;
  outcomePrices: string;  // JSON string: '["0.62","0.38"]'
  outcomes:      string;  // JSON string: '["Yes","No"]'
  clobTokenIds:  string;  // separado por coma: "tokenA,tokenB"
  closed:        boolean;
  active:        boolean;
  resolutionTime?: string;
}

export interface GammaToken {
  token_id: string;
  outcome:  string;
  price:    string;
  winner?:  boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Convierte un GammaMarket al array de tokens que usan las estrategias
// ─────────────────────────────────────────────────────────────────────────────

export function parseTokens(market: GammaMarket): GammaToken[] {
  try {
    const prices   = JSON.parse(market.outcomePrices ?? '[]') as string[];
    const outcomes = JSON.parse(market.outcomes      ?? '[]') as string[];
    const tokenIds = (market.clobTokenIds ?? '')
      .split(',')
      .map(t => t.trim())
      .filter(Boolean);

    return tokenIds.map((token_id, i) => ({
      token_id,
      outcome: outcomes[i] ?? `Outcome ${i}`,
      price:   prices[i]   ?? '0',
    }));
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch genérico de mercados activos ordenados por volumen 24h
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchActiveMarkets(
  base:      string,
  minVolume: number,
  limit:     number,
): Promise<GammaMarket[]> {
  const url = `${base}/markets?closed=false&limit=${limit}&order=volume24hr&ascending=false`;
  const res  = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`gamma API ${res.status}`);
  const data: GammaMarket[] = await res.json() as GammaMarket[];
  return data.filter(m => Number(m.volume24hr ?? 0) >= minVolume && m.clobTokenIds);
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch de mercados cerrados recientemente (para resolution-arb)
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchResolvedMarkets(
  base:      string,
  minVolume: number,
  limit:     number,
): Promise<GammaMarket[]> {
  const url = `${base}/markets?closed=true&limit=${limit}&order=volume24hr&ascending=false`;
  const res  = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`gamma API ${res.status}`);
  const data: GammaMarket[] = await res.json() as GammaMarket[];
  return data.filter(m => Number(m.volume24hr ?? 0) >= minVolume && m.clobTokenIds);
}