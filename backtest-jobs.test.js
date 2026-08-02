const test = require('node:test');
const assert = require('node:assert/strict');

const jobs = require('./backtest-jobs');
const { timeframesFor } = require('./scripts/backtest-worker');

test('job validation accepts a well-formed request', () => {
  const spec = jobs.validate({ symbol: 'BTCUSD', timeframes: ['5m', '15m'], preset: 'Balanced', days: 90 });
  assert.equal(spec.symbol, 'BTCUSD');
  assert.deepEqual(spec.timeframes, ['5m', '15m']);
  assert.equal(spec.preset, 'Balanced');
  assert.equal(spec.days, 90);
  assert.equal(spec.strategy, 'all');
});

test('job validation rejects a bias timeframe as an entry timeframe', () => {
  // Backtesting 1h as an entry would measure something the live engine never
  // does: 1h and 4h are bias inputs and are never the sole source of a signal.
  assert.throws(() => jobs.validate({ symbol: 'BTCUSD', timeframes: ['1h'] }), /bias timeframe/);
  assert.throws(() => jobs.validate({ symbol: 'BTCUSD', timeframes: ['1D'] }), /bias timeframe/);
});

test('job validation rejects unknown symbols, presets and impossible ranges', () => {
  assert.throws(() => jobs.validate({ symbol: 'DOESNOTEXIST' }), /Unknown symbol/);
  assert.throws(() => jobs.validate({ symbol: 'BTCUSD', preset: 'Reckless' }), /Unknown preset/);
  assert.throws(() => jobs.validate({ symbol: 'BTCUSD', days: 0 }), /days must be/);
  assert.throws(() => jobs.validate({ symbol: 'BTCUSD', days: 5000 }), /days must be/);
  assert.throws(() => jobs.validate({ symbol: 'BTCUSD', timeframes: ['7m'] }), /Unsupported timeframe/);
});

test('a job defaults to the 5m entry timeframe and the default preset', () => {
  const spec = jobs.validate({ symbol: 'ETHUSD' });
  assert.deepEqual(spec.timeframes, ['5m']);
  assert.equal(spec.preset, 'Balanced');
  assert.equal(spec.days, 180);
});

test('the worker pulls in every bias timeframe an entry timeframe needs', () => {
  // A 1m entry reads 15m for its trend gate and 1h/4h for S5 bias; loading only
  // the entry series would silently disable those filters.
  assert.deepEqual(timeframesFor(['1m']).sort(), ['15m', '1h', '4h', '1m', '5m'].sort());
  assert.deepEqual(timeframesFor(['15m']).sort(), ['15m', '1h', '4h'].sort());
  assert.deepEqual(timeframesFor(['5m', '15m']).sort(), ['15m', '1h', '4h', '5m'].sort());
});

test('an unknown job id is a 404, not a crash', async () => {
  await assert.rejects(() => jobs.get('bt-does-not-exist'), /No backtest job/);
});
