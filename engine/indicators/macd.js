// MACD (12/26/9) with histogram.
//
// Returns null until the slow EMA has warmed, then an object whose `signal` and
// `histogram` stay null for a further `signalPeriod` bars. The MACD line is
// usable before the signal line exists, and pretending otherwise would delay
// every MACD-gated strategy by 9 bars for no reason — but a caller reading
// `histogram` must handle the null rather than be handed a fabricated zero.
const ema = require('./ema');
const { makeBatch, resolveParams } = require('./util');

const DEFAULTS = { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 };

/**
 * @typedef {Object} MacdValue
 * @property {number} macd            Fast EMA − slow EMA.
 * @property {number|null} signal     EMA of the MACD line.
 * @property {number|null} histogram  macd − signal.
 */

/**
 * @typedef {Object} MacdState
 * @property {import('./ema').EmaState} fast
 * @property {import('./ema').EmaState} slow
 * @property {import('./ema').EmaState} signal
 */

/**
 * @param {{fastPeriod?: number, slowPeriod?: number, signalPeriod?: number}} [params]
 * @returns {MacdState}
 */
function init(params) {
  const { fastPeriod, slowPeriod, signalPeriod } = resolveParams(DEFAULTS, params);
  if (fastPeriod >= slowPeriod) {
    throw new Error(`MACD fastPeriod (${fastPeriod}) must be less than slowPeriod (${slowPeriod})`);
  }
  return {
    fast: ema.init({ period: fastPeriod }),
    slow: ema.init({ period: slowPeriod }),
    signal: ema.init({ period: signalPeriod }),
  };
}

/**
 * @param {MacdState} state
 * @param {import('../types').Bar} bar
 * @returns {MacdValue|null}
 */
function update(state, bar) {
  const fast = ema.update(state.fast, bar.close);
  const slow = ema.update(state.slow, bar.close);
  if (fast === null || slow === null) return null;

  const macd = fast - slow;
  const signal = ema.update(state.signal, macd);

  return {
    macd,
    signal,
    histogram: signal === null ? null : macd - signal,
  };
}

/** @param {MacdState} state @returns {MacdState} */
function clone(state) {
  return {
    fast: ema.clone(state.fast),
    slow: ema.clone(state.slow),
    signal: ema.clone(state.signal),
  };
}

module.exports = { init, update, clone, batch: makeBatch(init, update), DEFAULTS };
