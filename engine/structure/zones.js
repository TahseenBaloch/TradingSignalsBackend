// Support / resistance zones, clustered from confirmed swing pivots.
//
// A zone is a price BAND, not a line: real reactions happen in a neighbourhood,
// and a band is what the Phase 8 ZonePrimitive draws. Bands are sized in ATR so
// the same parameters behave identically on BTC and DOGE.
//
// Role (support vs resistance) is derived from where price currently sits
// relative to the band rather than from the pivot kind that created it. That
// gets role reversal — broken resistance becoming support — for free, with no
// flip bookkeeping to get wrong.
const { resolveParams } = require('../indicators/util');

const DEFAULTS = {
  clusterAtr: 0.5, // a pivot joins a zone if within this x ATR of its centre
  minHalfWidthAtr: 0.15, // floor on band half-width, so one pivot still has a band
  breakAtr: 0.25, // a close this far beyond the band counts as a break through it
  expireBars: 300, // drop a zone untouched for this many bars
  halfLifeBars: 120, // recency half-life used by the strength heuristic
  touchScale: 3, // touches at which the touch term is ~63% saturated
  touchWeight: 0.65,
  recencyWeight: 0.35,
  maxZones: 40,
};

/**
 * @typedef {Object} Zone
 * @property {number} id
 * @property {number} low            Lower edge of the band.
 * @property {number} high           Upper edge of the band.
 * @property {number} centre         Mean of the member pivot prices.
 * @property {'high'|'low'|'both'} origin  Which pivot kinds formed it.
 * @property {'support'|'resistance'|'inside'} role  Relative to the latest close.
 * @property {number} touches        Edge-triggered visits, including the founding pivot.
 * @property {number} pivotCount
 * @property {number} breaks         Decisive closes through the band.
 * @property {number} createdIndex
 * @property {number} createdTime
 * @property {number} lastTouchIndex
 * @property {number} lastTouchTime
 * @property {number} strength       0..1 ranking heuristic — NOT a probability.
 */

/**
 * @typedef {Object} ZoneState
 * @property {typeof DEFAULTS} params
 * @property {Zone[]} zones
 * @property {number} nextId
 */

/**
 * @param {Partial<typeof DEFAULTS>} [params]
 * @returns {ZoneState}
 */
function init(params) {
  return { params: resolveParams(DEFAULTS, params), zones: [], nextId: 1 };
}

/** Internal bookkeeping kept off the public Zone shape. */
function internals(zone) {
  return zone._;
}

function reband(zone, atr, p) {
  const inner = internals(zone);
  const minHalf = p.minHalfWidthAtr * atr;
  const centre = inner.sum / inner.count;
  const half = Math.max(minHalf, (inner.max - inner.min) / 2);
  zone.centre = centre;
  zone.low = centre - half;
  zone.high = centre + half;
}

/**
 * Advances the zone set by one closed bar.
 *
 * @param {ZoneState} state
 * @param {import('../types').Bar} bar
 * @param {{index: number, atr: number, pivots?: import('./pivots').Pivot[]}} ctx
 * @returns {Zone[]} the live zones, strongest first.
 */
