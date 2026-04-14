// strategies/reward-executor/fetch-reward-markets.ts
// Función aislada para obtener mercados con recompensas activas de Polymarket.

export interface RewardToken  { token_id: string; outcome: string; price: number; }
export interface RewardsConfig {
  id: number; asset_address: string;
  start_date: string; end_date: string;
  rate_per_day: number; total_rewards: number;
}
export interface RewardsMarket {
  condition_id:         string;
  question:             string;
  market_slug?:         string;
  event_slug?:          string;
  slug?:                string;
  rewards_min_size:     number;
  spread:               number;
  end_date:             string;
  tokens:               RewardToken[];
  volume_24hr:          number;
  rewards_config:       RewardsConfig[];
  neg_risk?:              boolean;
  minimum_tick_size?:     number;
  market_competitiveness?: number;
}

export async function fetchRewardMarkets(clobBase: string, fetchMinRate: number, fetchMaxMinSize: number): Promise<RewardsMarket[]> {
  const LAST_CURSOR = 'LTE=';

  // ── Step 1: paginar /rewards/markets/current?sponsored=true ──────────────
  interface CurrentEntry {
    condition_id:        string;
    rewards_min_size:    number;
    rewards_max_spread:  number;
    total_daily_rate?:   number;
    rewards_config?:     Array<{ rate_per_day?: number; end_date?: string; id?: number; [k: string]: unknown }>;
  }
  interface CurrentResponse { limit: number; count: number; next_cursor: string; data: CurrentEntry[]; }

  const qualifiedMap = new Map<string, { rewards_min_size: number; rewards_max_spread: number; rate_per_day: number; reward_end_date: string; reward_id: number }>();
  let cursor: string | null = null;

  do {
    const url = new URL(`${clobBase}/rewards/markets/current`);
    url.searchParams.set('sponsored', 'true');
    if (cursor) url.searchParams.set('next_cursor', cursor);

    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`CLOB rewards/current ${res.status}: ${body}`);
    }
    const data = await res.json() as CurrentResponse;

    for (const m of (data.data ?? [])) {
      const rate = Number(m.total_daily_rate ?? m.rewards_config?.[0]?.rate_per_day ?? 0);
      if (rate >= fetchMinRate && Number(m.rewards_min_size) <= fetchMaxMinSize) {
        qualifiedMap.set(m.condition_id, {
          rewards_min_size:  Number(m.rewards_min_size),
          rewards_max_spread: Number(m.rewards_max_spread),
          rate_per_day:      rate,
          reward_end_date:   String(m.rewards_config?.[0]?.end_date ?? ''),
          reward_id:         Number(m.rewards_config?.[0]?.id ?? 0),
        });
      }
    }
    cursor = (data.next_cursor === LAST_CURSOR || !data.next_cursor) ? null : data.next_cursor;
  } while (cursor);

  console.log(`[rewards_executor] fetchRewardMarkets: ${qualifiedMap.size} mercados calificados (rate≥${fetchMinRate}, minSize≤${fetchMaxMinSize})`);
  if (qualifiedMap.size === 0) return [];

  // ── Step 2: enriquecer desde /markets/{condition_id} ────────────────────
  interface ClobMarketDetail {
    condition_id:      string;
    question:          string;
    tokens:            RewardToken[];
    neg_risk:          boolean;
    minimum_tick_size: number;
    rewards_config: {
      asset_address: string;
      start_date: string;
      end_date: string;
      id: number;
      rate_per_day: number;
      total_rewards: number;
      total_days: number;
    };
    rewards: {
      rates: [{ asset_address: string; rewards_daily_rate: number }];
      min_size: number;
      max_spread: number;
    };
    rewards_max_spread: number;
    rewards_min_size: number;
    end_date_iso?:     string;
    end_date?:         string;
  }

  const markets: RewardsMarket[] = [];

  for (const id of qualifiedMap.keys()) {
    try {
      const detailRes = await fetch(`${clobBase}/markets/${id}`, { signal: AbortSignal.timeout(10_000) });
      if (!detailRes.ok) continue;
      const d = await detailRes.json() as ClobMarketDetail;

      const q = qualifiedMap.get(d.condition_id);
      if (!q || !d.tokens || d.tokens.length < 2) continue;
      if (d.tokens.some((t: RewardToken & { winner?: boolean }) => t.winner === true)) continue;
      if (d.tokens.some((t: RewardToken) => Number(t.price) === 0 || Number(t.price) === 1)) continue;

      const endDate = d.end_date_iso ?? d.end_date ?? '';
      markets.push({
        condition_id:       d.condition_id,
        question:           d.question ?? '',
        rewards_min_size:   q.rewards_min_size,
        spread:             d.rewards_max_spread ? Number(d.rewards_max_spread ?? 0) : Number(d.rewards.max_spread ?? 0),
        end_date:           endDate,
        tokens:             d.tokens,
        volume_24hr:        0,
        rewards_config:     [{ id: q.reward_id, asset_address: '', start_date: '', end_date: q.reward_end_date || endDate, rate_per_day: q.rate_per_day, total_rewards: 0 }],
        neg_risk:           d.neg_risk ?? false,
        minimum_tick_size:  d.minimum_tick_size ?? 0.01,
      });
    } catch { /* si falla un mercado, seguimos con el siguiente */ }
  }

  console.log(`[rewards_executor] fetchRewardMarkets: ${markets.length} mercados listos`);
  return markets;
}
