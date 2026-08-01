// Session-anchored VWAP with ±1σ / ±2σ / ±3σ bands.
//
// Crypto trades continuously, so the session anchor is the UTC day boundary —
// the same anchor TradingView uses for 24h markets, and the one strategy S2
// assumes when it skips signals near the daily reset.
//
// The boundary is derived from `bar.time`, never from the clock (Rule 6): a
// backtest replaying 2022 must anchor to 2022's midnights, and it does so with
// the identical code path the live pipeline runs.
const { makeBatch, utcDayIndex } = require('./util');

const DEFAULTS = { deviations: [1, 2, 3] };

/**
 * @typedef {Object} VwapValue
 * @property {number} vwap
 * @property {number} stdev
 * @property {number[]} upper   Bands at +1σ, +2σ, +3σ (index 0..2).
 * @property {number[]} lower   Bands at −1σ, −2σ, −3σ.
 * @property {number} barsInSession  How far into the session this bar is (1-based).
 */

/**
 * @typedef {Object} VwapSessionState
 * @property {number[]} deviations
 * @property {number|null} day       UTC day index of the running session.
 * @property {number} weightSum      Σ volume.
 * @property {number} mean           Running volume-weighted mean of typical price.
 * @property {number} m2             Weighted sum of squared deviations (Welford).
 * @property {number} bars
 */

/**
 * @param {{deviations?: number[]}} [params]
 * @returns {VwapSessionState}
 */
function init(params) {
  const { deviations } = { ...DEFAULTS, ...(params || {}) };
  if (!Array.isArray(deviations) || deviations.length === 0) {
    throw new Error('VWAP deviations must be a non-empty array');
  }
  return { deviations: deviations.slice(), day: null, weightSum: 0, mean: 0, m2: 0, bars: 0 };
}

function reset(state, day) {
  state.day = day;
  state.weightSum = 0;
  state.mean = 0;
  state.m2 = 0;
  state.bars = 0;
}

/**
 * @param {VwapSessionState} state
 * @param {import('../types').Bar} bar
 * @returns {VwapValue|null} null only before any volume has accumulated.
 */
function update(state, bar) {
  const day = utcDayIndex(bar.time);
  if (state.day !== day) reset(state, day);

  const typical = (bar.high + bar.low + bar.close) / 3;
  const weight = bar.volume > 0 ? bar.volume : 0;

  // Weighted Welford rather than Σvp / Σv and Σvp² / Σv − vwap². The closed
  // form loses the variance to catastrophic cancellation on a quiet session:
  // for a five-figure price the two terms agree to more digits than a double
  // carries, and the bands collapse or go imaginary. Welford stays exact.
  if (weight > 0) {
    state.weightSum += weight;
    const delta = typical - state.mean;
    state.mean += (weight / state.weightSum) * delta;
    state.m2 += weight * delta * (typical - state.mean);
  }

  state.bars += 1;
  if (state.weightSum <= 0) return null; // a session that has traded nothing yet

  const stdev = Math.sqrt(Math.max(0, state.m2 / state.weightSum));

  return {
    vwap: state.mean,
    stdev,
    upper: state.deviations.map((k) => state.mean + k * stdev),
    lower: state.deviations.map((k) => state.mean - k * stdev),
    barsInSession: state.bars,
  };
}

/** @param {VwapSessionState} state @returns {VwapSessionState} */
function clone(state) {
  return {
    deviations: state.deviations.slice(),
    day: state.day,
    weightSum: state.weightSum,
    mean: state.mean,
    m2: state.m2,
    bars: state.bars,
  };
}

module.exports = { init, update, clone, batch: makeBatch(init, update), DEFAULTS };
