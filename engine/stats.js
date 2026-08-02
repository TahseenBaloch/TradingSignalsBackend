// The measured-probability store.
//
// Rule 5, in one place: the "probability" attached to a signal is the HISTORICAL
// WIN RATE of that signal configuration from stored backtest results, shown with
// its sample size. Nothing here invents, smooths or extrapolates a number.
//
// Buckets are keyed by strategy x direction x regime, which is the granularity
// the spec asks for. A key with fewer than `minSample` resolved trades reports
// `insufficient: true` and a null rate — the UI must then print "insufficient
// data" rather than a percentage derived from four observations.
//
// The store is plain serialisable data so it can round-trip through disk or
// Redis unchanged, and so the backtester can build one offline and the live
// pipeline can read it without either knowing about the other.

const DEFAULT_MIN_SAMPLE = 30;

/**
 * @typedef {Object} Bucket
 * @property {number} wins
 * @property {number} losses
 * @property {number} sumR     Total R across resolved trades, for expectancy.
 */

/**
 * @typedef {Object} Probability
 * @property {number|null} winRate   0..1, or null when the sample is too small.
 * @property {number} sample
 * @property {boolean} insufficient
 * @property {number|null} expectancyR
 * @property {string} label          Ready-to-render, e.g. "58% over 214 trades".
 */

function keyOf({ strategyId, direction, regime }) {
  return `${strategyId}|${direction}|${regime || 'ANY'}`;
}

/**
 * @param {{minSample?: number, buckets?: Record<string, Bucket>}} [seed]
 */
function create(seed = {}) {
  return {
    minSample: seed.minSample ?? DEFAULT_MIN_SAMPLE,
    buckets: { ...(seed.buckets || {}) },
  };
}

/**
 * Records one RESOLVED trade. Open positions are never counted: including them
 * would let a losing trade that has not closed yet flatter the win rate.
 *
 * @param {ReturnType<create>} store
 * @param {{strategyId: string, direction: string, regime: string, won: boolean, r: number}} outcome
 */
function record(store, outcome) {
  const key = keyOf(outcome);
  const bucket = store.buckets[key] || (store.buckets[key] = { wins: 0, losses: 0, sumR: 0 });
  if (outcome.won) bucket.wins += 1;
  else bucket.losses += 1;
  if (Number.isFinite(outcome.r)) bucket.sumR += outcome.r;
  return store;
}

/**
 * @param {ReturnType<create>} store
 * @param {{strategyId: string, direction: string, regime: string}} query
 * @returns {Probability}
 */
function lookup(store, query) {
  const bucket = store.buckets[keyOf(query)];
  const sample = bucket ? bucket.wins + bucket.losses : 0;

  if (sample < store.minSample) {
    return {
      winRate: null,
      sample,
      insufficient: true,
      expectancyR: null,
      label: 'insufficient data',
    };
  }

  const winRate = bucket.wins / sample;
  return {
    winRate,
    sample,
    insufficient: false,
    expectancyR: bucket.sumR / sample,
    label: `${Math.round(winRate * 100)}% over ${sample} trades`,
  };
}

/**
 * Probability for a whole SignalEvent: the sample-weighted blend of its
 * contributing strategies' buckets.
 *
 * Blending only ever uses buckets that individually clear the sample floor.
 * Pooling thin buckets to manufacture a quotable sample is exactly the kind of
 * smoothing Rule 5 forbids, and it would let three 8-trade buckets masquerade
 * as one 24-trade measurement.
 *
 * @param {ReturnType<create>} store
 * @param {{strategyId: string, direction: string, regime: string}[]} contributors
 * @returns {Probability}
 */
function blend(store, contributors) {
  const usable = contributors
    .map((c) => lookup(store, c))
    .filter((p) => !p.insufficient);

  if (usable.length === 0) {
    const sample = contributors.reduce((sum, c) => sum + lookup(store, c).sample, 0);
    return { winRate: null, sample, insufficient: true, expectancyR: null, label: 'insufficient data' };
  }

  const totalSample = usable.reduce((sum, p) => sum + p.sample, 0);
  const winRate = usable.reduce((sum, p) => sum + p.winRate * p.sample, 0) / totalSample;
  const expectancyR = usable.reduce((sum, p) => sum + p.expectancyR * p.sample, 0) / totalSample;

  return {
    winRate,
    sample: totalSample,
    insufficient: false,
    expectancyR,
    label: `${Math.round(winRate * 100)}% over ${totalSample} trades`,
  };
}

/** Serialisable snapshot, for the disk/Redis store. */
function toJSON(store) {
  return { minSample: store.minSample, buckets: store.buckets };
}

module.exports = { create, record, lookup, blend, keyOf, toJSON, DEFAULT_MIN_SAMPLE };
