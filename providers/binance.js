const { INTERVALS } = require('../intervals');
const { httpError } = require('../http-error');

const BASE = process.env.BINANCE_BASE_URL || 'https://api.binance.com';
const TIMEOUT_MS = Number(process.env.PROVIDER_TIMEOUT_MS) || 8000;
const MAX_LIMIT = 1000; // Binance's hard cap for /api/v3/klines

// Set when Binance answers 429/418. Hammering through a rate limit escalates to
// a temporary IP ban, so we fail fast locally until the window passes.
let circuitOpenUntil = 0;

// Raw kline: [openTimeMs, open, high, low, close, volume, closeTimeMs, ...]
// Prices and volumes arrive as strings, times as milliseconds.
function normalize(raw) {
  const bars = [];

  for (const k of raw) {
    if (!Array.isArray(k) || k.length < 7) continue;

    const bar = {
      time: Math.floor(Number(k[0]) / 1000),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]), // base-asset volume, what charts show by default
      closeTime: Math.floor(Number(k[6]) / 1000),
    };

    const usable =
      Number.isFinite(bar.time) &&
      Number.isFinite(bar.closeTime) &&
      Number.isFinite(bar.open) &&
      Number.isFinite(bar.high) &&
      Number.isFinite(bar.low) &&
      Number.isFinite(bar.close);
    if (!usable) continue;

    if (!Number.isFinite(bar.volume)) bar.volume = 0;
    bars.push(bar);
  }

  // lightweight-charts asserts on out-of-order or duplicate timestamps and
  // blanks the chart, so guarantee the ordering here rather than trusting it.
  bars.sort((a, b) => a.time - b.time);
  return bars.filter((b, i) => i === bars.length - 1 || b.time !== bars[i + 1].time);
}

async function fetchCandles({ providerSymbol, interval, limit = MAX_LIMIT }) {
  if (Date.now() < circuitOpenUntil) {
    throw httpError(429, 'rate_limited', 'Market data provider rate limit hit, backing off');
  }

  const url = new URL('/api/v3/klines', BASE);
  url.searchParams.set('symbol', providerSymbol);
  url.searchParams.set('interval', INTERVALS[interval].binance);
  url.searchParams.set('limit', String(Math.min(limit, MAX_LIMIT)));

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
    // Binance errors look like { code: -1121, msg: 'Invalid symbol.' }. A bad
    // symbol here means our own providerSymbol mapping is wrong, which is a
    // server-side bug, not client input error - hence 502 rather than 400.
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

  return { bars: normalize(raw), fetchedAt: Math.floor(Date.now() / 1000) };
}

module.exports = { name: 'binance', maxLimit: MAX_LIMIT, fetchCandles };
