// Confluence engine: strategy signals -> one levelled SignalEvent.
//
//   raw      = weighted average of contributing scores, boosted by agreement
//   adjusted = raw x biasMultiplier(S5) x regimePenalty x patternContext
//   level    = threshold mapping, scaled by the sensitivity preset
//
// Why a weighted AVERAGE and not the spec's literal sum: a plain sum saturates
// almost immediately — two strategies at 60 already exceed 100, so everything
// clamps to STRONG and the five levels collapse into two. The average keeps a
// single strategy's conviction meaningful, and an explicit agreement multiplier
// restores the property the sum was reaching for, which is that independent
// confirmation should count for more than one loud voice. Both the average and
// the multiplier are in config, so the balance is tunable from Phase 7's
// cadence table rather than baked in here.
const ladder = require('../strategies/ladder');
const stats = require('../stats');

const LEVELS = {
  STRONG_BUY: 'STRONG_BUY',
  BUY: 'BUY',
  NEUTRAL: 'NEUTRAL',
  SELL: 'SELL',
  STRONG_SELL: 'STRONG_SELL',
};

const DEFAULTS = {
  // Each additional agreeing strategy adds this much multiplier, so two
  // agreeing modules at an average of 60 reach STRONG on the Balanced preset.
  confluenceStep: 0.35,
  maxConfluenceBoost: 2.0,
  // Aligning with the higher-timeframe bias helps far less than fighting it
  // hurts. That asymmetry is deliberate: agreement is the normal case and
  // should not inflate everything, while trading into a strong opposing trend
  // is the specific mistake this multiplier exists to punish.
  biasAlignBoost: 0.2,
};

/** Maps a clamped −100..+100 score onto the five levels. */
function levelFor(score, thresholds) {
  if (score >= thresholds.strong) return LEVELS.STRONG_BUY;
  if (score >= thresholds.weak) return LEVELS.BUY;
  if (score <= -thresholds.strong) return LEVELS.STRONG_SELL;
  if (score <= -thresholds.weak) return LEVELS.SELL;
  return LEVELS.NEUTRAL;
}

const isActionable = (level) => level !== LEVELS.NEUTRAL;
const directionOf = (level) =>
  level === LEVELS.STRONG_BUY || level === LEVELS.BUY
    ? 'long'
    : level === LEVELS.STRONG_SELL || level === LEVELS.SELL
      ? 'short'
      : null;

/**
 * How the higher-timeframe bias scales a signal in a given direction.
 * A −80 bias against a long yields ~0.5, which is what "crushed toward NEUTRAL"
 * means in practice.
 */
function biasMultiplier(biasScore, direction, cfg, tuning) {
  if (biasScore === null || biasScore === undefined) return 1;
  const magnitude = Math.min(1, Math.abs(biasScore) / 100);
  const aligned = (biasScore >= 0 && direction === 'long') || (biasScore < 0 && direction === 'short');
  return aligned ? 1 + tuning.biasAlignBoost * magnitude : 1 - cfg.maxPenalty * magnitude;
}

/**
 * Pattern context: confirmed structure that agrees with the signal is a bonus,
 * confirmed structure standing in its way is a penalty.
 */
function patternContext(patterns, direction, entry, cfg) {
  let multiplier = 1;
  const notes = [];

  for (const pattern of patterns.open || []) {
    if (pattern.status !== 'confirmed') continue;

    if (pattern.direction === direction) {
      const bonus =
        pattern.type === 'breakout-retest' && pattern.meta && pattern.meta.phase === 'retest'
          ? cfg.confirmingBreakout
          : 1 + (cfg.confirmingBreakout - 1) / 2;
      multiplier *= bonus;
      notes.push({ id: `pattern-${pattern.id}`, label: 'Pattern agrees', detail: `${pattern.type} confirmed ${direction}`, weight: bonus });
      continue;
    }

    // An opposing confirmed pattern only matters if it is actually in the way:
    // its target sits between price and where this signal wants to go.
    const inTheWay =
      pattern.target !== null &&
      (direction === 'long' ? pattern.target > entry : pattern.target < entry) === false;
    if (pattern.direction !== 'neutral' && inTheWay) {
      multiplier *= cfg.opposingPattern;
      notes.push({ id: `pattern-${pattern.id}`, label: 'Pattern opposes', detail: `${pattern.type} confirmed the other way`, weight: cfg.opposingPattern });
    }
  }

  // A failed break is tradeable in the direction of the snap-back.
  for (const event of patterns.events || []) {
    if (event.type === 'failed-break' && event.reversalDirection === direction) {
      multiplier *= cfg.failedBreakReversal;
      notes.push({ id: `failed-break-${event.zoneId}`, label: 'Failed break', detail: `Trapped ${event.brokeDirection} break reverses ${direction}`, weight: cfg.failedBreakReversal });
    }
  }

  return { multiplier: Math.max(cfg.minPenalty, Math.min(cfg.maxBonus, multiplier)), notes };
}

