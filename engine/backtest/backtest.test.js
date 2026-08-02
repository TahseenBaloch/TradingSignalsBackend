const test = require('node:test');
const assert = require('node:assert/strict');

const backtest = require('./index');
const simulator = require('./simulator');
const metrics = require('./metrics');
const config = require('../config');

const RESOLVED = config.resolve('Balanced');
const COSTS = RESOLVED.costs;
const PLAN = RESOLVED.backtest.ladderPlan;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function mkEvent(overrides = {}) {
  return {
    id: 'BTCUSD:5m:1000',
    symbol: 'BTCUSD',
    timeframe: '5m',
    barTime: 1000,
    direction: 'long',
    level: 'BUY',
    score: 45,
    regime: 'TRENDING',
    stops: [98, 97, 96],
    targets: [102, 104, 106],
    strategies: [{ id: 'strategy-1', dominant: true }],
    ...overrides,
  };
}

const mkBar = (time, open, high, low, close, volume = 100) => ({ time, open, high, low, close, volume });

function ladderOptions(variant = 'ladder') {
  return { ...simulator.DEFAULTS, variant };
}

/** 1m bars, then honestly aggregated into the higher timeframes. */
function multiTimeframeSeries(minutes, seed = 33) {
  let s = seed;
  const next = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };

  const base = [];
  let price = 100;
  const start = 1_700_000_000 - (1_700_000_000 % 3600);

  for (let i = 0; i < minutes; i += 1) {
    const open = price;
    price *= 1 + (next() - 0.5) * 0.004;
    base.push(
      mkBar(
        start + i * 60,
        open,
        Math.max(open, price) + next() * 0.05,
        Math.min(open, price) - next() * 0.05,
        price,
        50 + next() * 200
      )
    );
  }

  const aggregate = (bars, factor, seconds) => {
    const out = [];
    for (let i = 0; i + factor <= bars.length; i += factor) {
      const chunk = bars.slice(i, i + factor);
      // Align the aggregated bar to its own boundary, as the exchange would.
      if (chunk[0].time % seconds !== 0) continue;
      out.push({
        time: chunk[0].time,
        open: chunk[0].open,
        high: Math.max(...chunk.map((b) => b.high)),
        low: Math.min(...chunk.map((b) => b.low)),
        close: chunk.at(-1).close,
        volume: chunk.reduce((sum, b) => sum + b.volume, 0),
      });
    }
    return out;
  };

  return {
    '1m': base,
    '5m': aggregate(base, 5, 300),
    '15m': aggregate(base, 15, 900),
    '1h': aggregate(base, 60, 3600),
  };
}

// ---------------------------------------------------------------------------
// entry mechanics
// ---------------------------------------------------------------------------

test('entries fill at the NEXT bar open plus slippage, never at the signal close', () => {
  const trade = simulator.open(mkEvent(), mkBar(1300, 100, 101, 99, 100.5), COSTS, ladderOptions());

  // slippage = max(100 * 0.0002, one 0.01 tick) = 0.02
  assert.ok(Math.abs(trade.entryPrice - 100.02) < 1e-9);
  assert.ok(Math.abs(trade.rPrice - 2.02) < 1e-9, 'R is measured from the FILL, not the signal');
  assert.ok(Math.abs(trade.size - 1 / 2.02) < 1e-9, 'sized so SL1 costs exactly 1R');
  assert.ok(trade.costR > 0, 'the entry fee is charged immediately');
});

test('a gap straight through SL1 is skipped rather than invented', () => {
  // The next bar opens below the stop: there is no risk distance to size
  // against, and manufacturing one would create a trade nobody could have taken.
  const trade = simulator.open(mkEvent(), mkBar(1300, 97, 98, 96, 97.5), COSTS, ladderOptions());
  assert.equal(trade, null);
});

test('shorts mirror exactly', () => {
  const event = mkEvent({ direction: 'short', stops: [102, 103, 104], targets: [98, 96, 94] });
  const trade = simulator.open(event, mkBar(1300, 100, 101, 99, 100.5), COSTS, ladderOptions());
  assert.ok(Math.abs(trade.entryPrice - 99.98) < 1e-9, 'slippage works against a short too');
  assert.ok(Math.abs(trade.rPrice - 2.02) < 1e-9);
});

// ---------------------------------------------------------------------------
// exits
// ---------------------------------------------------------------------------

test('a bar touching both the stop and a target counts as the stop', () => {
  // The pessimistic branch is the only honest one: OHLC does not record
  // intrabar order. It also has to match how Phase 4 resolves pattern outcomes.
  const trade = simulator.open(mkEvent(), mkBar(1300, 100, 100.1, 99.9, 100), COSTS, ladderOptions());
  simulator.step(trade, mkBar(1600, 100, 103, 97, 101), COSTS, PLAN, ladderOptions());
  simulator.settle(trade);

  assert.equal(trade.open, false);
  assert.equal(trade.outcome, simulator.OUTCOMES.STOP);
  assert.ok(trade.netR < 0);
});

