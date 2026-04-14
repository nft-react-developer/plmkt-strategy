import express, { Request, Response } from 'express';
import { fetchRewardMarkets, RewardsMarket } from '../strategies/reward-executor/fetch-reward-markets';

const app = express();

const CLOB_BASE   = process.env.CLOB_API_BASE  ?? 'https://clob.polymarket.com';
const MIN_RATE    = Number(process.env.API_MIN_RATE    ?? 60);
const MAX_MIN_SIZE = Number(process.env.API_MAX_MIN_SIZE ?? 500);
const INTERVAL_MS = Number(process.env.API_INTERVAL_MS  ?? 60_000);

// ── Cache + poller ────────────────────────────────────────────────────────────

let cache: RewardsMarket[] = [];
const clients = new Set<Response>();

async function poll() {
  try {
    cache = await fetchRewardMarkets(CLOB_BASE, MIN_RATE, MAX_MIN_SIZE);
    broadcast(cache);
  } catch (err) {
    console.error('[api] poll error:', err);
  }
}

function broadcast(markets: RewardsMarket[]) {
  const payload = `data: ${JSON.stringify({ ts: Date.now(), count: markets.length, markets })}\n\n`;
  for (const res of clients) res.write(payload);
}

// ── REST endpoint (snapshot) ──────────────────────────────────────────────────

app.get('/reward-markets', async (req, res) => {
  try {
    const minRate    = Number(req.query.minRate    ?? MIN_RATE);
    const maxMinSize = Number(req.query.maxMinSize ?? MAX_MIN_SIZE);
    const markets = await fetchRewardMarkets(CLOB_BASE, minRate, maxMinSize);
    res.json(markets);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// ── SSE viewer (browser) ──────────────────────────────────────────────────────

app.get('/reward-markets/live', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Reward Markets</title>
  <style>
    body { font-family: monospace; background: #0d1117; color: #c9d1d9; padding: 1rem; }
    #ts  { color: #8b949e; font-size: .85rem; margin-bottom: .5rem; }
    pre  { white-space: pre-wrap; word-break: break-word; }
  </style>
</head>
<body>
  <div id="ts">waiting...</div>
  <pre id="out"></pre>
  <script>
    const es = new EventSource('/reward-markets/stream');
    es.onmessage = e => {
      const { ts, count, markets } = JSON.parse(e.data);
      document.getElementById('ts').textContent =
        new Date(ts).toLocaleTimeString() + ' — ' + count + ' markets';
      const rows = markets
        .sort((a, b) => (b.rewards_config[0]?.rate_per_day ?? 0) - (a.rewards_config[0]?.rate_per_day ?? 0))
        .map(m => ({
          question:         m.question,
          condition_id:     m.condition_id,
          rewards_min_size: m.rewards_min_size,
          rate_per_day:     m.rewards_config[0]?.rate_per_day ?? 0,
          spread:           m.spread,
        }));
      document.getElementById('out').textContent =
        JSON.stringify(rows, null, 2);
    };
  </script>
</body>
</html>`);
});

// ── SSE stream (raw) ──────────────────────────────────────────────────────────

app.get('/reward-markets/stream', (req: Request, res: Response) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  // manda el cache inmediatamente al conectar
  if (cache.length > 0) {
    res.write(`data: ${JSON.stringify({ ts: Date.now(), count: cache.length, markets: cache })}\n\n`);
  }

  clients.add(res);
  console.log(`[sse] client connected (total: ${clients.size})`);

  req.on('close', () => {
    clients.delete(res);
    console.log(`[sse] client disconnected (total: ${clients.size})`);
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

export function startApiServer(port = 3001) {
  app.listen(port, async () => {
    console.log(`[api] REST   → http://localhost:${port}/reward-markets`);
    console.log(`[api] Live   → http://localhost:${port}/reward-markets/live`);
    console.log(`[api] Stream → http://localhost:${port}/reward-markets/stream`);
    console.log(`[api] polling every ${INTERVAL_MS / 1000}s`);
    await poll();
    setInterval(poll, INTERVAL_MS);
  });
}
