const test = require('node:test');
const assert = require('node:assert/strict');

const structure = require('./index');
const pivots = require('./pivots');
const zones = require('./zones');
const trendlines = require('./trendlines');
const trend = require('./trend');
const regime = require('./regime');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Bars from explicit highs/lows; close defaults to the midpoint. */
function bars(rows, { step = 60 } = {}) {
  return rows.map((r, i) => ({
    time: i * step,
    open: r.open ?? (r.high + r.low) / 2,
    high: r.high,
    low: r.low,
    close: r.close ?? (r.high + r.low) / 2,
    volume: r.volume ?? 1,
  }));
}

/** Bars whose high/low straddle a close by ±1. */
function barsFromCloses(closes, { step = 60 } = {}) {
  return closes.map((close, i) => ({
    time: i * step,
    open: i === 0 ? close : closes[i - 1],
    high: close + 1,
    low: close - 1,
    close,
    volume: 1,
  }));
}

function syntheticBars(count, seed = 7) {
  let s = seed;
  const next = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const out = [];
  let price = 100;
  for (let i = 0; i < count; i += 1) {
    const open = price;
    price *= 1 + (next() - 0.5) * 0.02;
    const wick = Math.abs(price - open) + next() * 0.4 + 0.01;
    out.push({
      time: i * 60,
      open,
      high: Math.max(open, price) + wick,
      low: Math.min(open, price) - wick,
      close: price,
      volume: 10 + next() * 90,
    });
  }
  return out;
}

/** A PivotState pre-loaded with synthetic pivots, for the vote-level tests. */
function pivotStateWith({ highs = [], lows = [] }) {
  const state = pivots.init({ lookback: 2 });
  state.highs = highs.map((p, i) => ({
    kind: 'high',
    index: p.index ?? i * 10,
    time: (p.index ?? i * 10) * 60,
    price: p.price,
    confirmedIndex: (p.index ?? i * 10) + 2,
    confirmedTime: ((p.index ?? i * 10) + 2) * 60,
    barsDelayed: 2,
  }));
  state.lows = lows.map((p, i) => ({
    kind: 'low',
    index: p.index ?? i * 10,
    time: (p.index ?? i * 10) * 60,
    price: p.price,
    confirmedIndex: (p.index ?? i * 10) + 2,
    confirmedTime: ((p.index ?? i * 10) + 2) * 60,
    barsDelayed: 2,
  }));
  return state;
}

function bollingerAt(middle, bandwidth) {
  const half = (bandwidth * middle) / 2;
  return {
    middle,
    upper: middle + half,
    lower: middle - half,
    stdev: half / 2,
    bandwidth,
    percentB: 0.5,
  };
}

// ---------------------------------------------------------------------------
// pivots
// ---------------------------------------------------------------------------

test('a pivot high is found at its own bar but confirmed `lookback` bars later', () => {
  const series = bars([
    { high: 10, low: 9 },
    { high: 11, low: 10 },
    { high: 15, low: 14 },
    { high: 11, low: 10 },
    { high: 10, low: 9 },
  ]);
  const out = pivots.batch(series, { lookback: 2 });

  assert.deepEqual(out.slice(0, 4), [[], [], [], []], 'nothing can be known before the right side exists');

  const [pivot] = out[4];
  assert.equal(pivot.kind, 'high');
  assert.equal(pivot.index, 2, 'the pivot itself is at bar 2');
  assert.equal(pivot.price, 15);
  assert.equal(pivot.confirmedIndex, 4, 'but it only became knowable at bar 4');
  assert.equal(pivot.barsDelayed, 2);
  assert.equal(pivot.time, 120);
  assert.equal(pivot.confirmedTime, 240);
});

test('a pivot low mirrors the high case', () => {
  const series = bars([
    { high: 10, low: 9 },
    { high: 9, low: 8 },
    { high: 6, low: 5 },
    { high: 9, low: 8 },
    { high: 10, low: 9 },
  ]);
  const [pivot] = pivots.batch(series, { lookback: 2 })[4];
  assert.equal(pivot.kind, 'low');
  assert.equal(pivot.index, 2);
  assert.equal(pivot.price, 5);
});

