// Candlestick classifier.
//
// Every threshold is ATR-relative or a ratio of the bar's own range, never a
// fixed percentage, so one parameter set works on a $100,000 BTC bar and a
// $0.20 DOGE bar without retuning.
//
// Context is not decoration here — it changes the verdict. A hammer and a
// hanging man are the SAME SHAPE; only what preceded them decides whether the
// long lower wick means buyers defended a low or that a rally has run out of
// room. The classifier therefore takes prior trend, the nearest S/R zone and
// relative volume, and a shape with no supporting context is emitted at
// strength 1 with a `no-prior-trend` tag rather than dressed up as a signal.
const { metrics } = require('./metrics');
const { resolveParams } = require('../indicators/util');

const DEFAULTS = {
  minRangeAtr: 0.3, // ignore bars too small to mean anything
  dojiBodyRatio: 0.1, // body <= 10% of range is a doji
  dojiDominantWick: 0.6, // dragonfly/gravestone need this much wick on one side
  dojiFlatWick: 0.15, // ...and no more than this on the other
  longLeggedWick: 0.3, // both wicks at least this to be long-legged
  wickToBody: 2.0, // spec: a rejection wick is >= 2x the body
  decisiveWickToBody: 3.0, // ...and >= 3x earns the extra strength point
  oppositeWickMax: 0.3, // hammer/star: the other wick stays under this of range
  outerThird: 1 / 3, // pin bar: body must sit in an outer third of the range
  marubozuBodyRatio: 0.9,
  engulfMinBodyAtr: 0.3, // an engulfing body this small is noise
  tweezerToleranceAtr: 0.1,
  soldiersBodyRatio: 0.5,
  trendLookback: 5, // bars back used to judge prior advance/decline
  trendMoveAtr: 0.5, // ...and how far price must have travelled
  zoneProximityAtr: 0.5,
  highVolume: 1.5,
};

/**
 * Registry of every type the classifier can emit. Phase 8 needs stable ids to
 * hang per-type visibility toggles off, so ids are part of the contract.
 */
const CANDLE_TYPES = [
  { id: 'doji', label: 'Doji', bias: 'neutral', code: 'D' },
  { id: 'dragonfly-doji', label: 'Dragonfly Doji', bias: 'bullish', code: 'D' },
  { id: 'gravestone-doji', label: 'Gravestone Doji', bias: 'bearish', code: 'D' },
  { id: 'long-legged-doji', label: 'Long-legged Doji', bias: 'neutral', code: 'D' },
  { id: 'hammer', label: 'Hammer', bias: 'bullish', code: 'H' },
  { id: 'hanging-man', label: 'Hanging Man', bias: 'bearish', code: 'H' },
  { id: 'inverted-hammer', label: 'Inverted Hammer', bias: 'bullish', code: 'I' },
  { id: 'shooting-star', label: 'Shooting Star', bias: 'bearish', code: 'S' },
  { id: 'bullish-engulfing', label: 'Bullish Engulfing', bias: 'bullish', code: 'E' },
  { id: 'bearish-engulfing', label: 'Bearish Engulfing', bias: 'bearish', code: 'E' },
  { id: 'pin-bar-bullish', label: 'Bullish Pin Bar', bias: 'bullish', code: 'P' },
  { id: 'pin-bar-bearish', label: 'Bearish Pin Bar', bias: 'bearish', code: 'P' },
  { id: 'inside-bar', label: 'Inside Bar', bias: 'neutral', code: 'N' },
  { id: 'outside-bar', label: 'Outside Bar', bias: 'neutral', code: 'O' },
  { id: 'marubozu-bullish', label: 'Bullish Marubozu', bias: 'bullish', code: 'M' },
  { id: 'marubozu-bearish', label: 'Bearish Marubozu', bias: 'bearish', code: 'M' },
  { id: 'tweezer-top', label: 'Tweezer Top', bias: 'bearish', code: 'T' },
  { id: 'tweezer-bottom', label: 'Tweezer Bottom', bias: 'bullish', code: 'T' },
  { id: 'three-white-soldiers', label: 'Three White Soldiers', bias: 'bullish', code: 'W' },
  { id: 'three-black-crows', label: 'Three Black Crows', bias: 'bearish', code: 'C' },
];

const TYPES_BY_ID = new Map(CANDLE_TYPES.map((t) => [t.id, t]));

/**
 * @typedef {Object} CandleSignal
 * @property {string} type       One of CANDLE_TYPES' ids.
 * @property {'bullish'|'bearish'|'neutral'} bias
 * @property {1|2|3} strength
 * @property {string[]} context  Stable tags: after-decline, at-support, ...
 * @property {number} index
 * @property {number} time
 */

function init(params) {
  return { params: resolveParams(DEFAULTS, params), history: [], index: -1 };
}

/** Clamps a strength accumulator into the documented 1..3 band. */
function strengthOf(bonuses) {
  return Math.max(1, Math.min(3, 1 + bonuses.filter(Boolean).length));
}

/**
 * Builds the context tags for a bar: what preceded it, what it is sitting on,
 * and whether anyone showed up to trade it.
 */
