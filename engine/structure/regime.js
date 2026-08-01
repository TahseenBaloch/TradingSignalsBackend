// Regime classifier. Regime is the gate that decides which strategies are even
// allowed to speak on a given bar (S1 trend-only, S2 range-only, S3 squeeze-only),
// so its precedence order is a real design decision rather than a formality:
//
//   SQUEEZE  >  VOLATILE_EXPANSION  >  TRENDING  >  RANGING
//
// SQUEEZE wins because it is the narrowest and most perishable condition — it
// lasts a handful of bars and is the only window in which S3 may fire. Volatile
// expansion outranks trending because a 90th-percentile ATR bar is a different
// animal from a steady trend even when ADX agrees, and strategies sized for
// normal volatility should stand aside for it.
//
// `primary` is always one of the four, never null: a bar with no regime would
// silence every strategy, and long stretches of silence are exactly what the
// cadence requirement forbids.
const { Window, resolveParams } = require('../indicators/util');

const DEFAULTS = {
  trendingAdx: 25,
  rangingAdx: 20,
  squeezeLookback: 20, // BandWidth at a low over this many bars
  atrLookback: 100, // window for the ATR percentile
  expansionPercentile: 80,
  oscillationLookback: 20,
  // Crossings of the band middle, per `oscillationLookback` bars, at which
  // rangeQuality saturates at 1.
  oscillationTarget: 5,
};

/**
 * @typedef {Object} RegimeState_
 * @property {'TRENDING'|'RANGING'|'SQUEEZE'|'VOLATILE_EXPANSION'} primary
 * @property {{trending: boolean, ranging: boolean, squeeze: boolean, volatileExpansion: boolean}} flags
 * @property {number|null} adx
 * @property {number|null} atrPercentile   0..100 rank of the current ATR.
 * @property {number|null} bandwidth
 * @property {number} rangeQuality         0..1 — how genuinely price is oscillating.
 */

function init(params) {
  const p = resolveParams(DEFAULTS, params);
  return {
    params: p,
    bandwidths: new Window(p.squeezeLookback),
    atrs: new Window(p.atrLookback),
    signs: new Window(p.oscillationLookback),
  };
}

/**
 * Rank of `value` within the window, 0..100. Returns null until the window is
 * full — a percentile over four samples is not a percentile.
 *
 * Ties take a MIDRANK (half credit), not full credit. Counting `<=` would rank
 * a value equal to every sample at the 100th percentile, so a market whose ATR
 * is merely steady would sit permanently in VOLATILE_EXPANSION and silence
 * every strategy gated on a calmer regime. Under a midrank the same series
 * ranks at 50, which is what "equal to everything" actually means.
 */
function percentileOf(window, value) {
  if (!window.full) return null;
  let below = 0;
  let equal = 0;
  for (let i = 0; i < window.count; i += 1) {
    if (window.buf[i] < value) below += 1;
    else if (window.buf[i] === value) equal += 1;
  }
  return (100 * (below + equal / 2)) / window.count;
}

/**
 * @param {ReturnType<init>} state
 * @param {{
 *   atr: number|null,
 *   adx: import('../indicators/adx').AdxValue|null,
 *   bollinger: import('../indicators/bollinger').BollingerValue|null,
 *   close: number
 * }} ctx
 * @returns {RegimeState_}
 */
function evaluate(state, ctx) {
  const p = state.params;
  const adx = ctx.adx && ctx.adx.adx !== null ? ctx.adx.adx : null;
  const bandwidth = ctx.bollinger ? ctx.bollinger.bandwidth : null;

  // --- squeeze: BandWidth at its lowest in the lookback -------------------
  let squeeze = false;
  if (bandwidth !== null) {
    // Compared BEFORE pushing, so "lowest in the last N" excludes the current
    // bar from its own comparison set and a first-ever reading cannot qualify.
    const previousLow = state.bandwidths.full ? state.bandwidths.min() : null;
    squeeze = previousLow !== null && bandwidth <= previousLow;
    state.bandwidths.push(bandwidth);
  }

  // --- volatility expansion: ATR high in its own recent distribution ------
  let atrPercentile = null;
  if (ctx.atr !== null && Number.isFinite(ctx.atr)) {
    atrPercentile = percentileOf(state.atrs, ctx.atr);
    state.atrs.push(ctx.atr);
  }
  const volatileExpansion = atrPercentile !== null && atrPercentile > p.expansionPercentile;

  // --- oscillation: how often price crosses the band middle ---------------
  // This is what separates a genuine range from a quiet drift. Both show a low
  // ADX; only one of them mean-reverts, and only one of them is safe for S2.
  let rangeQuality = 0;
  if (ctx.bollinger) {
    state.signs.push(Math.sign(ctx.close - ctx.bollinger.middle));
    if (state.signs.full) {
      const values = state.signs.values();
      let crossings = 0;
      for (let i = 1; i < values.length; i += 1) {
        if (values[i] !== 0 && values[i - 1] !== 0 && values[i] !== values[i - 1]) crossings += 1;
      }
      rangeQuality = Math.min(1, crossings / p.oscillationTarget);
    }
  }

  const trending = adx !== null && adx >= p.trendingAdx;
  const ranging = adx !== null && adx < p.rangingAdx && rangeQuality > 0;

  let primary;
  if (squeeze) primary = 'SQUEEZE';
  else if (volatileExpansion) primary = 'VOLATILE_EXPANSION';
  else if (trending) primary = 'TRENDING';
  else if (ranging) primary = 'RANGING';
  // The 20–25 ADX grey zone, and low-ADX drift that is not oscillating. Neither
  // is a clean range, so lean trending above the floor and ranging below it.
  else if (adx !== null && adx >= p.rangingAdx) primary = 'TRENDING';
  else primary = 'RANGING';

  return {
    primary,
    flags: { trending, ranging, squeeze, volatileExpansion },
    adx,
    atrPercentile,
    bandwidth,
    rangeQuality,
  };
}

function clone(state) {
  return {
    params: { ...state.params },
    bandwidths: state.bandwidths.clone(),
    atrs: state.atrs.clone(),
    signs: state.signs.clone(),
  };
}

module.exports = { init, evaluate, clone, DEFAULTS };