/**
 * Scores one bar's strategy output into a levelled SignalEvent.
 *
 * @param {Object} input
 * @param {{key: string, id: string, weight: number, signal: object}[]} input.signals
 * @param {{score: number, reasons: object[]}|null} input.bias
 * @param {object} input.ctx        MarketContext for this bar.
 * @param {object} input.store      Probability store (engine/stats.js).
 * @param {boolean} [input.provisional]  True when driven by a forming bar.
 * @returns {object|null} A SignalEvent, or null when nothing contributed.
 */
function evaluate({ signals, bias, ctx, store, provisional = false }) {
  const config = ctx.config;
  const cfg = config.confluence;
  const tuning = { ...DEFAULTS, ...(cfg.tuning || {}) };

  if (!signals || signals.length === 0) return null;

  // --- raw: weighted average, then an agreement multiplier ----------------
  let net = 0;
  let totalWeight = 0;
  for (const { weight, signal } of signals) {
    const sign = signal.direction === 'long' ? 1 : -1;
    net += signal.score * sign * weight;
    totalWeight += weight;
  }
  if (totalWeight === 0) return null;

  const average = net / totalWeight;
  const netDirection = average >= 0 ? 'long' : 'short';
  const agreeing = signals.filter((s) => s.signal.direction === netDirection);
  const boost = Math.min(
    tuning.maxConfluenceBoost,
    1 + tuning.confluenceStep * Math.max(0, agreeing.length - 1)
  );
  const raw = average * boost;

  // --- adjustments ---------------------------------------------------------
  const biasScore = bias ? bias.score : null;
  const biasMult = biasMultiplier(biasScore, netDirection, config.strategies.s5, tuning);

  const regime = ctx.structure.regime.primary;
  const regimeMult = cfg.regimePenalty[regime] ?? 1;

  const entry = agreeing.length > 0 ? agreeing[0].signal.entry : ctx.bar.close;
  const pattern = patternContext(ctx.patterns, netDirection, entry, cfg.patternContext);

  const adjusted = Math.max(-100, Math.min(100, raw * biasMult * regimeMult * pattern.multiplier));
  const level = levelFor(adjusted, cfg.thresholds);

  // --- the dominant strategy owns the ladder ------------------------------
  const dominant = agreeing
    .slice()
    .sort((a, b) => b.signal.score * b.weight - a.signal.score * a.weight)[0];

  let ladderOut = null;
  if (dominant) {
    const s = dominant.signal;
    // Re-validate rather than trust: this ladder is about to be drawn on the
    // chart, size a position and seed the backtest exit model.
    const check = ladder.validate(s.direction, s.entry, s.stops, s.targets);
    if (check.ok) {
      ladderOut = { entry: s.entry, stops: s.stops, targets: s.targets, r: s.r };
    }
  }

  const probability = stats.blend(
    store,
    agreeing.map((s) => ({ strategyId: s.id, direction: s.signal.direction, regime }))
  );

  return {
    // Deterministic and clock-free (Rule 6). The server adds wall-clock time at
    // persistence if it wants it; the engine never reads a clock.
    id: `${ctx.symbol}:${ctx.timeframe}:${ctx.bar.time}${provisional ? ':provisional' : ''}`,
    symbol: ctx.symbol,
    timeframe: ctx.timeframe,
    barTime: ctx.bar.time,
    barIndex: ctx.index,
    provisional,

    level,
    direction: directionOf(level),
    score: adjusted,
    actionable: isActionable(level),

    ...(ladderOut || { entry: ctx.bar.close, stops: null, targets: null, r: null }),

    strategies: signals.map((s) => ({
      key: s.key,
      id: s.id,
      weight: s.weight,
      direction: s.signal.direction,
      score: s.signal.score,
      reasons: s.signal.reasons,
      dominant: dominant ? s.key === dominant.key : false,
    })),

    regime,
    regimeFlags: ctx.structure.regime.flags,
    trend: ctx.structure.trend.state,
    bias: bias ? { score: bias.score, reasons: bias.reasons } : null,
    probability,

    breakdown: {
      average,
      agreement: agreeing.length,
      confluenceBoost: boost,
      raw,
      biasMultiplier: biasMult,
      regimePenalty: regimeMult,
      patternContext: pattern.multiplier,
      patternNotes: pattern.notes,
      adjusted,
      thresholds: cfg.thresholds,
    },
  };
}

module.exports = {
  evaluate,
  levelFor,
  isActionable,
  directionOf,
  biasMultiplier,
  patternContext,
  LEVELS,
  DEFAULTS,
};
