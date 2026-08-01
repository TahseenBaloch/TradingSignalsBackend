const test = require('node:test');
const assert = require('node:assert/strict');

const candles = require('./index');
const { metrics } = require('./metrics');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

let clock = 0;
function mkBar(open, high, low, close, volume = 1) {
  return { time: (clock++) * 60, open, high, low, close, volume };
}

/** A run of filler bars walking `from` to `to`, used to establish prior trend. */
function ramp(from, to, count = 6) {
  const step = (to - from) / count;
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const close = from + step * (i + 1);
    const open = from + step * i;
    out.push(mkBar(open, Math.max(open, close) + 0.1, Math.min(open, close) - 0.1, close));
  }
  return out;
}

/** Feeds a series and returns the signals for the LAST bar only. */
function classifySeries(series, { atr = 2, zone = null, relativeVolume = null, params } = {}) {
  const state = candles.init(params);
  let last = [];
  series.forEach((bar, i) => {
    last = candles.update(state, bar, { index: i, atr, zone, relativeVolume });
  });
  return last;
}

const typesOf = (signals) => signals.map((s) => s.type);
const find = (signals, type) => signals.find((s) => s.type === type);

// ---------------------------------------------------------------------------
// metrics
// ---------------------------------------------------------------------------

test('metrics decompose a bar and survive a zero range', () => {
  const m = metrics(mkBar(100, 104, 99, 102), 2);
  assert.equal(m.body, 2);
  assert.equal(m.range, 5);
  assert.equal(m.upperWick, 2);
  assert.equal(m.lowerWick, 1);
  assert.equal(m.direction, 1);
  assert.equal(m.bodyAtr, 1);

  const flat = metrics(mkBar(100, 100, 100, 100), 2);
  assert.equal(flat.range, 0);
  assert.equal(flat.bodyRatio, 0, 'a bar with no shape has no ratios, not NaN');
  assert.equal(flat.direction, 0);
});

// ---------------------------------------------------------------------------
// doji family
// ---------------------------------------------------------------------------

test('dragonfly and gravestone doji are told apart by which wick dominates', () => {
  const dragonfly = classifySeries([...ramp(110, 100), mkBar(100, 100.1, 98, 100)]);
  assert.ok(typesOf(dragonfly).includes('dragonfly-doji'));
  assert.equal(find(dragonfly, 'dragonfly-doji').bias, 'bullish');

  const gravestone = classifySeries([...ramp(100, 110), mkBar(110, 112, 109.9, 110)]);
  assert.ok(typesOf(gravestone).includes('gravestone-doji'));
  assert.equal(find(gravestone, 'gravestone-doji').bias, 'bearish');
});

test('a doji with two long wicks is long-legged, and a lopsided one is plain', () => {
  const longLegged = classifySeries([...ramp(100, 100), mkBar(100, 101, 99, 100)]);
  assert.ok(typesOf(longLegged).includes('long-legged-doji'));

  // Upper wick 0.70 of range, lower 0.25: too lopsided for long-legged, but the
  // lower wick is too big for a gravestone.
  const plain = classifySeries([...ramp(100, 100), mkBar(100, 100.75, 99.75, 100.05)]);
  assert.ok(typesOf(plain).includes('doji'));
  assert.equal(find(plain, 'doji').bias, 'neutral');
});

// ---------------------------------------------------------------------------
// context changes the verdict
// ---------------------------------------------------------------------------

test('the same bar is a hammer after a decline and a hanging man after a rally', () => {
  // This is the whole point of a context-aware classifier: the geometry below
  // is byte-identical in both calls. Only what came before it differs.
  const shape = () => mkBar(100, 100.4, 99, 100.3);

  const afterDecline = classifySeries([...ramp(110, 100), shape()]);
  const hammer = find(afterDecline, 'hammer');
  assert.ok(hammer, 'a long lower wick into a decline is a hammer');
  assert.equal(hammer.bias, 'bullish');
  assert.ok(hammer.context.includes('after-decline'));
  assert.equal(typesOf(afterDecline).includes('hanging-man'), false);

  const afterRally = classifySeries([...ramp(90, 100), shape()]);
  const hanging = find(afterRally, 'hanging-man');
  assert.ok(hanging, 'the identical bar after a rally is a hanging man');
  assert.equal(hanging.bias, 'bearish');
  assert.ok(hanging.context.includes('after-advance'));
  assert.equal(typesOf(afterRally).includes('hammer'), false);
});

test('a hammer shape with no prior trend is emitted weakly and says so', () => {
  const flat = classifySeries([...ramp(100, 100), mkBar(100, 100.4, 99, 100.3)]);
  const hammer = find(flat, 'hammer');
  assert.ok(hammer);
  assert.equal(hammer.strength, 1, 'no supporting context means no strength bonus');
  assert.ok(hammer.context.includes('no-prior-trend'));
});

