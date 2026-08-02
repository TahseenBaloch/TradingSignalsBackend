// The six strategy modules.
//
// Every module reads its parameters from the resolved config (config.js) and
// hardcodes nothing, so the sensitivity presets can scale filter strictness
// without touching this file.
//
// Each returns a StrategySignal or null:
//
//   { direction, score, entry, stops[3], targets[3], reasons[] }
//
// The three stops and three targets always come from ladder.build(). Where a
// strategy's own rules name targets (S2's "T1 = VWAP", S6's "T2 = 1.5R"), those
// feed the ladder as structural/measured inputs rather than overriding it: the
// spec fixes TP1 at exactly 1R for every strategy so that R-multiples stay
// comparable across modules and the backtester can pool them.
const ladder = require('./ladder');
const { utcDayIndex } = require('../indicators/util');

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} EvidenceItem
 * @property {string} id        Stable, for the HUD to key hover-highlighting off.
 * @property {string} label
 * @property {string} detail
 * @property {number} weight    Score contribution, for the evidence breakdown.
 * @property {{time: number, price: number}} [anchor]  What to highlight on the chart.
 */

const evidence = (id, label, detail, weight, anchor) => ({
  id,
  label,
  detail,
  weight,
  ...(anchor ? { anchor } : {}),
});

const lowestLow = (bars, n) => Math.min(...bars.slice(-n).map((b) => b.low));
const highestHigh = (bars, n) => Math.max(...bars.slice(-n).map((b) => b.high));

/** The bias-timeframe snapshot this entry timeframe defers to. */
function biasSnapshot(ctx) {
  const tf = ctx.config.timeframes.biasFor[ctx.timeframe];
  return { tf, snapshot: ctx.bias ? ctx.bias[tf] || null : null };
}

/** Does a candle signal of the required bias exist on this bar? */
function candleConfirms(ctx, direction) {
  const want = direction === 'long' ? 'bullish' : 'bearish';
  return (ctx.candles || []).some((c) => c.bias === want);
}

function strongestCandle(ctx, direction) {
  const want = direction === 'long' ? 'bullish' : 'bearish';
  return (ctx.candles || [])
    .filter((c) => c.bias === want)
    .sort((a, b) => b.strength - a.strength)[0];
}

/** Nearest zone beyond a stop, used as the SL2 structural anchor. */
function structuralStopFor(ctx, direction, entry) {
  const zones = ctx.structure ? ctx.structure.zones : [];
  if (direction === 'long') {
    const below = zones.filter((z) => z.high < entry).sort((a, b) => b.high - a.high)[0];
    return below ? below.low : null;
  }
  const above = zones.filter((z) => z.low > entry).sort((a, b) => a.low - b.low)[0];
  return above ? above.high : null;
}

/** Nearest opposing zone, used as the TP2 structural target. */
function structuralTargetFor(ctx, direction, entry) {
  const zones = ctx.structure ? ctx.structure.zones : [];
  if (direction === 'long') {
    const above = zones.filter((z) => z.low > entry).sort((a, b) => a.low - b.low)[0];
    return above ? above.low : null;
  }
  const below = zones.filter((z) => z.high < entry).sort((a, b) => b.high - a.high)[0];
  return below ? below.high : null;
}

/**
 * Assembles the final signal. Every module funnels through here so no path can
 * produce a signal missing a rung of the ladder.
 */
