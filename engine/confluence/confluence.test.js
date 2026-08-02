const test = require('node:test');
const assert = require('node:assert/strict');

const confluence = require('./index');
const feed = require('./feed');
const stats = require('../stats');
const pipeline = require('../pipeline');
const config = require('../config');
const ladder = require('../strategies/ladder');

const RESOLVED = config.resolve('Balanced');
const { LEVELS } = confluence;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function mkStrategySignal(direction, score, entry = 100) {
  const built = ladder.build({ direction, entry, sl1: direction === 'long' ? 98 : 102, atr: 2 });
  return {
    direction,
    score,
    entry: built.entry,
    stops: built.stops,
    targets: built.targets,
    r: built.r,
    reasons: [{ id: 'r1', label: 'Test', detail: 'reason', weight: 0 }],
  };
}

function mkCtx(overrides = {}) {
  return {
    symbol: 'BTCUSD',
    timeframe: '5m',
    index: 500,
    bar: { time: 907_200, open: 100, high: 101, low: 99, close: 100, volume: 100 },
    structure: {
      regime: {
        primary: 'TRENDING',
        flags: { trending: true, ranging: false, squeeze: false, volatileExpansion: false },
        rangeQuality: 0,
      },
      trend: { state: 'UP' },
      zones: [],
      trendlines: { resistance: null, support: null },
    },
    patterns: { open: [], confirmed: [], resolved: [], events: [], stats: {} },
    config: RESOLVED,
    ...overrides,
  };
}

const emptyStore = stats.create();

function score(signals, { bias = null, ctx = mkCtx(), store = emptyStore } = {}) {
  return confluence.evaluate({
    signals: signals.map((s, i) => ({ key: `s${i + 1}`, id: `strategy-${i + 1}`, weight: s.weight ?? 1, signal: s.signal })),
    bias,
    ctx,
    store,
  });
}

// ---------------------------------------------------------------------------
// stats — Rule 5
// ---------------------------------------------------------------------------

test('a thin bucket reports insufficient data, never a percentage', () => {
  const store = stats.create();
  for (let i = 0; i < 12; i += 1) {
    stats.record(store, { strategyId: 's1', direction: 'long', regime: 'TRENDING', won: i % 2 === 0, r: 1 });
  }

  const p = stats.lookup(store, { strategyId: 's1', direction: 'long', regime: 'TRENDING' });
  assert.equal(p.insufficient, true);
  assert.equal(p.winRate, null);
  assert.equal(p.sample, 12);
  assert.equal(p.label, 'insufficient data');
});

test('a bucket past the floor reports the measured rate and its sample', () => {
  const store = stats.create();
  for (let i = 0; i < 100; i += 1) {
    stats.record(store, {
      strategyId: 's1',
      direction: 'long',
      regime: 'TRENDING',
      won: i < 58,
      r: i < 58 ? 1 : -1,
    });
  }

  const p = stats.lookup(store, { strategyId: 's1', direction: 'long', regime: 'TRENDING' });
  assert.equal(p.insufficient, false);
  assert.ok(Math.abs(p.winRate - 0.58) < 1e-9);
  assert.equal(p.sample, 100);
  assert.equal(p.label, '58% over 100 trades');
  assert.ok(Math.abs(p.expectancyR - 0.16) < 1e-9);
});

test('buckets are separated by strategy, direction and regime', () => {
  const store = stats.create();
  for (let i = 0; i < 40; i += 1) {
    stats.record(store, { strategyId: 's1', direction: 'long', regime: 'TRENDING', won: true, r: 1 });
    stats.record(store, { strategyId: 's1', direction: 'long', regime: 'RANGING', won: false, r: -1 });
  }
  assert.equal(stats.lookup(store, { strategyId: 's1', direction: 'long', regime: 'TRENDING' }).winRate, 1);
  assert.equal(stats.lookup(store, { strategyId: 's1', direction: 'long', regime: 'RANGING' }).winRate, 0);
  assert.equal(stats.lookup(store, { strategyId: 's1', direction: 'short', regime: 'TRENDING' }).insufficient, true);
});

