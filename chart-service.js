const cache = require('./cache');
const { getSymbol } = require('./symbols');
const { SUPPORTED, resolveInterval, nextBarCloseAt } = require('./intervals');
const { httpError } = require('./http-error');

// Register additional providers here; symbols.js decides which one each symbol
// resolves to.
const PROVIDERS = {
  binance: require('./providers/binance'),
};

const CACHE_VERSION = 'v2'; // bump to invalidate every entry after a shape change
const MIN_LIMIT = 10;
const DEFAULT_LIMIT = 1000;

// Coalesces concurrent misses for the same key onto one upstream fetch. React
// StrictMode double-invokes effects, and the frontend's AbortController does not
// propagate through the Next proxy, so duplicate in-flight requests are routine.
const inflight = new Map();

function dedupe(key, fn) {
  const pending = inflight.get(key);
  if (pending) return pending;

  const promise = fn().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

// Expire exactly when the next bar closes: never sooner (wasted fetch), never
// later (stale data). Small jitter avoids a thundering herd across symbols.
function ttlFor(interval, nowSec) {
  const secondsLeft = nextBarCloseAt(interval, nowSec) - nowSec;
  return Math.max(5, secondsLeft + Math.floor(Math.random() * 3));
}

// Bars are cached as positional tuples rather than objects: repeating six key
// names across ~1000 bars more than doubles the payload, and payload size is
// what dominates the round trip to a remote Redis.
function encodeBars(bars) {
  return bars.map((b) => [b.time, b.open, b.high, b.low, b.close, b.volume]);
}

function decodeBars(rows) {
  if (!Array.isArray(rows) || !rows.length) return null; // treat empty as a miss
  return rows.map(([time, open, high, low, close, volume]) => ({
    time,
    open,
    high,
    low,
    close,
    volume,
  }));
}

function parseLimit(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw httpError(400, 'invalid_limit', 'limit must be a positive integer');
  }
  return Math.min(Math.max(Math.floor(n), MIN_LIMIT), DEFAULT_LIMIT);
}

async function loadClosedBars(key, symbol, interval) {
  const provider = PROVIDERS[symbol.provider];
  if (!provider) {
    throw httpError(500, 'provider_missing', `No provider registered for ${symbol.symbol}`);
  }

  const { bars } = await provider.fetchCandles({
    providerSymbol: symbol.providerSymbol,
    interval,
    limit: provider.maxLimit,
  });

  // The newest kline is the bar currently forming. Caching it would freeze a
  // partial close as if it were final - drop it and let the Phase 2 WebSocket
  // own the live bar. Filtering on closeTime is safer than popping the tail.
  const nowSec = Math.floor(Date.now() / 1000);
  const closed = bars
    .filter((b) => b.closeTime < nowSec)
    .map(({ closeTime, ...bar }) => bar);

  if (!closed.length) {
    throw httpError(502, 'empty_series', 'Market data provider returned no closed bars');
  }

  const encoded = encodeBars(closed);
  await cache.set(key, encoded, ttlFor(interval, nowSec));
  await cache.setStale(key, encoded);
  return closed;
}

async function getChart({ symbol: symbolInput, interval: intervalInput, limit: limitInput }) {
  if (!symbolInput) {
    throw httpError(400, 'missing_symbol', 'symbol query parameter is required');
  }

  const symbol = getSymbol(symbolInput);
  if (!symbol) {
    throw httpError(400, 'unknown_symbol', `Unknown symbol: ${symbolInput}`);
  }

  const interval = resolveInterval(intervalInput);
  if (!interval) {
    throw httpError(
      400,
      'invalid_interval',
      `Unsupported interval: ${intervalInput}. Supported: ${SUPPORTED.join(', ')}`
    );
  }

  const limit = parseLimit(limitInput);
  const key = `chart:${CACHE_VERSION}:${symbol.provider}:${symbol.providerSymbol}:${interval}`;

  let bars = decodeBars(await cache.get(key));
  let cached = true;
  let stale = false;

  if (!bars) {
    cached = false;
    try {
      bars = await dedupe(key, () => loadClosedBars(key, symbol, interval));
    } catch (err) {
      // Last resort: serve the long-lived copy rather than a broken chart.
      const fallback = decodeBars(await cache.getStale(key));
      if (!fallback) throw err;
      console.warn(`[chart] ${symbol.symbol} ${interval} serving stale data:`, err.message);
      bars = fallback;
      stale = true;
    }
  }

  const candles = limit < bars.length ? bars.slice(-limit) : bars;

  return {
    symbol: symbol.symbol,
    interval,
    candles,
    meta: {
      provider: symbol.provider,
      count: candles.length,
      // Every bar returned is closed; the one still forming arrives at
      // nextBarAvailableAt, which is also when this cache entry expires.
      lastBarClosed: true,
      nextBarAvailableAt: nextBarCloseAt(interval, Math.floor(Date.now() / 1000)),
      cached,
      cacheBackend: cache.backend(),
      stale,
    },
  };
}

module.exports = { getChart };
