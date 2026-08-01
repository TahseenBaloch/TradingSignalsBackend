// Fractal swing pivots.
//
// A pivot high is a bar whose high exceeds the `lookback` bars on each side; a
// pivot low mirrors it. The consequence that matters more than the definition:
// a pivot CANNOT be known until `lookback` bars after it printed, because the
// bars to its right have not happened yet.
//
// That delay is the whole no-repaint story for market structure (Rule 1). Every
// emitted pivot therefore carries `index` (when it happened), `confirmedIndex`
// (when we were allowed to know), and `barsDelayed`, so the UI can draw it as
// confirmed-in-hindsight rather than implying we saw it live.
const { resolveParams } = require('../indicators/util');

const DEFAULTS = { lookback: 5, maxPivots: 500 };

/**
 * @typedef {Object} Pivot
 * @property {'high'|'low'} kind
 * @property {number} index            Bar index of the pivot itself.
 * @property {number} time             Bar time of the pivot itself.
 * @property {number} price            The high (kind 'high') or low (kind 'low').
 * @property {number} confirmedIndex   Bar index at which it became knowable.
 * @property {number} confirmedTime    Bar time at which it became knowable.
 * @property {number} barsDelayed      confirmedIndex − index. Always `lookback`.
 */

/**
 * @typedef {Object} PivotState
 * @property {number} lookback
 * @property {number} maxPivots
 * @property {{index: number, bar: import('../types').Bar}[]} buffer
 * @property {number} barIndex
 * @property {Pivot[]} highs
 * @property {Pivot[]} lows
 */

/**
 * @param {{lookback?: number, maxPivots?: number}} [params]
 * @returns {PivotState}
 */
function init(params) {
  const { lookback, maxPivots } = resolveParams(DEFAULTS, params);
  return { lookback, maxPivots, buffer: [], barIndex: -1, highs: [], lows: [] };
}

function trim(list, max) {
  if (list.length > max) list.splice(0, list.length - max);
}

/**
 * Feeds one closed bar.
 *
 * @param {PivotState} state
 * @param {import('../types').Bar} bar
 * @returns {Pivot[]} pivots CONFIRMED by this bar — normally empty. The pivot
 *   itself sits `lookback` bars in the past.
 */
function update(state, bar) {
  state.barIndex += 1;
  state.buffer.push({ index: state.barIndex, bar });

  const span = 2 * state.lookback + 1;
  if (state.buffer.length > span) state.buffer.shift();
  if (state.buffer.length < span) return [];

  const centre = state.buffer[state.lookback];
  const found = [];

  // Ties are broken by direction: a bar must be >= its left neighbours but
  // strictly > its right ones. A flat top like [4,5,5,4] then resolves to the
  // LAST bar of the plateau rather than emitting two pivots or none. The rule
  // is arbitrary but it must be fixed, or the same plateau would produce
  // different structure on a replay (Rule 6).
  let isHigh = true;
  let isLow = true;
  for (let i = 0; i < span && (isHigh || isLow); i += 1) {
    if (i === state.lookback) continue;
    const other = state.buffer[i].bar;
    const left = i < state.lookback;

    if (isHigh && (left ? centre.bar.high < other.high : centre.bar.high <= other.high)) {
      isHigh = false;
    }
    if (isLow && (left ? centre.bar.low > other.low : centre.bar.low >= other.low)) {
      isLow = false;
    }
  }

  // A single wide bar can top and bottom its neighbourhood at once. Both are
  // real and both are emitted.
  if (isHigh) found.push(makePivot('high', centre, centre.bar.high, state, bar));
  if (isLow) found.push(makePivot('low', centre, centre.bar.low, state, bar));

  for (const pivot of found) {
    if (pivot.kind === 'high') state.highs.push(pivot);
    else state.lows.push(pivot);
  }
  trim(state.highs, state.maxPivots);
  trim(state.lows, state.maxPivots);

  return found;
}

function makePivot(kind, centre, price, state, confirmingBar) {
  return {
    kind,
    index: centre.index,
    time: centre.bar.time,
    price,
    confirmedIndex: state.barIndex,
    confirmedTime: confirmingBar.time,
    barsDelayed: state.lookback,
  };
}

/**
 * The most recent `count` confirmed pivots of one kind, oldest first.
 *
 * @param {PivotState} state
 * @param {'high'|'low'} kind
 * @param {number} count
 * @returns {Pivot[]}
 */
function recent(state, kind, count) {
  const list = kind === 'high' ? state.highs : state.lows;
  return count >= list.length ? list.slice() : list.slice(list.length - count);
}

/** @param {PivotState} state @returns {PivotState} */
function clone(state) {
  return {
    lookback: state.lookback,
    maxPivots: state.maxPivots,
    buffer: state.buffer.map((e) => ({ index: e.index, bar: e.bar })),
    barIndex: state.barIndex,
    highs: state.highs.slice(),
    lows: state.lows.slice(),
  };
}

/**
 * Batch helper. Returns one entry per bar holding that bar's newly confirmed
 * pivots, mirroring the indicator library's alignment convention.
 *
 * @param {readonly import('../types').Bar[]} bars
 * @param {{lookback?: number, maxPivots?: number}} [params]
 * @returns {Pivot[][]}
 */
function batch(bars, params) {
  const state = init(params);
  return bars.map((bar) => update(state, bar));
}

module.exports = { init, update, clone, batch, recent, DEFAULTS };