test('a flat top resolves to the last bar of the plateau, exactly once', () => {
  // Ties must break deterministically or a replay could produce different
  // structure from the same bars.
  const series = bars([
    { high: 4, low: 3 },
    { high: 5, low: 4 },
    { high: 5, low: 4 },
    { high: 4, low: 3 },
  ]);
  const found = pivots.batch(series, { lookback: 1 }).flat().filter((p) => p.kind === 'high');
  assert.equal(found.length, 1);
  assert.equal(found[0].index, 2);
});

test('one wide bar can be both a pivot high and a pivot low', () => {
  const series = bars([
    { high: 10, low: 9 },
    { high: 20, low: 1 },
    { high: 10, low: 9 },
  ]);
  const found = pivots.batch(series, { lookback: 1 })[2];
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((p) => p.kind).sort(), ['high', 'low']);
});

test('pivot detection does not look ahead', () => {
  const series = syntheticBars(400);
  const cut = 250;
  const full = pivots.batch(series, { lookback: 5 });
  const prefix = pivots.batch(series.slice(0, cut), { lookback: 5 });
  assert.deepEqual(prefix, full.slice(0, cut));
});

test('recent() returns the newest pivots oldest-first', () => {
  const state = pivotStateWith({ highs: [{ price: 1 }, { price: 2 }, { price: 3 }] });
  assert.deepEqual(
    pivots.recent(state, 'high', 2).map((p) => p.price),
    [2, 3]
  );
  assert.equal(pivots.recent(state, 'high', 10).length, 3, 'asking for more than exists is fine');
});

// ---------------------------------------------------------------------------
// zones
// ---------------------------------------------------------------------------

function pivotAt(index, price, kind = 'high') {
  return {
    kind,
    index,
    time: index * 60,
    price,
    confirmedIndex: index + 5,
    confirmedTime: (index + 5) * 60,
    barsDelayed: 5,
  };
}

test('nearby pivots cluster into one zone, distant ones do not', () => {
  const state = zones.init();
  const atr = 1; // clusterAtr 0.5 => pivots within 0.5 merge

  zones.update(state, bars([{ high: 200, low: 199 }])[0], {
    index: 0,
    atr,
    pivots: [pivotAt(0, 100), pivotAt(0, 100.2)],
  });
  assert.equal(state.zones.length, 1, '0.2 apart with a 0.5 tolerance is one zone');
  assert.equal(state.zones[0].pivotCount, 2);

  zones.update(state, bars([{ high: 200, low: 199 }])[0], {
    index: 1,
    atr,
    pivots: [pivotAt(1, 105)],
  });
  assert.equal(state.zones.length, 2, '5 apart is a separate zone');
});

test('zone touches are edge-triggered, so a long consolidation counts once', () => {
  const state = zones.init();
  const atr = 1;

  // Found the zone with a pivot at 100 on a bar far away from it.
  zones.update(state, bars([{ high: 200, low: 199 }])[0], {
    index: 0,
    atr,
    pivots: [pivotAt(0, 100)],
  });
  const zone = state.zones[0];
  assert.equal(zone.touches, 1, 'the founding pivot is one touch');

  // Ten consecutive bars sitting inside the band.
  for (let i = 1; i <= 10; i += 1) {
    zones.update(state, bars([{ high: 100.05, low: 99.95 }])[0], { index: i, atr, pivots: [] });
  }
  assert.equal(zone.touches, 2, 'entering the band is one touch, not ten');

  // Leave, then come back: that is a genuine second test of the level.
  zones.update(state, bars([{ high: 210, low: 209 }])[0], { index: 11, atr, pivots: [] });
  zones.update(state, bars([{ high: 100.05, low: 99.95 }])[0], { index: 12, atr, pivots: [] });
  assert.equal(zone.touches, 3);
});

