// Strategy registry and runner.
//
// The common interface the spec defines:
//
//   { id, requiredTimeframes, allowedRegimes, evaluate(ctx) -> StrategySignal|null }
//
// Descriptive fields are read from config rather than restated here, so there
// is one place to change a strategy's timeframes or regime gate.
const modules = require('./modules');
const ladder = require('./ladder');

/**
 * @typedef {Object} StrategySignal
 * @property {'long'|'short'} direction
 * @property {number} score              0-100 conviction from this strategy.
 * @property {number} entry
 * @property {[number,number,number]} stops    [SL1, SL2, SL3]
 * @property {[number,number,number]} targets  [TP1, TP2, TP3]
 * @property {number} r
 * @property {import('./modules').EvidenceItem[]} reasons
 */

/**
 * @typedef {Object} MarketContext
 * @property {string} symbol
 * @property {string} timeframe
 * @property {number} index
 * @property {import('../types').Bar} bar        The bar that just CLOSED.
 * @property {import('../types').Bar[]} bars     Recent closed bars.
 * @property {number|null} atr
 * @property {number|null} rsi
 * @property {object|null} macd
 * @property {object|null} adx
 * @property {object|null} bollinger
 * @property {object|null} stochastic
 * @property {object|null} supertrend
 * @property {object|null} volume
 * @property {object|null} vwapSession
 * @property {object|null} vwapRolling
 * @property {Record<number, number|null>} ema   Keyed by period: 9, 21, 50, 200.
 * @property {object} structure                  StructureView.
 * @property {object[]} candles                  This bar's candle signals.
 * @property {object} patterns                   PatternView.
 * @property {Record<string, object>} bias       Bias-timeframe snapshots.
 * @property {object} config                     Resolved config for the preset.
 */

const ORDER = ['s1', 's2', 's3', 's4', 's5', 's6'];

/** Descriptor for one strategy, resolved against a config. */
function describe(key, config) {
  const cfg = config.strategies[key];
  return {
    key,
    id: cfg.id,
    name: cfg.name,
    enabled: cfg.enabled,
    weight: cfg.weight,
    biasOnly: Boolean(cfg.biasOnly),
    requiredTimeframes: cfg.timeframes,
    allowedRegimes: cfg.allowedRegimes || [],
  };
}

/** Every strategy descriptor, in a stable order. */
function list(config) {
  return ORDER.map((key) => describe(key, config));
}

/**
 * Creates runner state. One instance per symbol x timeframe: strategies keep
 * per-series memory (S2's previous RSI, S4's session ranges, S6's cooldowns),
 * and sharing it across symbols would leak one symbol's state into another's
 * signals.
 */
function init(config) {
  const states = {};
  for (const key of ORDER) states[key] = modules[key].initState();
  return { config, states };
}

/**
 * Runs every strategy over one bar's context.
 *
 * @param {ReturnType<init>} state
 * @param {MarketContext} ctx
 * @returns {{signals: {key: string, id: string, weight: number, signal: StrategySignal}[], bias: {score: number, reasons: object[]}|null}}
 */
function run(state, ctx) {
  const signals = [];
  let bias = null;

  for (const key of ORDER) {
    const cfg = ctx.config.strategies[key];
    if (!cfg.enabled) continue;

    const module = modules[key];
    const out = module.evaluate(ctx, state.states[key]);
    if (!out) continue;

    if (module.biasOnly) {
      bias = { score: out.bias, reasons: out.reasons };
      continue;
    }

    // A strategy below the preset's conviction floor is silent rather than
    // contributing a weak vote — this floor is one of the cadence levers.
    if (out.score < ctx.config.limits.minStrategyScore) continue;

    signals.push({ key, id: cfg.id, weight: cfg.weight, signal: out });
  }

  return { signals, bias };
}

function clone(state) {
  const states = {};
  for (const key of ORDER) {
    const s = state.states[key];
    states[key] =
      s && s.sessions instanceof Map ? { ...s, sessions: new Map(s.sessions) } : { ...s };
  }
  return { config: state.config, states };
}

module.exports = { init, run, clone, list, describe, ORDER, modules, ladder };