test('the ladder scales out and trails the stop behind each fill', () => {
  const options = ladderOptions();
  const trade = simulator.open(mkEvent(), mkBar(1300, 100, 100.1, 99.9, 100), COSTS, options);

  // TP1 only.
  simulator.step(trade, mkBar(1600, 100.5, 102.5, 100.2, 102.2), COSTS, PLAN, options);
  assert.equal(trade.filled.tp1, true);
  assert.ok(Math.abs(trade.remaining - 0.5) < 1e-9, 'half the position is out');
  assert.equal(trade.activeStop, trade.entryPrice, 'stop moved to breakeven');

  // TP2 next.
  simulator.step(trade, mkBar(1900, 102.2, 104.5, 102, 104.2), COSTS, PLAN, options);
  assert.equal(trade.filled.tp2, true);
  assert.ok(Math.abs(trade.remaining - 0.2) < 1e-9);
  assert.equal(trade.activeStop, trade.targets[0], 'stop trails to TP1');

  // TP3 closes it.
  simulator.step(trade, mkBar(2200, 104.2, 106.5, 104, 106.2), COSTS, PLAN, options);
  simulator.settle(trade);
  assert.equal(trade.open, false);
  assert.equal(trade.remaining <= 1e-9, true);
  assert.equal(trade.fills.length, 3, 'three partial fills');
  assert.ok(trade.netR > 1.5);
});

test('every partial fill is charged a fee', () => {
  const options = ladderOptions();
  const trade = simulator.open(mkEvent(), mkBar(1300, 100, 100.1, 99.9, 100), COSTS, options);
  const afterEntry = trade.costR;

  simulator.step(trade, mkBar(1600, 100.5, 102.5, 100.2, 102.2), COSTS, PLAN, options);
  const afterTp1 = trade.costR;
  simulator.step(trade, mkBar(1900, 102.2, 104.5, 102, 104.2), COSTS, PLAN, options);

  assert.ok(afterTp1 > afterEntry, 'TP1 partial pays a fee');
  assert.ok(trade.costR > afterTp1, 'so does TP2');
  assert.equal(trade.fills.every((f) => f.feeR > 0), true);
});

test('the simple variant takes the whole position at TP1', () => {
  const options = ladderOptions('simple');
  const trade = simulator.open(mkEvent(), mkBar(1300, 100, 100.1, 99.9, 100), COSTS, options);
  simulator.step(trade, mkBar(1600, 100.5, 102.5, 100.2, 102.2), COSTS, PLAN, options);
  simulator.settle(trade);

  assert.equal(trade.open, false);
  assert.equal(trade.fills.length, 1);
  // Filled 0.02 above the signal entry, so a "1R" target returns slightly under
  // 1R gross, then costs come off. Both are honest, and neither is rounded away.
  assert.ok(trade.grossR < 1 && trade.grossR > 0.97);
  assert.ok(trade.netR < trade.grossR);
});

test('a trade that never resolves is expired into the metrics, not dropped', () => {
  const options = { ...ladderOptions(), maxBarsHeld: 3 };
  const trade = simulator.open(mkEvent(), mkBar(1300, 100, 100.1, 99.9, 100), COSTS, options);
  for (let i = 0; i < 3; i += 1) {
    simulator.step(trade, mkBar(1600 + i * 300, 100, 100.5, 99.5, 100), COSTS, PLAN, options);
  }
  simulator.settle(trade);
  assert.equal(trade.open, false);
  assert.equal(trade.outcome, simulator.OUTCOMES.EXPIRED);
});

test('a win is decided on the NET result', () => {
  // A trade that reaches its target and hands the whole gain back in fees is
  // not a win. Counting it as one is how a flattering win rate hides a losing
  // system.
  const expensive = { ...COSTS, takerFeeRate: 0.02 };
  const options = ladderOptions('simple');
  const trade = simulator.open(mkEvent(), mkBar(1300, 100, 100.1, 99.9, 100), expensive, options);
  simulator.step(trade, mkBar(1600, 100.5, 102.5, 100.2, 102.2), expensive, PLAN, options);
  simulator.settle(trade);

  assert.ok(trade.grossR > 0, 'the target was reached');
  assert.ok(trade.netR < 0, 'but the fees ate it');
  assert.equal(trade.won, false);
});

