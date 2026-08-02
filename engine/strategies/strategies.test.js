const test = require('node:test');
const assert = require('node:assert/strict');

const ladder = require('./ladder');
const strategies = require('./index');
const modules = require('./modules');
const config = require('../config');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// Default bar time is midday UTC, not midnight. 864_000 is exactly a day
// boundary, where S2's session-reset guard correctly suppresses everything —
// which made every S2 fixture silently untestable.
const MIDDAY = 864_000 + 43_200;

function mkBar(close, { high, low, open, volume = 100, time = MIDDAY } = {}) {
  return {
    time,
    open: open ?? close,
    high: high ?? close + 0.5,
    low: low ?? close - 0.5,
    close,
    volume,
  };
}

const RESOLVED = config.resolve('Balanced');

/** A context with everything present and neutral, for targeted overriding. */
function mkCtx(overrides = {}) {
  const bar = overrides.bar || mkBar(100);
  const bars = overrides.bars || new Array(10).fill(null).map((_, i) => mkBar(100 - (9 - i) * 0.1));

  return {
    symbol: 'BTCUSD',
    timeframe: '5m',
    index: 500,
    bar,
    bars,
    atr: 2,
    rsi: 50,
    macd: { macd: 0.5, signal: 0.2, histogram: 0.3 },
    adx: { adx: 30, plusDI: 30, minusDI: 10 },
    bollinger: { middle: 100, upper: 104, lower: 96, stdev: 2, bandwidth: 0.08, percentB: 0.5 },
    stochastic: { k: 50, d: 50 },
    supertrend: { value: 96, direction: 1, upper: 104, lower: 96, flipped: false },
    volume: { volume: 150, sma: 100, relative: 1.5 },
    vwapSession: {
      vwap: 100,
      stdev: 1,
      upper: [101, 102, 103],
      lower: [99, 98, 97],
      barsInSession: 300,
    },
    vwapRolling: null,
    ema: { 9: 100, 21: 99.5, 50: 99, 200: 95 },
    structure: {
      regime: {
        primary: 'TRENDING',
        flags: { trending: true, ranging: false, squeeze: false, volatileExpansion: false },
        adx: 30,
        atrPercentile: 50,
        bandwidth: 0.08,
        rangeQuality: 0,
      },
      trend: { state: 'UP', score: 3, votes: {}, higherHighs: true, higherLows: true },
      zones: [],
      trendlines: { resistance: null, support: null },
      pivots: { highs: [], lows: [] },
    },
    candles: [],
    patterns: { open: [], confirmed: [], resolved: [], events: [], stats: {} },
    bias: {
      '15m': {
        close: 110,
        ema50: 105,
        ema200: 100,
        supertrend: { direction: 1, value: 105 },
        adx: { adx: 30, plusDI: 30, minusDI: 10 },
        trend: { state: 'UP' },
      },
      '1h': {
        close: 110,
        ema50: 105,
        ema200: 100,
        supertrend: { direction: 1, value: 104 },
        adx: { adx: 28, plusDI: 28, minusDI: 12 },
        trend: { state: 'UP' },
      },
      '4h': {
        close: 110,
        ema50: 105,
        ema200: 100,
        supertrend: { direction: 1, value: 100 },
        adx: { adx: 26, plusDI: 26, minusDI: 14 },
        trend: { state: 'UP' },
      },
    },
    config: RESOLVED,
    ...overrides,
  };
}

const bullishCandle = { type: 'hammer', bias: 'bullish', strength: 2, context: ['after-decline'] };
const bearishCandle = { type: 'shooting-star', bias: 'bearish', strength: 2, context: ['after-advance'] };

// ---------------------------------------------------------------------------
// ladder
// ---------------------------------------------------------------------------

test('a long ladder is strictly monotonic with TP1 at exactly 1R', () => {
  const l = ladder.build({ direction: 'long', entry: 100, sl1: 98, atr: 2 });

  assert.equal(l.r, 2);
  assert.equal(l.targets[0], 102, 'TP1 is entry + 1R by definition');
  assert.equal(ladder.validate('long', l.entry, l.stops, l.targets).ok, true);

  const [sl1, sl2, sl3] = l.stops;
  const [tp1, tp2, tp3] = l.targets;
  assert.ok(sl3 < sl2 && sl2 < sl1 && sl1 < 100 && 100 < tp1 && tp1 < tp2 && tp2 < tp3);
});

