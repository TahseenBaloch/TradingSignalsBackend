// THE config file. Everything tunable lives here: timeframes, indicator
// periods, structure and pattern parameters, all six strategies, confluence
// weights and thresholds, sensitivity presets, costs, and walk-forward windows.
// Strategy files read from this and hardcode nothing.
//
// Deliberately dependency-free plain JS so the browser can import it alongside
// the rest of the engine. Runtime validation (zod) and hot reloading live in
// backend/config-validate.js, outside the pure engine.
//
// Symbols are NOT listed here. backend/symbols.js already owns the tradable
// universe, and duplicating it would create two places to add a pair. The
// engine is handed symbol ids and stays agnostic.

/** Timeframes the engine reasons about. Tokens must match backend/intervals.js. */
const TIMEFRAMES = {
  // Where entries are generated. This is a scalping tool; these are the point.
  entry: ['1m', '5m', '15m'],
  // Context only. These may filter or weight a signal but must never be its
  // sole source — a strategy whose natural cadence is one signal a day is not
  // an acceptable primary output.
  bias: ['15m', '1h', '4h'],
  // Which bias timeframe each entry timeframe defers to.
  biasFor: { '1m': '15m', '5m': '15m', '15m': '1h' },
  seconds: { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1D': 86400, '1W': 604800 },
};

const INDICATORS = {
  ema: [9, 21, 50, 200],
  rsi: { period: 14 },
  macd: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
  atr: { period: 14 },
  adx: { period: 14 },
  bollinger: { period: 20, stdDev: 2 },
  vwapRolling: { period: 20, deviations: [1, 2, 3] },
  vwapSession: { deviations: [1, 2, 3] },
  supertrend: { atrPeriod: 10, multiplier: 3.0 },
  stochastic: { period: 14, smoothK: 3, smoothD: 3 },
  volume: { period: 20 },
};

const STRUCTURE = {
  pivots: { lookback: 5, maxPivots: 500 },
  zones: {
    clusterAtr: 0.5,
    minHalfWidthAtr: 0.15,
    breakAtr: 0.25,
    expireBars: 300,
    halfLifeBars: 120,
    maxZones: 40,
  },
  trendlines: { poolSize: 8, minTouches: 3, toleranceAtr: 0.35, breakAtr: 0.25 },
  trend: { adxFloor: 20, minVotes: 2 },
  regime: {
    trendingAdx: 25,
    rangingAdx: 20,
    squeezeLookback: 20,
    atrLookback: 100,
    expansionPercentile: 80,
    oscillationLookback: 20,
    oscillationTarget: 5,
  },
};

const CANDLES = {
  minRangeAtr: 0.3,
  wickToBody: 2.0,
  zoneProximityAtr: 0.5,
  highVolume: 1.5,
};

const PATTERNS = {
  breakoutAtr: 0.25,
  failbackAtr: 0.5,
  minHeightAtr: 1.0,
  impulseAtr: 2.0,
  maxAge: 120,
};

// ---------------------------------------------------------------------------
// TP / SL ladder
// ---------------------------------------------------------------------------

const LADDER = {
  // Minimum separation between adjacent rungs, so monotonicity survives
  // rounding and two levels never collapse onto each other.
  minGapAtr: 0.05,
  structuralPadAtr: 0.5, // SL2 clears the zone or pivot by this much
  sl3FallbackR: 2.0, // invalidation fallback = entry -/+ 2R
  tp2MinR: 1.5, // spec: TP2 is never closer than 1.5R
  tp2DefaultR: 2.0,
  tp3FallbackR: 3.0,
};

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

const STRATEGIES = {
  // S1 - MTF EMA Pullback. Fires on nearly every pullback leg in a healthy
  // trend, which is intended: that is the frequency backbone on 5m/15m.
  s1: {
    id: 's1-ema-pullback',
    name: 'MTF EMA Pullback',
    enabled: true,
    weight: 1.0,
    timeframes: ['1m', '5m', '15m'],
    allowedRegimes: ['TRENDING', 'VOLATILE_EXPANSION'],
    baseScore: 55,
    pullbackTouchAtr: 0.25, // how close to the 9/21 EMA counts as a touch
    stopPadAtr: 0.5,
    zoneBonus: 12,
    trendlineBonus: 8,
    candleStrengthBonus: 6,
    minAdx: 20,
  },

  // S2 - VWAP Band Reversion. Two tiers: 1-sigma touches are regular strength,
  // 2-sigma touches with an RSI recross are high conviction. Never on a band
  // touch alone.
  s2: {
    id: 's2-vwap-reversion',
    name: 'VWAP Band Reversion',
    enabled: true,
    weight: 1.0,
    timeframes: ['1m', '5m', '15m'],
    allowedRegimes: ['RANGING'],
    baseScoreTier1: 45,
    baseScoreTier2: 70,
    // Evidence bonuses. Without these, tier 1 sat exactly on the Balanced
    // conviction floor and below the Conservative one, so the floor silenced
    // the whole tier instead of filtering weak instances of it.
    candleBonus: 6,
    zoneBonus: 10,
    rangeQualityBonus: 8,
    strongRangeQuality: 0.6,
    touchAtr: 0.2,
    rsiOversold: 30,
    rsiOverbought: 70,
    // Skip signals within this many seconds of the daily UTC reset, where the
    // session anchor has almost no data behind it.
    sessionResetSkipSeconds: 900,
    minRangeQuality: 0.2,
  },

  // S3 - Bollinger Squeeze Breakout. Squeezes on 1m/5m occur many times a day.
  s3: {
    id: 's3-squeeze-breakout',
    name: 'Bollinger Squeeze Breakout',
    enabled: true,
    weight: 1.0,
    timeframes: ['1m', '5m', '15m'],
    allowedRegimes: ['SQUEEZE', 'VOLATILE_EXPANSION'],
    baseScore: 60,
    minRelativeVolume: 1.5,
    targetMultiple: 2.0, // target = 2x the squeeze range height
    patternBonus: 15, // compression patterns confirming each other
  },

  // S4 - Session Range Breakout. Capped cadence by nature: a few high-quality
  // signals per day on top of the frequent strategies.
  s4: {
    id: 's4-session-breakout',
    name: 'Session Range Breakout',
    enabled: true,
    weight: 1.0,
    timeframes: ['5m', '15m'],
    allowedRegimes: ['TRENDING', 'RANGING', 'SQUEEZE', 'VOLATILE_EXPANSION'],
    baseScore: 65,
    sessions: [
      { id: 'daily-open', startSecondsUTC: 0, windowSeconds: 900 },
      { id: 'ny-open', startSecondsUTC: 48_600, windowSeconds: 900 }, // 13:30 UTC
    ],
    minRangeAtr: 0.5, // below this there was no real compression
    maxRangeAtr: 3.0, // above this it was a news bar, not a range
    maxTradesPerSessionPerDirection: 1,
    targetMultiples: [1.0, 1.5],
  },

  // S5 - Supertrend Regime Rider. NOT an entry generator: outputs a bias score
  // in -100..+100 that multiplies into every other strategy's contribution.
  s5: {
    id: 's5-regime-bias',
    name: 'Supertrend Regime Rider',
    enabled: true,
    weight: 0, // never contributes directionally on its own
    timeframes: ['1h', '4h'],
    biasOnly: true,
    supertrendWeight: 40, // per timeframe, so 1h + 4h agreeing is +/-80
    adxWeight: 20,
    emaWeight: 20,
    diWeight: 20,
    // How hard an opposing bias crushes a signal. 0 would ignore bias entirely;
    // 1 would veto outright. 0.6 means a -80 bias roughly halves a long.
    maxPenalty: 0.6,
  },

  // S6 - Momentum Micro-Scalp. The frequency workhorse. Lower base weight so it
  // seasons the feed without drowning out the structural strategies.
  s6: {
    id: 's6-micro-scalp',
    name: 'Momentum Micro-Scalp',
    enabled: true,
    weight: 0.6,
    timeframes: ['1m', '5m'],
    allowedRegimes: ['TRENDING', 'RANGING', 'SQUEEZE', 'VOLATILE_EXPANSION'],
    baseScore: 40,
    // S6 previously returned a FIXED 40, below the Balanced (45) and
    // Conservative (55) conviction floors — so the frequency workhorse was
    // structurally silent on two of three presets and contributed zero trades
    // to the first seed run. These bonuses let it earn its way past the floor
    // on the instances that deserve it. Max reachable: 40 + 15 + 10 + 10 = 75.
    depthBonus: 15, // how far out of the extreme the cross came from
    volumeBonus: 10,
    trendBonus: 10, // strength of the 15m trend it is aligned with
    stochLow: 30,
    stochHigh: 70,
    minRelativeVolume: 1.2,
    stopAtr: 1.0,
    targetMultiples: [1.0, 1.5],
    cooldownBars: 3, // per symbol per direction, to stop spam from one swing
  },
};

// ---------------------------------------------------------------------------
// Confluence
// ---------------------------------------------------------------------------

const CONFLUENCE = {
  // raw = sum(strategy.score * direction * weight), then scaled by bias,
  // regime penalty and pattern context.
  regimePenalty: {
    // Multiplier applied when a strategy fires in an allowed but imperfect
    // regime. A strategy outside its allowed set does not fire at all.
    VOLATILE_EXPANSION: 0.8,
    SQUEEZE: 0.9,
    TRENDING: 1.0,
    RANGING: 1.0,
  },
  patternContext: {
    // Long into overhead confirmed resistance, or short into support.
    opposingPattern: 0.75,
    // Aligned with a confirmed breakout that has held its retest.
    confirmingBreakout: 1.2,
    failedBreakReversal: 1.15,
    maxBonus: 1.35,
    minPenalty: 0.6,
  },
  // Level thresholds. These SCALE WITH THE PRESET — see PRESETS below. The
  // values here are the Balanced defaults and match the spec's stated bands.
  thresholds: { strong: 65, weak: 30 },
};

// ---------------------------------------------------------------------------
// Sensitivity presets
// ---------------------------------------------------------------------------

// The main lever for hitting the cadence target. Aggressive narrows the NEUTRAL
// band and loosens the filters; Conservative widens and tightens both.
//
// These are STARTING points. Phase 7's cadence table is what decides the
// shipped defaults, and tuning them against the seed dataset is part of that
// phase rather than optional polish.
const PRESETS = {
  Conservative: {
    thresholds: { strong: 75, weak: 40 },
    minStrategyScore: 55,
    adxTrendFloor: 25,
    minRelativeVolume: 1.5,
    cooldownMultiplier: 1.6,
    bandTouchAtr: 0.15,
    requireCandleConfirmation: true,
  },
  Balanced: {
    thresholds: { strong: 65, weak: 30 },
    minStrategyScore: 45,
    adxTrendFloor: 20,
    minRelativeVolume: 1.2,
    cooldownMultiplier: 1.0,
    bandTouchAtr: 0.2,
    requireCandleConfirmation: true,
  },
  Aggressive: {
    thresholds: { strong: 55, weak: 20 },
    minStrategyScore: 35,
    adxTrendFloor: 18,
    minRelativeVolume: 1.0,
    cooldownMultiplier: 0.6,
    bandTouchAtr: 0.3,
    requireCandleConfirmation: false,
  },
};

const DEFAULT_PRESET = 'Balanced';

// ---------------------------------------------------------------------------
// Costs — Rule 4. Always on, never optional.
// ---------------------------------------------------------------------------

const COSTS = {
  // Binance spot taker, base tier. Charged on EVERY side and every partial fill.
  takerFeeRate: 0.001,
  makerFeeRate: 0.001,
  // Slippage: the greater of a rate and one tick.
  slippageRate: 0.0002,
  minSlippageTicks: 1,
  // Per-symbol tick sizes. Anything absent falls back to tickSizeDefault.
  tickSize: {
    BTCUSD: 0.01,
    ETHUSD: 0.01,
    SOLUSD: 0.01,
    XRPUSD: 0.0001,
    BNBUSD: 0.01,
    ADAUSD: 0.0001,
    DOGEUSD: 0.00001,
  },
  tickSizeDefault: 0.01,
};

// ---------------------------------------------------------------------------
// Backtest
// ---------------------------------------------------------------------------

const BACKTEST = {
  // Ladder exit plan: scale out, trailing the stop behind each fill.
  ladderPlan: [
    { level: 'tp1', fraction: 0.5, moveStopTo: 'entry' },
    { level: 'tp2', fraction: 0.3, moveStopTo: 'tp1' },
    { level: 'tp3', fraction: 0.2, moveStopTo: null },
  ],
  // Every run also reports a simple 100%-out-at-TP1-or-SL1 variant, so the
  // ladder has to prove it beats the simple exit net of costs.
  runSimpleVariant: true,
  riskPerTradeR: 1,
  walkForward: { trainDays: 180, testDays: 60, stepDays: 60 },
  // Rule 7: a config only ships enabled if it clears BOTH of these
  // out-of-sample.
  qualification: { minProfitFactor: 1.2, minTrades: 50 },
  probabilityMinSample: 30, // Rule 5: below this, "insufficient data"
  seed: {
    '1h': { days: 730 },
    '15m': { days: 180 },
    '5m': { days: 180 },
    '1m': { days: 60 },
  },
};

/**
 * Resolves the effective config for a preset: base values with the preset's
 * overrides folded in. Pure and side-effect free, so the backtester can sweep
 * presets without mutating anything.
 *
 * @param {string} [presetName]
 */
function resolve(presetName = DEFAULT_PRESET) {
  const preset = PRESETS[presetName];
  if (!preset) {
    throw new Error(`Unknown preset "${presetName}". Known: ${Object.keys(PRESETS).join(', ')}`);
  }

  const strategies = applyPreset(STRATEGIES, preset);
  assertReachable(strategies, preset.minStrategyScore, presetName);

  return {
    preset: presetName,
    timeframes: TIMEFRAMES,
    indicators: INDICATORS,
    structure: {
      ...STRUCTURE,
      trend: { ...STRUCTURE.trend, adxFloor: preset.adxTrendFloor },
      regime: { ...STRUCTURE.regime, trendingAdx: preset.adxTrendFloor + 5 },
    },
    candles: CANDLES,
    patterns: PATTERNS,
    ladder: LADDER,
    strategies,
    confluence: { ...CONFLUENCE, thresholds: preset.thresholds },
    costs: COSTS,
    backtest: BACKTEST,
    limits: {
      minStrategyScore: preset.minStrategyScore,
      requireCandleConfirmation: preset.requireCandleConfirmation,
    },
  };
}

/**
 * Highest score a strategy can possibly emit, given its parameters.
 *
 * Used only by the guard below. It is deliberately hand-maintained rather than
 * derived: if someone adds a bonus to a strategy and forgets to account for it
 * here, the guard becomes conservative (it under-estimates the ceiling and may
 * complain), which is the safe direction to be wrong in.
 */
function maxScoreOf(key, s) {
  switch (key) {
    case 's1':
      return s.baseScore + s.candleStrengthBonus * 3 + s.zoneBonus + s.trendlineBonus;
    case 's2':
      // The floor has to be reachable by TIER 1, not just by the rarer tier 2.
      return s.baseScoreTier1 + s.candleBonus * 2 + s.zoneBonus + s.rangeQualityBonus;
    case 's3':
      return s.baseScore + s.patternBonus;
    case 's4':
      return s.baseScore;
    case 's6':
      return s.baseScore + s.depthBonus + s.volumeBonus + s.trendBonus;
    default:
      // NOT Infinity. Defaulting to "unbounded" would let a newly added
      // strategy slip past the very check that exists to catch an unreachable
      // one — which is exactly how S6 went missing. Bias-only modules never
      // reach here; assertReachable skips them before calling this.
      throw new Error(
        `No score ceiling defined for strategy "${key}". Add one to maxScoreOf() ` +
          `so the conviction-floor guard can verify it is reachable.`
      );
  }
}

/**
 * Guards against a conviction floor that silences a whole strategy instead of
 * filtering weak instances of it.
 *
 * This is the check that was missing when S6 shipped with a fixed score of 40
 * against a Balanced floor of 45: the frequency workhorse contributed zero
 * trades to an entire seed run, and nothing failed — the strategy was simply
 * absent from every report. A silent strategy is far worse than a loud bug.
 */
function assertReachable(strategies, floor, preset) {
  for (const [key, s] of Object.entries(strategies)) {
    if (!s.enabled || s.biasOnly) continue;
    const ceiling = maxScoreOf(key, s);
    if (ceiling < floor) {
      throw new Error(
        `Strategy ${s.id} can score at most ${ceiling} but preset "${preset}" requires ` +
          `${floor}; it could never fire. Raise its evidence bonuses or lower minStrategyScore.`
      );
    }
  }
}

/** Folds preset-scaled filter strictness into each strategy's parameters. */
function applyPreset(strategies, preset) {
  const out = {};
  for (const [key, s] of Object.entries(strategies)) {
    out[key] = { ...s };
    if ('minAdx' in s) out[key].minAdx = preset.adxTrendFloor;
    if ('minRelativeVolume' in s) out[key].minRelativeVolume = preset.minRelativeVolume;
    if ('touchAtr' in s) out[key].touchAtr = preset.bandTouchAtr;
    if ('cooldownBars' in s) {
      out[key].cooldownBars = Math.max(1, Math.round(s.cooldownBars * preset.cooldownMultiplier));
    }
  }
  return out;
}

module.exports = {
  TIMEFRAMES,
  INDICATORS,
  STRUCTURE,
  CANDLES,
  PATTERNS,
  LADDER,
  STRATEGIES,
  CONFLUENCE,
  PRESETS,
  DEFAULT_PRESET,
  COSTS,
  BACKTEST,
  resolve,
  maxScoreOf,
  assertReachable,
};
