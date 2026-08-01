// Trend state per timeframe: UP, DOWN or RANGE.
//
// Three independent witnesses vote, and no single one can carry the verdict:
//
//   1. EMA stack        9 > 21 > 200 (or the inverse)
//   2. Swing structure  higher highs AND higher lows (or lower/lower)
//   3. Directional      ADX above its floor with +DI/−DI agreeing
//
// Requiring two of three is what stops the classic failure where a 200-EMA
// still sloping up declares "uptrend" through the first leg of a reversal that
// structure and ADX have both already called.
const { resolveParams } = require('../indicators/util');
const pivotsModule = require('./pivots');

const DEFAULTS = { adxFloor: 20, minVotes: 2 };

/**
 * @typedef {Object} TrendState
 * @property {'UP'|'DOWN'|'RANGE'} state
 * @property {number} score   Sum of the three votes, −3..+3.
 * @property {{emaStack: number, structure: number, directional: number}} votes
 * @property {boolean} higherHighs
 * @property {boolean} higherLows
 */

/**
 * Reads the swing sequence: are the last two confirmed highs ascending, and the
 * last two lows? Returns 0 when there is not yet enough structure to say.
 *
 * @param {import('./pivots').PivotState} pivotState
 */
function structureVote(pivotState) {
  const highs = pivotsModule.recent(pivotState, 'high', 2);
  const lows = pivotsModule.recent(pivotState, 'low', 2);
  if (highs.length < 2 || lows.length < 2) {
    return { vote: 0, higherHighs: false, higherLows: false };
  }

  const higherHighs = highs[1].price > highs[0].price;
  const higherLows = lows[1].price > lows[0].price;

  let vote = 0;
  if (higherHighs && higherLows) vote = 1;
  else if (!higherHighs && !higherLows) vote = -1;

  return { vote, higherHighs, higherLows };
}

/**
 * @param {Partial<typeof DEFAULTS>} [params]
 */
function init(params) {
  return { params: resolveParams(DEFAULTS, params) };
}

/**
 * @param {{params: typeof DEFAULTS}} state
 * @param {{
 *   ema9: number|null, ema21: number|null, ema200: number|null,
 *   adx: import('../indicators/adx').AdxValue|null,
 *   pivots: import('./pivots').PivotState
 * }} ctx
 * @returns {TrendState}
 */
function evaluate(state, ctx) {
  const p = state.params;

  let emaStack = 0;
  if (ctx.ema9 !== null && ctx.ema21 !== null && ctx.ema200 !== null) {
    if (ctx.ema9 > ctx.ema21 && ctx.ema21 > ctx.ema200) emaStack = 1;
    else if (ctx.ema9 < ctx.ema21 && ctx.ema21 < ctx.ema200) emaStack = -1;
  }

  const structure = structureVote(ctx.pivots);

  let directional = 0;
  if (ctx.adx && ctx.adx.adx !== null && ctx.adx.adx >= p.adxFloor) {
    directional = ctx.adx.plusDI > ctx.adx.minusDI ? 1 : -1;
  }

  const votes = { emaStack, structure: structure.vote, directional };
  const score = emaStack + structure.vote + directional;

  let result = 'RANGE';
  if (score >= p.minVotes) result = 'UP';
  else if (score <= -p.minVotes) result = 'DOWN';

  return {
    state: result,
    score,
    votes,
    higherHighs: structure.higherHighs,
    higherLows: structure.higherLows,
  };
}

function clone(state) {
  return { params: { ...state.params } };
}

module.exports = { init, evaluate, clone, structureVote, DEFAULTS };