test('inverted hammer and shooting star split the same way', () => {
  const shape = () => mkBar(100, 101.4, 99.9, 100.3);

  const afterDecline = classifySeries([...ramp(110, 100), shape()]);
  assert.ok(typesOf(afterDecline).includes('inverted-hammer'));

  const afterRally = classifySeries([...ramp(90, 100), shape()]);
  assert.ok(typesOf(afterRally).includes('shooting-star'));
});

test('sitting on a zone raises strength', () => {
  const series = [...ramp(110, 100), mkBar(100, 100.4, 99, 100.3)];

  const away = classifySeries(series);
  const onZone = classifySeries(series, {
    zone: { role: 'support', low: 98.9, high: 99.4 },
  });

  assert.ok(find(onZone, 'hammer').strength > find(away, 'hammer').strength);
  assert.ok(find(onZone, 'hammer').context.includes('at-support'));
});

// ---------------------------------------------------------------------------
// two-bar and three-bar patterns
// ---------------------------------------------------------------------------

test('engulfing needs a real body that covers the previous one', () => {
  const bullish = classifySeries([
    ...ramp(110, 101),
    mkBar(101, 101.2, 99.9, 100),
    mkBar(99.8, 101.6, 99.7, 101.5),
  ]);
  assert.ok(typesOf(bullish).includes('bullish-engulfing'));

  const bearish = classifySeries([
    ...ramp(90, 100),
    mkBar(100, 101.2, 99.9, 101),
    mkBar(101.2, 101.3, 99.4, 99.5),
  ]);
  assert.ok(typesOf(bearish).includes('bearish-engulfing'));
});

test('a tiny engulfing body is rejected as noise', () => {
  // Body of 0.1 against an ATR of 2 is 0.05 ATR, well under the 0.3 floor.
  const out = classifySeries([
    ...ramp(110, 101),
    mkBar(100.5, 100.55, 100.4, 100.45),
    mkBar(100.4, 100.6, 100.35, 100.56),
  ]);
  assert.equal(typesOf(out).includes('bullish-engulfing'), false);
});

test('pin bar requires the body in an outer third', () => {
  const pin = classifySeries([...ramp(110, 100), mkBar(100.5, 101, 99, 100.8)]);
  assert.ok(typesOf(pin).includes('pin-bar-bullish'));

  // Same long lower wick, but the body sits mid-range.
  const midBody = classifySeries([...ramp(110, 100), mkBar(99.9, 101, 99, 100.1)]);
  assert.equal(typesOf(midBody).includes('pin-bar-bullish'), false);
});

test('inside and outside bars are read against the previous bar', () => {
  const inside = classifySeries([...ramp(100, 100), mkBar(100, 102, 98, 101), mkBar(100, 101, 99, 100.5)]);
  assert.ok(typesOf(inside).includes('inside-bar'));

  const outside = classifySeries([...ramp(100, 100), mkBar(100, 101, 99, 100.5), mkBar(100, 102, 98, 101.5)]);
  assert.ok(typesOf(outside).includes('outside-bar'));
});

test('marubozu needs an almost wickless body', () => {
  const out = classifySeries([...ramp(100, 100), mkBar(100, 102.05, 99.95, 102)]);
  assert.ok(typesOf(out).includes('marubozu-bullish'));

  const wicked = classifySeries([...ramp(100, 100), mkBar(100, 103, 99, 102)]);
  assert.equal(typesOf(wicked).includes('marubozu-bullish'), false);
});

test('tweezers need matching extremes and opposing directions', () => {
  const top = classifySeries([
    ...ramp(90, 100),
    mkBar(100, 101.5, 99.8, 101),
    mkBar(101, 101.45, 99.7, 100),
  ]);
  assert.ok(typesOf(top).includes('tweezer-top'));

  const bottom = classifySeries([
    ...ramp(110, 101),
    mkBar(101, 101.2, 99.5, 100),
    mkBar(100, 101.3, 99.55, 101),
  ]);
  assert.ok(typesOf(bottom).includes('tweezer-bottom'));
});

test('three soldiers must step, not gap', () => {
  const stepped = classifySeries([
    ...ramp(100, 100),
    mkBar(100, 101.2, 99.9, 101),
    mkBar(100.8, 102.2, 100.7, 102),
    mkBar(101.8, 103.2, 101.7, 103),
  ]);
  assert.ok(typesOf(stepped).includes('three-white-soldiers'));

  // Each bar opening above the previous close is a gap sequence, not an advance.
  const gapped = classifySeries([
    ...ramp(100, 100),
    mkBar(100, 101.2, 99.9, 101),
    mkBar(101.5, 102.7, 101.4, 102.5),
    mkBar(103, 104.2, 102.9, 104),
  ]);
  assert.equal(typesOf(gapped).includes('three-white-soldiers'), false);

  const crows = classifySeries([
    ...ramp(100, 100),
    mkBar(103, 103.2, 101.8, 102),
    mkBar(102.2, 102.3, 100.8, 101),
    mkBar(101.2, 101.3, 99.8, 100),
  ]);
  assert.ok(typesOf(crows).includes('three-black-crows'));
});

