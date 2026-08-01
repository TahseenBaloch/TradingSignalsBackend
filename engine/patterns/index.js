// Pattern engine: runs every detector, drives the state machines, and keeps the
// per-type completion tallies the UI quotes.
//
// At most ONE forming pattern exists per type at a time. When a detector
// re-proposes a type that is already forming, its geometry is refreshed in
// place rather than a second copy created — that is what makes "show the
// pattern while it develops" mean a shape that tracks the latest fit instead of
// a pile of overlapping near-duplicates. Confirmed patterns are different: they
// are being tracked to resolution and several can be open at once.
const base = require('./base');
const detectors = require('./detectors');
const breakout = require('./breakout');

const DEFAULTS = {
  ...detectors.DEFAULTS,
  formingGraceBars: 3, // keep a shape this long after its detector goes quiet
  maxTracked: 40,
  maxAge: 120, // confirmed patterns expire rather than skew the hit rate
  barRing: 40,
};

/**
 * @typedef {Object} PatternView
 * @property {import('./base').Pattern[]} open       Forming and confirmed.
 * @property {import('./base').Pattern[]} confirmed  Confirmed on THIS bar.
 * @property {import('./base').Pattern[]} resolved   Resolved on THIS bar.
 * @property {object[]} events                       Failed-break reversal risks.
 * @property {Record<string, object>} stats          Per-type completion tallies.
 */

function init(params = {}) {
  return {
    params: { ...DEFAULTS, ...params },
    index: -1,
    seq: 0,
    forming: new Map(), // type -> pattern
    lastSeen: new Map(), // type -> bar index the detector last proposed it
    tracked: [], // confirmed, awaiting resolution
    breakout: breakout.init(params.breakout),
    bars: [],
    stats: new Map(),
  };
}

function tallyFor(state, type) {
  let entry = state.stats.get(type);
  if (!entry) {
    entry = { type, confirmed: 0, target: 0, invalidation: 0, expired: 0 };
    state.stats.set(type, entry);
  }
  return entry;
}

/**
 * Hit rate for a pattern type, or null when the sample is too small to quote.
 *
 * The 30-case floor is Rule 5 applied to patterns: below it the honest answer
 * is "insufficient data", not a number rounded to a percent that happens to be
 * based on four observations.
 */
function hitRate(state, type, minSample = 30) {
  const t = state.stats.get(type);
  if (!t) return null;
  const resolved = t.target + t.invalidation;
  if (resolved < minSample) return { type, sample: resolved, rate: null, insufficient: true };
  return { type, sample: resolved, rate: t.target / resolved, insufficient: false };
}

/**
 * @param {ReturnType<init>} state
 * @param {import('../types').Bar} bar
 * @param {{
 *   atr: number, pivots: object, trendlines: object, zones: object[],
 *   relativeVolume: number|null, nextAbove?: object|null, nextBelow?: object|null,
 *   secondsPerBar?: number
 * }} input
 * @returns {PatternView}
 */
