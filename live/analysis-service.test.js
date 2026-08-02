const test = require('node:test');
const assert = require('node:assert/strict');

const service = require('./analysis-service');
const config = require('../engine/config');
const qualification = require('../engine/qualification');
const stats = require('../engine/stats');

const RESOLVED = config.resolve('Balanced');

function bars(count, seed = 17, step = 300, startPrice = 100) {
  let s = seed;
  const next = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const out = [];
  let price = startPrice;
  for (let i = 0; i < count; i += 1) {
    const open = price;
    price *= 1 + (next() - 0.5) * 0.02;
    out.push({
      time: 1_700_000_000 + i * step,
      open,
      high: Math.max(open, price) + next() * 0.4,
      low: Math.min(open, price) - next() * 0.4,
      close: price,
      volume: 50 + next() * 200,
    });
  }
  return out;
}

function mkService(overrides = {}) {
  const published = [];
  const svc = service.create({
    config: RESOLVED,
    store: stats.create(),
    gate: overrides.gate || qualification.create(),
    publish: (msg) => published.push(msg),
  });
  return { svc, published };
}

// ---------------------------------------------------------------------------
// diffing
// ---------------------------------------------------------------------------

const snapshot = (over = {}) => ({
  symbol: 'BTCUSD',
  timeframe: '5m',
  barTime: 1000,
  zones: [],
  trendlines: [],
  patterns: [],
  candles: [],
  trend: 'RANGE',
  regime: 'TRENDING',
  events: [],
  ...over,
});

test('the first diff is a full snapshot', () => {
  const diff = service.diffSnapshots(null, snapshot());
  assert.ok(diff.full, 'a client with no state needs everything, not a delta');
});

test('an unchanged snapshot produces no diff', () => {
  const a = snapshot({ zones: [{ id: 1, low: 1, high: 2 }] });
  const b = snapshot({ zones: [{ id: 1, low: 1, high: 2 }] });
  assert.equal(service.diffSnapshots(a, b), null, 'nothing changed, so nothing is sent');
});

test('diffs carry only what moved, by id', () => {
  const before = snapshot({
    zones: [
      { id: 1, low: 1, high: 2 },
      { id: 2, low: 5, high: 6 },
    ],
  });
  const after = snapshot({
    zones: [
      { id: 1, low: 1, high: 2 }, // unchanged
      { id: 3, low: 9, high: 10 }, // added; id 2 removed
    ],
  });

  const diff = service.diffSnapshots(before, after);
  assert.deepEqual(diff.zones.upserted, [{ id: 3, low: 9, high: 10 }]);
  assert.deepEqual(diff.zones.removed, [2]);
});

test('a mutated item is re-sent under its own id', () => {
  const before = snapshot({ zones: [{ id: 1, low: 1, high: 2, touches: 3 }] });
  const after = snapshot({ zones: [{ id: 1, low: 1, high: 2, touches: 4 }] });
  assert.deepEqual(service.diffSnapshots(before, after).zones.upserted, [
    { id: 1, low: 1, high: 2, touches: 4 },
  ]);
});

test('trend and regime are sent only when they change', () => {
  const before = snapshot({ trend: 'UP', regime: 'TRENDING' });
  const same = service.diffSnapshots(before, snapshot({ trend: 'UP', regime: 'TRENDING' }));
  assert.equal(same, null);

  const changed = service.diffSnapshots(before, snapshot({ trend: 'DOWN', regime: 'RANGING' }));
  assert.equal(changed.trend, 'DOWN');
  assert.equal(changed.regime, 'RANGING');
});

// ---------------------------------------------------------------------------
// bar handling
// ---------------------------------------------------------------------------

test('replaying the same closed bar is a no-op', () => {
  // A reconnect can redeliver a close. Counting it twice would double-post to
  // the feed and double-count the live stats.
  const { svc } = mkService();
  const series = bars(300);
  service.warmup(svc, 'BTCUSD', '5m', series);

  const nextBar = { ...series.at(-1), time: series.at(-1).time + 300 };
  const first = service.onBarClosed(svc, 'BTCUSD', '5m', nextBar);
  const second = service.onBarClosed(svc, 'BTCUSD', '5m', nextBar);

  assert.notEqual(first.diff, undefined);
  assert.equal(second.event, null);
  assert.equal(second.diff, null);
});

test('an out-of-order bar is rejected', () => {
  const { svc } = mkService();
  const series = bars(300);
  service.warmup(svc, 'BTCUSD', '5m', series);

  const stale = { ...series.at(-5) };
  assert.deepEqual(service.onBarClosed(svc, 'BTCUSD', '5m', stale), { event: null, diff: null });
});

test('warmup leaves the analyzer able to produce structure', () => {
  const { svc } = mkService();
  service.warmup(svc, 'BTCUSD', '5m', bars(400));

  const entry = service.analyzerFor(svc, 'BTCUSD', '5m');
  assert.equal(entry.warmed, true);
  assert.ok(entry.lastBarTime !== null);
});

