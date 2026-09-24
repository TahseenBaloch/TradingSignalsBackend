const { httpError } = require('../http-error');

// aggTrades client: same timeouts and circuit breaker as providers/binance.js, but the endpoint that carries aggressor side.
const TIMEOUT_MS = Number(process.env.PROVIDER_TIMEOUT_MS) || 8000;
const MAX_LIMIT = 1000; // Binance's hard cap for aggTrades, spot and futures alike

/** Binance's `m` means "was the buyer the maker", so aggressor side is normalized once here - backwards silently inverts every delta downstream. */
function normalize(raw) {
  const trades = [];
  for (const t of raw) {
    const price = Number(t.p);
    const qty = Number(t.q);
    const time = Math.floor(Number(t.T) / 1000);
    if (!Number.isFinite(price) || !Number.isFinite(qty) || !Number.isFinite(time)) continue;
    trades.push({ time, price, qty, buyerAggressor: t.m === false });
  }
  return trades;
}

// Spot and futures aggTrades share a payload (including the meaning of `m`) but not a rate limit, hence one breaker per instance.
function createTradesProvider({ name, baseUrl, path }) {
  let circuitOpenUntil = 0;

  async function fetchAggTrades({ providerSymbol, startMs, endMs }) {
    if (Date.now() < circuitOpenUntil) {
      throw httpError(429, 'rate_limited', 'Market data provider rate limit hit, backing off');
    }

    const url = new URL(path, baseUrl);
    url.searchParams.set('symbol', providerSymbol);
    url.searchParams.set('startTime', String(startMs));
    url.searchParams.set('endTime', String(endMs));
    url.searchParams.set('limit', String(MAX_LIMIT));

    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw httpError(504, 'upstream_timeout', 'Market data provider timed out');
      }
      throw httpError(502, 'upstream_unreachable', 'Market data provider unreachable');
    }

    if (res.status === 429 || res.status === 418) {
      const retryAfter = Number(res.headers.get('retry-after')) || 30;
      circuitOpenUntil = Date.now() + retryAfter * 1000;
      throw httpError(429, 'rate_limited', 'Market data provider rate limit hit');
    }

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const detail = body && body.msg ? `: ${body.msg}` : '';
      throw httpError(502, 'upstream_error', `Market data provider rejected the request${detail}`, {
        providerCode: body && body.code,
      });
    }

    const raw = await res.json().catch(() => null);
    if (!Array.isArray(raw)) {
      throw httpError(502, 'upstream_bad_payload', 'Unexpected response from market data provider');
    }

    // A window busier than the cap returns its first 1000 trades, not a sample, so report it rather than pretending the bar is complete.
    return { trades: normalize(raw), truncated: raw.length >= MAX_LIMIT };
  }

  return { name, maxLimit: MAX_LIMIT, fetchAggTrades };
}

const spot = createTradesProvider({
  name: 'binance-trades',
  baseUrl: process.env.BINANCE_BASE_URL || 'https://api.binance.com',
  path: '/api/v3/aggTrades',
});

const futures = createTradesProvider({
  name: 'binance-futures-trades',
  baseUrl: process.env.BINANCE_FUTURES_BASE_URL || 'https://fapi.binance.com',
  path: '/fapi/v1/aggTrades',
});

// Keyed by the symbol registry's `provider`, so flow-service can pick the tape that matches the chart.
const TRADES_BY_PROVIDER = { binance: spot, 'binance-futures': futures };

module.exports = { ...spot, TRADES_BY_PROVIDER };
