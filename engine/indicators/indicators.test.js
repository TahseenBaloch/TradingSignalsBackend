const test = require('node:test');
const assert = require('node:assert/strict');

const ind = require('./index');
const { Window } = require('./util');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Builds a bar, defaulting the fields a given test does not care about. */
function bar(overrides) {
  const close = overrides.close ?? 100;
  return {
    time: 0,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
    ...overrides,
  };
}

/** A series of bars from closes alone, with a symmetric ±1 range. */
function barsFromCloses(closes, { volume = 1, startTime = 0, step = 60 } = {}) {
  return closes.map((close, i) =>
    bar({
      time: startTime + i * step,
      open: i === 0 ? close : closes[i - 1],
      high: close + 1,
      low: close - 1,
      close,
      volume,
    })
  );
}

/**
 * Deterministic pseudo-random bars. A seeded LCG, never Math.random: Rule 6
 * requires the same input to produce the same output on every run, and a test
 * that cannot be reproduced cannot prove that.
 */
function syntheticBars(count, seed = 42) {
  let s = seed;
  const next = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };

  const bars = [];
  let price = 100;
  for (let i = 0; i < count; i += 1) {
    const open = price;
    price = price * (1 + (next() - 0.5) * 0.02);
    const close = price;
    const wick = Math.abs(close - open) + next() * 0.5 + 0.01;
    bars.push({
      time: i * 60,
      open,
      high: Math.max(open, close) + wick,
      low: Math.min(open, close) - wick,
      close,
      volume: 10 + next() * 90,
    });
  }
  return bars;
}

/** Every bar-driven indicator, for the cross-cutting contract tests. */
const BAR_INDICATORS = Object.entries(ind.BAR);

function approx(actual, expected, tolerance = 1e-9, message) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    message || `expected ${actual} to be within ${tolerance} of ${expected}`
  );
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

test('Window reports a mean only once full, then rolls', () => {
  const w = new Window(3);
  assert.equal(w.push(1), null);
  assert.equal(w.mean(), null);
  w.push(2);
  assert.equal(w.mean(), null);
  w.push(3);
  assert.equal(w.mean(), 2);
  assert.equal(w.push(4), 1); // evicts the oldest
  assert.equal(w.mean(), 3);
  assert.deepEqual(w.values(), [2, 3, 4]);
  assert.equal(w.max(), 4);
  assert.equal(w.min(), 2);
});

test('Window resync removes accumulated float drift', () => {
  const w = new Window(4);
  for (let i = 0; i < 10_000; i += 1) w.push(0.1);
  w.resync();
  approx(w.sum, 0.4, 1e-12);
});

test('Window rejects a non-positive size', () => {
  assert.throws(() => new Window(0), /positive integer/);
  assert.throws(() => new Window(1.5), /positive integer/);
});

// ---------------------------------------------------------------------------
// SMA / EMA — hand-computable reference values
// ---------------------------------------------------------------------------

test('SMA matches hand-computed values and respects warmup', () => {
  assert.deepEqual(ind.sma.batch([1, 2, 3, 4, 5], { period: 3 }), [null, null, 2, 3, 4]);
});

test('EMA seeds with an SMA then smooths at 2/(period+1)', () => {
  // period 3 => k = 0.5. Seed = SMA3([1,2,3]) = 2, then (4-2)*0.5+2 = 3, (5-3)*0.5+3 = 4.
  assert.deepEqual(ind.ema.batch([1, 2, 3, 4, 5], { period: 3 }), [null, null, 2, 3, 4]);
});

test('EMA of a constant series is that constant', () => {
  const out = ind.ema.batch(new Array(50).fill(7), { period: 10 });
  assert.equal(out[9], 7);
  assert.equal(out[49], 7);
});

// ---------------------------------------------------------------------------
// RSI — exact Wilder values, computed by hand in the test comment
// ---------------------------------------------------------------------------

