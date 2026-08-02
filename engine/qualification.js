// Rule 7 enforcement at runtime.
//
// "A strategy config only qualifies as 'active' if out-of-sample profit factor
// >= 1.2 with >= 50 trades." The seed run measures that; this module is what
// makes it BINDING rather than advisory.
//
// The default is DISABLED. A configuration is live only if the seed explicitly
// recorded it as qualifying — an unmeasured config is not an innocent one, and
// defaulting to enabled would mean any strategy that was never backtested (or
// whose seed run silently produced zero trades, as S6 once did) would ship live
// on no evidence at all.
//
// Nothing is hidden: `describe()` returns the measured stats for every config
// including the failing ones, so the UI can show exactly why something is off.

/**
 * @typedef {Object} QualificationEntry
 * @property {string} key
 * @property {boolean} qualified
 * @property {number} trades
 * @property {number|null} profitFactor
 * @property {number|null} expectancyR
 * @property {string[]} reasons     Empty when qualified.
 */

const keyOf = ({ symbol, timeframe, preset, strategyId }) =>
  [symbol || '*', timeframe || '*', preset || '*', strategyId || '*'].join('|');

function create(seed = {}) {
  return { entries: { ...(seed.entries || {}) }, generatedAtBarTime: seed.generatedAtBarTime ?? null };
}

function record(store, spec, metrics, rule) {
  const reasons = [];
  if (metrics.trades < rule.minTrades) {
    reasons.push(`only ${metrics.trades} out-of-sample trades (need ${rule.minTrades})`);
  }
  if (metrics.profitFactor === null || metrics.profitFactor < rule.minProfitFactor) {
    const shown = metrics.profitFactor === null ? 'n/a' : metrics.profitFactor.toFixed(2);
    reasons.push(`out-of-sample profit factor ${shown} (need ${rule.minProfitFactor})`);
  }

  store.entries[keyOf(spec)] = {
    key: keyOf(spec),
    ...spec,
    qualified: reasons.length === 0,
    trades: metrics.trades,
    profitFactor: metrics.profitFactor,
    expectancyR: metrics.expectancyR,
    winRate: metrics.winRate,
    costPerTradeR: metrics.costPerTradeR,
    reasons,
  };
  return store;
}

/**
 * Is this configuration allowed to emit live signals?
 *
 * Falls back from the most specific key to the least, so a symbol-specific
 * result beats a general one. Absent at every level means NOT qualified.
 */
function isActive(store, spec) {
  const candidates = [
    keyOf(spec),
    keyOf({ ...spec, strategyId: null }),
    keyOf({ ...spec, symbol: null, strategyId: null }),
  ];
  for (const key of candidates) {
    const entry = store.entries[key];
    if (entry) return entry.qualified;
  }
  return false; // unmeasured is not innocent
}

/** The stats behind a decision, for the UI to show alongside a disabled toggle. */
function describe(store, spec) {
  const candidates = [keyOf(spec), keyOf({ ...spec, strategyId: null })];
  for (const key of candidates) {
    if (store.entries[key]) return store.entries[key];
  }
  return {
    key: keyOf(spec),
    ...spec,
    qualified: false,
    trades: 0,
    profitFactor: null,
    expectancyR: null,
    reasons: ['never backtested'],
  };
}

/** Every recorded config, qualified or not — the Backtest page's source table. */
function list(store) {
  return Object.values(store.entries).sort(
    (a, b) => Number(b.qualified) - Number(a.qualified) || (b.profitFactor ?? -1) - (a.profitFactor ?? -1)
  );
}

const summary = (store) => {
  const all = list(store);
  return { total: all.length, qualified: all.filter((e) => e.qualified).length };
};

module.exports = { create, record, isActive, describe, list, summary, keyOf };
