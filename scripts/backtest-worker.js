#!/usr/bin/env node
// Backtest worker. Forked as a child process by backtest-jobs.js.
//
// A seed-scale backtest chews through hundreds of thousands of bars
// synchronously. Running that inside a route handler would block the event loop
// for the whole run, freezing /chart and every live WebSocket fan-out with it.
// A separate process keeps the server responsive and lets a runaway job be
// killed without taking the API down.
require('dotenv').config({ quiet: true });

const candleStore = require('../store/candles');
const backtest = require('../engine/backtest');
const config = require('../engine/config');

const BIAS_FOR = {
  '1m': ['5m', '15m', '1h', '4h'],
  '5m': ['15m', '1h', '4h'],
  '15m': ['1h', '4h'],
};

/** Everything the requested entry timeframes need in order to read bias. */
function timeframesFor(entryTimeframes) {
  const needed = new Set(entryTimeframes);
  for (const tf of entryTimeframes) {
    for (const bias of BIAS_FOR[tf] || []) needed.add(bias);
  }
  return [...needed];
}

async function runJob(spec) {
  const resolved = config.resolve(spec.preset || config.DEFAULT_PRESET);
  const entryTimeframes = spec.timeframes && spec.timeframes.length ? spec.timeframes : ['5m'];
  const timeframes = timeframesFor(entryTimeframes);

  const nowSec = Math.floor(Date.now() / 1000);
  const from = spec.from ?? nowSec - (spec.days ?? 180) * 86_400;
  const to = spec.to ?? nowSec;

  const series = {};
  for (const tf of timeframes) {
    const cached = await candleStore.load(spec.symbol, tf);
    if (!cached) {
      throw new Error(`No cached candles for ${spec.symbol} ${tf}. Run scripts/seed.js first.`);
    }
    series[tf] = candleStore.within(cached.bars, from, to);
  }

  const missing = entryTimeframes.filter((tf) => (series[tf] || []).length === 0);
  if (missing.length > 0) {
    throw new Error(`No bars in range for ${spec.symbol} ${missing.join(', ')}`);
  }

  const input = { symbol: spec.symbol, series, entryTimeframes, config: resolved };

  // A strategy filter runs the same engine with the others disabled, rather
  // than post-filtering trades: strategies interact through the confluence sum,
  // so filtering afterwards would report a strategy that never actually ran
  // alone.
  if (spec.strategy && spec.strategy !== 'all') {
    for (const key of Object.keys(resolved.strategies)) {
      if (resolved.strategies[key].id !== spec.strategy && !resolved.strategies[key].biasOnly) {
        resolved.strategies[key] = { ...resolved.strategies[key], enabled: false };
      }
    }
  }

  const both = backtest.runBothVariants(input);
  const result = {
    id: spec.id,
    symbol: spec.symbol,
    preset: resolved.preset,
    entryTimeframes,
    strategy: spec.strategy || 'all',
    range: { from, to },
    ladder: backtest.summaryOf(both.ladder),
    simple: backtest.summaryOf(both.simple),
    patternStats: both.ladder.patternStats,
    equity: both.ladder.overall.equity,
    // Bounded: a two-year 1m run can produce tens of thousands of trades, and
    // the report is served as one JSON body.
    trades: both.ladder.trades.slice(0, 5000),
    tradeCount: both.ladder.trades.length,
  };

  if (spec.walkForward) {
    result.walkForward = backtest.walkForward({
      ...input,
      windows: spec.walkForwardWindows || resolved.backtest.walkForward,
      warmupBars: 250,
    });
  }

  return result;
}

process.on('message', async (spec) => {
  try {
    process.send({ type: 'done', result: await runJob(spec) });
  } catch (err) {
    process.send({ type: 'error', message: err.message });
  } finally {
    process.exit(0);
  }
});

// Also usable standalone for debugging: node scripts/backtest-worker.js BTCUSD 5m
//
// Gated on require.main, NOT merely on the absence of IPC: anything that
// requires this module for its exported helpers would otherwise kick off a full
// backtest as a side effect of the import.
if (require.main === module && !process.send) {
  const [, , symbol = 'BTCUSD', tf = '5m'] = process.argv;
  runJob({ id: 'cli', symbol, timeframes: [tf], days: 180, walkForward: true })
    .then((r) => console.log(JSON.stringify(r.ladder.metrics, null, 2)))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

module.exports = { runJob, timeframesFor };