test('RSI reproduces hand-computed Wilder values', () => {
  // closes 10, 11, 10.5, 11.5, 11, 12 with period 3.
  // changes: +1, -0.5, +1, -0.5, +1
  // seed (first 3 changes): avgGain 2/3, avgLoss 1/6 -> RS 4      -> 80
  // then  avgGain 4/9,  avgLoss 5/18                 -> RS 1.6    -> 61.538461...
  // then  avgGain 17/27, avgLoss 5/27                -> RS 3.4    -> 77.272727...
  const out = ind.rsi.batch(barsFromCloses([10, 11, 10.5, 11.5, 11, 12]), { period: 3 });

  assert.deepEqual(out.slice(0, 3), [null, null, null]);
  approx(out[3], 80);
  approx(out[4], 100 - 100 / 2.6);
  approx(out[5], 100 - 100 / 4.4);
});

test('RSI pins to 100 on a pure advance and 0 on a pure decline', () => {
  const up = ind.rsi.batch(barsFromCloses([1, 2, 3, 4, 5, 6, 7]), { period: 3 });
  assert.equal(up.at(-1), 100);

  const down = ind.rsi.batch(barsFromCloses([7, 6, 5, 4, 3, 2, 1]), { period: 3 });
  assert.equal(down.at(-1), 0);
});

test('RSI of a flat series is 50, not 100', () => {
  // A market that has not moved is not "maximum overbought".
  const out = ind.rsi.batch(barsFromCloses([5, 5, 5, 5, 5, 5]), { period: 3 });
  assert.equal(out.at(-1), 50);
});

// ---------------------------------------------------------------------------
// ATR
// ---------------------------------------------------------------------------

test('ATR reproduces hand-computed Wilder values', () => {
  const bars = [
    bar({ high: 10, low: 8, close: 9 }), //  TR 2 (no previous close)
    bar({ high: 11, low: 9, close: 10 }), // TR max(2, 2, 0) = 2
    bar({ high: 12, low: 10, close: 11 }), // TR max(2, 2, 0) = 2  -> ATR = 2
    bar({ high: 14, low: 11, close: 13 }), // TR max(3, 3, 0) = 3  -> (2*2+3)/3
  ];
  const out = ind.atr.batch(bars, { period: 3 });

  assert.deepEqual(out.slice(0, 2), [null, null]);
  approx(out[2], 2);
  approx(out[3], 7 / 3);
});

test('ATR of bars with a constant range equals that range', () => {
  const bars = new Array(40).fill(null).map((_, i) => bar({ high: 102, low: 98, close: 100, time: i * 60 }));
  approx(ind.atr.batch(bars, { period: 14 }).at(-1), 4);
});

// ---------------------------------------------------------------------------
// MACD
// ---------------------------------------------------------------------------

test('MACD warms the line before the signal and never fabricates a histogram', () => {
  const out = ind.macd.batch(barsFromCloses(syntheticBars(80).map((b) => b.close)), {
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
  });

  assert.equal(out[24], null, 'no MACD line before the slow EMA warms');
  assert.notEqual(out[25], null, 'MACD line available once the slow EMA warms');
  assert.equal(out[25].signal, null, 'signal is still warming');
  assert.equal(out[25].histogram, null, 'histogram must be null, not 0, while signal is null');

  assert.notEqual(out[33].signal, null, 'signal warms 9 MACD values later');
  approx(out[33].histogram, out[33].macd - out[33].signal);
});

test('MACD of a constant series collapses to zero', () => {
  const out = ind.macd.batch(barsFromCloses(new Array(60).fill(50)));
  approx(out.at(-1).macd, 0, 1e-9);
  approx(out.at(-1).histogram, 0, 1e-9);
});

test('MACD rejects a fast period that is not faster than the slow one', () => {
  assert.throws(() => ind.macd.init({ fastPeriod: 26, slowPeriod: 12 }), /must be less than/);
});

// ---------------------------------------------------------------------------
// ADX
// ---------------------------------------------------------------------------