test('a short history leaves the analyzer marked unwarmed', () => {
  // 50 bars cannot have warmed a 200-EMA. Signals from it must not be counted,
  // and the flag is what stops them being fed into the live stats.
  const { svc } = mkService();
  service.warmup(svc, 'BTCUSD', '5m', bars(50));
  assert.equal(service.analyzerFor(svc, 'BTCUSD', '5m').warmed, false);
});

// ---------------------------------------------------------------------------
// Rule 7 at the point of emission
// ---------------------------------------------------------------------------

test('an unqualified config never emits an actionable signal', () => {
  // The gate is empty, so nothing is qualified — which is the real state after
  // the seed run. Any actionable signal reaching a client here would be a
  // strategy shipping live on no evidence.
  const { svc, published } = mkService();
  const series = bars(600);
  service.warmup(svc, 'BTCUSD', '5m', series.slice(0, 400));

  for (const bar of series.slice(400)) {
    service.onBarClosed(svc, 'BTCUSD', '5m', bar);
  }

  const signals = published.filter((m) => m.t === 'signal');
  assert.ok(signals.length > 0, 'the engine should still be producing context');
  for (const msg of signals) {
    assert.equal(msg.signal.actionable, false);
    if (msg.signal.suppressed) {
      assert.ok(msg.signal.suppressedReason.length > 0, 'suppression must explain itself');
    }
  }
  assert.equal(svc.feed.items.length, 0, 'nothing unqualified reaches the feed');
});

test('a qualified config is allowed through to the feed', () => {
  const gate = qualification.create();
  qualification.record(
    gate,
    { symbol: 'BTCUSD', timeframe: '5m', preset: 'Balanced', strategyId: null },
    { trades: 200, profitFactor: 1.6, expectancyR: 0.2, winRate: 0.55 },
    RESOLVED.backtest.qualification
  );

  const { svc } = mkService({ gate });
  const series = bars(700, 31);
  service.warmup(svc, 'BTCUSD', '5m', series.slice(0, 400));
  for (const bar of series.slice(400)) service.onBarClosed(svc, 'BTCUSD', '5m', bar);

  assert.ok(svc.feed.items.length > 0, 'a qualified config should reach the feed');
  for (const row of svc.feed.items) {
    assert.ok(['STRONG_BUY', 'BUY', 'SELL', 'STRONG_SELL'].includes(row.level));
  }
});

// ---------------------------------------------------------------------------
// live outcome tracking
// ---------------------------------------------------------------------------

test('live outcomes accumulate separately from the backtest store', () => {
  // Merging them would hide the divergence between measured and realised
  // performance, which is the overfitting alarm the spec asks for.
  const { svc } = mkService();
  stats.record(svc.store, { strategyId: 's1', direction: 'long', regime: 'TRENDING', won: true, r: 1 });

  assert.equal(Object.keys(svc.liveStats.buckets).length, 0);
  assert.notEqual(Object.keys(svc.store.buckets).length, 0);

  const gap = service.divergence(svc, { strategyId: 's1', direction: 'long', regime: 'TRENDING' });
  assert.equal(gap.backtest.insufficient, true, 'one trade is not a measurement');
  assert.equal(gap.live.insufficient, true);
  assert.equal(gap.gap, null, 'no gap can be quoted from insufficient samples');
});

test('a tracked position resolves into the live store', () => {
  const { svc, published } = mkService();
  svc.open.set('BTCUSD', [
    {
      id: 'sig-1',
      symbol: 'BTCUSD',
      timeframe: '5m',
      direction: 'long',
      entryPrice: 100,
      entryTime: 1_700_000_000,
      stops: [98, 97, 96],
      targets: [102, 104, 106],
      strategyId: 's1-ema-pullback',
      regime: 'TRENDING',
      status: 'active',
    },
  ]);

  // A bar that touches both the stop and TP3 must resolve as a LOSS, matching
  // the backtester's pessimistic rule.
  service.onBarClosed(svc, 'BTCUSD', '5m', {
    time: 1_700_000_300,
    open: 100,
    high: 107,
    low: 97,
    close: 100,
    volume: 100,
  });

  const outcome = published.find((m) => m.t === 'outcome');
  assert.ok(outcome);
  assert.equal(outcome.outcome, 'lost');
  assert.equal(svc.liveStats.buckets['s1-ema-pullback|long|TRENDING'].losses, 1);
});

test('a subscribe snapshot is a full payload, not a delta', () => {
  const { svc } = mkService();
  service.warmup(svc, 'BTCUSD', '5m', bars(400));
  service.onBarClosed(svc, 'BTCUSD', '5m', {
    time: 1_700_000_000 + 400 * 300,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 100,
  });

  const snap = service.snapshotFor(svc, 'BTCUSD', '5m');
  assert.equal(snap.t, 'analysis');
  assert.ok(snap.diff.full, 'a joining client must receive full state before diffs');
  assert.equal(snap.diff.full.symbol, 'BTCUSD');
});