test('blending never pools thin buckets into a quotable sample', () => {
  // Three 10-trade buckets must not masquerade as one 30-trade measurement.
  const store = stats.create();
  for (const id of ['a', 'b', 'c']) {
    for (let i = 0; i < 10; i += 1) {
      stats.record(store, { strategyId: id, direction: 'long', regime: 'TRENDING', won: true, r: 1 });
    }
  }
  const thin = stats.blend(store, ['a', 'b', 'c'].map((id) => ({ strategyId: id, direction: 'long', regime: 'TRENDING' })));
  assert.equal(thin.insufficient, true);
  assert.equal(thin.winRate, null);

  // Once one bucket clears the floor on its own, only that one is used.
  for (let i = 0; i < 50; i += 1) {
    stats.record(store, { strategyId: 'a', direction: 'long', regime: 'TRENDING', won: i < 30, r: 1 });
  }
  const blended = stats.blend(store, ['a', 'b', 'c'].map((id) => ({ strategyId: id, direction: 'long', regime: 'TRENDING' })));
  assert.equal(blended.insufficient, false);
  assert.equal(blended.sample, 60, 'only the qualifying bucket contributes');
});

// ---------------------------------------------------------------------------
// level mapping
// ---------------------------------------------------------------------------

test('level thresholds map exactly as the spec states', () => {
  const t = RESOLVED.confluence.thresholds; // strong 65, weak 30
  assert.equal(confluence.levelFor(65, t), LEVELS.STRONG_BUY);
  assert.equal(confluence.levelFor(64, t), LEVELS.BUY);
  assert.equal(confluence.levelFor(30, t), LEVELS.BUY);
  assert.equal(confluence.levelFor(29, t), LEVELS.NEUTRAL);
  assert.equal(confluence.levelFor(0, t), LEVELS.NEUTRAL);
  assert.equal(confluence.levelFor(-29, t), LEVELS.NEUTRAL);
  assert.equal(confluence.levelFor(-30, t), LEVELS.SELL);
  assert.equal(confluence.levelFor(-65, t), LEVELS.STRONG_SELL);
});

test('presets move the NEUTRAL band', () => {
  const aggressive = config.resolve('Aggressive').confluence.thresholds;
  const conservative = config.resolve('Conservative').confluence.thresholds;

  // A score of 25 is noise on Conservative, a BUY on Aggressive. That is the
  // single biggest lever on cadence.
  assert.equal(confluence.levelFor(25, conservative), LEVELS.NEUTRAL);
  assert.equal(confluence.levelFor(25, aggressive), LEVELS.BUY);
});

// ---------------------------------------------------------------------------
// scoring
// ---------------------------------------------------------------------------

test('one strategy is a BUY; two agreeing make it STRONG', () => {
  const lone = score([{ signal: mkStrategySignal('long', 55) }]);
  assert.equal(lone.level, LEVELS.BUY);
  assert.equal(lone.breakdown.agreement, 1);
  assert.equal(lone.breakdown.confluenceBoost, 1);

  const pair = score([
    { signal: mkStrategySignal('long', 55) },
    { signal: mkStrategySignal('long', 55) },
  ]);
  assert.equal(pair.level, LEVELS.STRONG_BUY);
  assert.equal(pair.breakdown.agreement, 2);
  assert.ok(pair.score > lone.score, 'independent confirmation must count for more');
});

test('strategies pointing opposite ways cancel to NEUTRAL', () => {
  const conflicted = score([
    { signal: mkStrategySignal('long', 55) },
    { signal: mkStrategySignal('short', 55) },
  ]);
  assert.equal(conflicted.level, LEVELS.NEUTRAL);
  assert.equal(conflicted.actionable, false);
});