test('a short ladder mirrors exactly', () => {
  const l = ladder.build({ direction: 'short', entry: 100, sl1: 102, atr: 2 });

  assert.equal(l.r, 2);
  assert.equal(l.targets[0], 98);
  assert.equal(ladder.validate('short', l.entry, l.stops, l.targets).ok, true);

  const [sl1, sl2, sl3] = l.stops;
  const [tp1, tp2, tp3] = l.targets;
  assert.ok(sl3 > sl2 && sl2 > sl1 && sl1 > 100 && 100 > tp1 && tp1 > tp2 && tp2 > tp3);
});

test('TP2 takes the nearer structural target but never comes inside 1.5R', () => {
  // Structure at 2.5R is further than the 2R default, so 2R wins.
  const far = ladder.build({ direction: 'long', entry: 100, sl1: 98, atr: 2, structuralTarget: 105 });
  assert.equal(far.targets[1], 104, 'default 2R');

  // Structure at 1.75R is nearer than 2R, so structure wins.
  const near = ladder.build({ direction: 'long', entry: 100, sl1: 98, atr: 2, structuralTarget: 103.5 });
  assert.equal(near.targets[1], 103.5);

  // Structure at 0.5R would put TP2 inside TP1; the 1.5R floor holds.
  const tooNear = ladder.build({ direction: 'long', entry: 100, sl1: 98, atr: 2, structuralTarget: 101 });
  assert.equal(tooNear.targets[1], 103, 'floored at 1.5R');
  assert.ok(tooNear.sources.includes('tp2:1.5R-floor'));
});

test('SL2 clears real structure, and falls back when there is none', () => {
  const structural = ladder.build({
    direction: 'long',
    entry: 100,
    sl1: 98,
    atr: 2,
    structuralStop: 96, // zone low
  });
  assert.equal(structural.stops[1], 95, 'padded by 0.5 ATR beyond the zone');
  assert.ok(structural.sources.includes('sl2:structure'));

  const none = ladder.build({ direction: 'long', entry: 100, sl1: 98, atr: 2 });
  assert.ok(none.sources.includes('sl2:fallback'));
  assert.ok(none.stops[1] < none.stops[0]);
});

test('SL3 takes the furthest thesis-killer available', () => {
  const withPattern = ladder.build({
    direction: 'long',
    entry: 100,
    sl1: 98,
    atr: 2,
    structuralStop: 97,
    patternInvalidation: 94,
    vwap3Sigma: 90, // further out, so this is where the thesis truly dies
  });
  assert.equal(withPattern.stops[2], 90);
  assert.ok(withPattern.sources.includes('sl3:vwap-3sigma'));

  const bare = ladder.build({ direction: 'long', entry: 100, sl1: 98, atr: 2 });
  assert.equal(bare.stops[2], 96, 'fallback is entry - 2R');
  assert.ok(bare.sources.includes('sl3:2R-fallback'));
});

test('a stop on the wrong side of entry is clamped, not propagated', () => {
  // A strategy bug must not become a signal with inverted risk.
  const l = ladder.build({ direction: 'long', entry: 100, sl1: 105, atr: 2 });
  assert.equal(ladder.validate('long', l.entry, l.stops, l.targets).ok, true);
  assert.ok(l.stops[0] < 100);
});

test('validate rejects a ladder that is out of order', () => {
  assert.equal(ladder.validate('long', 100, [98, 99, 97], [102, 104, 106]).ok, false);
  assert.equal(ladder.validate('long', 100, [98, 97, 96], [102, 101, 106]).ok, false);
  assert.equal(ladder.validate('long', 100, [98, 97, 96], [102, 104, NaN]).ok, false);
  assert.equal(ladder.validate('long', 100, [98, 97, 96], [102, 104, 106]).ok, true);
});

