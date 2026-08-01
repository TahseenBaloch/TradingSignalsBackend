const test = require('node:test');
const assert = require('node:assert/strict');

const patterns = require('./index');
const base = require('./base');
const detectors = require('./detectors');
const breakout = require('./breakout');
const pivotsModule = require('../structure/pivots');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function mkBar(close, { high, low, open, volume = 100, time = 0 } = {}) {
  return {
    time,
    open: open ?? close,
    high: high ?? close + 0.2,
    low: low ?? close - 0.2,
    close,
    volume,
  };
}

/** A PivotState pre-loaded with explicit pivots. */
function pivotStateWith({ highs = [], lows = [] }) {
  const state = pivotsModule.init({ lookback: 2 });
  const build = (kind) => (p) => ({
    kind,
    index: p.index,
    time: p.index * 60,
    price: p.price,
    confirmedIndex: p.index + 2,
    confirmedTime: (p.index + 2) * 60,
    barsDelayed: 2,
  });
  state.highs = highs.map(build('high'));
  state.lows = lows.map(build('low'));
  return state;
}

function line(slope, intercept, { touches = 3, broken = false } = {}) {
  return {
    kind: 'resistance',
    slope,
    intercept,
    touches,
    meanResidual: 0,
    anchors: [],
    from: { index: 0, time: 0, price: intercept },
    to: { index: 0, time: 0, price: intercept },
    broken,
    fittedAtIndex: 0,
  };
}

const P = patterns.DEFAULTS;

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

test('a pattern walks forming -> confirmed -> completed', () => {
  const p = base.create({ type: 'range-box', index: 0, time: 0, seq: 0 });
  assert.equal(p.status, base.STATUS.FORMING);
  assert.equal(p.target, null, 'a shape has no target until something triggers it');

  base.confirm(p, { index: 5, time: 300, direction: 'long', target: 110, invalidation: 95, entry: 100 });
  assert.equal(p.status, base.STATUS.CONFIRMED);
  assert.equal(p.target, 110);

  const done = base.track(p, mkBar(111, { high: 111 }), { index: 8, maxAge: 100 });
  assert.equal(done, true);
  assert.equal(p.status, base.STATUS.COMPLETED);
  assert.equal(p.outcome, 'target');
  assert.equal(p.barsToResolve, 3);
});

test('a bar touching both target and invalidation counts as a failure', () => {
  // Must match the backtester's pessimistic intrabar rule. If pattern stats
  // were measured optimistically while fills were pessimistic, every quoted
  // probability would be better than anything actually capturable.
  const p = base.create({ type: 'range-box', index: 0, time: 0, seq: 0 });
  base.confirm(p, { index: 0, time: 0, direction: 'long', target: 110, invalidation: 95 });

  base.track(p, mkBar(100, { high: 115, low: 90 }), { index: 1, maxAge: 100 });
  assert.equal(p.outcome, 'invalidation');
  assert.equal(p.status, base.STATUS.FAILED);
});

test('a confirmed pattern that never resolves expires', () => {
  const p = base.create({ type: 'range-box', index: 0, time: 0, seq: 0 });
  base.confirm(p, { index: 0, time: 0, direction: 'long', target: 110, invalidation: 95 });

  for (let i = 1; i <= 9; i += 1) base.track(p, mkBar(100), { index: i, maxAge: 10 });
  assert.equal(p.status, base.STATUS.CONFIRMED);

  base.track(p, mkBar(100), { index: 10, maxAge: 10 });
  assert.equal(p.status, base.STATUS.EXPIRED);
  assert.equal(p.outcome, 'expired');
});

test('pattern ids are deterministic and unique', () => {
  const a = base.create({ type: 'bull-flag', index: 7, time: 0, seq: 0 });
  const b = base.create({ type: 'bull-flag', index: 7, time: 0, seq: 1 });
  assert.equal(a.id, 'bull-flag:7:0');
  assert.notEqual(a.id, b.id);
});

// ---------------------------------------------------------------------------
// range box
// ---------------------------------------------------------------------------