test('ADX on a perfect uptrend gives exact reference values', () => {
  // Every bar rises by 2 with a ±1 wick, so on every bar after the first:
  //   +DM = 2, -DM = 0, TR = max(2, |high - prevClose|, |low - prevClose|) = 3
  // Smoothed over 14: TR 42, +DM 28  ->  +DI = 100*28/42 = 66.67, -DI = 0
  //   DX = 100 * |66.67 - 0| / 66.67 = 100, so ADX converges to exactly 100.
  const bars = barsFromCloses(new Array(60).fill(0).map((_, i) => 100 + i * 2));
  const out = ind.adx.batch(bars, { period: 14 });

  assert.equal(out[13], null, 'directional index needs `period` movements');
  assert.notEqual(out[14], null);
  approx(out[14].plusDI, (100 * 28) / 42, 1e-9);
  approx(out[14].minusDI, 0);
  assert.equal(out[14].adx, null, 'ADX itself needs a further `period` DX values');

  assert.notEqual(out[27].adx, null, 'ADX available at 2*period - 1');
  approx(out[27].adx, 100, 1e-9);
  approx(out.at(-1).adx, 100, 1e-9);
});

test('ADX reports a downtrend through -DI', () => {
  const bars = barsFromCloses(new Array(60).fill(0).map((_, i) => 220 - i * 2));
  const last = ind.adx.batch(bars, { period: 14 }).at(-1);
  assert.ok(last.minusDI > last.plusDI);
  approx(last.plusDI, 0);
  approx(last.adx, 100, 1e-9);
});

test('ADX survives a series of identical bars without dividing by zero', () => {
  const bars = new Array(60).fill(null).map((_, i) => bar({ time: i * 60, close: 100 }));
  const last = ind.adx.batch(bars, { period: 14 }).at(-1);
  assert.equal(last.plusDI, 0);
  assert.equal(last.minusDI, 0);
  assert.equal(last.adx, 0);
});

// ---------------------------------------------------------------------------
// Bollinger
// ---------------------------------------------------------------------------

test('Bollinger matches hand-computed population sigma', () => {
  // closes 1..5, period 5: mean 3, population variance 2, sigma sqrt(2).
  const out = ind.bollinger.batch(barsFromCloses([1, 2, 3, 4, 5]), { period: 5, stdDev: 2 });
  const last = out.at(-1);

  assert.deepEqual(out.slice(0, 4), [null, null, null, null]);
  approx(last.middle, 3);
  approx(last.stdev, Math.SQRT2);
  approx(last.upper, 3 + 2 * Math.SQRT2);
  approx(last.lower, 3 - 2 * Math.SQRT2);
  approx(last.bandwidth, (4 * Math.SQRT2) / 3);
  approx(last.percentB, (5 - (3 - 2 * Math.SQRT2)) / (4 * Math.SQRT2));
});

test('Bollinger collapses cleanly on a flat series', () => {
  const last = ind.bollinger.batch(barsFromCloses(new Array(30).fill(42)), { period: 20 }).at(-1);
  approx(last.stdev, 0);
  approx(last.upper, 42);
  approx(last.lower, 42);
  assert.equal(last.bandwidth, 0);
  assert.equal(last.percentB, 0.5, 'a zero-width band puts price at the middle, not at 0/0');
});

// ---------------------------------------------------------------------------
// VWAP
// ---------------------------------------------------------------------------

test('session VWAP is volume-weighted and resets on the UTC day boundary', () => {
  const bars = [
    bar({ time: 0, high: 100, low: 100, close: 100, volume: 1 }),
    bar({ time: 60, high: 200, low: 200, close: 200, volume: 3 }),
    // A new UTC day: the session restarts and forgets everything above.
    bar({ time: 86_400, high: 50, low: 50, close: 50, volume: 5 }),
  ];
  const out = ind.vwapSession.batch(bars);

  approx(out[0].vwap, 100);
  approx(out[1].vwap, (100 * 1 + 200 * 3) / 4, 1e-9); // 175, not the 150 a simple mean gives
  assert.equal(out[1].barsInSession, 2);

  approx(out[2].vwap, 50, 1e-9);
  assert.equal(out[2].barsInSession, 1, 'session counter restarts');
  approx(out[2].stdev, 0);
});

