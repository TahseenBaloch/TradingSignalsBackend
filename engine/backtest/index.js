// The backtest runner.
//
// The subtle correctness problem here is not the fills, it is TIMEFRAME
// ALIGNMENT. A 5m entry reads 15m and 1h bias, and it is trivially easy to hand
// it a higher-timeframe bar that had not closed yet — which looks like a
// brilliant strategy and is pure lookahead.
//
// The fix is to drive everything from one merged stream ordered by bar CLOSE
// time (open time + duration), with longer timeframes ordered first on ties
// because a 15m bar closing at the same instant as a 5m bar genuinely is known
// to it. Every bias read is then assert-checked against the consuming bar's
// close time, so a regression fails loudly instead of inflating the results.
const pipeline = require('../pipeline');
const simulator = require('./simulator');
const metricsModule = require('./metrics');
const statsModule = require('../stats');

/**
 * Merges per-timeframe series into one chronological stream of bar closes.
 *
 * @param {Record<string, import('../types').Bar[]>} series
 * @param {Record<string, number>} secondsByTf
 */
function mergeStreams(series, secondsByTf) {
  const events = [];
  for (const [timeframe, bars] of Object.entries(series)) {
    const duration = secondsByTf[timeframe];
    if (!duration) throw new Error(`No bar duration configured for timeframe ${timeframe}`);
    for (const bar of bars) {
      events.push({ timeframe, bar, duration, closeTime: bar.time + duration });
    }
  }

  events.sort((a, b) => a.closeTime - b.closeTime || b.duration - a.duration);
  return events;
}

/**
 * @param {Object} input
 * @param {string} input.symbol
 * @param {Record<string, import('../types').Bar[]>} input.series
 * @param {string[]} input.entryTimeframes
 * @param {object} input.config              Resolved config for a preset.
 * @param {object} [input.store]             Probability store for live lookups.
 * @param {'ladder'|'simple'} [input.variant]
 * @param {number} [input.warmupUntil]       Bar time before which signals are ignored.
 * @returns {object} report
 */
function run(input) {
  const {
    symbol,
    series,
    config,
    entryTimeframes = config.timeframes.entry,
    variant = 'ladder',
    warmupUntil = -Infinity,
  } = input;

  const store = input.store || statsModule.create();
  const costs = config.costs;
  const plan = config.backtest.ladderPlan;
  const options = { ...simulator.DEFAULTS, variant };

  const analyzers = {};
  const timeframes = Object.keys(series);
  for (const timeframe of timeframes) {
    analyzers[timeframe] = pipeline.createAnalyzer({ symbol, timeframe, config });
  }

  const events = mergeStreams(series, config.timeframes.seconds);
  const pending = new Map(); // timeframe -> SignalEvent awaiting the next bar's open
  const openTrades = [];
  const closed = [];
  const signalCounts = {};
  let signalsTotal = 0;
  let alignmentViolations = 0;

  for (const timeframe of entryTimeframes) signalCounts[timeframe] = 0;

  for (const { timeframe, bar, closeTime } of events) {
    // --- 1. fill anything the previous bar's signal queued -----------------
    const queued = pending.get(timeframe);
    if (queued) {
      pending.delete(timeframe);
      const trade = simulator.open(queued, bar, costs, options);
      if (trade) openTrades.push(trade);
    }

    // --- 2. advance open trades on THIS timeframe with this bar ------------
    for (const trade of openTrades) {
      if (trade.open && trade.timeframe === timeframe) {
        simulator.step(trade, bar, costs, plan, options);
      }
    }
    for (let i = openTrades.length - 1; i >= 0; i -= 1) {
      if (!openTrades[i].open) closed.push(simulator.settle(openTrades.splice(i, 1)[0]));
    }

    // --- 3. gather bias from higher timeframes ----------------------------
    const bias = {};
    for (const other of timeframes) {
      if (other === timeframe) continue;
      const snapshot = pipeline.biasOf(analyzers[other]);
      if (!snapshot) continue;

      // The guarantee, checked rather than trusted.
      const otherClose = snapshot.barTime + config.timeframes.seconds[other];
      if (otherClose > closeTime) {
        alignmentViolations += 1;
        continue;
      }
      bias[other] = snapshot;
    }

    // --- 4. run the engine on this bar ------------------------------------
    const out = pipeline.update(analyzers[timeframe], bar, { bias, store });

    // --- 5. queue an entry for the next bar's open ------------------------
    const isEntryTf = entryTimeframes.includes(timeframe);
    if (isEntryTf && out.event && out.event.actionable && out.event.stops && bar.time >= warmupUntil) {
      signalCounts[timeframe] += 1;
      signalsTotal += 1;
      pending.set(timeframe, out.event);
    }
  }

  // Anything still open at the end is force-closed at the last known price and
  // marked expired, so it appears in the metrics rather than silently vanishing.
  for (const trade of openTrades) {
    const last = series[trade.timeframe].at(-1);
    simulator.fill(trade, {
      price: last.close,
      fraction: trade.remaining,
      time: last.time,
      label: simulator.OUTCOMES.EXPIRED,
      costs,
    });
    trade.outcome = trade.outcome || simulator.OUTCOMES.EXPIRED;
    closed.push(simulator.settle(trade));
  }

  closed.sort((a, b) => a.exitTime - b.exitTime || a.entryTime - b.entryTime);

  const allBars = Object.values(series).flat();
  const from = Math.min(...allBars.map((b) => b.time));
  const to = Math.max(...allBars.map((b) => b.time));
  const context = { spanSeconds: to - from, signals: signalsTotal };

  const byTimeframe = {};
  for (const timeframe of entryTimeframes) {
    const subset = closed.filter((t) => t.timeframe === timeframe);
    const bars = series[timeframe] || [];
    const span =
      bars.length > 1 ? bars.at(-1).time - bars[0].time : context.spanSeconds;
    byTimeframe[timeframe] = metricsModule.summarise(subset, {
      spanSeconds: span,
      signals: signalCounts[timeframe],
    });
  }

  const patternStats = {};
  for (const timeframe of timeframes) {
    const engine = analyzers[timeframe].patterns;
    patternStats[timeframe] = Object.fromEntries(engine.stats);
  }

  return {
    symbol,
    preset: config.preset,
    variant,
    span: { from, to, seconds: context.spanSeconds, days: context.spanSeconds / 86_400 },
    timeframes: entryTimeframes,
    signals: signalsTotal,
    signalsByTimeframe: signalCounts,
    alignmentViolations,
    overall: metricsModule.summarise(closed, context),
    byTimeframe,
    byStrategy: metricsModule.groupBy(closed, (t) => t.strategyId, context),
    byRegime: metricsModule.groupBy(closed, (t) => t.regime, context),
    byLevel: metricsModule.groupBy(closed, (t) => t.level, context),
    patternStats,
    trades: closed,
  };
}

