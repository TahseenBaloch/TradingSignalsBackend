// Stochastic oscillator (14, 3, 3) — the "slow" stochastic.
//
// rawK is smoothed into %K, and %K is smoothed again into %D. Strategy S6 keys
// off the %K/%D cross out of an extreme, so both lines must come from the same
// smoothing convention the backtest measured.
const sma = require('./sma');
const { Window, makeBatch, resolveParams } = require('./util');

const DEFAULTS = { period: 14, smoothK: 3, smoothD: 3 };

/**
 * @typedef {Object} StochasticValue
 * @property {number} k       Smoothed %K, 0..100.
 * @property {number|null} d  %D, null for a further `smoothD − 1` bars.
 */

/**
 * @typedef {Object} StochasticState
 * @property {Window} highs
 * @property {Window} lows
 * @property {import('./sma').SmaState} kSmoother
 * @property {import('./sma').SmaState} dSmoother
 */

/**
 * @param {{period?: number, smoothK?: number, smoothD?: number}} [params]
 * @returns {StochasticState}
 */
function init(params) {
  const { period, smoothK, smoothD } = resolveParams(DEFAULTS, params);
  return {
    highs: new Window(period),
    lows: new Window(period),
    kSmoother: sma.init({ period: smoothK }),
    dSmoother: sma.init({ period: smoothD }),
  };
}

/**
 * @param {StochasticState} state
 * @param {import('../types').Bar} bar
 * @returns {StochasticValue|null}
 */
function update(state, bar) {
  state.highs.push(bar.high);
  state.lows.push(bar.low);
  if (!state.highs.full) return null;

  const highest = state.highs.max();
  const lowest = state.lows.min();
  const range = highest - lowest;

  // A window with no range is neither overbought nor oversold. 50 keeps S6's
  // "crossing out of an extreme" test from firing on a dead market, which a
  // 0-or-100 convention would do constantly.
  const rawK = range === 0 ? 50 : (100 * (bar.close - lowest)) / range;

  const k = sma.update(state.kSmoother, rawK);
  if (k === null) return null;

  return { k, d: sma.update(state.dSmoother, k) };
}

/** @param {StochasticState} state @returns {StochasticState} */
function clone(state) {
  return {
    highs: state.highs.clone(),
    lows: state.lows.clone(),
    kSmoother: sma.clone(state.kSmoother),
    dSmoother: sma.clone(state.dSmoother),
  };
}

module.exports = { init, update, clone, batch: makeBatch(init, update), DEFAULTS };