function contextFor(bar, history, ctx, p) {
  const tags = [];

  const back = history[history.length - p.trendLookback];
  if (back && ctx.atr > 0) {
    const move = bar.close - back.close;
    if (move <= -p.trendMoveAtr * ctx.atr) tags.push('after-decline');
    else if (move >= p.trendMoveAtr * ctx.atr) tags.push('after-advance');
  }

  const zone = ctx.zone || null;
  if (zone && ctx.atr > 0) {
    const distance =
      bar.low > zone.high ? bar.low - zone.high : bar.high < zone.low ? zone.low - bar.high : 0;
    if (distance <= p.zoneProximityAtr * ctx.atr) {
      tags.push(zone.role === 'resistance' ? 'at-resistance' : 'at-support');
    }
  }

  if (typeof ctx.relativeVolume === 'number' && ctx.relativeVolume >= p.highVolume) {
    tags.push('high-volume');
  }

  return tags;
}

/**
 * Classifies one CLOSED bar. A bar can legitimately be several things at once —
 * a hammer is often also a pin bar and an inside bar — so this returns every
 * match rather than picking a winner.
 *
 * @param {ReturnType<init>} state
 * @param {import('../types').Bar} bar
 * @param {{index: number, atr: number, zone?: object|null, relativeVolume?: number|null}} ctx
 * @returns {CandleSignal[]}
 */
