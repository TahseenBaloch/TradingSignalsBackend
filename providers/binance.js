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

async function fetchCandles({ providerSymbol, interval, limit = MAX_LIMIT, startTime, endTime }) {
  if (Date.now() < circuitOpenUntil) {
    throw httpError(429, 'rate_limited', 'Market data provider rate limit hit, backing off');
  }

  const url = new URL('/api/v3/klines', BASE);
  url.searchParams.set('symbol', providerSymbol);
  url.searchParams.set('interval', INTERVALS[interval].binance);
  url.searchParams.set('limit', String(Math.min(limit, MAX_LIMIT)));
  // Optional window, used by fetchRange() to page through deep history. Binance
  // expects milliseconds; everywhere else in this codebase times are seconds.
  if (startTime !== undefined) url.searchParams.set('startTime', String(startTime * 1000));
  if (endTime !== undefined) url.searchParams.set('endTime', String(endTime * 1000));

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

/**
 * Pages forward through history, 1000 klines at a time, until `endTime`.
 *
 * Only for the backtest seed — the live /chart path never needs this and must
 * not pay for it. Binance caps a single response at 1000 klines, so two years
 * of 1h bars is ~18 requests and sixty days of 1m bars is ~87.
 *
 * Paging forward from startTime (rather than backward from now) keeps the
 * result stable across reruns, which is what lets the on-disk cache be trusted.
 *
 * @param {Object} spec
 * @param {string} spec.providerSymbol
 * @param {string} spec.interval
 * @param {number} spec.startTime  Unix SECONDS, inclusive.
 * @param {number} spec.endTime    Unix SECONDS, exclusive.
 * @param {(info: {fetched: number, through: number}) => void} [spec.onProgress]
 * @param {number} [spec.pauseMs]  Courtesy delay between pages.
 * @returns {Promise<{bars: object[]}>}
 */
async function fetchRange({ providerSymbol, interval, startTime, endTime, onProgress, pauseMs = 120 }) {
  const step = INTERVALS[interval].seconds;
  const bars = [];
  let cursor = startTime;

  while (cursor < endTime) {
    // A full seed is ~1,200 requests; at that volume a transient upstream blip
    // is near-certain, and without a retry one of them kills a half-hour fetch
    // and discards everything already downloaded.
    let page = null;
    let lastError = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        ({ bars: page } = await fetchCandles({
          providerSymbol,
          interval,
          limit: MAX_LIMIT,
          startTime: cursor,
          endTime,
        }));
        break;
      } catch (err) {
        lastError = err;
        // Back off hard on a rate limit, gently on anything else.
        const wait = err.code === 'rate_limited' ? 30_000 : 1000 * 2 ** attempt;
        if (onProgress) onProgress({ fetched: bars.length, through: cursor, retrying: err.message });
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
    if (page === null) throw lastError;

    if (page.length === 0) break;

    for (const bar of page) {
      if (bar.time >= endTime) continue;
      bars.push(bar);
    }

    const last = page[page.length - 1].time;
    // A page that cannot advance the cursor means we have reached the end of
    // available history; without this guard the loop would spin forever.
    if (last + step <= cursor) break;
    cursor = last + step;

    if (onProgress) onProgress({ fetched: bars.length, through: last });
    if (page.length < MAX_LIMIT) break; // partial page: nothing left upstream
    if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }

  // The newest kline may still be forming. Deduplicate and drop it, matching
  // the closed-bars-only contract the rest of the system relies on.
  const seen = new Set();
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    bars: bars.filter((bar) => {
      if (seen.has(bar.time)) return false;
      seen.add(bar.time);
      return bar.closeTime < nowSec;
    }),
  };
}

module.exports = { name: 'binance', maxLimit: MAX_LIMIT, fetchCandles, fetchRange };