test('a zone role flips as price closes through it', () => {
  const state = zones.init();
  const atr = 1;
  zones.update(state, bars([{ high: 100, low: 100 }])[0], {
    index: 0,
    atr,
    pivots: [pivotAt(0, 100)],
  });
  const zone = state.zones[0];

  // breakAtr 0.25 with atr 1: a close 0.25 beyond the band edge breaks it.
  zones.update(state, bars([{ high: 102, low: 101, close: 101.5 }])[0], { index: 1, atr, pivots: [] });
  assert.equal(zone.role, 'support', 'price above a level means the level supports it');
  assert.equal(zone.breaks, 1);

  zones.update(state, bars([{ high: 99, low: 98, close: 98.5 }])[0], { index: 2, atr, pivots: [] });
  assert.equal(zone.role, 'resistance', 'and below it, the level caps it');
  assert.equal(zone.breaks, 2);
});

test('untouched zones expire', () => {
  const state = zones.init({ expireBars: 10 });
  const atr = 1;
  zones.update(state, bars([{ high: 500, low: 499 }])[0], {
    index: 0,
    atr,
    pivots: [pivotAt(0, 100)],
  });
  assert.equal(state.zones.length, 1);

  zones.update(state, bars([{ high: 500, low: 499 }])[0], { index: 11, atr, pivots: [] });
  assert.equal(state.zones.length, 0, 'nothing has revisited it in 11 bars');
});

test('zone lookups find the nearest band, above and below', () => {
  const state = zones.init();
  const atr = 1;
  const far = bars([{ high: 500, low: 499 }])[0];
  zones.update(state, far, { index: 0, atr, pivots: [pivotAt(0, 90), pivotAt(0, 110)] });

  assert.equal(zones.nextAbove(state, 100).centre, 110);
  assert.equal(zones.nextBelow(state, 100).centre, 90);
  assert.equal(zones.nearest(state, 109.9, atr, 0.5).centre, 110);
  assert.equal(zones.nearest(state, 100, atr, 0.5), null, 'nothing within half an ATR of 100');
});

test('zone strength is a bounded ranking score, not a probability', () => {
  const state = zones.init();
  const atr = 1;
  zones.update(state, bars([{ high: 500, low: 499 }])[0], {
    index: 0,
    atr,
    pivots: [pivotAt(0, 100)],
  });
  const zone = state.zones[0];
  assert.ok(zone.strength > 0 && zone.strength <= 1);

  // Strength decays as the zone goes untested.
  const before = zone.strength;
  zones.update(state, bars([{ high: 500, low: 499 }])[0], { index: 100, atr, pivots: [] });
  assert.ok(zone.strength < before, 'an untested zone should weaken');
});

// ---------------------------------------------------------------------------
// trendlines
// ---------------------------------------------------------------------------

test('least squares recovers an exact line', () => {
  const { slope, intercept } = trendlines.leastSquares([
    { index: 0, price: 0 },
    { index: 1, price: 1 },
    { index: 2, price: 2 },
  ]);
  assert.ok(Math.abs(slope - 1) < 1e-12);
  assert.ok(Math.abs(intercept) < 1e-12);
});

test('a trendline fit keeps aligned pivots and rejects the outlier', () => {
  const pool = [pivotAt(0, 100), pivotAt(10, 105), pivotAt(15, 90), pivotAt(20, 110)];
  const fitted = trendlines.fit(pool, 1, trendlines.DEFAULTS);

  assert.equal(fitted.touches ?? fitted.inliers.length, 3);
  assert.ok(Math.abs(fitted.slope - 0.5) < 1e-9);
  assert.ok(!fitted.inliers.some((p) => p.price === 90), 'the outlier must not be an anchor');
});

