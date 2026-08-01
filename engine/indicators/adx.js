// Average Directional Index with +DI / −DI, Wilder's original formulation.
//
// ADX is the engine's regime gate: TRENDING is ADX >= 25, RANGING is ADX < 20
// (see engine/structure). Getting its warmup right matters — ADX needs roughly
// 2 x period bars before it means anything, and a strategy that reads a
// half-warmed ADX is reading noise.
const { Window, makeBatch, resolveParams, wilder, trueRange } = require('./util');

const DEFAULTS = { period: 14 };

/**
 * @typedef {Object} AdxValue
 * @property {number} plusDI
 * @property {number} minusDI
 * @property {number|null} adx  null for a further `period` bars after the DIs.
 */

/**
 * @typedef {Object} AdxState
 * @property {number} period
 * @property {import('../types').Bar|null} prevBar
 * @property {Window} seedTr
 * @property {Window} seedPlusDm
 * @property {Window} seedMinusDm
 * @property {number|null} smoothedTr
 * @property {number|null} smoothedPlusDm
 * @property {number|null} smoothedMinusDm
 * @property {Window} seedDx
 * @property {number|null} adx
 */

/**
 * @param {{period?: number}} [params]
 * @returns {AdxState}
 */
function init(params) {
  const { period } = resolveParams(DEFAULTS, params);
  return {
    period,
    prevBar: null,
    seedTr: new Window(period),
    seedPlusDm: new Window(period),
    seedMinusDm: new Window(period),
    smoothedTr: null,
    smoothedPlusDm: null,
    smoothedMinusDm: null,
    seedDx: new Window(period),
    adx: null,
  };
}

/**
 * @param {AdxState} state
 * @param {import('../types').Bar} bar
 * @returns {AdxValue|null}
 */
function update(state, bar) {
  const prev = state.prevBar;
  state.prevBar = bar;
  if (prev === null) return null; // directional movement needs a previous bar

  const upMove = bar.high - prev.high;
  const downMove = prev.low - bar.low;

  // Only the dominant direction records movement; an inside bar records neither.
  const plusDm = upMove > downMove && upMove > 0 ? upMove : 0;
  const minusDm = downMove > upMove && downMove > 0 ? downMove : 0;
  const tr = trueRange(bar, prev.close);

  if (state.smoothedTr === null) {
    state.seedTr.push(tr);
    state.seedPlusDm.push(plusDm);
    state.seedMinusDm.push(minusDm);
    if (!state.seedTr.full) return null;
    // Wilder seeds the smoothed series with a SUM, not a mean. The DI ratio
    // makes the choice invisible, but ATR-style averaging here would change DX.
    state.smoothedTr = state.seedTr.sum;
    state.smoothedPlusDm = state.seedPlusDm.sum;
    state.smoothedMinusDm = state.seedMinusDm.sum;
  } else {
    const p = state.period;
    state.smoothedTr = state.smoothedTr - state.smoothedTr / p + tr;
    state.smoothedPlusDm = state.smoothedPlusDm - state.smoothedPlusDm / p + plusDm;
    state.smoothedMinusDm = state.smoothedMinusDm - state.smoothedMinusDm / p + minusDm;
  }

  // A run of identical bars has no true range at all; every DI is then zero
  // rather than infinite.
  const plusDI = state.smoothedTr === 0 ? 0 : (100 * state.smoothedPlusDm) / state.smoothedTr;
  const minusDI = state.smoothedTr === 0 ? 0 : (100 * state.smoothedMinusDm) / state.smoothedTr;

  const diSum = plusDI + minusDI;
  const dx = diSum === 0 ? 0 : (100 * Math.abs(plusDI - minusDI)) / diSum;

  if (state.adx === null) {
    state.seedDx.push(dx);
    if (state.seedDx.full) state.adx = state.seedDx.mean();
  } else {
    state.adx = wilder(state.adx, dx, state.period);
  }

  return { plusDI, minusDI, adx: state.adx };
}

/** @param {AdxState} state @returns {AdxState} */
function clone(state) {
  return {
    period: state.period,
    prevBar: state.prevBar,
    seedTr: state.seedTr.clone(),
    seedPlusDm: state.seedPlusDm.clone(),
    seedMinusDm: state.seedMinusDm.clone(),
    smoothedTr: state.smoothedTr,
    smoothedPlusDm: state.smoothedPlusDm,
    smoothedMinusDm: state.smoothedMinusDm,
    seedDx: state.seedDx.clone(),
    adx: state.adx,
  };
}

module.exports = { init, update, clone, batch: makeBatch(init, update), DEFAULTS };