test('session VWAP bands are ordered and symmetric', () => {
  const bars = syntheticBars(200).map((b) => ({ ...b, time: b.time }));
  const last = ind.vwapSession.batch(bars).at(-1);

  assert.ok(last.stdev > 0);
  for (let k = 0; k < 3; k += 1) {
    approx(last.upper[k] - last.vwap, last.vwap - last.lower[k], 1e-9);
  }
  assert.ok(last.upper[0] < last.upper[1] && last.upper[1] < last.upper[2]);
  assert.ok(last.lower[0] > last.lower[1] && last.lower[1] > last.lower[2]);
});

test('session VWAP ignores zero-volume bars rather than dividing by zero', () => {
  const out = ind.vwapSession.batch([
    bar({ time: 0, close: 100, volume: 0 }),
    bar({ time: 60, high: 100, low: 100, close: 100, volume: 2 }),
  ]);
  assert.equal(out[0], null, 'nothing has traded yet');
  approx(out[1].vwap, 100);
});

test('rolling VWAP only sees its window', () => {
  const bars = [
    bar({ time: 0, high: 100, low: 100, close: 100, volume: 1 }),
    bar({ time: 60, high: 100, low: 100, close: 100, volume: 1 }),
    bar({ time: 120, high: 200, low: 200, close: 200, volume: 1 }),
  ];
  const out = ind.vwapRolling.batch(bars, { period: 2 });

  assert.equal(out[0], null);
  approx(out[1].vwap, 100);
  approx(out[2].vwap, 150, 1e-9); // the first bar has rolled out of the window
});

// ---------------------------------------------------------------------------
// Supertrend
// ---------------------------------------------------------------------------

test('Supertrend holds bullish through an uptrend and keeps its line below price', () => {
  const bars = barsFromCloses(new Array(60).fill(0).map((_, i) => 100 + i * 2));
  const out = ind.supertrend.batch(bars, { atrPeriod: 10, multiplier: 3 });

  assert.equal(out[8], null, 'waits for ATR');
  const last = out.at(-1);
  assert.equal(last.direction, 1);
  assert.ok(last.value < bars.at(-1).close, 'a bullish Supertrend trails below price');
  assert.equal(last.value, last.lower);
});

test('Supertrend flips exactly once on a clean trend reversal', () => {
  const up = new Array(40).fill(0).map((_, i) => 100 + i * 2);
  const down = new Array(40).fill(0).map((_, i) => 178 - i * 4);
  const out = ind.supertrend.batch(barsFromCloses([...up, ...down]), {
    atrPeriod: 10,
    multiplier: 3,
  });

  const flips = out.filter((v) => v && v.flipped);
  assert.equal(flips.length, 1, 'one reversal should produce one flip, not a stream of them');
  assert.equal(flips[0].direction, -1);
  assert.equal(out.at(-1).direction, -1);
});

// ---------------------------------------------------------------------------
// Stochastic
// ---------------------------------------------------------------------------

test('Stochastic places price within its window range', () => {
  const bars = [
    bar({ high: 10, low: 8, close: 9 }),
    bar({ high: 12, low: 9, close: 11 }),
    bar({ high: 11, low: 9, close: 10 }),
  ];
  // smoothK/smoothD of 1 expose the raw %K: 100 * (10 - 8) / (12 - 8) = 50.
  const out = ind.stochastic.batch(bars, { period: 3, smoothK: 1, smoothD: 1 });
  assert.deepEqual(out.slice(0, 2), [null, null]);
  approx(out[2].k, 50);
  approx(out[2].d, 50);
});

test('Stochastic reads 50 on a rangeless window rather than 0 or 100', () => {
  const bars = new Array(20).fill(null).map((_, i) => bar({ time: i * 60, close: 100 }));
  approx(ind.stochastic.batch(bars, { period: 14, smoothK: 3, smoothD: 3 }).at(-1).k, 50);
});

test('Stochastic %D warms after %K', () => {
  const out = ind.stochastic.batch(syntheticBars(40), { period: 14, smoothK: 3, smoothD: 3 });
  const firstK = out.findIndex((v) => v !== null);
  assert.equal(firstK, 15, 'period + smoothK - 2');
  assert.equal(out[firstK].d, null);
  assert.notEqual(out[firstK + 2].d, null);
});

// ---------------------------------------------------------------------------
// Volume
// ---------------------------------------------------------------------------