test('a fit needs at least three aligned pivots', () => {
  assert.equal(trendlines.fit([pivotAt(0, 100), pivotAt(10, 105)], 1, trendlines.DEFAULTS), null);
  // Three pivots that are not collinear: any pair-line leaves the third far off.
  const scattered = [pivotAt(0, 100), pivotAt(10, 140), pivotAt(20, 100)];
  assert.equal(trendlines.fit(scattered, 1, trendlines.DEFAULTS), null);
});

test('a trendline marks itself broken and stays broken', () => {
  const state = trendlines.init();
  const pivotState = pivotStateWith({
    highs: [
      { index: 0, price: 100 },
      { index: 10, price: 105 },
      { index: 20, price: 110 },
    ],
  });
  const newPivot = [pivotAt(20, 110)];

  // Fit at bar 20: the line predicts 110 there, rising 0.5 per bar.
  trendlines.update(state, bars([{ high: 110, low: 109, close: 109.5 }])[0], { index: 20, atr: 1, pivots: pivotState }, newPivot);
  assert.equal(state.resistance.touches, 3);
  assert.equal(state.resistance.broken, false);

  // Bar 21 predicts 110.5; a close at 111 clears it by more than 0.25 x ATR.
  trendlines.update(state, bars([{ high: 112, low: 110, close: 111 }])[0], { index: 21, atr: 1, pivots: pivotState }, []);
  assert.equal(state.resistance.broken, true);

  // Falling back inside does not un-break it — that would be repainting.
  trendlines.update(state, bars([{ high: 108, low: 106, close: 107 }])[0], { index: 22, atr: 1, pivots: pivotState }, []);
  assert.equal(state.resistance.broken, true);
});

test('a trendline reprojects its free end to the current bar', () => {
  const state = trendlines.init();
  const pivotState = pivotStateWith({
    highs: [
      { index: 0, price: 100 },
      { index: 10, price: 105 },
      { index: 20, price: 110 },
    ],
  });
  trendlines.update(state, bars([{ high: 110, low: 109 }])[0], { index: 20, atr: 1, pivots: pivotState }, [pivotAt(20, 110)]);

  assert.equal(state.resistance.from.index, 0);
  trendlines.update(state, bars([{ high: 100, low: 99 }])[0], { index: 30, atr: 1, pivots: pivotState }, []);
  assert.equal(state.resistance.to.index, 30);
  assert.ok(Math.abs(state.resistance.to.price - 115) < 1e-9, 'slope 0.5 over 10 more bars');
});

// ---------------------------------------------------------------------------
// trend
// ---------------------------------------------------------------------------

test('trend needs two of three witnesses to call a direction', () => {
  const state = trend.init();
  const upStructure = pivotStateWith({
    highs: [{ index: 0, price: 100 }, { index: 10, price: 110 }],
    lows: [{ index: 5, price: 95 }, { index: 15, price: 105 }],
  });

  // EMA stack bullish + structure bullish + ADX bullish = unanimous.
  const strong = trend.evaluate(state, {
    ema9: 12,
    ema21: 11,
    ema200: 10,
    adx: { adx: 30, plusDI: 30, minusDI: 10 },
    pivots: upStructure,
  });
  assert.equal(strong.state, 'UP');
  assert.equal(strong.score, 3);
  assert.equal(strong.higherHighs, true);
  assert.equal(strong.higherLows, true);

  // Only the EMA stack still says up: one witness is not enough.
  const lone = trend.evaluate(state, {
    ema9: 12,
    ema21: 11,
    ema200: 10,
    adx: { adx: 10, plusDI: 15, minusDI: 15 },
    pivots: pivotStateWith({}),
  });
  assert.equal(lone.state, 'RANGE');
  assert.equal(lone.score, 1);
});

test('trend calls a downtrend from the mirrored evidence', () => {
  const downStructure = pivotStateWith({
    highs: [{ index: 0, price: 110 }, { index: 10, price: 100 }],
    lows: [{ index: 5, price: 105 }, { index: 15, price: 95 }],
  });
  const out = trend.evaluate(trend.init(), {
    ema9: 10,
    ema21: 11,
    ema200: 12,
    adx: { adx: 30, plusDI: 10, minusDI: 30 },
    pivots: downStructure,
  });
  assert.equal(out.state, 'DOWN');
  assert.equal(out.score, -3);
});