test('cost drag scales inversely with stop distance', () => {
  // This is the arithmetic behind the 1m viability problem: with a fixed
  // percentage fee, the tighter the stop, the more of R the round trip costs.
  const measure = (sl1) => {
    const options = ladderOptions('simple');
    const event = mkEvent({ stops: [sl1, sl1 - 1, sl1 - 2], targets: [100 + (100 - sl1), 104, 106] });
    const trade = simulator.open(event, mkBar(1300, 100, 100.1, 99.9, 100), COSTS, options);
    simulator.step(trade, mkBar(1600, 100.5, 110, 100.2, 109), COSTS, PLAN, options);
    simulator.settle(trade);
    return trade.costR;
  };

  const wideStop = measure(90); // 10% stop
  const tightStop = measure(99.5); // 0.5% stop

  assert.ok(tightStop > wideStop * 5, 'a tighter stop pays far more cost per unit of risk');
  assert.ok(tightStop > 0.3, 'a 0.5% stop already costs a third of R in fees alone');
});

// ---------------------------------------------------------------------------
// metrics
// ---------------------------------------------------------------------------

test('metrics summarise net results and surface cost drag separately', () => {
  const trades = [
    { netR: 2, grossR: 2.2, costR: 0.2, won: true, barsHeld: 10, exitTime: 1, outcome: 'tp2' },
    { netR: -1, grossR: -0.8, costR: 0.2, won: false, barsHeld: 5, exitTime: 2, outcome: 'stop' },
    { netR: 1, grossR: 1.2, costR: 0.2, won: true, barsHeld: 8, exitTime: 3, outcome: 'tp1' },
    { netR: -1, grossR: -0.8, costR: 0.2, won: false, barsHeld: 4, exitTime: 4, outcome: 'stop' },
  ];

  const m = metrics.summarise(trades, { spanSeconds: 4 * 86_400, signals: 10 });

  assert.equal(m.trades, 4);
  assert.equal(m.winRate, 0.5);
  assert.equal(m.profitFactor, 3 / 2);
  assert.ok(Math.abs(m.expectancyR - 0.25) < 1e-9);
  assert.ok(Math.abs(m.totalCostR - 0.8) < 1e-9);
  assert.equal(m.maxDrawdownR, 1, 'peak 2 down to 1');
  assert.equal(m.tradesPerDay, 1);
  assert.equal(m.signalsPerDay, 2.5);
  assert.deepEqual(m.outcomes, { tp2: 1, stop: 2, tp1: 1 });
});

test('profit factor is null rather than Infinity when nothing lost', () => {
  const m = metrics.summarise([
    { netR: 1, grossR: 1, costR: 0, won: true, barsHeld: 1, exitTime: 1, outcome: 'tp1' },
  ]);
  assert.equal(m.profitFactor, null, 'an infinite profit factor over one trade is not a result');
});

test('Rule 7 qualification needs both the sample and the profit factor', () => {
  const rule = RESOLVED.backtest.qualification; // PF >= 1.2, >= 50 trades

  assert.equal(metrics.qualifies({ trades: 80, profitFactor: 1.4 }, rule).ok, true);

  const thin = metrics.qualifies({ trades: 20, profitFactor: 3 }, rule);
  assert.equal(thin.ok, false);
  assert.match(thin.reasons[0], /only 20 trades/);

  const weak = metrics.qualifies({ trades: 200, profitFactor: 1.05 }, rule);
  assert.equal(weak.ok, false);
  assert.match(weak.reasons[0], /profit factor 1.05/);

  const none = metrics.qualifies({ trades: 200, profitFactor: null }, rule);
  assert.equal(none.ok, false);
});

// ---------------------------------------------------------------------------
// timeframe alignment — the easiest place to leak lookahead
// ---------------------------------------------------------------------------

test('the merged stream orders by close time, longer timeframes first on ties', () => {
  const series = {
    '5m': [mkBar(0, 1, 1, 1, 1), mkBar(300, 1, 1, 1, 1)],
    '15m': [mkBar(0, 1, 1, 1, 1)],
  };
  const merged = backtest.mergeStreams(series, RESOLVED.timeframes.seconds);

  // Labels are timeframe@closeTime: the 5m bars opening at 0 and 300 close at
  // 300 and 600, and the 15m bar opening at 0 only closes at 900 — so it is
  // ordered last despite opening first.
  assert.deepEqual(
    merged.map((e) => `${e.timeframe}@${e.closeTime}`),
    ['5m@300', '5m@600', '15m@900']
  );

  // A 15m and a 5m bar closing at the same instant: the 15m must come first,
  // because it genuinely is known to the 5m decision at that moment.
  const tie = backtest.mergeStreams(
    { '5m': [mkBar(600, 1, 1, 1, 1)], '15m': [mkBar(0, 1, 1, 1, 1)] },
    RESOLVED.timeframes.seconds
  );
  assert.deepEqual(tie.map((e) => e.timeframe), ['15m', '5m']);
});

