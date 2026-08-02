// The per symbol x timeframe analyser: bar in, SignalEvent out.
//
// This is the ONE place that wires indicators -> structure -> candles ->
// patterns -> strategies -> confluence, and both the live pipeline (Phase 9)
// and the backtester (Phase 7) drive it. That is Rule 3 made concrete: there is
// no second assembly of these parts that could evolve its own behaviour.
//
// It owns every incremental indicator state, so feeding one bar is O(1) rather
// than a recompute over history.
const indicators = require('./indicators');
const structure = require('./structure');
const candles = require('./candles');
const patterns = require('./patterns');
const strategies = require('./strategies');
const confluence = require('./confluence');

/**
 * @typedef {Object} BiasSnapshot
 * @property {number} close
 * @property {number|null} ema50
 * @property {number|null} ema200
 * @property {object|null} supertrend
 * @property {object|null} adx
 * @property {object} trend
 * @property {object} regime
 * @property {number} barTime  The bar this snapshot describes — callers MUST
 *   check it is not in the future relative to the bar they are analysing.
 */

/**
 * @param {{symbol: string, timeframe: string, config: object, barRing?: number}} spec
 */
function createAnalyzer(spec) {
  const { config } = spec;
  const ind = config.indicators;

  return {
    symbol: spec.symbol,
    timeframe: spec.timeframe,
    config,
    index: -1,
    barRing: spec.barRing ?? 60,
    bars: [],

    indicators: {
      atr: indicators.atr.init(ind.atr),
      adx: indicators.adx.init(ind.adx),
      rsi: indicators.rsi.init(ind.rsi),
      macd: indicators.macd.init(ind.macd),
      bollinger: indicators.bollinger.init(ind.bollinger),
      stochastic: indicators.stochastic.init(ind.stochastic),
      supertrend: indicators.supertrend.init(ind.supertrend),
      volume: indicators.volume.init(ind.volume),
      vwapSession: indicators.vwapSession.init(ind.vwapSession),
      vwapRolling: indicators.vwapRolling.init(ind.vwapRolling),
      ema: Object.fromEntries(ind.ema.map((period) => [period, indicators.ema.init({ period })])),
    },

    structure: structure.init(config.structure),
    candles: candles.init(config.candles),
    patterns: patterns.init(config.patterns),
    strategies: strategies.init(config),

    latest: null, // the most recent MarketContext, for bias snapshots
  };
}