test('trend tolerates missing indicators during warmup', () => {
  const out = trend.evaluate(trend.init(), {
    ema9: null,
    ema21: null,
    ema200: null,
    adx: null,
    pivots: pivotStateWith({}),
  });
  assert.equal(out.state, 'RANGE');
  assert.equal(out.score, 0);
});

// ---------------------------------------------------------------------------
// regime
// ---------------------------------------------------------------------------

test('regime always names one of the four, never null', () => {
  const state = regime.init();
  const out = regime.evaluate(state, { atr: null, adx: null, bollinger: null, close: 100 });
  assert.ok(['TRENDING', 'RANGING', 'SQUEEZE', 'VOLATILE_EXPANSION'].includes(out.primary));
});

test('regime flags a squeeze when BandWidth reaches a new low', () => {
  const state = regime.init({ squeezeLookback: 5 });
  const adx = { adx: 15, plusDI: 10, minusDI: 10 };

  for (let i = 0; i < 5; i += 1) {
    regime.evaluate(state, { atr: 1, adx, bollinger: bollingerAt(100, 0.05), close: 100 });
  }
  const out = regime.evaluate(state, { atr: 1, adx, bollinger: bollingerAt(100, 0.01), close: 100 });

  assert.equal(out.flags.squeeze, true);
  assert.equal(out.primary, 'SQUEEZE', 'squeeze outranks every other regime');
});

test('regime flags volatility expansion on a high ATR percentile', () => {
  const state = regime.init({ atrLookback: 20, squeezeLookback: 5 });
  const adx = { adx: 15, plusDI: 10, minusDI: 10 };

  // A flat BandWidth would read as a permanent squeeze and mask the result, so
  // walk it upward while the ATR distribution builds.
  for (let i = 0; i < 20; i += 1) {
    regime.evaluate(state, {
      atr: 1,
      adx,
      bollinger: bollingerAt(100, 0.05 + i * 0.001),
      close: 100,
    });
  }
  const out = regime.evaluate(state, {
    atr: 10,
    adx,
    bollinger: bollingerAt(100, 0.08),
    close: 100,
  });

  assert.equal(out.atrPercentile, 100);
  assert.equal(out.flags.volatileExpansion, true);
  assert.equal(out.primary, 'VOLATILE_EXPANSION');
});

test('regime calls TRENDING on a high ADX and RANGING on genuine oscillation', () => {
  const trendingState = regime.init({ squeezeLookback: 5, atrLookback: 10 });
  let out;
  for (let i = 0; i < 12; i += 1) {
    out = regime.evaluate(trendingState, {
      atr: 1,
      adx: { adx: 30, plusDI: 30, minusDI: 10 },
      bollinger: bollingerAt(100, 0.05 + i * 0.001),
      close: 100 + i,
    });
  }
  assert.equal(out.primary, 'TRENDING');

  const rangingState = regime.init({ squeezeLookback: 5, atrLookback: 10, oscillationLookback: 20 });
  for (let i = 0; i < 30; i += 1) {
    out = regime.evaluate(rangingState, {
      atr: 1,
      adx: { adx: 12, plusDI: 10, minusDI: 10 },
      bollinger: bollingerAt(100, 0.05 + i * 0.001),
      close: i % 2 === 0 ? 101 : 99, // crossing the middle every bar
      });
  }
  assert.equal(out.primary, 'RANGING');
  assert.equal(out.rangeQuality, 1);
});

