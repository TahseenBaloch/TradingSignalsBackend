// Market structure engine: pivots -> zones + trendlines -> trend + regime.
//
// This module does NOT compute indicators. It takes them as a snapshot, because
// the Phase 5 pipeline already computes each indicator once per bar and feeding
// structure its own private copies would both waste the work and create a
// second place for the numbers to drift. `analyse()` below wires the indicators
// up for tests and one-off analysis.
const pivots = require('./pivots');
const zones = require('./zones');
const trendlines = require('./trendlines');
const trend = require('./trend');
const regime = require('./regime');
const indicators = require('../indicators');

/**
 * @typedef {Object} IndicatorSnapshot
 * @property {number|null} atr
 * @property {import('../indicators/adx').AdxValue|null} adx
 * @property {import('../indicators/bollinger').BollingerValue|null} bollinger
 * @property {number|null} ema9
 * @property {number|null} ema21
 * @property {number|null} ema200
 */

/**
 * @typedef {Object} StructureView
 * @property {number} index
 * @property {import('./pivots').Pivot[]} newPivots  Confirmed by THIS bar.
 * @property {import('./pivots').PivotState} pivots
 * @property {import('./zones').Zone[]} zones        Strongest first.
 * @property {{resistance: import('./trendlines').Trendline|null, support: import('./trendlines').Trendline|null}} trendlines
 * @property {import('./trend').TrendState} trend
 * @property {import('./regime').RegimeState_} regime
 */

/**
 * @param {{pivots?: object, zones?: object, trendlines?: object, trend?: object, regime?: object}} [params]
 */
function init(params = {}) {
  return {
    index: -1,
    pivots: pivots.init(params.pivots),
    zones: zones.init(params.zones),
    trendlines: trendlines.init(params.trendlines),
    trend: trend.init(params.trend),
    regime: regime.init(params.regime),
  };
}

/**
 * Advances every structure component by one CLOSED bar.
 *
 * LIFETIME CONTRACT — read before retaining anything from the result.
 *
 * The returned view ALIASES live engine state. Zones, trendlines and the pivot
 * store are long-lived mutable objects that keep evolving on later bars, so a
 * view held across an update() will appear to change retroactively. That is
 * aliasing, not repainting: the state at bar N really is a function of bars
 * 0..N only, and re-running the engine over a prefix reproduces it exactly.
 *
 * Copying defensively on every bar would mean tens of millions of throwaway
 * objects across a seed backtest, so the hot path does not. Consumers that
 * persist, queue, diff or assert on a view must call snapshot() first. The live
 * pipeline serialises each view to the WebSocket immediately and the backtester
 * records primitives, so neither pays for the copy it does not need.
 *
 * @param {ReturnType<init>} state
 * @param {import('../types').Bar} bar
 * @param {IndicatorSnapshot} snapshot
 * @returns {StructureView} valid until the next update() on this state.
 */
function update(state, bar, snapshot) {
  state.index += 1;
  const index = state.index;
  const atr = snapshot.atr;

  const newPivots = pivots.update(state.pivots, bar);

  // Zones and trendlines are both ATR-scaled, so before ATR warms there is
  // nothing meaningful to build. They simply hold their previous (empty) shape.
  const zoneList = zones.update(state.zones, bar, { index, atr, pivots: newPivots });
  const lines = trendlines.update(
    state.trendlines,
    bar,
    { index, atr, pivots: state.pivots },
    newPivots
  );

  return {
    index,
    newPivots,
    pivots: state.pivots,
    zones: zoneList,
    trendlines: lines,
    trend: trend.evaluate(state.trend, {
      ema9: snapshot.ema9,
      ema21: snapshot.ema21,
      ema200: snapshot.ema200,
      adx: snapshot.adx,
      pivots: state.pivots,
    }),
    regime: regime.evaluate(state.regime, {
      atr,
      adx: snapshot.adx,
      bollinger: snapshot.bollinger,
      close: bar.close,
    }),
  };
}

function clone(state) {
  return {
    index: state.index,
    pivots: pivots.clone(state.pivots),
    zones: zones.clone(state.zones),
    trendlines: trendlines.clone(state.trendlines),
    trend: trend.clone(state.trend),
    regime: regime.clone(state.regime),
  };
}

/**
 * Convenience for tests and offline analysis: runs the indicator set and the
 * structure engine together over a bar array, one StructureView per bar.
 *
 * Every view is snapshotted, because the whole point of the returned array is
 * to be examined after the run — the one situation the aliasing contract on
 * update() says you must copy for. That makes this the slow path by design;
 * the live pipeline does NOT call it.
 *
 * @param {readonly import('../types').Bar[]} bars
 * @param {object} [params]
 * @returns {StructureView[]} detached snapshots, one per bar.
 */
function analyse(bars, params = {}) {
  const state = init(params);
  const atr = indicators.atr.init(params.atr);
  const adx = indicators.adx.init(params.adx);
  const bollinger = indicators.bollinger.init(params.bollinger);
  const ema9 = indicators.ema.init({ period: 9 });
  const ema21 = indicators.ema.init({ period: 21 });
  const ema200 = indicators.ema.init({ period: 200 });

  return bars.map((bar) =>
    snapshot(
      update(state, bar, {
        atr: indicators.atr.update(atr, bar),
        adx: indicators.adx.update(adx, bar),
        bollinger: indicators.bollinger.update(bollinger, bar),
        ema9: indicators.ema.update(ema9, bar.close),
        ema21: indicators.ema.update(ema21, bar.close),
        ema200: indicators.ema.update(ema200, bar.close),
      })
    )
  );
}

/**
 * Deep, detached copy of a StructureView — the supported way to keep one past
 * the bar that produced it. See the lifetime contract on update().
 *
 * `pivots` is deliberately reduced to its two confirmed lists rather than the
 * whole detector state: the ring buffer and bar counter are machinery, not
 * findings, and nothing downstream of a snapshot should be resuming detection
 * from it.
 *
 * @param {StructureView} view
 * @returns {StructureView}
 */
function snapshot(view) {
  const copyLine = (l) =>
    l === null
      ? null
      : { ...l, anchors: l.anchors.map((a) => ({ ...a })), from: { ...l.from }, to: { ...l.to } };

  return {
    index: view.index,
    newPivots: view.newPivots.map((p) => ({ ...p })),
    pivots: { highs: view.pivots.highs.slice(), lows: view.pivots.lows.slice() },
    zones: view.zones.map(({ _, ...rest }) => ({ ...rest })),
    trendlines: {
      resistance: copyLine(view.trendlines.resistance),
      support: copyLine(view.trendlines.support),
    },
    trend: { ...view.trend, votes: { ...view.trend.votes } },
    regime: { ...view.regime, flags: { ...view.regime.flags } },
  };
}

module.exports = {
  init,
  update,
  clone,
  snapshot,
  analyse,
  pivots,
  zones,
  trendlines,
  trend,
  regime,
};
