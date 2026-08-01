// Volume SMA(20) and relative volume.
//
// Relative volume is the participation gate several strategies depend on: S3
// requires >= 1.5 on a squeeze breakout, S6 requires >= 1.2, and the Phase 4
// breakout state machine will not promote a break without it. Being a ratio, it
// is directly comparable across symbols with wildly different absolute volume.
const sma = require('./sma');
const { makeBatch, resolveParams } = require('./util');

const DEFAULTS = { period: 20 };

/**
 * @typedef {Object} VolumeValue
 * @property {number} volume
 * @property {number} sma
 * @property {number} relative  volume / sma. 1 when the average is zero.
 */

/**
 * @typedef {Object} VolumeState
 * @property {import('./sma').SmaState} sma
 */

/**
 * @param {{period?: number}} [params]
 * @returns {VolumeState}
 */
function init(params) {
  const { period } = resolveParams(DEFAULTS, params);
  return { sma: sma.init({ period }) };
}

/**
 * @param {VolumeState} state
 * @param {import('../types').Bar} bar
 * @returns {VolumeValue|null} null until the average has warmed.
 */
function update(state, bar) {
  const average = sma.update(state.sma, bar.volume);
  if (average === null) return null;

  return {
    volume: bar.volume,
    sma: average,
    // An all-zero-volume window would otherwise divide by zero. Reporting 1
    // (i.e. "average") keeps every >= threshold gate closed rather than
    // handing them an Infinity that passes everything.
    relative: average === 0 ? 1 : bar.volume / average,
  };
}

/** @param {VolumeState} state @returns {VolumeState} */
function clone(state) {
  return { sma: sma.clone(state.sma) };
}

module.exports = { init, update, clone, batch: makeBatch(init, update), DEFAULTS };