/** Nearest zone to a price, for the candle classifier's context. */
function nearestZone(zones, price) {
  let best = null;
  let bestDistance = Infinity;
  for (const zone of zones) {
    const distance = price < zone.low ? zone.low - price : price > zone.high ? price - zone.high : 0;
    if (distance < bestDistance) {
      best = zone;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Feeds one CLOSED bar through the whole engine.
 *
 * @param {ReturnType<createAnalyzer>} state
 * @param {import('./types').Bar} bar
 * @param {Object} [options]
 * @param {Record<string, BiasSnapshot>} [options.bias]  Higher-timeframe context.
 *   Every snapshot MUST come from a bar that already closed at or before this
 *   one; supplying a later bar is lookahead and silently invalidates everything
 *   downstream. The backtester enforces this when it aligns timeframes.
 * @param {object} [options.store]  Probability store (engine/stats.js).
 * @param {boolean} [options.provisional]  Forming-bar recomputation.
 * @returns {{ctx: object, view: object, signals: object[], event: object|null}}
 */
function update(state, bar, options = {}) {
  state.index += 1;
  state.bars.push(bar);
  if (state.bars.length > state.barRing) state.bars.shift();

  const I = state.indicators;
  const atr = indicators.atr.update(I.atr, bar);
  const adx = indicators.adx.update(I.adx, bar);
  const bollinger = indicators.bollinger.update(I.bollinger, bar);
  const volume = indicators.volume.update(I.volume, bar);

  const ema = {};
  for (const [period, emaState] of Object.entries(I.ema)) {
    ema[period] = indicators.ema.update(emaState, bar.close);
  }

  const view = structure.update(state.structure, bar, {
    atr,
    adx,
    bollinger,
    ema9: ema[9] ?? null,
    ema21: ema[21] ?? null,
    ema200: ema[200] ?? null,
  });

  const relativeVolume = volume ? volume.relative : null;
  const candleSignals = candles.update(state.candles, bar, {
    index: state.index,
    atr,
    zone: nearestZone(view.zones, bar.close),
    relativeVolume,
  });

  const patternView = patterns.update(state.patterns, bar, {
    atr,
    pivots: view.pivots,
    trendlines: view.trendlines,
    zones: view.zones,
    relativeVolume,
    nextAbove: view.zones.filter((z) => z.low > bar.close).sort((a, b) => a.low - b.low)[0] || null,
    nextBelow: view.zones.filter((z) => z.high < bar.close).sort((a, b) => b.high - a.high)[0] || null,
    secondsPerBar: state.config.timeframes.seconds[state.timeframe] || 0,
  });

  const ctx = {
    symbol: state.symbol,
    timeframe: state.timeframe,
    index: state.index,
    bar,
    bars: state.bars,
    atr,
    adx,
    bollinger,
    volume,
    ema,
    rsi: indicators.rsi.update(I.rsi, bar),
    macd: indicators.macd.update(I.macd, bar),
    stochastic: indicators.stochastic.update(I.stochastic, bar),
    supertrend: indicators.supertrend.update(I.supertrend, bar),
    vwapSession: indicators.vwapSession.update(I.vwapSession, bar),
    vwapRolling: indicators.vwapRolling.update(I.vwapRolling, bar),
    structure: view,
    candles: candleSignals,
    patterns: patternView,
    bias: options.bias || {},
    config: state.config,
  };

  state.latest = ctx;

  const { signals, bias } = strategies.run(state.strategies, ctx);
  const event = confluence.evaluate({
    signals,
    bias,
    ctx,
    store: options.store || { minSample: Infinity, buckets: {} },
    provisional: Boolean(options.provisional),
  });

  return { ctx, view, patterns: patternView, candles: candleSignals, signals, event };
}

/**
 * The snapshot lower timeframes consume as bias. Carries its own bar time so a
 * consumer can assert it is not reading the future.
 *
 * @param {ReturnType<createAnalyzer>} state
 * @returns {BiasSnapshot|null}
 */
function biasOf(state) {
  const ctx = state.latest;
  if (!ctx) return null;
  return {
    close: ctx.bar.close,
    barTime: ctx.bar.time,
    ema50: ctx.ema[50] ?? null,
    ema200: ctx.ema[200] ?? null,
    supertrend: ctx.supertrend,
    adx: ctx.adx,
    trend: ctx.structure.trend,
    regime: ctx.structure.regime,
  };
}

/**
 * Forks an analyser. Walk-forward windows and the no-lookahead test both need
 * to branch a warmed-up engine without the branches contaminating each other.
 */
function clone(state) {
  const I = state.indicators;
  const ema = {};
  for (const [period, emaState] of Object.entries(I.ema)) ema[period] = indicators.ema.clone(emaState);

  return {
    ...state,
    bars: state.bars.slice(),
    indicators: {
      atr: indicators.atr.clone(I.atr),
      adx: indicators.adx.clone(I.adx),
      rsi: indicators.rsi.clone(I.rsi),
      macd: indicators.macd.clone(I.macd),
      bollinger: indicators.bollinger.clone(I.bollinger),
      stochastic: indicators.stochastic.clone(I.stochastic),
      supertrend: indicators.supertrend.clone(I.supertrend),
      volume: indicators.volume.clone(I.volume),
      vwapSession: indicators.vwapSession.clone(I.vwapSession),
      vwapRolling: indicators.vwapRolling.clone(I.vwapRolling),
      ema,
    },
    structure: structure.clone(state.structure),
    candles: candles.clone(state.candles),
    patterns: patterns.clone(state.patterns),
    strategies: strategies.clone(state.strategies),
    latest: null,
  };
}

module.exports = { createAnalyzer, update, biasOf, clone };
