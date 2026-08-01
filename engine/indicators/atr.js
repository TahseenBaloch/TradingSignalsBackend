// Average True Range, Wilder smoothing.
//
// ATR is the engine's unit of distance. Every threshold that would otherwise be
// a hardcoded percentage — pattern tolerances, zone widths, stop padding,
// candle body sizes — is expressed in ATR so the same parameters work on a
// $100,000 BTC bar and a $0.20 DOGE bar.
const { Window, makeBatch, resolveParams, wilder, trueRange } = require('./util');

const DEFAULTS = { period: 14 };

/**
 * @typedef {Object} AtrState
 * @property {number} period
 * @property {number|null} prevClose
 * @property {Window} seed
 * @property {number|null} value
 */

/**
 * @param {{period?: number}} [params]
 * @returns {AtrState}
 */
function init(params) {
  const { period } = resolveParams(DEFAULTS, params);
  return { period, prevClose: null, seed: new Window(period), value: null };
}

/**
 * @param {AtrState} state
 * @param {import('../types').Bar} bar
 * @returns {number|null} null until `period` bars have been seen.
 */
function update(state, bar) {
  const tr = trueRange(bar, state.prevClose);
  state.prevClose = bar.close;

  if (state.value === null) {
    state.seed.push(tr);
    state.value = state.seed.mean(); // stays null until the window fills
    return state.value;
  }

  state.value = wilder(state.value, tr, state.period);
  return state.value;
}

/** @param {AtrState} state @returns {AtrState} */
function clone(state) {
  return {
    period: state.period,
    prevClose: state.prevClose,
    seed: state.seed.clone(),
    value: state.value,
  };
}

module.exports = { init, update, clone, batch: makeBatch(init, update), DEFAULTS };
