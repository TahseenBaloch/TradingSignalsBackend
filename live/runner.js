// Drives the analysis service from the live upstream stream.
//
// Startup is deliberately staggered. The watch set is 7 symbols x 5 timeframes =
// 35 upstream sockets, and providers/binance-stream.js enforces a shared budget
// of 5 connects per 10 seconds (Binance bans at 300 attempts per 5 minutes).
// Opening all 35 at once would spend the whole budget and back off into a slow
// retry storm, so they are introduced at a rate the budget can absorb.
const upstream = require('../providers/binance-stream');
const { getChart } = require('../chart-service');
const { getSymbol, SYMBOLS } = require('../symbols');
const { nextBarCloseAt, INTERVALS } = require('../intervals');
const service = require('./analysis-service');

// Entry timeframes plus every bias timeframe they read.
const WATCHED_TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h'];

const CONNECT_STAGGER_MS = Number(process.env.LIVE_STAGGER_MS) || 2500;
// A close is late once this much of the next bar has elapsed without one
// arriving. Generous enough not to fire on ordinary jitter.
const WATCHDOG_GRACE_SECONDS = 20;
const WATCHDOG_INTERVAL_MS = 30_000;

function create({ config, store, gate, publish, symbols, timeframes }) {
  const analysis = service.create({ config, store, gate, publish });
  return {
    analysis,
    symbols: (symbols || SYMBOLS.map((s) => s.symbol)).map((s) => getSymbol(s)).filter(Boolean),
    timeframes: timeframes || WATCHED_TIMEFRAMES,
    subscriptions: [],
    watchdog: null,
    started: false,
  };
}

async function warmOne(runner, symbol, timeframe) {
  const { candles } = await getChart({
    symbol: symbol.symbol,
    interval: timeframe,
    limit: service.WARMUP_BARS,
  });
  service.warmup(runner.analysis, symbol.symbol, timeframe, candles);
  return candles.length;
}

/**
 * Warms every series, then attaches live subscriptions.
 *
 * Bias timeframes are warmed FIRST so that when a 1m bar closes moments later
 * its 15m/1h/4h context already exists. Warming in arbitrary order would leave
 * the first minutes of signals computed against absent bias, which is not
 * wrong exactly but is silently different from everything measured.
 */
async function start(runner, { log = console.log } = {}) {
  if (runner.started) return;
  runner.started = true;

  const ordered = [...runner.timeframes].sort(
    (a, b) => INTERVALS[b].seconds - INTERVALS[a].seconds
  );

  for (const timeframe of ordered) {
    for (const symbol of runner.symbols) {
      try {
        const count = await warmOne(runner, symbol, timeframe);
        log(`[live] warmed ${symbol.symbol} ${timeframe} with ${count} bars`);
      } catch (err) {
        // One series failing to warm must not stop the rest; it simply produces
        // no signals until its first live closes accumulate.
        log(`[live] warmup failed for ${symbol.symbol} ${timeframe}: ${err.message}`);
      }
    }
  }

  // Rebuild every snapshot now that ALL series are warm. Warmup runs longest
  // timeframe first, so a snapshot built during 5m's warmup captured a 1m
  // analyzer that had not run yet — leaving a hole in the MTF matrix until the
  // next 5m close. One pass here fills it immediately.
  for (const timeframe of ordered) {
    for (const symbol of runner.symbols) {
      service.refreshSnapshot(runner.analysis, symbol.symbol, timeframe);
    }
  }

  let delay = 0;
  for (const timeframe of ordered) {
    for (const symbol of runner.symbols) {
      setTimeout(() => attach(runner, symbol, timeframe, log), delay);
      delay += CONNECT_STAGGER_MS;
    }
  }

  runner.watchdog = setInterval(() => sweep(runner, log), WATCHDOG_INTERVAL_MS);
  runner.watchdog.unref();

  log(`[live] ${runner.symbols.length} symbols x ${runner.timeframes.length} timeframes attaching over ${Math.round(delay / 1000)}s`);
}

function attach(runner, symbol, timeframe, log) {
  const unsubscribe = upstream.subscribe(
    symbol.providerSymbol,
    timeframe,
    (event, payload) => {
      // Only CLOSED bars reach the engine. The forming bar drives provisional
      // recomputation in the browser; the server stays the authority for
      // confirmed events (Rule 1).
      if (event !== 'bar' || !payload.closed) return;
      try {
        service.onBarClosed(runner.analysis, symbol.symbol, timeframe, {
          time: payload.time,
          open: payload.open,
          high: payload.high,
          low: payload.low,
          close: payload.close,
          volume: payload.volume,
        });
      } catch (err) {
        log(`[live] ${symbol.symbol} ${timeframe} analysis failed: ${err.message}`);
      }
    },
    // keepAlive: this consumer must not be torn down just because no browser
    // happens to be watching. binance-stream.js documents this as the seam for
    // exactly this use.
    { keepAlive: true }
  );

  runner.subscriptions.push(unsubscribe);
}

/**
 * Notices closes that never arrived and backfills them over REST.
 *
 * A dropped socket produces silence, and silence in a signal engine is
 * indistinguishable from a quiet market — which is precisely the failure this
 * exists to catch.
 */
async function sweep(runner, log) {
  const nowSec = Math.floor(Date.now() / 1000);

  for (const timeframe of runner.timeframes) {
    for (const symbol of runner.symbols) {
      const entry = runner.analysis.analyzers.get(`${symbol.symbol}:${timeframe}`);
      if (!entry || entry.lastBarTime === null) continue;

      const seconds = INTERVALS[timeframe].seconds;
      const expectedClose = nextBarCloseAt(timeframe, entry.lastBarTime);
      if (nowSec < expectedClose + WATCHDOG_GRACE_SECONDS) continue;

      try {
        const { candles } = await getChart({ symbol: symbol.symbol, interval: timeframe, limit: 50 });
        const missed = candles.filter((c) => c.time > entry.lastBarTime);
        if (missed.length === 0) continue;

        log(`[live] backfilling ${missed.length} missed ${timeframe} bar(s) for ${symbol.symbol}`);
        for (const bar of missed) {
          service.onBarClosed(runner.analysis, symbol.symbol, timeframe, bar);
        }
      } catch (err) {
        log(`[live] backfill failed for ${symbol.symbol} ${timeframe}: ${err.message}`);
      }
    }
  }
}

function stop(runner) {
  clearInterval(runner.watchdog);
  for (const unsubscribe of runner.subscriptions) unsubscribe();
  runner.subscriptions = [];
  runner.started = false;
}

module.exports = { create, start, stop, sweep, WATCHED_TIMEFRAMES };