test('a range box needs flat edges on both sides and price still inside', () => {
  const ctx = {
    atr: 2,
    index: 40,
    bar: mkBar(105),
    pivots: pivotStateWith({
      highs: [{ index: 10, price: 110 }, { index: 30, price: 110.2 }],
      lows: [{ index: 20, price: 100 }, { index: 35, price: 100.1 }],
    }),
  };

  const found = detectors.detectRange(ctx, P);
  assert.ok(found);
  assert.equal(found.type, 'range-box');
  assert.equal(found.geometry.length, 4, 'a box draws as four corners');
  assert.ok(Math.abs(found.meta.top - 110.1) < 1e-9);
  assert.ok(Math.abs(found.meta.bottom - 100.05) < 1e-9);

  // Price already outside: the box is history, not a live pattern.
  assert.equal(detectors.detectRange({ ...ctx, bar: mkBar(120) }, P), null);

  // Edges too ragged to be flat (0.5 ATR = 1.0 tolerance).
  const ragged = {
    ...ctx,
    pivots: pivotStateWith({
      highs: [{ index: 10, price: 110 }, { index: 30, price: 116 }],
      lows: [{ index: 20, price: 100 }, { index: 35, price: 100.1 }],
    }),
  };
  assert.equal(detectors.detectRange(ragged, P), null);
});

test('a range breakout projects the box height as its target', () => {
  const pattern = base.create({
    type: 'range-box',
    index: 0,
    time: 0,
    seq: 0,
    meta: { top: 110, bottom: 100, height: 10 },
  });

  const up = detectors.promote(pattern, mkBar(111), { atr: 2 }, P);
  assert.equal(up.direction, 'long');
  assert.equal(up.target, 120, 'height projected from the box top');

  const down = detectors.promote(pattern, mkBar(99), { atr: 2 }, P);
  assert.equal(down.direction, 'short');
  assert.equal(down.target, 90);

  assert.equal(detectors.promote(pattern, mkBar(110.2), { atr: 2 }, P), null, 'inside the margin');
});

// ---------------------------------------------------------------------------
// triangles
// ---------------------------------------------------------------------------

test('triangles are classified from the two line slopes', () => {
  const at = (index, bar, resistance, support) => ({
    atr: 2,
    index,
    bar,
    secondsPerBar: 60,
    trendlines: { resistance, support },
  });

  const ascending = detectors.detectTriangle(
    at(100, mkBar(107), line(0, 110), line(0.1, 95)),
    P
  );
  assert.equal(ascending.type, 'ascending-triangle');
  assert.equal(ascending.direction, 'long');
  assert.ok(Math.abs(ascending.meta.height - 5) < 1e-9);
  assert.ok(ascending.geometry.some((g) => g.role === 'apex'));

  const descending = detectors.detectTriangle(
    at(100, mkBar(102), line(-0.1, 115), line(0, 100)),
    P
  );
  assert.equal(descending.type, 'descending-triangle');
  assert.equal(descending.direction, 'short');

  const symmetrical = detectors.detectTriangle(
    at(50, mkBar(105), line(-0.1, 115), line(0.1, 95)),
    P
  );
  assert.equal(symmetrical.type, 'symmetrical-triangle');
  assert.equal(symmetrical.direction, 'neutral', 'a symmetrical triangle picks no side until it breaks');
});

test('diverging or broken lines are not a triangle', () => {
  const diverging = detectors.detectTriangle(
    {
      atr: 2,
      index: 50,
      bar: mkBar(105),
      trendlines: { resistance: line(0.1, 108), support: line(-0.1, 102) },
    },
    P
  );
  assert.equal(diverging, null, 'lines must converge on an apex ahead');

  const broken = detectors.detectTriangle(
    {
      atr: 2,
      index: 100,
      bar: mkBar(107),
      trendlines: { resistance: line(0, 110, { broken: true }), support: line(0.1, 95) },
    },
    P
  );
  assert.equal(broken, null);
});

// ---------------------------------------------------------------------------
// doubles
// ---------------------------------------------------------------------------