function makeSignal(ctx, { direction, score, entry, sl1, reasons, structuralTarget, measuredTarget, patternInvalidation }) {
  const bias = biasSnapshot(ctx).snapshot;
  const vwap = ctx.vwapSession;

  const built = ladder.build({
    direction,
    entry,
    sl1,
    atr: ctx.atr,
    config: ctx.config.ladder,
    structuralStop: structuralStopFor(ctx, direction, entry),
    patternInvalidation: patternInvalidation ?? null,
    vwap3Sigma: vwap ? (direction === 'long' ? vwap.lower[2] : vwap.upper[2]) : null,
    biasSupertrend: bias && bias.supertrend ? bias.supertrend.value : null,
    structuralTarget: structuralTarget ?? structuralTargetFor(ctx, direction, entry),
    measuredTarget: measuredTarget ?? null,
  });

  const check = ladder.validate(direction, built.entry, built.stops, built.targets);
  if (!check.ok) return null; // never ship a malformed ladder

  return {
    direction,
    score: Math.max(0, Math.min(100, score)),
    entry: built.entry,
    stops: built.stops,
    targets: built.targets,
    r: built.r,
    ladderSources: built.sources,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// S1 - MTF EMA Pullback  (regime: TRENDING)
// ---------------------------------------------------------------------------

const s1 = {
  key: 's1',
  initState: () => ({}),

  evaluate(ctx, _state) {
    const p = ctx.config.strategies.s1;
    if (!p.enabled || !p.timeframes.includes(ctx.timeframe)) return null;
    if (!p.allowedRegimes.includes(ctx.structure.regime.primary)) return null;
    if (!ctx.atr || !ctx.adx || ctx.adx.adx === null || ctx.adx.adx < p.minAdx) return null;

    const { tf, snapshot } = biasSnapshot(ctx);
    if (!snapshot || !snapshot.supertrend || snapshot.ema200 === null) return null;

    // The bias timeframe decides which side we are allowed to take at all.
    const bullishBias = snapshot.close > snapshot.ema200 && snapshot.supertrend.direction === 1;
    const bearishBias = snapshot.close < snapshot.ema200 && snapshot.supertrend.direction === -1;
    if (!bullishBias && !bearishBias) return null;

    const direction = bullishBias ? 'long' : 'short';
    const ema9 = ctx.ema[9];
    const ema21 = ctx.ema[21];
    if (ema9 === null || ema21 === null) return null;

    const bandTop = Math.max(ema9, ema21);
    const bandBottom = Math.min(ema9, ema21);
    const touch = p.pullbackTouchAtr * ctx.atr;

    // The pullback must have REACHED the moving-average zone and the bar must
    // have closed back out of it in the trend's direction. A bar that merely
    // hovers nearby is not a pullback that resolved.
    const reached =
      direction === 'long'
        ? ctx.bar.low <= bandTop + touch
        : ctx.bar.high >= bandBottom - touch;
    const resumed = direction === 'long' ? ctx.bar.close > ema9 : ctx.bar.close < ema9;
    if (!reached || !resumed) return null;

    if (ctx.config.limits.requireCandleConfirmation && !candleConfirms(ctx, direction)) return null;

    const reasons = [
      evidence('s1-bias', `${tf} trend`, `${direction === 'long' ? 'Above' : 'Below'} 200 EMA with Supertrend agreeing on ${tf}`, 0),
      evidence('s1-adx', 'ADX', `Trend strength ${ctx.adx.adx.toFixed(1)} (>= ${p.minAdx})`, 0),
      evidence('s1-pullback', 'EMA pullback', `Pullback to the 9/21 EMA zone, closed back ${direction === 'long' ? 'above' : 'below'} the 9 EMA`, 0),
    ];

    let score = p.baseScore;

    const candle = strongestCandle(ctx, direction);
    if (candle) {
      const bump = p.candleStrengthBonus * candle.strength;
      score += bump;
      reasons.push(evidence('s1-candle', 'Reversal candle', `${candle.type} (strength ${candle.strength})`, bump, { time: ctx.bar.time, price: ctx.bar.close }));
    }

    // Extra conviction when the pullback lands on independent structure.
    const zones = ctx.structure.zones || [];
    const onZone = zones.find(
      (z) => ctx.bar.low <= z.high + touch && ctx.bar.high >= z.low - touch
    );
    if (onZone) {
      score += p.zoneBonus;
      reasons.push(evidence('s1-zone', 'S/R zone', `Pullback landed on a zone with ${onZone.touches} touches`, p.zoneBonus, { time: ctx.bar.time, price: onZone.centre }));
    }

    const line = direction === 'long' ? ctx.structure.trendlines.support : ctx.structure.trendlines.resistance;
    if (line && !line.broken) {
      score += p.trendlineBonus;
      reasons.push(evidence('s1-trendline', 'Trendline', `Riding a ${line.touches}-touch trendline`, p.trendlineBonus, line.to));
    }

    const window = Math.max(3, ctx.config.structure.pivots.lookback);
    const sl1 =
      direction === 'long'
        ? lowestLow(ctx.bars, window) - p.stopPadAtr * ctx.atr
        : highestHigh(ctx.bars, window) + p.stopPadAtr * ctx.atr;

    return makeSignal(ctx, { direction, score, entry: ctx.bar.close, sl1, reasons });
  },
};

// ---------------------------------------------------------------------------
// S2 - VWAP Band Reversion  (regime: RANGING, hard gate)
// ---------------------------------------------------------------------------

const s2 = {
  key: 's2',
  initState: () => ({ prevRsi: null }),

  evaluate(ctx, state) {
    const p = ctx.config.strategies.s2;
    const prevRsi = state.prevRsi;
    state.prevRsi = ctx.rsi;

    if (!p.enabled || !p.timeframes.includes(ctx.timeframe)) return null;
    // Hard gate: this is a mean-reversion strategy and it is only safe where
    // price actually mean-reverts.
    if (ctx.structure.regime.primary !== 'RANGING') return null;
    if (ctx.structure.regime.rangeQuality < p.minRangeQuality) return null;
    if (!ctx.atr || !ctx.vwapSession || ctx.rsi === null) return null;

    // The session anchor has almost no data behind it just after the UTC reset,
    // so its bands are meaningless there.
    const secondsIntoDay = ctx.bar.time - utcDayIndex(ctx.bar.time) * 86400;
    if (secondsIntoDay < p.sessionResetSkipSeconds) return null;

    const v = ctx.vwapSession;
    const touch = p.touchAtr * ctx.atr;

    const touched1Low = ctx.bar.low <= v.lower[0] + touch;
    const touched2Low = ctx.bar.low <= v.lower[1] + touch;
    const touched1High = ctx.bar.high >= v.upper[0] - touch;
    const touched2High = ctx.bar.high >= v.upper[1] - touch;

    let direction = null;
    if (touched1Low || touched2Low) direction = 'long';
    else if (touched1High || touched2High) direction = 'short';
    if (!direction) return null;

    // Never on a band touch alone.
    if (!candleConfirms(ctx, direction)) return null;

    // Tier 2 additionally needs momentum to have turned: RSI back across the
    // extreme it came from, not merely sitting at it.
    const recrossedUp = prevRsi !== null && prevRsi <= p.rsiOversold && ctx.rsi > p.rsiOversold;
    const recrossedDown = prevRsi !== null && prevRsi >= p.rsiOverbought && ctx.rsi < p.rsiOverbought;
    const tier2 =
      (direction === 'long' && touched2Low && recrossedUp) ||
      (direction === 'short' && touched2High && recrossedDown);

    const score = tier2 ? p.baseScoreTier2 : p.baseScoreTier1;
    const band = tier2 ? 2 : 1;

    const reasons = [
      evidence('s2-regime', 'Ranging', `Range quality ${ctx.structure.regime.rangeQuality.toFixed(2)}`, 0),
      evidence('s2-band', `VWAP ${band}σ`, `Price rejected the ${direction === 'long' ? 'lower' : 'upper'} ${band}σ band`, 0, {
        time: ctx.bar.time,
        price: direction === 'long' ? v.lower[band - 1] : v.upper[band - 1],
      }),
    ];
    if (tier2) {
      reasons.push(evidence('s2-rsi', 'RSI recross', `RSI back through ${direction === 'long' ? p.rsiOversold : p.rsiOverbought} (${ctx.rsi.toFixed(1)})`, p.baseScoreTier2 - p.baseScoreTier1));
    }

    // Stop beyond the next band out; a 2σ entry stops beyond 3σ.
    const sl1 = direction === 'long' ? v.lower[band] - touch : v.upper[band] + touch;

    return makeSignal(ctx, {
      direction,
      score,
      entry: ctx.bar.close,
      sl1,
      reasons,
      // The strategy's own targets: VWAP first, then the opposite 1σ band.
      structuralTarget: v.vwap,
      measuredTarget: direction === 'long' ? v.upper[0] : v.lower[0],
    });
  },
};

// ---------------------------------------------------------------------------
// S3 - Bollinger Squeeze Breakout  (regime: SQUEEZE)
// ---------------------------------------------------------------------------

const s3 = {
  key: 's3',
  initState: () => ({ squeezeHeight: null, squeezeIndex: null }),

  evaluate(ctx, state) {
    const p = ctx.config.strategies.s3;

    // Remember how tall the bands were while compressed — that height is the
    // measured move once price escapes, and by then the bands have expanded.
    if (ctx.bollinger && ctx.structure.regime.flags.squeeze) {
      state.squeezeHeight = ctx.bollinger.upper - ctx.bollinger.lower;
      state.squeezeIndex = ctx.index;
    }

    if (!p.enabled || !p.timeframes.includes(ctx.timeframe)) return null;
    if (!p.allowedRegimes.includes(ctx.structure.regime.primary)) return null;
    if (!ctx.atr || !ctx.bollinger || !ctx.macd || state.squeezeHeight === null) return null;
    if (ctx.macd.histogram === null || !ctx.volume) return null;
    if (ctx.volume.relative < p.minRelativeVolume) return null;

    const bb = ctx.bollinger;
    const long = ctx.bar.close > bb.upper && ctx.macd.histogram > 0;
    const short = ctx.bar.close < bb.lower && ctx.macd.histogram < 0;
    if (!long && !short) return null;

    const direction = long ? 'long' : 'short';
    const height = state.squeezeHeight;

    const reasons = [
      evidence('s3-squeeze', 'Squeeze', `BandWidth compressed to a ${ctx.config.structure.regime.squeezeLookback}-bar low`, 0),
      evidence('s3-break', 'Band break', `Closed ${long ? 'above' : 'below'} the ${long ? 'upper' : 'lower'} band`, 0, { time: ctx.bar.time, price: long ? bb.upper : bb.lower }),
      evidence('s3-volume', 'Volume', `Relative volume ${ctx.volume.relative.toFixed(2)} (>= ${p.minRelativeVolume})`, 0),
      evidence('s3-macd', 'MACD', `Histogram ${ctx.macd.histogram > 0 ? 'positive' : 'negative'}, agreeing with the break`, 0),
    ];

    let score = p.baseScore;

    // Compression patterns confirming each other.
    const compression = (ctx.patterns.open || []).find(
      (x) => x.status === 'confirmed' && x.direction === direction && x.type.includes('triangle')
    );
    if (compression) {
      score += p.patternBonus;
      reasons.push(evidence('s3-pattern', 'Pattern', `${compression.type} broke the same way`, p.patternBonus));
    }

    return makeSignal(ctx, {
      direction,
      score,
      entry: ctx.bar.close,
      sl1: bb.middle, // spec: stop at the band mid
      reasons,
      measuredTarget: long ? ctx.bar.close + p.targetMultiple * height : ctx.bar.close - p.targetMultiple * height,
    });
  },
};

// ---------------------------------------------------------------------------
// S4 - Session Range Breakout  (supplementary, capped cadence by nature)
// ---------------------------------------------------------------------------

const s4 = {
  key: 's4',
  initState: () => ({ day: null, sessions: new Map() }),

  evaluate(ctx, state) {
    const p = ctx.config.strategies.s4;
    if (!p.enabled || !p.timeframes.includes(ctx.timeframe) || !ctx.atr) return null;

    const day = utcDayIndex(ctx.bar.time);
    if (state.day !== day) {
      state.day = day;
      state.sessions = new Map();
    }
    const secondsIntoDay = ctx.bar.time - day * 86400;

    let fired = null;

    for (const session of p.sessions) {
      const end = session.startSecondsUTC + session.windowSeconds;
      let record = state.sessions.get(session.id);

      if (secondsIntoDay >= session.startSecondsUTC && secondsIntoDay < end) {
        // Inside the window: accumulate the range, never trade it.
        if (!record) {
          record = { high: ctx.bar.high, low: ctx.bar.low, complete: false, long: 0, short: 0 };
          state.sessions.set(session.id, record);
        } else {
          record.high = Math.max(record.high, ctx.bar.high);
          record.low = Math.min(record.low, ctx.bar.low);
        }
        continue;
      }

      if (!record || secondsIntoDay < end) continue;
      record.complete = true;

      const height = record.high - record.low;
      // Too small means no real compression; too large means a news bar, and
      // neither is the setup this strategy is describing.
      if (height < p.minRangeAtr * ctx.atr || height > p.maxRangeAtr * ctx.atr) continue;

      const long = ctx.bar.close > record.high;
      const short = ctx.bar.close < record.low;
      if (!long && !short) continue;
      if (long && record.long >= p.maxTradesPerSessionPerDirection) continue;
      if (short && record.short >= p.maxTradesPerSessionPerDirection) continue;

      const direction = long ? 'long' : 'short';
      if (long) record.long += 1;
      else record.short += 1;

      const mid = (record.high + record.low) / 2;
      fired = {
        direction,
        score: p.baseScore,
        entry: ctx.bar.close,
        sl1: mid, // spec: stop at the range midpoint
        reasons: [
          evidence('s4-session', 'Session range', `${session.id} range of ${height.toFixed(4)} (${(height / ctx.atr).toFixed(2)} ATR)`, 0, { time: ctx.bar.time, price: long ? record.high : record.low }),
          evidence('s4-break', 'Range break', `Closed ${long ? 'above the high' : 'below the low'} of the opening range`, 0),
        ],
        measuredTarget: long
          ? record.high + p.targetMultiples[1] * height
          : record.low - p.targetMultiples[1] * height,
      };
      break;
    }

    return fired ? makeSignal(ctx, fired) : null;
  },
};

// ---------------------------------------------------------------------------
// S5 - Supertrend Regime Rider  (bias only, never an entry)
// ---------------------------------------------------------------------------

const s5 = {
  key: 's5',
  biasOnly: true,
  initState: () => ({}),

  /**
   * Returns a bias score in −100..+100 built from the 1h and 4h picture. This
   * is NOT a signal; the confluence engine multiplies it into every other
   * strategy's contribution, so a 5m long fighting a −80 4h downtrend gets
   * crushed toward NEUTRAL.
   */
  evaluate(ctx) {
    const p = ctx.config.strategies.s5;
    if (!p.enabled || !ctx.bias) return null;

    let score = 0;
    let available = 0;
    const reasons = [];

    for (const tf of p.timeframes) {
      const snapshot = ctx.bias[tf];
      if (!snapshot) continue;
      available += 1;

      if (snapshot.supertrend) {
        const contribution = snapshot.supertrend.direction * (p.supertrendWeight / p.timeframes.length);
        score += contribution;
        reasons.push(evidence(`s5-st-${tf}`, `${tf} Supertrend`, snapshot.supertrend.direction === 1 ? 'Bullish' : 'Bearish', contribution));
      }

      if (snapshot.adx && snapshot.adx.adx !== null) {
        const strength = Math.min(1, snapshot.adx.adx / 50);
        const side = snapshot.adx.plusDI > snapshot.adx.minusDI ? 1 : -1;
        const contribution = side * strength * (p.adxWeight / p.timeframes.length);
        score += contribution;

        const spread = snapshot.adx.plusDI + snapshot.adx.minusDI;
        if (spread > 0) {
          const diSkew = (snapshot.adx.plusDI - snapshot.adx.minusDI) / spread;
          score += diSkew * (p.diWeight / p.timeframes.length);
        }
      }

      if (snapshot.ema50 !== null && snapshot.ema200 !== null && snapshot.ema200 !== undefined) {
        const side = snapshot.ema50 > snapshot.ema200 ? 1 : -1;
        score += side * (p.emaWeight / p.timeframes.length);
      }
    }

    if (available === 0) return null;
    return { bias: Math.max(-100, Math.min(100, score)), reasons };
  },
};

// ---------------------------------------------------------------------------
// S6 - Momentum Micro-Scalp  (1m + 5m, the frequency workhorse)
// ---------------------------------------------------------------------------

const s6 = {
  key: 's6',
  initState: () => ({ prev: null, lastLong: -Infinity, lastShort: -Infinity }),

  evaluate(ctx, state) {
    const p = ctx.config.strategies.s6;
    const prev = state.prev;
    if (ctx.stochastic && ctx.stochastic.d !== null) {
      state.prev = { k: ctx.stochastic.k, d: ctx.stochastic.d };
    }

    if (!p.enabled || !p.timeframes.includes(ctx.timeframe)) return null;
    if (!ctx.atr || !ctx.stochastic || ctx.stochastic.d === null || !prev) return null;
    if (!ctx.volume || ctx.volume.relative < p.minRelativeVolume) return null;
    if (!ctx.vwapSession) return null;

    const k = ctx.stochastic.k;
    const d = ctx.stochastic.d;

    // A cross OUT of an extreme, not merely a reading inside one.
    const crossUp = prev.k <= prev.d && k > d && prev.k < p.stochLow;
    const crossDown = prev.k >= prev.d && k < d && prev.k > p.stochHigh;
    if (!crossUp && !crossDown) return null;

    const direction = crossUp ? 'long' : 'short';

    // Only ever in the direction of the 15m EMA trend.
    const trend15 = ctx.bias ? ctx.bias['15m'] : null;
    if (!trend15 || !trend15.trend) return null;
    if (direction === 'long' && trend15.trend.state !== 'UP') return null;
    if (direction === 'short' && trend15.trend.state !== 'DOWN') return null;

    // And on the trend side of the session VWAP.
    const onSide =
      direction === 'long' ? ctx.bar.close > ctx.vwapSession.vwap : ctx.bar.close < ctx.vwapSession.vwap;
    if (!onSide) return null;

    // Cooldown, so one swing does not spam the feed.
    const last = direction === 'long' ? state.lastLong : state.lastShort;
    if (ctx.index - last < p.cooldownBars) return null;
    if (direction === 'long') state.lastLong = ctx.index;
    else state.lastShort = ctx.index;

    const sl1 =
      direction === 'long'
        ? ctx.bar.close - p.stopAtr * ctx.atr
        : ctx.bar.close + p.stopAtr * ctx.atr;
    const r = p.stopAtr * ctx.atr;

    return makeSignal(ctx, {
      direction,
      score: p.baseScore,
      entry: ctx.bar.close,
      sl1,
      reasons: [
        evidence('s6-stoch', 'Stochastic cross', `%K crossed %D out of ${crossUp ? 'oversold' : 'overbought'} (${k.toFixed(1)}/${d.toFixed(1)})`, 0),
        evidence('s6-trend', '15m trend', `Aligned with the 15m ${trend15.trend.state} trend`, 0),
        evidence('s6-vwap', 'VWAP side', `Price on the ${direction === 'long' ? 'upper' : 'lower'} side of session VWAP`, 0),
        evidence('s6-volume', 'Volume', `Relative volume ${ctx.volume.relative.toFixed(2)}`, 0),
      ],
      measuredTarget:
        direction === 'long'
          ? ctx.bar.close + p.targetMultiples[1] * r
          : ctx.bar.close - p.targetMultiples[1] * r,
    });
  },
};

module.exports = { s1, s2, s3, s4, s5, s6, evidence, structuralStopFor, structuralTargetFor, makeSignal };