// ---------------------------------------------------------------------------
// the properties the spec actually asks for
// ---------------------------------------------------------------------------

test('classification is price-scale invariant', () => {
  // The spec's reason for ATR-relative thresholds: identical geometry must
  // classify identically on a five-figure BTC bar and a sub-dollar DOGE bar.
  const template = [...ramp(110, 100), mkBar(100, 100.4, 99, 100.3)];

  const scaleBy = (factor) =>
    template.map((b) => ({
      ...b,
      open: b.open * factor,
      high: b.high * factor,
      low: b.low * factor,
      close: b.close * factor,
    }));

  const btc = classifySeries(scaleBy(1000), { atr: 2000 });
  const doge = classifySeries(scaleBy(0.002), { atr: 0.004 });

  assert.deepEqual(typesOf(btc).sort(), typesOf(doge).sort());
  assert.ok(typesOf(btc).includes('hammer'));
  assert.deepEqual(
    btc.map((s) => s.strength),
    doge.map((s) => s.strength)
  );
});

test('nothing is classified before ATR has warmed', () => {
  const state = candles.init();
  const out = candles.update(state, mkBar(100, 100.4, 99, 100.3), { index: 0, atr: null });
  assert.deepEqual(out, [], 'with no scale to judge against, no claim is made');
});

test('bars too small relative to ATR are ignored', () => {
  // Textbook hammer geometry, but the whole range is 0.07 ATR.
  const out = classifySeries([...ramp(110, 100), mkBar(100, 100.04, 99.9, 100.03)], { atr: 2 });
  assert.equal(typesOf(out).includes('hammer'), false);
});

test('every emitted type is registered, and strength always lands in 1..3', () => {
  // The Phase 8 settings panel hangs per-type toggles off CANDLE_TYPES, so an
  // unregistered type would be undismissable.
  let s = 11;
  const next = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };

  const state = candles.init();
  const seen = new Set();
  let price = 100;

  for (let i = 0; i < 4000; i += 1) {
    const open = price;
    price *= 1 + (next() - 0.5) * 0.03;
    const wick = next() * 1.2;
    const bar = {
      time: i * 60,
      open,
      high: Math.max(open, price) + wick,
      low: Math.min(open, price) - next() * 1.2,
      close: price,
      volume: 10 + next() * 90,
    };
    for (const signal of candles.update(state, bar, { index: i, atr: 2, relativeVolume: next() * 3 })) {
      seen.add(signal.type);
      assert.ok(
        candles.TYPES_BY_ID.has(signal.type),
        `${signal.type} is not in the CANDLE_TYPES registry`
      );
      assert.ok(
        Number.isInteger(signal.strength) && signal.strength >= 1 && signal.strength <= 3,
        `strength ${signal.strength} out of range`
      );
      assert.ok(['bullish', 'bearish', 'neutral'].includes(signal.bias));
    }
  }

  assert.ok(seen.size >= 10, `random walk should exercise most detectors, saw ${seen.size}`);
});

test('classification is deterministic and does not look ahead', () => {
  let s = 3;
  const next = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const series = [];
  let price = 100;
  for (let i = 0; i < 600; i += 1) {
    const open = price;
    price *= 1 + (next() - 0.5) * 0.02;
    series.push({
      time: i * 60,
      open,
      high: Math.max(open, price) + next() * 0.8,
      low: Math.min(open, price) - next() * 0.8,
      close: price,
      volume: 50,
    });
  }

  const ctxFor = (_bar, i) => ({ index: i, atr: 2, relativeVolume: 1 });
  const a = candles.batch(series, ctxFor);
  const b = candles.batch(series, ctxFor);
  assert.deepEqual(a, b);

  const cut = 400;
  const prefix = candles.batch(series.slice(0, cut), ctxFor);
  assert.deepEqual(prefix, a.slice(0, cut), 'later bars must not change earlier verdicts');
});

test('reversal helpers filter by bias and strength', () => {
  const signals = [
    { type: 'hammer', bias: 'bullish', strength: 1, context: [] },
    { type: 'doji', bias: 'neutral', strength: 2, context: [] },
  ];
  assert.equal(candles.hasBullishReversal(signals), true);
  assert.equal(candles.hasBullishReversal(signals, 2), false, 'strength floor is respected');
  assert.equal(candles.hasBearishReversal(signals), false);
});
