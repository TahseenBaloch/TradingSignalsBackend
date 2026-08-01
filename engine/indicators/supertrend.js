// Supertrend (ATR 10, multiplier 3.0).
//
// The trailing band only ever moves in the trend's favour, which is what makes
// it useful as a bias filter (S1, S5) rather than just another moving average.
const atrIndicator = require('./atr');
const { makeBatch, resolveParams } = require('./util');

const DEFAULTS = { atrPeriod: 10, multiplier: 3.0 };

/**
 * @typedef {Object} SupertrendValue
 * @property {number} value      The active band — the line drawn on the chart.
 * @property {1|-1} direction    1 bullish (line below price), −1 bearish.
 * @property {number} upper      Final upper band.
 * @property {number} lower      Final lower band.
 * @property {boolean} flipped   True on the bar the direction changed.
 */

/**
 * @typedef {Object} SupertrendState
 * @property {number} multiplier
 * @property {import('./atr').AtrState} atr
 * @property {number|null} prevClose
 * @property {number|null} upper
 * @property {number|null} lower
 * @property {1|-1|null} direction
 */

/**
 * @param {{atrPeriod?: number, multiplier?: number}} [params]
 * @returns {SupertrendState}
 */
function init(params) {
  const { atrPeriod, multiplier } = resolveParams(DEFAULTS, params);
  return {
    multiplier,
    atr: atrIndicator.init({ period: atrPeriod }),
    prevClose: null,
    upper: null,
    lower: null,
    direction: null,
  };
}

/**
 * @param {SupertrendState} state
 * @param {import('../types').Bar} bar
 * @returns {SupertrendValue|null} null until ATR has warmed.
 */
function update(state, bar) {
  const atr = atrIndicator.update(state.atr, bar);
  if (atr === null) return null;

  const mid = (bar.high + bar.low) / 2;
  const basicUpper = mid + state.multiplier * atr;
  const basicLower = mid - state.multiplier * atr;

  if (state.direction === null) {
    // First usable bar: adopt the raw bands and pick a side from where the
    // close sits. Any seed converges within a few bars, but it must be a
    // function of the data alone so replays are identical (Rule 6).
    state.upper = basicUpper;
    state.lower = basicLower;
    state.direction = bar.close >= mid ? 1 : -1;
    state.prevClose = bar.close;
    return {
      value: state.direction === 1 ? state.lower : state.upper,
      direction: state.direction,
      upper: state.upper,
      lower: state.lower,
      flipped: false,
    };
  }

  // The ratchet: a band tightens freely but only loosens once price has closed
  // through it. Without this the line would jitter with every ATR wiggle and
  // the "trend" it reports would be meaningless.
  const upper =
    basicUpper < state.upper || state.prevClose > state.upper ? basicUpper : state.upper;
  const lower =
    basicLower > state.lower || state.prevClose < state.lower ? basicLower : state.lower;

  const previous = state.direction;
  const direction = previous === 1 ? (bar.close < lower ? -1 : 1) : bar.close > upper ? 1 : -1;

  state.upper = upper;
  state.lower = lower;
  state.direction = direction;
  state.prevClose = bar.close;

  return {
    value: direction === 1 ? lower : upper,
    direction,
    upper,
    lower,
    flipped: direction !== previous,
  };
}

/** @param {SupertrendState} state @returns {SupertrendState} */
function clone(state) {
  return {
    multiplier: state.multiplier,
    atr: atrIndicator.clone(state.atr),
    prevClose: state.prevClose,
    upper: state.upper,
    lower: state.lower,
    direction: state.direction,
  };
}

module.exports = { init, update, clone, batch: makeBatch(init, update), DEFAULTS };