test('a double top confirms on the neckline, not on the second peak', () => {
  const ctx = {
    atr: 2,
    index: 40,
    bar: mkBar(106),
    pivots: pivotStateWith({
      highs: [{ index: 10, price: 110 }, { index: 30, price: 110.3 }],
      lows: [{ index: 20, price: 104 }],
    }),
  };

  const found = detectors.detectDouble(ctx, P, 'high');
  assert.ok(found);
  assert.equal(found.type, 'double-top');
  assert.equal(found.direction, 'short');
  assert.equal(found.meta.neckline, 104);
  assert.ok(Math.abs(found.meta.height - 6.15) < 1e-9);

  const pattern = base.create({ type: 'double-top', index: 0, time: 0, seq: 0, meta: found.meta });
  assert.equal(detectors.promote(pattern, mkBar(105), { atr: 2 }, P), null, 'above the neckline: nothing yet');

  const confirmed = detectors.promote(pattern, mkBar(103), { atr: 2 }, P);
  assert.equal(confirmed.direction, 'short');
  assert.ok(Math.abs(confirmed.target - 97.85) < 1e-9, 'height projected below the neckline');
});

test('a double bottom mirrors it', () => {
  const found = detectors.detectDouble(
    {
      atr: 2,
      index: 40,
      bar: mkBar(104),
      pivots: pivotStateWith({
        lows: [{ index: 10, price: 100 }, { index: 30, price: 100.3 }],
        highs: [{ index: 20, price: 106 }],
      }),
    },
    P,
    'low'
  );
  assert.equal(found.type, 'double-bottom');
  assert.equal(found.direction, 'long');
  assert.equal(found.meta.neckline, 106);
});

test('peaks too far apart or at different prices are not a double', () => {
  const make = (highs) =>
    detectors.detectDouble(
      { atr: 2, index: 200, bar: mkBar(106), pivots: pivotStateWith({ highs, lows: [{ index: 20, price: 104 }] }) },
      P,
      'high'
    );

  assert.equal(make([{ index: 10, price: 110 }, { index: 30, price: 114 }]), null, 'prices too far apart');
  assert.equal(make([{ index: 10, price: 110 }, { index: 120, price: 110.2 }]), null, 'separated by too many bars');
  assert.equal(make([{ index: 10, price: 110 }, { index: 13, price: 110.2 }]), null, 'too close together');
});

// ---------------------------------------------------------------------------
// flags
// ---------------------------------------------------------------------------

test('a bull flag needs an impulse, a shallow pullback and fading volume', () => {
  const closes = [
    ...new Array(9).fill(100),
    101.7, 103.4, 105.1, 106.8, 108.5, 110, // impulse
    109.7, 109.4, 109.1, 108.8, 108.5, 108.2, 108, // flag
  ];
  const volumes = [
    ...new Array(9).fill(100),
    ...new Array(6).fill(200),
    ...new Array(7).fill(50),
  ];
  const bars = closes.map((c, i) => mkBar(c, { volume: volumes[i], time: i * 60 }));

  const found = detectors.detectFlag({ atr: 2, index: 21, bar: bars.at(-1), bars }, P);
  assert.ok(found, 'impulse then quiet pullback is a flag');
  assert.equal(found.type, 'bull-flag');
  assert.equal(found.direction, 'long');
  assert.ok(found.meta.impulse >= 4);

  // Same shape, but volume RISING through the pullback: that is distribution.
  const heavy = bars.map((b, i) => (i >= 15 ? { ...b, volume: 400 } : b));
  assert.equal(detectors.detectFlag({ atr: 2, index: 21, bar: heavy.at(-1), bars: heavy }, P), null);
});

test('a pullback deeper than half the impulse is not a flag', () => {
  const closes = [
    ...new Array(9).fill(100),
    101.7, 103.4, 105.1, 106.8, 108.5, 110,
    108, 106, 104, 103, 102.5, 102, 101.8, // gives back most of the move
  ];
  const bars = closes.map((c, i) =>
    mkBar(c, { volume: i >= 15 ? 50 : i >= 9 ? 200 : 100, time: i * 60 })
  );
  assert.equal(detectors.detectFlag({ atr: 2, index: 21, bar: bars.at(-1), bars }, P), null);
});

// ---------------------------------------------------------------------------
// breakout / retest machine
// ---------------------------------------------------------------------------

function zone(low, high, id = 1) {
  return { id, low, high, centre: (low + high) / 2, role: 'inside', strength: 0.5, touches: 3 };
}

