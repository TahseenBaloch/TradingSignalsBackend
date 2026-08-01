// Simple moving average over a scalar series.
//
// Scalar rather than bar-based on purpose: SMA is used on closes, on volume,
// and on derived series (the DX series inside ADX). Callers pass whatever
// series they mean.
const { Window, makeBatch, resolveParams } = require('./util');

const DEFAULTS = { period: 20 };

/**
 * @typedef {Object} SmaState
 * @property {number} period
 * @property {Window} window
 */

/**
 * @param {{period?: number}} [params]
 * @returns {SmaState}
 */
function init(params) {
  const { period } = resolveParams(DEFAULTS, params);
  return { period, window: new Window(period) };
}

/**
 * @param {SmaState} state
 * @param {number} value
 * @returns {number|null} null until `period` values have been seen.
 */
function update(state, value) {
  state.window.push(value);
  return state.window.mean();
}

/** @param {SmaState} state @returns {SmaState} */
function clone(state) {
  return { period: state.period, window: state.window.clone() };
}

module.exports = { init, update, clone, batch: makeBatch(init, update), DEFAULTS };