/**
 * Runs both exit models over identical entries, so the ladder has to prove it
 * beats simply taking TP1 or SL1 — net of costs, where the extra partial fills
 * are charged for.
 */
function runBothVariants(input) {
  return {
    ladder: run({ ...input, variant: 'ladder' }),
    simple: run({ ...input, variant: 'simple' }),
  };
}

/**
 * Walk-forward validation (Rule 7).
 *
 * Each window feeds a warmup prefix whose signals are discarded, so a window
 * never starts with cold indicators — a 200-EMA that has not warmed would
 * silence the first two hundred bars of every test window and quietly bias the
 * comparison toward whichever windows happened to be longer.
 *
 * @param {Object} input  As run(), plus `windows` from config.backtest.walkForward.
 */
function walkForward(input) {
  const { config, series } = input;
  const w = input.windows || config.backtest.walkForward;
  const trainSeconds = w.trainDays * 86_400;
  const testSeconds = w.testDays * 86_400;
  const stepSeconds = w.stepDays * 86_400;
  const warmupBars = input.warmupBars ?? 250;

  const allBars = Object.values(series).flat();
  const start = Math.min(...allBars.map((b) => b.time));
  const end = Math.max(...allBars.map((b) => b.time));

  const slice = (fromTime, toTime) => {
    const out = {};
    for (const [timeframe, bars] of Object.entries(series)) {
      const firstIndex = bars.findIndex((b) => b.time >= fromTime);
      if (firstIndex === -1) {
        out[timeframe] = [];
        continue;
      }
      const warmStart = Math.max(0, firstIndex - warmupBars);
      out[timeframe] = bars.filter((b, i) => i >= warmStart && b.time < toTime);
    }
    return out;
  };

  const windows = [];
  for (let cursor = start; cursor + trainSeconds + testSeconds <= end; cursor += stepSeconds) {
    const trainFrom = cursor;
    const trainTo = cursor + trainSeconds;
    const testTo = trainTo + testSeconds;

    windows.push({
      index: windows.length,
      train: { from: trainFrom, to: trainTo },
      test: { from: trainTo, to: testTo },
      inSample: run({ ...input, series: slice(trainFrom, trainTo), warmupUntil: trainFrom }),
      outOfSample: run({ ...input, series: slice(trainTo, testTo), warmupUntil: trainTo }),
    });
  }

  const pooled = (pick) => {
    const trades = windows.flatMap((win) => pick(win).trades);
    const seconds = windows.reduce((sum, win) => sum + pick(win).span.seconds, 0);
    const signals = windows.reduce((sum, win) => sum + pick(win).signals, 0);
    return metricsModule.summarise(trades, { spanSeconds: seconds, signals });
  };

  const outOfSample = pooled((win) => win.outOfSample);

  return {
    symbol: input.symbol,
    preset: config.preset,
    windowCount: windows.length,
    windows: windows.map((win) => ({
      index: win.index,
      train: win.train,
      test: win.test,
      inSample: summaryOf(win.inSample),
      outOfSample: summaryOf(win.outOfSample),
    })),
    pooled: { inSample: pooled((win) => win.inSample), outOfSample },
    // Rule 7's gate is applied to OUT-OF-SAMPLE only. In-sample numbers never
    // qualify a configuration.
    qualification: metricsModule.qualifies(outOfSample, config.backtest.qualification),
  };
}

/** The compact form used in tables, without the trade list or equity curve. */
function summaryOf(report) {
  const { equity, ...rest } = report.overall;
  return {
    span: report.span,
    signals: report.signals,
    signalsByTimeframe: report.signalsByTimeframe,
    metrics: rest,
    byTimeframe: Object.fromEntries(
      Object.entries(report.byTimeframe).map(([tf, m]) => {
        const { equity: _e, ...bare } = m;
        return [tf, bare];
      })
    ),
  };
}

/**
 * Builds a probability store from a completed run, so live signals can quote
 * measured win rates. Only closed trades contribute (see engine/stats.js).
 */
function buildStore(reports, minSample) {
  const store = statsModule.create({ minSample });
  for (const report of Array.isArray(reports) ? reports : [reports]) {
    for (const trade of report.trades) {
      statsModule.record(store, {
        strategyId: trade.strategyId,
        direction: trade.direction,
        regime: trade.regime,
        won: trade.won,
        r: trade.netR,
      });
    }
  }
  return store;
}

module.exports = {
  run,
  runBothVariants,
  walkForward,
  mergeStreams,
  buildStore,
  summaryOf,
  simulator,
  metrics: metricsModule,
};