function update(state, bar, ctx) {
  const p = state.params;
  const { index, atr } = ctx;
  if (!Number.isFinite(atr) || atr <= 0) return sorted(state.zones);

  // 1. Absorb newly confirmed pivots into the nearest zone, or open a new one.
  for (const pivot of ctx.pivots || []) {
    const tolerance = p.clusterAtr * atr;
    let best = null;
    let bestDistance = Infinity;

    for (const zone of state.zones) {
      const distance = Math.abs(pivot.price - zone.centre);
      if (distance <= tolerance && distance < bestDistance) {
        best = zone;
        bestDistance = distance;
      }
    }

    if (best) {
      const inner = internals(best);
      inner.sum += pivot.price;
      inner.count += 1;
      inner.min = Math.min(inner.min, pivot.price);
      inner.max = Math.max(inner.max, pivot.price);
      best.pivotCount += 1;
      best.touches += 1;
      // The pivot's own bar is the touch, not the bar that confirmed it.
      best.lastTouchIndex = Math.max(best.lastTouchIndex, pivot.index);
      best.lastTouchTime = Math.max(best.lastTouchTime, pivot.time);
      if (best.origin !== pivot.kind) best.origin = 'both';
      reband(best, atr, p);
    } else {
      const zone = {
        id: state.nextId++,
        low: 0,
        high: 0,
        centre: pivot.price,
        origin: pivot.kind,
        role: 'inside',
        touches: 1,
        pivotCount: 1,
        breaks: 0,
        createdIndex: pivot.index,
        createdTime: pivot.time,
        lastTouchIndex: pivot.index,
        lastTouchTime: pivot.time,
        strength: 0,
        _: { sum: pivot.price, count: 1, min: pivot.price, max: pivot.price, inside: false },
      };
      reband(zone, atr, p);
      state.zones.push(zone);
    }
  }

  // 2. Register this bar against every zone.
  for (const zone of state.zones) {
    const inner = internals(zone);
    const intersects = bar.low <= zone.high && bar.high >= zone.low;

    // Edge-triggered: price entering the band is one touch, however many bars
    // it then spends inside. Level-triggering would let a single consolidation
    // inflate a zone to "tested 40 times".
    if (intersects && !inner.inside) {
      zone.touches += 1;
      zone.lastTouchIndex = index;
      zone.lastTouchTime = bar.time;
    }
    inner.inside = intersects;

    const margin = p.breakAtr * atr;
    if (bar.close > zone.high + margin) {
      if (inner.side !== 'above') zone.breaks += 1;
      inner.side = 'above';
      zone.role = 'support'; // price is above it, so it now holds price up
    } else if (bar.close < zone.low - margin) {
      if (inner.side !== 'below') zone.breaks += 1;
      inner.side = 'below';
      zone.role = 'resistance';
    } else {
      zone.role = 'inside';
    }

    const age = index - zone.lastTouchIndex;
    const recency = Math.exp(-age / p.halfLifeBars);
    const touchScore = 1 - Math.exp(-zone.touches / p.touchScale);
    // A ranking heuristic for draw opacity and confluence bonuses. It is
    // deliberately NOT called a probability: under Rule 5 the only numbers
    // shown as probabilities come from measured backtest outcomes.
    zone.strength = p.touchWeight * touchScore + p.recencyWeight * recency;
  }

  // 3. Retire zones nothing has touched in a long time, then cap the set.
  state.zones = state.zones.filter((z) => index - z.lastTouchIndex <= p.expireBars);
  if (state.zones.length > p.maxZones) {
    state.zones = sorted(state.zones).slice(0, p.maxZones);
  }

  return sorted(state.zones);
}

function sorted(zones) {
  return zones.slice().sort((a, b) => b.strength - a.strength || a.id - b.id);
}

/**
 * The zone nearest a price, if any lies within `withinAtr` x ATR of it.
 *
 * @param {ZoneState} state
 * @param {number} price
 * @param {number} atr
 * @param {number} [withinAtr]
 * @returns {Zone|null}
 */
function nearest(state, price, atr, withinAtr = 1) {
  let best = null;
  let bestDistance = Infinity;
  for (const zone of state.zones) {
    // Distance to the BAND, not its centre: price inside the band is at zero.
    const distance = price < zone.low ? zone.low - price : price > zone.high ? price - zone.high : 0;
    if (distance <= withinAtr * atr && distance < bestDistance) {
      best = zone;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The nearest zone strictly above `price` — an overhead obstacle for a long.
 *
 * @param {ZoneState} state
 * @param {number} price
 * @returns {Zone|null}
 */
function nextAbove(state, price) {
  let best = null;
  for (const zone of state.zones) {
    if (zone.low > price && (best === null || zone.low < best.low)) best = zone;
  }
  return best;
}

/**
 * The nearest zone strictly below `price` — the first shelf under a long.
 *
 * @param {ZoneState} state
 * @param {number} price
 * @returns {Zone|null}
 */
function nextBelow(state, price) {
  let best = null;
  for (const zone of state.zones) {
    if (zone.high < price && (best === null || zone.high > best.high)) best = zone;
  }
  return best;
}

/** @param {ZoneState} state @returns {ZoneState} */
function clone(state) {
  return {
    params: { ...state.params },
    nextId: state.nextId,
    zones: state.zones.map((z) => ({ ...z, _: { ...z._ } })),
  };
}

module.exports = { init, update, clone, nearest, nextAbove, nextBelow, DEFAULTS };