test('the feed format is the compact one-liner', () => {
  const l = ladder.build({ direction: 'long', entry: 43210, sl1: 43050, atr: 100 });
  const text = ladder.format(l, 0);
  assert.match(text, /^E 43,210 · SL 43,050\/[\d,]+\/[\d,]+ · TP 43,370\//);
});

test('every ladder built from random inputs is monotonic', () => {
  // The invariant matters more than any single case: nothing downstream —
  // position sizing, the chart drawing, the backtest exit model — is correct if
  // the rungs can cross.
  let s = 99;
  const next = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };

  for (let i = 0; i < 3000; i += 1) {
    const direction = next() > 0.5 ? 'long' : 'short';
    const entry = 0.5 + next() * 50_000;
    const atr = Math.max(1e-6, entry * (0.0005 + next() * 0.02));
    const sign = direction === 'long' ? 1 : -1;
    const sl1 = entry - sign * atr * (0.2 + next() * 3);

    const pick = (chance, value) => (next() < chance ? value : null);
    const l = ladder.build({
      direction,
      entry,
      sl1,
      atr,
      structuralStop: pick(0.6, entry - sign * atr * next() * 6),
      patternInvalidation: pick(0.4, entry - sign * atr * next() * 8),
      vwap3Sigma: pick(0.5, entry - sign * atr * next() * 10),
      biasSupertrend: pick(0.4, entry - sign * atr * next() * 7),
      structuralTarget: pick(0.6, entry + sign * atr * next() * 6),
      measuredTarget: pick(0.5, entry + sign * atr * next() * 12),
    });

    const check = ladder.validate(direction, l.entry, l.stops, l.targets);
    assert.equal(check.ok, true, `iteration ${i}: ${check.reason}`);
    assert.ok(Math.abs(Math.abs(l.entry - l.stops[0]) - l.r) < 1e-9, 'R must be |entry - SL1|');
  }
});

// ---------------------------------------------------------------------------
// S1 - EMA pullback
// ---------------------------------------------------------------------------

test('S1 fires on a pullback that closed back above the 9 EMA', () => {
  const ctx = mkCtx({
    bar: mkBar(101, { low: 99.5, high: 101.2 }),
    candles: [bullishCandle],
  });
  const signal = modules.s1.evaluate(ctx, modules.s1.initState());

  assert.ok(signal);
  assert.equal(signal.direction, 'long');
  assert.equal(signal.stops.length, 3);
  assert.equal(signal.targets.length, 3);
  assert.equal(ladder.validate('long', signal.entry, signal.stops, signal.targets).ok, true);
  assert.ok(signal.reasons.some((r) => r.id === 's1-candle'));
});

test('S1 is silent when the bias timeframe disagrees', () => {
  const ctx = mkCtx({
    bar: mkBar(101, { low: 99.5 }),
    candles: [bullishCandle],
    bias: {
      ...mkCtx().bias,
      '15m': {
        close: 90,
        ema50: 95,
        ema200: 100,
        supertrend: { direction: -1, value: 95 },
        adx: { adx: 30, plusDI: 10, minusDI: 30 },
        trend: { state: 'DOWN' },
      },
    },
  });
  // The 15m says down, the 5m pullback is a long: no trade in either direction.
  assert.equal(modules.s1.evaluate(ctx, modules.s1.initState()), null);
});

test('S1 respects its regime gate and its ADX floor', () => {
  const base = { bar: mkBar(101, { low: 99.5 }), candles: [bullishCandle] };

  const ranging = mkCtx(base);
  ranging.structure.regime.primary = 'RANGING';
  assert.equal(modules.s1.evaluate(ranging, modules.s1.initState()), null);

  const weak = mkCtx({ ...base, adx: { adx: 12, plusDI: 20, minusDI: 18 } });
  assert.equal(modules.s1.evaluate(weak, modules.s1.initState()), null);
});

test('S1 scores higher when the pullback lands on a zone', () => {
  const plain = modules.s1.evaluate(
    mkCtx({ bar: mkBar(101, { low: 99.5 }), candles: [bullishCandle] }),
    modules.s1.initState()
  );

  const onZone = mkCtx({ bar: mkBar(101, { low: 99.5 }), candles: [bullishCandle] });
  onZone.structure.zones = [
    { id: 1, low: 99.2, high: 99.8, centre: 99.5, role: 'support', touches: 4, strength: 0.8 },
  ];
  const boosted = modules.s1.evaluate(onZone, modules.s1.initState());

  assert.ok(boosted.score > plain.score);
  assert.ok(boosted.reasons.some((r) => r.id === 's1-zone'));
});

// ---------------------------------------------------------------------------
// S2 - VWAP band reversion
// ---------------------------------------------------------------------------