test('low ADX without oscillation is not treated as a tradeable range', () => {
  // A quiet drift and a real range both show a low ADX. Only one mean-reverts,
  // and S2 is only safe in the one that does.
  const state = regime.init({ squeezeLookback: 5, atrLookback: 10 });
  let out;
  for (let i = 0; i < 30; i += 1) {
    out = regime.evaluate(state, {
      atr: 1,
      adx: { adx: 12, plusDI: 10, minusDI: 10 },
      bollinger: bollingerAt(100 + i, 0.05 + i * 0.001),
      close: 100 + i + 5, // always above the middle: no crossings at all
    });
  }
  assert.equal(out.rangeQuality, 0);
  assert.equal(out.flags.ranging, false);
});

// ---------------------------------------------------------------------------
// the assembled engine
// ---------------------------------------------------------------------------

test('structure engine runs end to end and stays deterministic', () => {
  const series = syntheticBars(500);
  const a = structure.analyse(series);
  const b = structure.analyse(series);

  assert.equal(a.length, 500);
  assert.deepEqual(
    a.map((v) => v.regime.primary),
    b.map((v) => v.regime.primary)
  );
  assert.deepEqual(
    a.map((v) => v.trend.state),
    b.map((v) => v.trend.state)
  );
  assert.deepEqual(
    a.map((v) => v.newPivots),
    b.map((v) => v.newPivots)
  );
});

test('structure engine does not look ahead', () => {
  // Rule 2 for structure: what the engine reported at bar N must not change
  // because bars after N later arrived.
  const series = syntheticBars(500);
  const cut = 320;

  const full = structure.analyse(series);
  const prefix = structure.analyse(series.slice(0, cut));

  const summarise = (v) => ({
    index: v.index,
    pivots: v.newPivots,
    trend: v.trend.state,
    regime: v.regime.primary,
    zones: v.zones.map((z) => ({ id: z.id, centre: z.centre, touches: z.touches })),
    resistance: v.trendlines.resistance
      ? { slope: v.trendlines.resistance.slope, broken: v.trendlines.resistance.broken }
      : null,
  });

  assert.deepEqual(prefix.map(summarise), full.slice(0, cut).map(summarise));
});

test('structure engine produces real structure on a trending series', () => {
  // A rising staircase: ten bars up, six back, repeat. Each leg has to be
  // longer than the pivot lookback on BOTH sides or nothing ever confirms — a
  // five-bar pullback simply does not contain a five-bar-lookback pivot, which
  // is the detector being correct rather than shy.
  //
  // Length 410 ends on the last rising bar of a cycle, so the final bar is
  // mid-advance rather than mid-pullback.
  const closes = [];
  let price = 100;
  for (let i = 0; i < 410; i += 1) {
    price += i % 16 < 10 ? 1 : -1.2;
    closes.push(price);
  }
  const view = structure.analyse(barsFromCloses(closes)).at(-1);

  assert.ok(view.pivots.highs.length > 3, 'a staircase should print swing highs');
  assert.ok(view.pivots.lows.length > 3, 'and swing lows');
  assert.ok(view.zones.length > 0, 'and cluster some of them into zones');
  assert.equal(view.trend.state, 'UP');
  assert.equal(view.trend.higherHighs, true);
  assert.equal(view.trend.higherLows, true);
});

test('an ATR that never changes ranks at the median, not the maximum', () => {
  // Regression: counting ties as "at or below" ranked a perfectly steady ATR at
  // the 100th percentile, pinning the engine in VOLATILE_EXPANSION forever and
  // silencing every strategy gated on a calmer regime.
  const state = regime.init({ atrLookback: 10, squeezeLookback: 5 });
  let out;
  for (let i = 0; i < 15; i += 1) {
    out = regime.evaluate(state, {
      atr: 1,
      adx: { adx: 30, plusDI: 30, minusDI: 10 },
      bollinger: bollingerAt(100, 0.05 + i * 0.001),
      close: 100 + i,
    });
  }
  assert.equal(out.atrPercentile, 50);
  assert.equal(out.flags.volatileExpansion, false);
  assert.equal(out.primary, 'TRENDING');
});