test('a break needs distance AND volume', () => {
  const state = breakout.init();
  const z = zone(100, 101);

  // Approach.
  breakout.update(state, mkBar(99.5), { index: 0, atr: 2, zones: [z], relativeVolume: 1 });
  assert.equal(state.machines.get(1).phase, breakout.PHASE.APPROACH);

  // Far enough past the zone, but nobody traded it.
  let out = breakout.update(state, mkBar(102), { index: 1, atr: 2, zones: [z], relativeVolume: 1.0 });
  assert.equal(out.patterns.length, 0, 'drift without participation is not a break');
  assert.equal(state.machines.get(1).phase, breakout.PHASE.APPROACH);

  out = breakout.update(state, mkBar(102), { index: 2, atr: 2, zones: [z], relativeVolume: 2.0 });
  assert.equal(out.patterns.length, 1);
  assert.equal(out.patterns[0].type, 'breakout-retest');
  assert.equal(out.patterns[0].status, base.STATUS.CONFIRMED, 'the break is itself the trigger');
  assert.equal(out.patterns[0].direction, 'long');
  assert.equal(state.machines.get(1).phase, breakout.PHASE.BREAK);
});

test('a break that closes back inside raises a reversal-risk event', () => {
  const state = breakout.init();
  const z = zone(100, 101);

  breakout.update(state, mkBar(99.5), { index: 0, atr: 2, zones: [z], relativeVolume: 1 });
  const broke = breakout.update(state, mkBar(102), { index: 1, atr: 2, zones: [z], relativeVolume: 2 });
  const pattern = broke.patterns[0];

  const out = breakout.update(state, mkBar(100.5), { index: 3, atr: 2, zones: [z], relativeVolume: 1 });

  assert.equal(state.machines.get(1).phase, breakout.PHASE.FAILED);
  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].type, 'failed-break');
  assert.equal(out.events[0].brokeDirection, 'long');
  assert.equal(out.events[0].reversalDirection, 'short', 'the trap is tradeable the other way');
  assert.equal(pattern.status, base.STATUS.FAILED);
});

test('coming back to the zone but holding above it is a retest, not a failure', () => {
  const state = breakout.init();
  const z = zone(100, 101);

  breakout.update(state, mkBar(99.5), { index: 0, atr: 2, zones: [z], relativeVolume: 1 });
  breakout.update(state, mkBar(102), { index: 1, atr: 2, zones: [z], relativeVolume: 2 });

  // Wicks into the band but closes back above it.
  const out = breakout.update(state, mkBar(101.4, { low: 100.9 }), {
    index: 2,
    atr: 2,
    zones: [z],
    relativeVolume: 1,
  });

  assert.equal(state.machines.get(1).phase, breakout.PHASE.RETEST);
  assert.equal(out.events.length, 0);
});

test('running far enough past the zone is continuation', () => {
  const state = breakout.init();
  const z = zone(100, 101);
  breakout.update(state, mkBar(99.5), { index: 0, atr: 2, zones: [z], relativeVolume: 1 });
  breakout.update(state, mkBar(102), { index: 1, atr: 2, zones: [z], relativeVolume: 2 });
  breakout.update(state, mkBar(104), { index: 2, atr: 2, zones: [z], relativeVolume: 1 });
  assert.equal(state.machines.get(1).phase, breakout.PHASE.CONTINUATION);
});

test('a break targets the next zone in its path when there is one', () => {
  const state = breakout.init();
  const z = zone(100, 101);
  const overhead = zone(108, 109, 2);

  breakout.update(state, mkBar(99.5), { index: 0, atr: 2, zones: [z], relativeVolume: 1 });
  const out = breakout.update(state, mkBar(102), {
    index: 1,
    atr: 2,
    zones: [z],
    relativeVolume: 2,
    nextAbove: overhead,
  });
  assert.equal(out.patterns[0].target, 108, 'structure beats an arbitrary ATR multiple');
});

// ---------------------------------------------------------------------------
// the assembled engine
// ---------------------------------------------------------------------------