function update(state, bar, input) {
  const p = state.params;
  state.index += 1;
  const index = state.index;

  state.bars.push(bar);
  if (state.bars.length > p.barRing) state.bars.shift();

  const ctx = { ...input, index, bar, bars: state.bars };
  const confirmed = [];
  const resolved = [];

  // --- 1. advance confirmed patterns toward resolution --------------------
  for (const pattern of state.tracked) {
    if (base.track(pattern, bar, { index, maxAge: p.maxAge })) {
      resolved.push(pattern);
      const tally = tallyFor(state, pattern.type);
      tally[pattern.outcome] += 1;
    }
  }
  state.tracked = state.tracked.filter(base.isOpen);

  if (!Number.isFinite(ctx.atr) || ctx.atr <= 0) {
    return view(state, confirmed, resolved, []);
  }

  // --- 2. promote or discard forming patterns -----------------------------
  for (const [type, pattern] of [...state.forming]) {
    const promotion = detectors.promote(pattern, bar, ctx, p);
    if (promotion) {
      base.confirm(pattern, { index, time: bar.time, ...promotion });
      tallyFor(state, type).confirmed += 1;
      state.forming.delete(type);
      state.lastSeen.delete(type);
      state.tracked.push(pattern);
      confirmed.push(pattern);
      continue;
    }

    if (detectors.invalidated(pattern, bar, ctx, p)) {
      state.forming.delete(type);
      state.lastSeen.delete(type);
      continue;
    }

    // A shape whose detector has gone quiet for a few bars is no longer true.
    if (index - (state.lastSeen.get(type) ?? index) > p.formingGraceBars) {
      state.forming.delete(type);
      state.lastSeen.delete(type);
    }
  }

  // --- 3. detect new shapes ------------------------------------------------
  const proposals = [
    detectors.detectRange(ctx, p),
    detectors.detectTriangle(ctx, p),
    detectors.detectDouble(ctx, p, 'high'),
    detectors.detectDouble(ctx, p, 'low'),
    detectors.detectFlag(ctx, p),
  ].filter(Boolean);

  for (const proposal of proposals) {
    state.lastSeen.set(proposal.type, index);
    const existing = state.forming.get(proposal.type);

    if (existing) {
      // Refresh in place so the drawn shape follows the newest fit.
      existing.geometry = proposal.geometry;
      existing.meta = { ...existing.meta, ...proposal.meta };
      existing.trigger = proposal.trigger;
      existing.updatedIndex = index;
      continue;
    }

    state.forming.set(
      proposal.type,
      base.create({ ...proposal, index, time: bar.time, seq: state.seq++ })
    );
  }

  // --- 4. zone breakout machines ------------------------------------------
  const fromBreakout = breakout.update(state.breakout, bar, ctx);
  for (const pattern of fromBreakout.patterns) {
    tallyFor(state, pattern.type).confirmed += 1;
    state.tracked.push(pattern);
    confirmed.push(pattern);
  }

  // Breakout machines resolve their own patterns on the same bar they fail, so
  // sweep for anything they closed before handing back the view.
  for (const pattern of state.tracked) {
    if (base.isResolved(pattern) && !resolved.includes(pattern)) {
      resolved.push(pattern);
      tallyFor(state, pattern.type)[pattern.outcome] += 1;
    }
  }
  state.tracked = state.tracked.filter(base.isOpen);

  if (state.tracked.length > p.maxTracked) {
    state.tracked = state.tracked.slice(-p.maxTracked);
  }

  return view(state, confirmed, resolved, fromBreakout.events);
}

function view(state, confirmed, resolved, events) {
  return {
    open: [...state.forming.values(), ...state.tracked],
    confirmed,
    resolved,
    events,
    stats: Object.fromEntries(state.stats),
  };
}

/** Detached copy — see the lifetime contract on structure/index.js update(). */
function snapshot(v) {
  const copy = (pattern) => ({
    ...pattern,
    geometry: pattern.geometry.map((g) => ({ ...g })),
    meta: { ...pattern.meta },
  });
  return {
    open: v.open.map(copy),
    confirmed: v.confirmed.map(copy),
    resolved: v.resolved.map(copy),
    events: v.events.map((e) => ({ ...e })),
    stats: JSON.parse(JSON.stringify(v.stats)),
  };
}

function clone(state) {
  const copy = (pattern) => ({
    ...pattern,
    geometry: pattern.geometry.map((g) => ({ ...g })),
    meta: { ...pattern.meta },
  });
  const forming = new Map();
  for (const [k, v] of state.forming) forming.set(k, copy(v));
  const stats = new Map();
  for (const [k, v] of state.stats) stats.set(k, { ...v });

  return {
    params: { ...state.params },
    index: state.index,
    seq: state.seq,
    forming,
    lastSeen: new Map(state.lastSeen),
    tracked: state.tracked.map(copy),
    breakout: breakout.clone(state.breakout),
    bars: state.bars.slice(),
    stats,
  };
}

module.exports = {
  init,
  update,
  clone,
  snapshot,
  hitRate,
  STATUS: base.STATUS,
  PATTERN_TYPES: base.PATTERN_TYPES,
  TYPES_BY_ID: base.TYPES_BY_ID,
  PHASE: breakout.PHASE,
  DEFAULTS,
};
