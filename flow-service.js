const cache = require('./cache');
const { getSymbol } = require('./symbols');
const { INTERVALS, resolveInterval, SUPPORTED } = require('./intervals');
const { httpError } = require('./http-error');
const { fetchAggTrades } = require('./providers/binance-trades');

// Per-bar order flow built from aggregated trades: the buy/sell split at each
// price level (a footprint), plus the bar totals the Flow tools summarise.
//
// Klines cannot produce this. A kline knows a bar's total volume but not which
// side crossed the spread, so delta, imbalance and absorption are all invisible
// from OHLCV alone - hence a separate endpoint rather than more fields on
// /chart.

const CACHE_VERSION = 'v1';
const DEFAULT_BARS = 40;
const MAX_BARS = 120;
// Closed bars can never change, so their footprint is cached effectively
// forever. Only the forming bar needs a short TTL.
const CLOSED_TTL_SECONDS = 7 * 24 * 3600;
const FORMING_TTL_SECONDS = 10;
// Binance permits far more, but the point of a limit is to stay a good citizen
// when someone asks for 120 bars at once.
const CONCURRENCY = 6;

function parseBars(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_BARS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw httpError(400, 'invalid_bars', 'bars must be a positive integer');
  }
  return Math.min(Math.floor(n), MAX_BARS);
}

function parseBucket(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw httpError(400, 'invalid_bucket', 'bucket must be a positive number');
  }
  return n;
}

/**
 * Price granularity for the footprint rows. Raw trade prices are far too fine
 * to read - one weekday gold M5 bar prints ~84 distinct prices across an $8
 * range - so trades are grouped into buckets. Derived from the symbol's own
 * scale so this works for a $4000 metal and a $0.07 altcoin alike.
 */
function defaultBucket(trades) {
  if (!trades.length) return 0.01;
  let min = Infinity;
  let max = -Infinity;
  for (const t of trades) {
    if (t.price < min) min = t.price;
    if (t.price > max) max = t.price;
  }
  const span = max - min;
  if (!(span > 0)) return Math.max(0.01, max * 1e-5);
  // Aim for roughly 20 rows per bar, then snap to a round increment so rows
  // line up across bars instead of drifting.
  const target = span / 20;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  for (const step of [1, 2.5, 5, 10]) {
    if (magnitude * step >= target) return magnitude * step;
  }
  return magnitude * 10;
}

function bucketPrice(price, bucket) {
  return Math.round(Math.floor(price / bucket) * bucket * 1e8) / 1e8;
}

/** Fold one bar's trades into price-bucketed rows plus totals. */
function buildBar(time, trades, bucket, truncated) {
  const rows = new Map();
  let buy = 0;
  let sell = 0;

  for (const trade of trades) {
    const key = bucketPrice(trade.price, bucket);
    let row = rows.get(key);
    if (!row) {
      row = { price: key, buy: 0, sell: 0 };
      rows.set(key, row);
    }
    if (trade.buyerAggressor) {
      row.buy += trade.qty;
      buy += trade.qty;
    } else {
      row.sell += trade.qty;
      sell += trade.qty;
    }
  }

  const levels = [...rows.values()].sort((a, b) => a.price - b.price);
  // Point of control: the price level that traded the most, per bar.
  let poc = null;
  let pocVolume = -1;
  for (const row of levels) {
    const total = row.buy + row.sell;
    if (total > pocVolume) {
      pocVolume = total;
      poc = row.price;
    }
  }

  return {
    time,
    buy: round(buy),
    sell: round(sell),
    delta: round(buy - sell),
    volume: round(buy + sell),
    trades: trades.length,
    poc,
    levels: levels.map((r) => ({ price: r.price, buy: round(r.buy), sell: round(r.sell) })),
    truncated,
  };
}

function round(n) {
  return Math.round(n * 1e8) / 1e8;
}

/** Run `jobs` with bounded concurrency, preserving order. */
async function pooled(jobs, limit) {
  const results = new Array(jobs.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await jobs[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

async function getFlow({ symbol: symbolInput, interval: intervalInput, bars: barsInput, bucket: bucketInput }) {
  if (!symbolInput) {
    throw httpError(400, 'missing_symbol', 'symbol query parameter is required');
  }

  const symbol = getSymbol(symbolInput);
  if (!symbol) {
    throw httpError(400, 'unknown_symbol', `Unknown symbol: ${symbolInput}`);
  }
  if (symbol.provider !== 'binance') {
    throw httpError(400, 'flow_unsupported', `Order flow is not available for ${symbol.symbol}`);
  }

  const interval = resolveInterval(intervalInput);
  if (!interval) {
    throw httpError(
      400,
      'invalid_interval',
      `Unsupported interval: ${intervalInput}. Supported: ${SUPPORTED.join(', ')}`
    );
  }

  const barCount = parseBars(barsInput);
  const requestedBucket = parseBucket(bucketInput);
  const step = INTERVALS[interval].seconds;
  const nowSec = Math.floor(Date.now() / 1000);
  const currentOpen = Math.floor(nowSec / step) * step;

  // Oldest first, ending with the bar currently forming.
  const opens = [];
  for (let i = barCount - 1; i >= 0; i--) opens.push(currentOpen - i * step);

  const jobs = opens.map((open) => async () => {
    const closed = open + step <= nowSec;
    const key = `flow:${CACHE_VERSION}:${symbol.providerSymbol}:${interval}:${open}:${requestedBucket ?? 'auto'}`;

    const hit = await cache.get(key);
    if (hit) return hit;

    const { trades, truncated } = await fetchAggTrades({
      providerSymbol: symbol.providerSymbol,
      startMs: open * 1000,
      endMs: (open + step) * 1000 - 1,
    });

    const bucket = requestedBucket ?? defaultBucket(trades);
    const bar = buildBar(open, trades, bucket, truncated);
    bar.bucket = bucket;

    await cache.set(key, bar, closed ? CLOSED_TTL_SECONDS : FORMING_TTL_SECONDS);
    return bar;
  });

  const built = await pooled(jobs, CONCURRENCY);

  // Cumulative delta runs across the returned window, so the caller does not
  // have to reduce it and every tool agrees on the same running total.
  let cumulative = 0;
  for (const bar of built) {
    cumulative = round(cumulative + bar.delta);
    bar.cumulativeDelta = cumulative;
  }

  return {
    symbol: symbol.symbol,
    interval,
    bars: built,
    meta: {
      provider: 'binance-trades',
      count: built.length,
      bucket: requestedBucket ?? (built.find((b) => b.bucket)?.bucket ?? null),
      truncatedBars: built.filter((b) => b.truncated).length,
      cacheBackend: cache.backend(),
    },
  };
}

module.exports = { getFlow };