function runEngine(barCount, seed = 5) {
  let s = seed;
  const next = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };

  const state = patterns.init();
  const structure = require('../structure');
  const structState = structure.init();
  const indicators = require('../indicators');
  const atrState = indicators.atr.init();
  const adxState = indicators.adx.init();
  const bbState = indicators.bollinger.init();
  const volState = indicators.volume.init();
  const e9 = indicators.ema.init({ period: 9 });
  const e21 = indicators.ema.init({ period: 21 });
  const e200 = indicators.ema.init({ period: 200 });

  const views = [];
  let price = 100;

  for (let i = 0; i < barCount; i += 1) {
    const open = price;
    price *= 1 + (next() - 0.5) * 0.02;
    const bar = {
      time: i * 60,
      open,
      high: Math.max(open, price) + next() * 0.5,
      low: Math.min(open, price) - next() * 0.5,
      close: price,
      volume: 50 + next() * 150,
    };

    const atr = indicators.atr.update(atrState, bar);
    const view = structure.update(structState, bar, {
      atr,
      adx: indicators.adx.update(adxState, bar),
      bollinger: indicators.bollinger.update(bbState, bar),
      ema9: indicators.ema.update(e9, bar.close),
      ema21: indicators.ema.update(e21, bar.close),
      ema200: indicators.ema.update(e200, bar.close),
    });
    const vol = indicators.volume.update(volState, bar);

    views.push(
      patterns.snapshot(
        patterns.update(state, bar, {
          atr,
          pivots: view.pivots,
          trendlines: view.trendlines,
          zones: view.zones,
          relativeVolume: vol ? vol.relative : null,
          secondsPerBar: 60,
        })
      )
    );
  }
  return { views, state };
}

test('the pattern engine runs end to end and only emits registered types', () => {
  const { views, state } = runEngine(1500);

  const seen = new Set();
  for (const v of views) {
    for (const pattern of [...v.open, ...v.confirmed, ...v.resolved]) {
      seen.add(pattern.type);
      assert.ok(patterns.TYPES_BY_ID.has(pattern.type), `${pattern.type} is unregistered`);
      assert.ok(
        Object.values(patterns.STATUS).includes(pattern.status),
        `${pattern.status} is not a valid status`
      );
      if (pattern.status === patterns.STATUS.CONFIRMED) {
        assert.notEqual(pattern.target, null, 'a confirmed pattern must carry a target');
        assert.notEqual(pattern.invalidation, null, 'and an invalidation level');
      }
    }
  }
  assert.ok(seen.size >= 3, `expected several pattern types on a random walk, saw ${seen.size}`);
  assert.ok(state.stats.size > 0, 'completion tallies should accumulate');
});

test('at most one pattern of each type is forming at a time', () => {
  const { views } = runEngine(1200);
  for (const v of views) {
    const forming = v.open.filter((p) => p.status === patterns.STATUS.FORMING);
    const byType = new Map();
    for (const p of forming) byType.set(p.type, (byType.get(p.type) || 0) + 1);
    for (const [type, count] of byType) {
      assert.equal(count, 1, `${type} had ${count} forming copies`);
    }
  }
});

test('the pattern engine is deterministic and does not look ahead', () => {
  const a = runEngine(900).views;
  const b = runEngine(900).views;
  assert.deepEqual(a, b, 'same bars in, same patterns out');

  const cut = 600;
  const prefix = runEngine(cut).views;
  assert.deepEqual(prefix, a.slice(0, cut), 'later bars must not rewrite earlier patterns');
});

test('hit rate refuses to quote a number below the sample floor', () => {
  // Rule 5 for patterns: four observations is not a percentage.
  const state = patterns.init();
  const tally = { type: 'range-box', confirmed: 5, target: 3, invalidation: 1, expired: 1 };
  state.stats.set('range-box', tally);

  const thin = patterns.hitRate(state, 'range-box');
  assert.equal(thin.insufficient, true);
  assert.equal(thin.rate, null);
  assert.equal(thin.sample, 4);

  tally.target = 40;
  tally.invalidation = 20;
  const solid = patterns.hitRate(state, 'range-box');
  assert.equal(solid.insufficient, false);
  assert.ok(Math.abs(solid.rate - 40 / 60) < 1e-9);
  assert.equal(solid.sample, 60);
});