function rangingCtx(overrides = {}) {
  const ctx = mkCtx(overrides);
  ctx.structure.regime.primary = 'RANGING';
  ctx.structure.regime.rangeQuality = 0.6;
  ctx.structure.regime.flags = { trending: false, ranging: true, squeeze: false, volatileExpansion: false };
  return ctx;
}

test('S2 only fires in a genuine range', () => {
  const state = modules.s2.initState();
  const trending = mkCtx({ bar: mkBar(99, { low: 98.9 }), candles: [bullishCandle] });
  assert.equal(modules.s2.evaluate(trending, state), null);

  const drifting = rangingCtx({ bar: mkBar(99, { low: 98.9 }), candles: [bullishCandle] });
  drifting.structure.regime.rangeQuality = 0.05; // low ADX but no oscillation
  assert.equal(modules.s2.evaluate(drifting, modules.s2.initState()), null);
});

test('S2 needs a rejection candle, never a band touch alone', () => {
  const bare = rangingCtx({ bar: mkBar(99, { low: 98.9 }), candles: [] });
  assert.equal(modules.s2.evaluate(bare, modules.s2.initState()), null);

  const confirmed = rangingCtx({ bar: mkBar(99, { low: 98.9 }), candles: [bullishCandle] });
  assert.ok(modules.s2.evaluate(confirmed, modules.s2.initState()));
});

test('S2 tier 2 needs the 2-sigma band AND an RSI recross', () => {
  const p = RESOLVED.strategies.s2;

  // Touch of 2 sigma, but RSI never left the extreme: tier 1 only.
  const state = modules.s2.initState();
  modules.s2.evaluate(rangingCtx({ bar: mkBar(98, { low: 97.9 }), rsi: 25, candles: [bullishCandle] }), state);
  const stillLow = modules.s2.evaluate(
    rangingCtx({ bar: mkBar(98, { low: 97.9 }), rsi: 26, candles: [bullishCandle] }),
    state
  );
  assert.equal(stillLow.score, p.baseScoreTier1);

  // Now RSI crosses back up through 30.
  const state2 = modules.s2.initState();
  modules.s2.evaluate(rangingCtx({ bar: mkBar(98, { low: 97.9 }), rsi: 28, candles: [bullishCandle] }), state2);
  const recross = modules.s2.evaluate(
    rangingCtx({ bar: mkBar(98, { low: 97.9 }), rsi: 34, candles: [bullishCandle] }),
    state2
  );
  assert.equal(recross.score, p.baseScoreTier2);
  assert.ok(recross.reasons.some((r) => r.id === 's2-rsi'));
});

test('S2 stands aside just after the UTC session reset', () => {
  // The session VWAP anchor has almost no data behind it there.
  const justAfterMidnight = rangingCtx({
    bar: mkBar(99, { low: 98.9, time: 864_000 + 300 }),
    candles: [bullishCandle],
  });
  assert.equal(modules.s2.evaluate(justAfterMidnight, modules.s2.initState()), null);
});

// ---------------------------------------------------------------------------
// S3 - squeeze breakout
// ---------------------------------------------------------------------------

function squeezeCtx(overrides = {}) {
  const ctx = mkCtx(overrides);
  ctx.structure.regime.primary = 'SQUEEZE';
  ctx.structure.regime.flags = { trending: false, ranging: false, squeeze: true, volatileExpansion: false };
  return ctx;
}

test('S3 needs the band break, the volume and the MACD to agree', () => {
  const state = modules.s3.initState();
  // First bar: in the squeeze, recording the compressed height.
  modules.s3.evaluate(squeezeCtx({ bar: mkBar(100) }), state);
  assert.equal(state.squeezeHeight, 8);

  const breakout = squeezeCtx({ bar: mkBar(105), volume: { volume: 200, sma: 100, relative: 2 } });
  const signal = modules.s3.evaluate(breakout, state);
  assert.ok(signal);
  assert.equal(signal.direction, 'long');
  assert.equal(signal.stops[0] < signal.entry, true);

  const quiet = squeezeCtx({ bar: mkBar(105), volume: { volume: 90, sma: 100, relative: 0.9 } });
  assert.equal(modules.s3.evaluate(quiet, modules.s3.initState()), null, 'no volume, no break');

  const disagreeing = squeezeCtx({
    bar: mkBar(105),
    volume: { volume: 200, sma: 100, relative: 2 },
    macd: { macd: -0.5, signal: 0.2, histogram: -0.7 },
  });
  const s2state = modules.s3.initState();
  modules.s3.evaluate(squeezeCtx({ bar: mkBar(100) }), s2state);
  assert.equal(modules.s3.evaluate(disagreeing, s2state), null, 'MACD must agree with the break');
});

