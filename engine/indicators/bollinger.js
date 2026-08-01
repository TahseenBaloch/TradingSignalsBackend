// Bollinger Bands (20, 2σ) with BandWidth and %B.
//
// BandWidth drives the SQUEEZE regime and strategy S3: a BandWidth at a
// 20-period low is the compression signature those look for. It is normalised
// by the middle band so it is comparable across symbols and across time.
const { Window, makeBatch, resolveParams } = require('./util');

const DEFAULTS = { period: 20, stdDev: 2 };

/**
 * @typedef {Object} BollingerValue
 * @property {number} middle
 * @property {number} upper
 * @property {number} lower
 * @property {number} stdev
 * @property {number} bandwidth  (upper − lower) / middle. 0 for a flat series.
 * @property {number} percentB   0 at the lower band, 1 at the upper. 0.5 when flat.
 */

/**
 * @typedef {Object} BollingerState
 * @property {number} period
 * @property {number} stdDev
 * @property {Window} window
 */

/**
 * @param {{period?: number, stdDev?: number}} [params]
 * @returns {BollingerState}
 */
function init(params) {
  const { period, stdDev } = resolveParams(DEFAULTS, params);
  return { period, stdDev, window: new Window(period) };
}

/**
 * @param {BollingerState} state
 * @param {import('../types').Bar} bar
 * @returns {BollingerValue|null}
 */
function update(state, bar) {
  state.window.push(bar.close);
  const middle = state.window.mean();
  if (middle === null) return null;

  // Population (not sample) standard deviation, which is what Bollinger
  // specified and what every charting package uses.
  const variance = state.window.varianceAbout(middle);
  const stdev = Math.sqrt(Math.max(0, variance));

  const offset = state.stdDev * stdev;
  const upper = middle + offset;
  const lower = middle - offset;
  const width = upper - lower;

  return {
    middle,
    upper,
    lower,
    stdev,
    bandwidth: middle === 0 ? 0 : width / middle,
    // A zero-width band means every close in the window was identical, so the
    // close sits exactly at the middle: 0.5, not a division by zero.
    percentB: width === 0 ? 0.5 : (bar.close - lower) / width,
  };
}

/** @param {BollingerState} state @returns {BollingerState} */
function clone(state) {
  return { period: state.period, stdDev: state.stdDev, window: state.window.clone() };
}

module.exports = { init, update, clone, batch: makeBatch(init, update), DEFAULTS };