test('a real run reads no bias from a bar that has not closed', () => {
  const report = backtest.run({
    symbol: 'BTCUSD',
    series: multiTimeframeSeries(4000),
    entryTimeframes: ['5m'],
    config: RESOLVED,
  });
  assert.equal(report.alignmentViolations, 0, 'any violation is lookahead');
});

// ---------------------------------------------------------------------------
// the properties the spec demands
// ---------------------------------------------------------------------------

test('the backtest does not look ahead: truncating the tail preserves the past', () => {
  // The spec's explicit no-lookahead test. Feed a series, then re-run with the
  // last K bars removed; every trade that opened before the cut must be
  // byte-identical.
  const full = multiTimeframeSeries(6000);
  const cutTime = full['1m'].at(-1).time - 1200 * 60;

  const truncated = {};
  for (const [tf, bars] of Object.entries(full)) {
    truncated[tf] = bars.filter((b) => b.time < cutTime);
  }

  const base = { symbol: 'BTCUSD', entryTimeframes: ['5m', '15m'], config: RESOLVED };
  const whole = backtest.run({ ...base, series: full });
  const partial = backtest.run({ ...base, series: truncated });

  // Compare only trades that both runs had time to finish well before the cut.
  const horizon = cutTime - 500 * 60;
  const pick = (report) =>
    report.trades
      .filter((t) => t.exitTime < horizon)
      .map((t) => ({
        id: t.id,
        entryTime: t.entryTime,
        entryPrice: t.entryPrice,
        exitTime: t.exitTime,
        exitPrice: t.exitPrice,
        netR: t.netR,
        outcome: t.outcome,
      }));

  const a = pick(whole);
  assert.ok(a.length > 0, 'the fixture must actually produce trades to compare');
  assert.deepEqual(pick(partial), a);
});

test('the backtest is deterministic: same input, byte-identical report', () => {
  const series = multiTimeframeSeries(3000);
  const input = { symbol: 'BTCUSD', series, entryTimeframes: ['5m'], config: RESOLVED };

  const a = backtest.run(input);
  const b = backtest.run(input);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('a run reports both exit variants over identical entries', () => {
  const series = multiTimeframeSeries(4000);
  const both = backtest.runBothVariants({
    symbol: 'BTCUSD',
    series,
    entryTimeframes: ['5m'],
    config: RESOLVED,
  });

  assert.equal(both.ladder.signals, both.simple.signals, 'entries must be identical');
  assert.equal(both.ladder.variant, 'ladder');
  assert.equal(both.simple.variant, 'simple');
  // Whether the ladder actually wins is an empirical question for the seed run;
  // what matters here is that both are measured over the same entries.
  assert.ok(both.ladder.overall.trades > 0);
});

test('reports carry the cadence numbers the frequency requirement is judged on', () => {
  const report = backtest.run({
    symbol: 'BTCUSD',
    series: multiTimeframeSeries(5000),
    entryTimeframes: ['1m', '5m'],
    config: RESOLVED,
  });

  assert.ok(report.span.days > 0);
  for (const tf of ['1m', '5m']) {
    const m = report.byTimeframe[tf];
    assert.ok(m.signalsPerDay !== null, `${tf} must report signals/day`);
    assert.ok(m.tradesPerDay !== null, `${tf} must report trades/day`);
    assert.equal(m.signals, report.signalsByTimeframe[tf]);
  }
});

test('walk-forward reports in-sample and out-of-sample separately', () => {
  const series = multiTimeframeSeries(30_000);
  const out = backtest.walkForward({
    symbol: 'BTCUSD',
    series,
    entryTimeframes: ['5m'],
    config: RESOLVED,
    windows: { trainDays: 8, testDays: 3, stepDays: 3 },
    warmupBars: 250,
  });

  assert.ok(out.windowCount >= 1, 'the fixture must span at least one window');
  assert.ok('inSample' in out.pooled && 'outOfSample' in out.pooled);
  for (const win of out.windows) {
    assert.ok(win.test.from >= win.train.to, 'the test window must follow the train window');
  }
  // Rule 7's gate is applied to out-of-sample results only.
  assert.ok('ok' in out.qualification && Array.isArray(out.qualification.reasons));
});

test('a probability store built from a run only counts closed trades', () => {
  const report = backtest.run({
    symbol: 'BTCUSD',
    series: multiTimeframeSeries(5000),
    entryTimeframes: ['5m'],
    config: RESOLVED,
  });
  const store = backtest.buildStore(report, 30);

  const totalRecorded = Object.values(store.buckets).reduce((sum, b) => sum + b.wins + b.losses, 0);
  assert.equal(totalRecorded, report.trades.length);
});