// ---------------------------------------------------------------------------
// S4 - session range breakout
// ---------------------------------------------------------------------------

test('S4 builds the opening range, then trades one break per direction', () => {
  const state = modules.s4.initState();
  const day = 20_000 * 86_400;
  const run = (secondsIntoDay, bar) =>
    modules.s4.evaluate(
      mkCtx({ timeframe: '5m', bar: { ...bar, time: day + secondsIntoDay } }),
      state
    );

  // Inside the 00:00 window: accumulate, never signal.
  assert.equal(run(60, mkBar(100, { high: 101, low: 99 })), null);
  assert.equal(run(600, mkBar(100.5, { high: 102, low: 99.5 })), null);
  assert.equal(state.sessions.get('daily-open').high, 102);
  assert.equal(state.sessions.get('daily-open').low, 99);

  // After the window, a close above the range high triggers once.
  const first = run(1200, mkBar(103, { high: 103.2, low: 102 }));
  assert.ok(first);
  assert.equal(first.direction, 'long');
  assert.equal(first.stops[0], 100.5, 'stop at the range midpoint');

  assert.equal(run(1500, mkBar(104, { high: 104.2, low: 103 })), null, 'one long per session');
});

test('S4 skips ranges that are too tight or too wide', () => {
  const day = 20_000 * 86_400;

  const tight = modules.s4.initState();
  modules.s4.evaluate(mkCtx({ bar: mkBar(100, { high: 100.2, low: 100, time: day + 60 }) }), tight);
  assert.equal(
    modules.s4.evaluate(mkCtx({ bar: mkBar(101, { time: day + 1200 }) }), tight),
    null,
    'a 0.2 range against a 2.0 ATR is not compression'
  );

  const wide = modules.s4.initState();
  modules.s4.evaluate(mkCtx({ bar: mkBar(100, { high: 110, low: 100, time: day + 60 }) }), wide);
  assert.equal(
    modules.s4.evaluate(mkCtx({ bar: mkBar(111, { time: day + 1200 }) }), wide),
    null,
    'a 5 ATR opening range is a news bar'
  );
});

// ---------------------------------------------------------------------------
// S5 - regime bias
// ---------------------------------------------------------------------------

test('S5 produces a bias score, never a tradeable signal', () => {
  const bullish = modules.s5.evaluate(mkCtx());
  assert.ok(bullish.bias > 0);
  assert.equal(bullish.direction, undefined, 'S5 is not an entry generator');
  assert.ok(bullish.bias <= 100);

  const ctx = mkCtx();
  for (const tf of ['1h', '4h']) {
    ctx.bias[tf] = {
      close: 90,
      ema50: 95,
      ema200: 100,
      supertrend: { direction: -1, value: 95 },
      adx: { adx: 40, plusDI: 10, minusDI: 40 },
      trend: { state: 'DOWN' },
    };
  }
  const bearish = modules.s5.evaluate(ctx);
  assert.ok(bearish.bias < 0);
  assert.ok(bearish.bias >= -100);
});

// ---------------------------------------------------------------------------
// S6 - micro scalp
// ---------------------------------------------------------------------------

test('S6 fires on a stochastic cross out of oversold, with a cooldown', () => {
  const state = modules.s6.initState();

  // Priming bar: no previous stochastic yet.
  assert.equal(modules.s6.evaluate(mkCtx({ stochastic: { k: 20, d: 25 } }), state), null);

  const crossed = mkCtx({ index: 501, stochastic: { k: 30, d: 26 }, bar: mkBar(101) });
  const signal = modules.s6.evaluate(crossed, state);
  assert.ok(signal);
  assert.equal(signal.direction, 'long');
  assert.equal(ladder.validate('long', signal.entry, signal.stops, signal.targets).ok, true);

  // A second cross one bar later is inside the cooldown.
  modules.s6.evaluate(mkCtx({ index: 502, stochastic: { k: 20, d: 25 } }), state);
  const spam = modules.s6.evaluate(mkCtx({ index: 502, stochastic: { k: 31, d: 27 }, bar: mkBar(101) }), state);
  assert.equal(spam, null, 'one swing must not spam the feed');
});

