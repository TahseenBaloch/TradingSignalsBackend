// Exponential moving average over a scalar series.
//
// Seeded with the SMA of the first `period` values, which is the convention
// TradingView and Wilder's successors use. The alternative (seeding with the
// first value) produces a different curve for hundreds of bars, so live and
// backtest numbers would only agree if both made the same choice — they share
// this code, so they do.
const { Window, makeBatch, resolveParams } = require('./util');

const DEFAULTS = { period: 20 };

/**
 * @typedef {Object} EmaState
 * @property {number} period
 * @property {number} k       Smoothing factor, 2 / (period + 1).
 * @property {Window} seed    Collects the first `period` values for the SMA seed.
 * @property {number|null} value
 */

/**
 * @param {{period?: number}} [params]
 * @returns {EmaState}
 */
function init(params) {
  const { period } = resolveParams(DEFAULTS, params);
  return {
    period,
    k: 2 / (period + 1),
    seed: new Window(period),
    value: null,
  };
}

/**
 * @param {EmaState} state
 * @param {number} value
 * @returns {number|null} null until `period` values have been seen.
 */
function update(state, value) {
  if (state.value === null) {
    state.seed.push(value);
    // The seeding SMA is itself the first EMA value, emitted on the same bar
    // the window fills — so warmup is exactly `period` bars, no more.
    state.value = state.seed.mean();
    return state.value;
  }
  state.value = (value - state.value) * state.k + state.value;
  return state.value;
}

/** @param {EmaState} state @returns {EmaState} */
function clone(state) {
  return {
    period: state.period,
    k: state.k,
    seed: state.seed.clone(),
    value: state.value,
  };
}

module.exports = { init, update, clone, batch: makeBatch(init, update), DEFAULTS };