function update(state, bar, ctx) {
  const p = state.params;
  state.index += 1;

  const history = state.history;
  const prev = history[history.length - 1] || null;
  const prev2 = history[history.length - 2] || null;

  const push = () => {
    history.push(bar);
    if (history.length > p.trendLookback + 3) history.shift();
  };

  // Below ATR warmup there is no scale to judge against, so nothing is claimed.
  if (!Number.isFinite(ctx.atr) || ctx.atr <= 0) {
    push();
    return [];
  }

  const m = metrics(bar, ctx.atr);
  const found = [];
  const tags = contextFor(bar, history, ctx, p);
  const afterDecline = tags.includes('after-decline');
  const afterAdvance = tags.includes('after-advance');
  const atZone = tags.includes('at-support') || tags.includes('at-resistance');
  const heavy = tags.includes('high-volume');
  const big = m.rangeAtr >= 1;

  const emit = (type, bias, bonuses, extra = []) => {
    found.push({
      type,
      bias,
      strength: strengthOf(bonuses),
      context: extra.length ? [...tags, ...extra] : tags.slice(),
      index: ctx.index,
      time: bar.time,
    });
  };

  const meaningful = m.rangeAtr >= p.minRangeAtr;

  // --- doji family ---------------------------------------------------------
  if (meaningful && m.bodyRatio <= p.dojiBodyRatio) {
    if (m.lowerRatio >= p.dojiDominantWick && m.upperRatio <= p.dojiFlatWick) {
      emit('dragonfly-doji', 'bullish', [afterDecline, atZone || heavy]);
    } else if (m.upperRatio >= p.dojiDominantWick && m.lowerRatio <= p.dojiFlatWick) {
      emit('gravestone-doji', 'bearish', [afterAdvance, atZone || heavy]);
    } else if (m.upperRatio >= p.longLeggedWick && m.lowerRatio >= p.longLeggedWick) {
      emit('long-legged-doji', 'neutral', [big, atZone]);
    } else {
      emit('doji', 'neutral', [atZone, heavy]);
    }
  }

  // --- hammer / hanging man ------------------------------------------------
  // Identical geometry; only the preceding trend separates them.
  const hammerShape =
    meaningful &&
    m.body > 0 &&
    m.lowerWick >= p.wickToBody * m.body &&
    m.upperRatio <= p.oppositeWickMax &&
    m.bodyRatio > p.dojiBodyRatio;

  if (hammerShape) {
    const decisive = m.lowerWick >= p.decisiveWickToBody * m.body;
    if (afterAdvance) emit('hanging-man', 'bearish', [decisive, atZone || heavy]);
    else if (afterDecline) emit('hammer', 'bullish', [decisive, atZone || heavy]);
    else emit('hammer', 'bullish', [], ['no-prior-trend']);
  }

  // --- inverted hammer / shooting star -------------------------------------
  const starShape =
    meaningful &&
    m.body > 0 &&
    m.upperWick >= p.wickToBody * m.body &&
    m.lowerRatio <= p.oppositeWickMax &&
    m.bodyRatio > p.dojiBodyRatio;

  if (starShape) {
    const decisive = m.upperWick >= p.decisiveWickToBody * m.body;
    if (afterAdvance) emit('shooting-star', 'bearish', [decisive, atZone || heavy]);
    else if (afterDecline) emit('inverted-hammer', 'bullish', [decisive, atZone || heavy]);
    else emit('shooting-star', 'bearish', [], ['no-prior-trend']);
  }

  // --- pin bar -------------------------------------------------------------
  // Overlaps hammer by design: the spec lists them separately and Phase 8
  // toggles them separately, so both are reported.
  if (meaningful && m.body > 0) {
    const upperThird = bar.low + (1 - p.outerThird) * m.range;
    const lowerThird = bar.low + p.outerThird * m.range;

    if (m.lowerWick >= p.wickToBody * m.body && m.bodyBottom >= upperThird) {
      emit('pin-bar-bullish', 'bullish', [afterDecline, atZone || heavy]);
    } else if (m.upperWick >= p.wickToBody * m.body && m.bodyTop <= lowerThird) {
      emit('pin-bar-bearish', 'bearish', [afterAdvance, atZone || heavy]);
    }
  }

  // --- engulfing -----------------------------------------------------------
  if (prev) {
    const pm = metrics(prev, ctx.atr);
    const engulfsBody = m.bodyTop >= pm.bodyTop && m.bodyBottom <= pm.bodyBottom;
    const substantial = m.bodyAtr >= p.engulfMinBodyAtr;

    if (engulfsBody && substantial && m.direction === 1 && pm.direction === -1) {
      emit('bullish-engulfing', 'bullish', [atZone, afterDecline || heavy]);
    } else if (engulfsBody && substantial && m.direction === -1 && pm.direction === 1) {
      emit('bearish-engulfing', 'bearish', [atZone, afterAdvance || heavy]);
    }
  }

  // --- inside / outside ----------------------------------------------------
  if (prev) {
    if (bar.high <= prev.high && bar.low >= prev.low) {
      emit('inside-bar', 'neutral', [m.rangeAtr <= 0.5]);
    } else if (bar.high > prev.high && bar.low < prev.low) {
      emit('outside-bar', m.direction === 1 ? 'bullish' : m.direction === -1 ? 'bearish' : 'neutral', [
        big,
        heavy,
      ]);
    }
  }

  // --- marubozu ------------------------------------------------------------
  if (m.bodyRatio >= p.marubozuBodyRatio && m.rangeAtr >= 0.5) {
    if (m.direction === 1) emit('marubozu-bullish', 'bullish', [big, heavy]);
    else if (m.direction === -1) emit('marubozu-bearish', 'bearish', [big, heavy]);
  }

  // --- tweezers ------------------------------------------------------------
  if (prev) {
    const tolerance = p.tweezerToleranceAtr * ctx.atr;
    const pm = metrics(prev, ctx.atr);

    if (
      Math.abs(bar.high - prev.high) <= tolerance &&
      pm.direction === 1 &&
      m.direction === -1 &&
      afterAdvance
    ) {
      emit('tweezer-top', 'bearish', [atZone, heavy]);
    } else if (
      Math.abs(bar.low - prev.low) <= tolerance &&
      pm.direction === -1 &&
      m.direction === 1 &&
      afterDecline
    ) {
      emit('tweezer-bottom', 'bullish', [atZone, heavy]);
    }
  }

  // --- three soldiers / crows ----------------------------------------------
  if (prev && prev2) {
    const trio = [prev2, prev, bar];
    const ms = trio.map((b) => metrics(b, ctx.atr));
    const solid = ms.every((x) => x.bodyRatio >= p.soldiersBodyRatio && x.rangeAtr >= p.minRangeAtr);

    if (solid && ms.every((x) => x.direction === 1)) {
      // Each open inside the previous body is what separates a genuine advance
      // from three gaps stacked on top of each other.
      const stepped =
        trio[1].close > trio[0].close &&
        trio[2].close > trio[1].close &&
        trio[1].open <= trio[0].close &&
        trio[2].open <= trio[1].close;
      if (stepped) emit('three-white-soldiers', 'bullish', [heavy, ms[2].rangeAtr >= 1]);
    } else if (solid && ms.every((x) => x.direction === -1)) {
      const stepped =
        trio[1].close < trio[0].close &&
        trio[2].close < trio[1].close &&
        trio[1].open >= trio[0].close &&
        trio[2].open >= trio[1].close;
      if (stepped) emit('three-black-crows', 'bearish', [heavy, ms[2].rangeAtr >= 1]);
    }
  }

  push();
  return found;
}

function clone(state) {
  return { params: { ...state.params }, history: state.history.slice(), index: state.index };
}

/**
 * @param {readonly import('../types').Bar[]} bars
 * @param {(bar: import('../types').Bar, i: number) => object} ctxFor
 * @param {object} [params]
 * @returns {CandleSignal[][]}
 */
function batch(bars, ctxFor, params) {
  const state = init(params);
  return bars.map((bar, i) => update(state, bar, ctxFor(bar, i)));
}

/** True if any signal in the list is a bullish reversal candle (used by S1/S2). */
function hasBullishReversal(signals, minStrength = 1) {
  return signals.some((s) => s.bias === 'bullish' && s.strength >= minStrength);
}

/** True if any signal in the list is a bearish reversal candle. */
function hasBearishReversal(signals, minStrength = 1) {
  return signals.some((s) => s.bias === 'bearish' && s.strength >= minStrength);
}

module.exports = {
  init,
  update,
  clone,
  batch,
  metrics,
  hasBullishReversal,
  hasBearishReversal,
  CANDLE_TYPES,
  TYPES_BY_ID,
  DEFAULTS,
};