test('S6 will not trade against the 15m trend', () => {
  const state = modules.s6.initState();
  modules.s6.evaluate(mkCtx({ stochastic: { k: 20, d: 25 } }), state);

  const ctx = mkCtx({ index: 501, stochastic: { k: 30, d: 26 }, bar: mkBar(101) });
  ctx.bias['15m'].trend = { state: 'DOWN' };
  assert.equal(modules.s6.evaluate(ctx, state), null);
});

// ---------------------------------------------------------------------------
// registry, runner and config
// ---------------------------------------------------------------------------

test('the runner reports strategy signals and the bias separately', () => {
  const state = strategies.init(RESOLVED);
  const ctx = mkCtx({ bar: mkBar(101, { low: 99.5 }), candles: [bullishCandle] });

  const out = strategies.run(state, ctx);
  assert.ok(out.signals.length >= 1);
  assert.ok(out.bias, 'S5 contributes bias, not a signal');
  assert.equal(
    out.signals.some((s) => s.key === 's5'),
    false,
    'the bias module never appears among directional signals'
  );

  for (const entry of out.signals) {
    const { signal } = entry;
    assert.equal(signal.stops.length, 3);
    assert.equal(signal.targets.length, 3);
    assert.equal(ladder.validate(signal.direction, signal.entry, signal.stops, signal.targets).ok, true);
    assert.ok(signal.score >= RESOLVED.limits.minStrategyScore);
    assert.ok(signal.reasons.length > 0, 'every signal must carry its evidence');
  }
});

test('presets scale the thresholds and filters that drive cadence', () => {
  const conservative = config.resolve('Conservative');
  const balanced = config.resolve('Balanced');
  const aggressive = config.resolve('Aggressive');

  // Narrower NEUTRAL band and lower conviction floor => more signals.
  assert.ok(aggressive.confluence.thresholds.weak < balanced.confluence.thresholds.weak);
  assert.ok(balanced.confluence.thresholds.weak < conservative.confluence.thresholds.weak);
  assert.ok(aggressive.limits.minStrategyScore < conservative.limits.minStrategyScore);

  // Looser filters too, not just thresholds.
  assert.ok(aggressive.strategies.s1.minAdx < conservative.strategies.s1.minAdx);
  assert.ok(aggressive.strategies.s3.minRelativeVolume < conservative.strategies.s3.minRelativeVolume);
  assert.ok(aggressive.strategies.s6.cooldownBars < conservative.strategies.s6.cooldownBars);

  assert.equal(balanced.confluence.thresholds.strong, 65, 'Balanced matches the spec bands');
  assert.equal(balanced.confluence.thresholds.weak, 30);
});

test('config.resolve is pure and rejects an unknown preset', () => {
  const a = config.resolve('Balanced');
  const b = config.resolve('Balanced');
  assert.deepEqual(a, b);

  a.strategies.s1.baseScore = 999;
  assert.notEqual(config.resolve('Balanced').strategies.s1.baseScore, 999, 'no shared mutable state');

  assert.throws(() => config.resolve('Reckless'), /Unknown preset/);
});

test('the registry describes every strategy for the settings UI', () => {
  const all = strategies.list(RESOLVED);
  assert.equal(all.length, 6);
  assert.deepEqual(all.map((s) => s.key), ['s1', 's2', 's3', 's4', 's5', 's6']);

  const bias = all.find((s) => s.key === 's5');
  assert.equal(bias.biasOnly, true);
  assert.equal(bias.weight, 0, 'the bias module never contributes directionally');

  for (const s of all) {
    assert.ok(s.id && s.name);
    assert.ok(Array.isArray(s.requiredTimeframes) && s.requiredTimeframes.length > 0);
  }

  // The entry timeframes are the scalping ones; bias timeframes never generate.
  const entryStrategies = all.filter((s) => !s.biasOnly);
  for (const s of entryStrategies) {
    assert.ok(
      s.requiredTimeframes.some((tf) => ['1m', '5m', '15m'].includes(tf)),
      `${s.id} must be able to fire on a scalping timeframe`
    );
  }
});