test('an opposing higher-timeframe bias crushes a signal toward NEUTRAL', () => {
  // The spec's own example: a 5m long against a -80 4h downtrend.
  const withoutBias = score([{ signal: mkStrategySignal('long', 55) }]);
  assert.equal(withoutBias.level, LEVELS.BUY);

  const against = score([{ signal: mkStrategySignal('long', 55) }], { bias: { score: -80, reasons: [] } });
  assert.equal(against.level, LEVELS.NEUTRAL);
  assert.ok(against.breakdown.biasMultiplier < 0.6);

  const with_ = score([{ signal: mkStrategySignal('long', 55) }], { bias: { score: 80, reasons: [] } });
  assert.ok(with_.score > withoutBias.score);
  assert.ok(
    with_.breakdown.biasMultiplier - 1 < 1 - against.breakdown.biasMultiplier,
    'alignment should help less than opposition hurts'
  );
});

test('a strong pair fighting the bias drops a level rather than surviving intact', () => {
  const clean = score([
    { signal: mkStrategySignal('long', 55) },
    { signal: mkStrategySignal('long', 55) },
  ]);
  assert.equal(clean.level, LEVELS.STRONG_BUY);

  const fighting = score(
    [{ signal: mkStrategySignal('long', 55) }, { signal: mkStrategySignal('long', 55) }],
    { bias: { score: -80, reasons: [] } }
  );
  assert.equal(fighting.level, LEVELS.BUY);
});

test('regime penalty scales the result', () => {
  const ctx = mkCtx();
  ctx.structure.regime.primary = 'VOLATILE_EXPANSION';
  const penalised = score([{ signal: mkStrategySignal('long', 55) }], { ctx });
  assert.equal(penalised.breakdown.regimePenalty, 0.8);
  assert.ok(penalised.score < 55);
});

test('pattern context rewards agreement and punishes an obstacle', () => {
  const agreeing = mkCtx();
  agreeing.patterns.open = [
    { id: 'p1', type: 'breakout-retest', status: 'confirmed', direction: 'long', target: 110, meta: { phase: 'retest' } },
  ];
  const boosted = score([{ signal: mkStrategySignal('long', 55) }], { ctx: agreeing });
  assert.ok(boosted.breakdown.patternContext > 1);
  assert.ok(boosted.breakdown.patternNotes.some((n) => n.label === 'Pattern agrees'));

  const opposing = mkCtx();
  opposing.patterns.open = [
    { id: 'p2', type: 'descending-triangle', status: 'confirmed', direction: 'short', target: 90, meta: {} },
  ];
  const penalised = score([{ signal: mkStrategySignal('long', 55) }], { ctx: opposing });
  assert.ok(penalised.breakdown.patternContext < 1);
});

test('a failed break boosts the snap-back direction', () => {
  const ctx = mkCtx();
  ctx.patterns.events = [
    { type: 'failed-break', zoneId: 1, brokeDirection: 'long', reversalDirection: 'short', index: 500, time: 907_200 },
  ];
  const out = score([{ signal: mkStrategySignal('short', 55) }], { ctx });
  assert.ok(out.breakdown.patternContext > 1);
  assert.ok(out.breakdown.patternNotes.some((n) => n.label === 'Failed break'));
});

// ---------------------------------------------------------------------------
// the SignalEvent
// ---------------------------------------------------------------------------

test('the dominant strategy owns the ladder, and it is re-validated', () => {
  const weak = { key: 's6', id: 'strategy-weak', weight: 0.6, signal: mkStrategySignal('long', 40, 100) };
  const strong = { key: 's1', id: 'strategy-strong', weight: 1.0, signal: mkStrategySignal('long', 70, 100) };

  const event = confluence.evaluate({ signals: [weak, strong], bias: null, ctx: mkCtx(), store: emptyStore });

  assert.equal(event.strategies.find((s) => s.key === 's1').dominant, true);
  assert.equal(event.strategies.find((s) => s.key === 's6').dominant, false);
  assert.deepEqual(event.stops, strong.signal.stops);
  assert.equal(ladder.validate('long', event.entry, event.stops, event.targets).ok, true);
});

