// Relative Strength Index with Wilder smoothing.
//
// Warmup is `period + 1` bars, not `period`: the first bar produces no change
// to average, so the first RSI value lands at index `period`.
const { Window, makeBatch, resolveParams, wilder } = require('./util');

const DEFAULTS = { period: 14 };

/**
 * @typedef {Object} RsiState
 * @property {number} period
 * @property {number|null} prevClose
 * @property {Window} seedGains
 * @property {Window} seedLosses
 * @property {number|null} avgGain
 * @property {number|null} avgLoss
 */

/**
 * @param {{period?: number}} [params]
 * @returns {RsiState}
 */
function init(params) {
  const { period } = resolveParams(DEFAULTS, params);
  return {
    period,
    prevClose: null,
    seedGains: new Window(period),
    seedLosses: new Window(period),
    avgGain: null,
    avgLoss: null,
  };
}

/**
 * @param {RsiState} state
 * @param {import('../types').Bar} bar
 * @returns {number|null} 0..100, or null during warmup.
 */
function update(state, bar) {
  const close = bar.close;

  if (state.prevClose === null) {
    state.prevClose = close;
    return null;
  }

  const change = close - state.prevClose;
  state.prevClose = close;

  const gain = change > 0 ? change : 0;
  const loss = change < 0 ? -change : 0;

  if (state.avgGain === null) {
    state.seedGains.push(gain);
    state.seedLosses.push(loss);
    if (!state.seedGains.full) return null;
    state.avgGain = state.seedGains.mean();
    state.avgLoss = state.seedLosses.mean();
  } else {
    state.avgGain = wilder(state.avgGain, gain, state.period);
    state.avgLoss = wilder(state.avgLoss, loss, state.period);
  }

  // A perfectly flat series has no strength in either direction. Returning 100
  // here (what the avgLoss === 0 branch would give) would read as "maximum
  // overbought" for a series that has not moved at all.
  if (state.avgLoss === 0 && state.avgGain === 0) return 50;
  if (state.avgLoss === 0) return 100;
  if (state.avgGain === 0) return 0;

  return 100 - 100 / (1 + state.avgGain / state.avgLoss);
}

/** @param {RsiState} state @returns {RsiState} */
function clone(state) {
  return {
    period: state.period,
    prevClose: state.prevClose,
    seedGains: state.seedGains.clone(),
    seedLosses: state.seedLosses.clone(),
    avgGain: state.avgGain,
    avgLoss: state.avgLoss,
  };
}

module.exports = { init, update, clone, batch: makeBatch(init, update), DEFAULTS };
