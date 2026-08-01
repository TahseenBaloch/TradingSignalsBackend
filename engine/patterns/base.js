// Shared lifecycle for every chart pattern.
//
// Each pattern is an explicit state machine, never a one-shot check, so the
// frontend can draw one while it develops:
//
//   FORMING     geometry exists, nothing has triggered yet
//   CONFIRMED   the trigger fired; direction, target and invalidation are set
//   COMPLETED   target reached first
//   FAILED      invalidation reached first
//   EXPIRED     neither happened within maxAge bars
//
// The transition into CONFIRMED is the moment the backtester measures from, and
// the COMPLETED/FAILED split is the per-pattern hit rate the UI quotes ("target
// hit 54% of 122 cases"). EXPIRED exists so a pattern that simply drifts
// sideways forever cannot sit open and quietly flatter the hit rate by never
// being counted as a miss.

const STATUS = {
  FORMING: 'forming',
  CONFIRMED: 'confirmed',
  COMPLETED: 'completed',
  FAILED: 'failed',
  EXPIRED: 'expired',
};

/**
 * Registry of pattern types. Phase 8 hangs a per-type visibility toggle off
 * each id, so anything drawable must be listed here.
 */
const PATTERN_TYPES = [
  { id: 'range-box', label: 'Range Box', directional: false },
  { id: 'ascending-triangle', label: 'Ascending Triangle', directional: true },
  { id: 'descending-triangle', label: 'Descending Triangle', directional: true },
  { id: 'symmetrical-triangle', label: 'Symmetrical Triangle', directional: false },
  { id: 'breakout-retest', label: 'Breakout / Retest', directional: true },
  { id: 'double-top', label: 'Double Top', directional: true },
  { id: 'double-bottom', label: 'Double Bottom', directional: true },
  { id: 'bull-flag', label: 'Bull Flag', directional: true },
  { id: 'bear-flag', label: 'Bear Flag', directional: true },
];

const TYPES_BY_ID = new Map(PATTERN_TYPES.map((t) => [t.id, t]));

/**
 * @typedef {Object} PatternPoint
 * @property {number} time
 * @property {number} price
 * @property {string} [role]  Optional label, e.g. 'neckline', 'apex'.
 */

/**
 * @typedef {Object} Pattern
 * @property {string} id
 * @property {string} type
 * @property {string} status
 * @property {'long'|'short'|'neutral'} direction
 * @property {PatternPoint[]} geometry     Everything needed to draw it.
 * @property {number|null} trigger         Price whose breach confirms it.
 * @property {number|null} target          Measured move, set at confirmation.
 * @property {number|null} invalidation    Thesis-dead level, set at confirmation.
 * @property {number} createdIndex
 * @property {number} createdTime
 * @property {number} updatedIndex
 * @property {number|null} confirmedIndex
 * @property {number|null} confirmedTime
 * @property {number|null} resolvedIndex
 * @property {number|null} resolvedTime
 * @property {'target'|'invalidation'|'expired'|null} outcome
 * @property {number|null} barsToResolve
 * @property {Record<string, any>} meta
 */

/**
 * @param {{
 *   type: string, direction?: string, geometry?: PatternPoint[],
 *   trigger?: number|null, index: number, time: number, meta?: object, seq: number
 * }} spec
 * @returns {Pattern}
 */
function create(spec) {
  return {
    // Deterministic and collision-free: type plus the creating bar plus a
    // monotonic sequence. No clock, no randomness (Rule 6).
    id: `${spec.type}:${spec.index}:${spec.seq}`,
    type: spec.type,
    status: STATUS.FORMING,
    direction: spec.direction || 'neutral',
    geometry: spec.geometry || [],
    trigger: spec.trigger ?? null,
    target: null,
    invalidation: null,
    createdIndex: spec.index,
    createdTime: spec.time,
    updatedIndex: spec.index,
    confirmedIndex: null,
    confirmedTime: null,
    resolvedIndex: null,
    resolvedTime: null,
    outcome: null,
    barsToResolve: null,
    meta: spec.meta || {},
  };
}

/**
 * Fires the trigger. Direction, target and invalidation only become real here —
 * before confirmation a pattern is a shape, not a trade thesis.
 */
function confirm(pattern, { index, time, direction, target, invalidation, entry }) {
  pattern.status = STATUS.CONFIRMED;
  pattern.direction = direction;
  pattern.target = target;
  pattern.invalidation = invalidation;
  pattern.confirmedIndex = index;
  pattern.confirmedTime = time;
  pattern.updatedIndex = index;
  if (entry !== undefined) pattern.meta.entry = entry;
  return pattern;
}

function resolve(pattern, outcome, { index, time }) {
  pattern.status =
    outcome === 'target' ? STATUS.COMPLETED : outcome === 'expired' ? STATUS.EXPIRED : STATUS.FAILED;
  pattern.outcome = outcome;
  pattern.resolvedIndex = index;
  pattern.resolvedTime = time;
  pattern.updatedIndex = index;
  pattern.barsToResolve = pattern.confirmedIndex === null ? null : index - pattern.confirmedIndex;
  return pattern;
}

/**
 * Advances a CONFIRMED pattern toward resolution using one closed bar.
 *
 * When a single bar touches BOTH target and invalidation, the invalidation
 * wins. That is the same pessimistic intrabar convention the Phase 7 backtester
 * uses for stop-versus-target, and the two must agree: if pattern stats were
 * measured optimistically while trades were filled pessimistically, the
 * "probability" the UI quotes would be systematically better than anything the
 * strategy could actually capture.
 *
 * @returns {boolean} true if this bar resolved the pattern.
 */
function track(pattern, bar, { index, maxAge }) {
  if (pattern.status !== STATUS.CONFIRMED) return false;
  pattern.updatedIndex = index;

  const long = pattern.direction === 'long';
  const hitTarget =
    pattern.target !== null && (long ? bar.high >= pattern.target : bar.low <= pattern.target);
  const hitInvalidation =
    pattern.invalidation !== null &&
    (long ? bar.low <= pattern.invalidation : bar.high >= pattern.invalidation);

  if (hitInvalidation) {
    resolve(pattern, 'invalidation', { index, time: bar.time });
    return true;
  }
  if (hitTarget) {
    resolve(pattern, 'target', { index, time: bar.time });
    return true;
  }
  if (maxAge && index - pattern.confirmedIndex >= maxAge) {
    resolve(pattern, 'expired', { index, time: bar.time });
    return true;
  }
  return false;
}

const isOpen = (p) => p.status === STATUS.FORMING || p.status === STATUS.CONFIRMED;
const isResolved = (p) => !isOpen(p);

module.exports = {
  STATUS,
  PATTERN_TYPES,
  TYPES_BY_ID,
  create,
  confirm,
  resolve,
  track,
  isOpen,
  isResolved,
};