test('a malformed ladder is dropped rather than shipped', () => {
  const broken = {
    key: 's1',
    id: 'strategy-1',
    weight: 1,
    signal: { direction: 'long', score: 70, entry: 100, stops: [101, 102, 103], targets: [99, 98, 97], r: 1, reasons: [] },
  };
  const event = confluence.evaluate({ signals: [broken], bias: null, ctx: mkCtx(), store: emptyStore });
  assert.equal(event.stops, null, 'crossed levels must not reach the chart or the backtester');
});

test('a SignalEvent carries its evidence, breakdown and honest probability', () => {
  const store = stats.create();
  for (let i = 0; i < 80; i += 1) {
    stats.record(store, { strategyId: 'strategy-1', direction: 'long', regime: 'TRENDING', won: i < 46, r: 1 });
  }

  const event = score([{ signal: mkStrategySignal('long', 55) }], { store });

  assert.equal(event.probability.insufficient, false);
  assert.equal(event.probability.sample, 80);
  assert.match(event.probability.label, /% over 80 trades/);

  assert.ok(event.strategies[0].reasons.length > 0);
  assert.equal(event.regime, 'TRENDING');
  assert.equal(event.trend, 'UP');
  assert.ok('adjusted' in event.breakdown && 'raw' in event.breakdown);
});

test('event ids are deterministic and derived from bar time, not the clock', () => {
  const a = score([{ signal: mkStrategySignal('long', 55) }]);
  const b = score([{ signal: mkStrategySignal('long', 55) }]);
  assert.equal(a.id, b.id);
  assert.equal(a.id, 'BTCUSD:5m:907200');
  assert.equal(a.barTime, 907_200);

  const provisional = confluence.evaluate({
    signals: [{ key: 's1', id: 'strategy-1', weight: 1, signal: mkStrategySignal('long', 55) }],
    bias: null,
    ctx: mkCtx(),
    store: emptyStore,
    provisional: true,
  });
  assert.equal(provisional.provisional, true);
  assert.notEqual(provisional.id, a.id, 'a provisional event must not collide with the confirmed one');
});

// ---------------------------------------------------------------------------
// signal feed
// ---------------------------------------------------------------------------

test('the feed takes confirmed actionable signals only', () => {
  const f = feed.create({ capacity: 5 });

  assert.equal(feed.add(f, score([{ signal: mkStrategySignal('long', 55) }])), true);
  assert.equal(
    feed.add(f, score([{ signal: mkStrategySignal('long', 55) }, { signal: mkStrategySignal('short', 55) }])),
    false,
    'NEUTRAL is context, not a feed entry'
  );

  const provisional = confluence.evaluate({
    signals: [{ key: 's1', id: 'strategy-1', weight: 1, signal: mkStrategySignal('long', 55) }],
    bias: null,
    ctx: mkCtx(),
    store: emptyStore,
    provisional: true,
  });
  assert.equal(feed.add(f, provisional), false, 'a provisional signal must never be persisted');
  assert.equal(f.items.length, 1);
});

test('the feed dedupes, bounds and filters', () => {
  const f = feed.create({ capacity: 3 });
  const event = score([{ signal: mkStrategySignal('long', 55) }]);

  assert.equal(feed.add(f, event), true);
  assert.equal(feed.add(f, event), false, 'a re-emitted bar close must not double-post');

  for (let i = 1; i <= 5; i += 1) {
    const ctx = mkCtx({ bar: { time: 907_200 + i * 300, open: 100, high: 101, low: 99, close: 100, volume: 100 } });
    feed.add(f, score([{ signal: mkStrategySignal('long', 55) }], { ctx }));
  }
  assert.equal(f.items.length, 3, 'capacity is respected');
  assert.equal(f.seen.size, 3, 'the dedupe set is trimmed with it');
  assert.ok(f.items[0].barTime > f.items[1].barTime, 'newest first');

  assert.equal(feed.list(f, { levels: ['STRONG_BUY'] }).length, 0);
  assert.equal(feed.list(f, { symbol: 'BTCUSD' }).length, 3);
  assert.equal(feed.list(f, { symbol: 'ETHUSD' }).length, 0);
  assert.equal(feed.list(f, { limit: 2 }).length, 2);
});

