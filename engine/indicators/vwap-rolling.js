// Rolling-window VWAP with ±1σ / ±2σ / ±3σ bands.
//
// Unlike the session VWAP this never resets, so it stays meaningful right
// across the UTC boundary — which is exactly the window where S2 has to stop
// trusting the session anchor.
const { Window, makeBatch, resolveParams } = require('./util');

const DEFAULTS = { period: 20, deviations: [1, 2, 3] };

/**
 * @typedef {Object} VwapRollingState
 * @property {number} period
 * @property {number[]} deviations
 * @property {Window} typical   Typical price per bar.
 * @property {Window} volume    Volume per bar, pushed in lockstep with `typical`.
 * @property {Window} weighted  volume x typical, for the O(1) numerator.
 */

/**
 * @param {{period?: number, deviations?: number[]}} [params]
 * @returns {VwapRollingState}
 */
function init(params) {
  const merged = { ...DEFAULTS, ...(params || {}) };
  const { period } = resolveParams({ period: DEFAULTS.period }, { period: merged.period });
  if (!Array.isArray(merged.deviations) || merged.deviations.length === 0) {
    throw new Error('VWAP deviations must be a non-empty array');
  }
  return {
    period,
    deviations: merged.deviations.slice(),
    typical: new Window(period),
    volume: new Window(period),
    weighted: new Window(period),
  };
}

/**
 * @param {VwapRollingState} state
 * @param {import('../types').Bar} bar
 * @returns {import('./vwap-session').VwapValue|null} null until the window fills.
 */
function update(state, bar) {
  const typical = (bar.high + bar.low + bar.close) / 3;
  const volume = bar.volume > 0 ? bar.volume : 0;

  state.typical.push(typical);
  state.volume.push(volume);
  state.weighted.push(volume * typical);

  if (!state.typical.full) return null;

  const volumeSum = state.volume.sum;
  if (volumeSum <= 0) return null; // a fully untraded window has no VWAP

  const vwap = state.weighted.sum / volumeSum;

  // Two-pass weighted variance straight off the ring buffers. The two windows
  // are pushed together and share a size, so raw buffer index i refers to the
  // same bar in both; variance does not care about chronological order, so the
  // ring's rotation can be ignored.
  let acc = 0;
  for (let i = 0; i < state.typical.count; i += 1) {
    const d = state.typical.buf[i] - vwap;
    acc += state.volume.buf[i] * d * d;
  }
  const stdev = Math.sqrt(Math.max(0, acc / volumeSum));

  return {
    vwap,
    stdev,
    upper: state.deviations.map((k) => vwap + k * stdev),
    lower: state.deviations.map((k) => vwap - k * stdev),
    barsInSession: state.period,
  };
}

/** @param {VwapRollingState} state @returns {VwapRollingState} */
function clone(state) {
  return {
    period: state.period,
    deviations: state.deviations.slice(),
    typical: state.typical.clone(),
    volume: state.volume.clone(),
    weighted: state.weighted.clone(),
  };
}

module.exports = { init, update, clone, batch: makeBatch(init, update), DEFAULTS };