test('relative volume is the ratio to its own average', () => {
  const bars = new Array(21)
    .fill(null)
    .map((_, i) => bar({ time: i * 60, volume: i === 20 ? 30 : 10 }));
  const out = ind.volume.batch(bars, { period: 20 });

  assert.equal(out[18], null);
  approx(out[19].relative, 1);
  // The 21st bar's average still covers bars 1..20 inclusive of the spike:
  // (19*10 + 30) / 20 = 11, so 30 / 11.
  approx(out[20].sma, 11);
  approx(out[20].relative, 30 / 11);
});

test('relative volume reports 1 on a dead window instead of Infinity', () => {
  const bars = new Array(25).fill(null).map((_, i) => bar({ time: i * 60, volume: 0 }));
  // Every >= threshold gate in the strategies must stay shut here.
  assert.equal(ind.volume.batch(bars, { period: 20 }).at(-1).relative, 1);
});

// ---------------------------------------------------------------------------
// Cross-cutting contracts — these are the rules, not the arithmetic
// ---------------------------------------------------------------------------

test('every indicator is deterministic: identical input, identical output', () => {
  const bars = syntheticBars(300);
  for (const [name, indicator] of BAR_INDICATORS) {
    const a = indicator.batch(bars);
    const b = indicator.batch(bars);
    assert.deepEqual(a, b, `${name} is not deterministic`);
  }
});

test('no indicator looks ahead: truncating the input truncates the output', () => {
  // Rule 2 at the indicator level. Whatever an indicator reports at bar N must
  // depend only on bars 0..N, so running it over a prefix must reproduce that
  // prefix exactly. This is the same property the Phase 7 backtester asserts
  // end-to-end.
  const bars = syntheticBars(300);
  const cut = 180;

  for (const [name, indicator] of BAR_INDICATORS) {
    const full = indicator.batch(bars);
    const prefix = indicator.batch(bars.slice(0, cut));
    assert.deepEqual(prefix, full.slice(0, cut), `${name} looks ahead`);
  }
});

test('every indicator returns null throughout its warmup, never a placeholder', () => {
  const bars = syntheticBars(300);
  for (const [name, indicator] of BAR_INDICATORS) {
    const out = indicator.batch(bars);
    const firstValue = out.findIndex((v) => v !== null);

    assert.notEqual(firstValue, -1, `${name} never produced a value`);
    assert.ok(
      out.slice(0, firstValue).every((v) => v === null),
      `${name} emitted a value during warmup`
    );
    // Once warm it must stay warm; a hole downstream would silently disable
    // whichever strategy depends on it.
    assert.ok(
      out.slice(firstValue).every((v) => v !== null),
      `${name} went null again after warming`
    );
  }
});

test('clone forks state without the copies affecting each other', () => {
  const bars = syntheticBars(120);

  for (const [name, indicator] of BAR_INDICATORS) {
    const state = indicator.init();
    for (const b of bars.slice(0, 60)) indicator.update(state, b);

    const forked = indicator.clone(state);

    const fromOriginal = bars.slice(60).map((b) => indicator.update(state, b));
    const fromFork = bars.slice(60).map((b) => indicator.update(forked, b));

    assert.deepEqual(fromFork, fromOriginal, `${name} clone diverged from its source`);
  }
});

test('batch and incremental update produce identical results', () => {
  // The guarantee behind Rule 3: the backtester runs `batch`, the live pipeline
  // runs `update` bar by bar. If these could differ, the backtest would be
  // measuring a strategy the live engine never runs.
  const bars = syntheticBars(300);

  for (const [name, indicator] of BAR_INDICATORS) {
    const state = indicator.init();
    const incremental = bars.map((b) => indicator.update(state, b));
    assert.deepEqual(incremental, indicator.batch(bars), `${name} batch differs from incremental`);
  }
});

test('indicators reject nonsensical parameters instead of producing quiet nonsense', () => {
  assert.throws(() => ind.ema.init({ period: 0 }), /positive number/);
  assert.throws(() => ind.rsi.init({ period: -5 }), /positive number/);
  assert.throws(() => ind.atr.init({ period: NaN }), /positive number/);
});