test('a feed row carries what the panel renders', () => {
  const row = feed.compact(score([{ signal: mkStrategySignal('long', 55) }]));
  assert.equal(row.symbol, 'BTCUSD');
  assert.equal(row.timeframe, '5m');
  assert.equal(row.level, LEVELS.BUY);
  assert.equal(row.stops.length, 3);
  assert.equal(row.targets.length, 3);
  assert.match(row.topReason, /Test: reason/);
});

// ---------------------------------------------------------------------------
// the assembled pipeline
// ---------------------------------------------------------------------------

function syntheticBars(count, seed = 21) {
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
    out.push({
      time: 1_700_000_000 + i * 300,
      open,
      high: Math.max(open, price) + next() * 0.4,
      low: Math.min(open, price) - next() * 0.4,
      close: price,
      volume: 50 + next() * 200,
    });
  }
  return out;
}

function runPipeline(bars) {
  const state = pipeline.createAnalyzer({ symbol: 'BTCUSD', timeframe: '5m', config: RESOLVED });
  const store = stats.create();
  const events = [];
  for (const bar of bars) {
    const out = pipeline.update(state, bar, { store });
    if (out.event) events.push(out.event);
  }
  return events;
}

test('the pipeline runs end to end and produces well-formed events', () => {
  const events = runPipeline(syntheticBars(1200));
  assert.ok(events.length > 0, 'the engine should say something over 1200 bars');

  for (const event of events) {
    assert.ok(Object.values(LEVELS).includes(event.level));
    assert.ok(event.score >= -100 && event.score <= 100);
    assert.equal(event.symbol, 'BTCUSD');
    assert.ok(event.strategies.length > 0);

    if (event.actionable && event.stops) {
      assert.equal(
        ladder.validate(event.direction, event.entry, event.stops, event.targets).ok,
        true,
        'every actionable signal ships a valid six-level ladder'
      );
    }
    // Rule 5: with an empty store nothing may claim a probability.
    assert.equal(event.probability.insufficient, true);
    assert.equal(event.probability.winRate, null);
  }
});

test('the pipeline is deterministic and does not look ahead', () => {
  const bars = syntheticBars(1000);

  const a = runPipeline(bars);
  const b = runPipeline(bars);
  assert.deepEqual(a, b, 'same bars in, same signals out');

  const cut = 700;
  const prefix = runPipeline(bars.slice(0, cut));
  const expected = a.filter((e) => e.barIndex < cut);
  assert.deepEqual(prefix, expected, 'truncating the future must not change the past');
});

test('a bias snapshot names the bar it describes', () => {
  // Phase 7 has to align timeframes without leaking a future higher-timeframe
  // bar into a lower-timeframe decision; the snapshot carries barTime so that
  // alignment is checkable rather than assumed.
  const state = pipeline.createAnalyzer({ symbol: 'BTCUSD', timeframe: '1h', config: RESOLVED });
  assert.equal(pipeline.biasOf(state), null, 'nothing to describe before the first bar');

  const bars = syntheticBars(30);
  for (const bar of bars) pipeline.update(state, bar, {});

  const snapshot = pipeline.biasOf(state);
  assert.equal(snapshot.barTime, bars.at(-1).time);
  assert.equal(snapshot.close, bars.at(-1).close);
  assert.ok('trend' in snapshot && 'regime' in snapshot && 'supertrend' in snapshot);
});
