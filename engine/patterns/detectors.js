// Geometry detectors: range boxes, triangles, double tops/bottoms and flags.
//
// Every detector returns a FORMING pattern with drawable geometry and a trigger
// price; the orchestrator promotes it to CONFIRMED when a close breaches that
// trigger. Splitting it that way is what lets the chart show a shape developing
// instead of only announcing it after the fact.
//
// Detectors read confirmed pivots and fitted trendlines from Phase 2, so they
// inherit its no-repaint delay: a triangle cannot appear until the pivots
// defining it were confirmable.
const pivotsModule = require('../structure/pivots');
const base = require('./base');

const DEFAULTS = {
  // --- shared -------------------------------------------------------------
  breakoutAtr: 0.25, // close must clear a level by this x ATR to trigger
  failbackAtr: 0.5, // ...and fall back this far inside to invalidate
  minHeightAtr: 1.0, // a pattern shorter than this is not worth trading
  maxHeightAtr: 10.0,
  // --- range box ----------------------------------------------------------
  rangeFlatAtr: 0.5, // pivots this close together count as one flat edge
  rangeMinTouches: 2,
  // --- triangles ----------------------------------------------------------
  flatSlopeAtr: 0.02, // |slope| per bar, in ATR, below which a line is flat
  minConvergeBars: 3, // apex must still be this far ahead
  maxConvergeBars: 400,
  // --- doubles ------------------------------------------------------------
  doubleToleranceAtr: 0.5, // spec: two pivots within 0.5 ATR
  doubleMinSeparation: 5,
  doubleMaxSeparation: 60,
  // --- flags --------------------------------------------------------------
  impulseAtr: 2.0, // spec: impulse leg >= 2 ATR
  impulseMinBars: 3,
  impulseMaxBars: 12,
  flagMinBars: 3, // spec: counter-trend channel of 3-10 bars
  flagMaxBars: 10,
  flagMaxRetrace: 0.5, // ...retracing no more than half the impulse
  flagScanWindow: 22, // cheap gate: only hunt when something moved recently
};

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Are these prices all within `tolerance` of their own mean? */
function clustered(prices, tolerance) {
  if (prices.length === 0) return false;
  const centre = mean(prices);
  return prices.every((p) => Math.abs(p - centre) <= tolerance);
}

// ---------------------------------------------------------------------------
// Range / consolidation box
// ---------------------------------------------------------------------------

/**
 * A flat resistance and a flat support with >= 2 touches each. Detected from
 * pivots rather than from zones so the box has definite left and right edges to
 * draw, which a zone (an open-ended horizontal band) does not.
 */
function detectRange(ctx, p) {
  const { atr, index, bar } = ctx;
  const highs = pivotsModule.recent(ctx.pivots, 'high', p.rangeMinTouches);
  const lows = pivotsModule.recent(ctx.pivots, 'low', p.rangeMinTouches);
  if (highs.length < p.rangeMinTouches || lows.length < p.rangeMinTouches) return null;

  const tolerance = p.rangeFlatAtr * atr;
  if (!clustered(highs.map((h) => h.price), tolerance)) return null;
  if (!clustered(lows.map((l) => l.price), tolerance)) return null;

  const top = mean(highs.map((h) => h.price));
  const bottom = mean(lows.map((l) => l.price));
  const height = top - bottom;
  if (height < p.minHeightAtr * atr || height > p.maxHeightAtr * atr) return null;

  // Price must still be inside the box; a box price has already left is history.
  if (bar.close > top || bar.close < bottom) return null;

  const startTime = Math.min(highs[0].time, lows[0].time);

  return {
    type: 'range-box',
    direction: 'neutral',
    trigger: top,
    geometry: [
      { time: startTime, price: top, role: 'top-left' },
      { time: bar.time, price: top, role: 'top-right' },
      { time: bar.time, price: bottom, role: 'bottom-right' },
      { time: startTime, price: bottom, role: 'bottom-left' },
    ],
    meta: { top, bottom, height, touchesTop: highs.length, touchesBottom: lows.length },
  };
}

// ---------------------------------------------------------------------------
// Triangles
// ---------------------------------------------------------------------------

const priceOn = (line, index) => line.slope * index + line.intercept;

/**
 * Ascending, descending and symmetrical triangles, classified from the slopes
 * of the two fitted trendlines. All three share the same measured move: the
 * height where the lines started, projected from wherever price breaks out.
 */
function detectTriangle(ctx, p) {
  const { atr, index, bar, trendlines } = ctx;
  const upper = trendlines.resistance;
  const lower = trendlines.support;
  if (!upper || !lower || upper.broken || lower.broken) return null;

  const upperAt = priceOn(upper, index);
  const lowerAt = priceOn(lower, index);
  const height = upperAt - lowerAt;
  if (height < p.minHeightAtr * atr || height > p.maxHeightAtr * atr) return null;
  if (bar.close > upperAt || bar.close < lowerAt) return null;

  // Slopes normalised to ATR-per-bar so "flat" means the same on every symbol.
  const upperSlope = upper.slope / atr;
  const lowerSlope = lower.slope / atr;
  const flat = (s) => Math.abs(s) <= p.flatSlopeAtr;

  let type = null;
  if (flat(upperSlope) && lowerSlope > p.flatSlopeAtr) type = 'ascending-triangle';
  else if (flat(lowerSlope) && upperSlope < -p.flatSlopeAtr) type = 'descending-triangle';
  else if (upperSlope < -p.flatSlopeAtr && lowerSlope > p.flatSlopeAtr) type = 'symmetrical-triangle';
  if (!type) return null;

  // The lines must still be converging on a point that has not arrived yet.
  const closing = lowerSlope - upperSlope;
  if (closing <= 0) return null;
  const barsToApex = height / (closing * atr);
  if (barsToApex < p.minConvergeBars || barsToApex > p.maxConvergeBars) return null;

  const apexIndex = index + barsToApex;
  const secondsPerBar = ctx.secondsPerBar || 0;

  return {
    type,
    direction: type === 'ascending-triangle' ? 'long' : type === 'descending-triangle' ? 'short' : 'neutral',
    trigger: type === 'descending-triangle' ? lowerAt : upperAt,
    geometry: [
      { time: upper.from.time, price: upper.from.price, role: 'upper-start' },
      { time: bar.time, price: upperAt, role: 'upper-end' },
      { time: lower.from.time, price: lower.from.price, role: 'lower-start' },
      { time: bar.time, price: lowerAt, role: 'lower-end' },
      {
        time: bar.time + Math.round(barsToApex * secondsPerBar),
        price: (priceOn(upper, apexIndex) + priceOn(lower, apexIndex)) / 2,
        role: 'apex',
      },
    ],
    meta: {
      height,
      upperSlope: upper.slope,
      lowerSlope: lower.slope,
      barsToApex,
      upperTouches: upper.touches,
      lowerTouches: lower.touches,
    },
  };
}

// ---------------------------------------------------------------------------
// Double top / double bottom
// ---------------------------------------------------------------------------

/**
 * Two pivots at the same price with a counter-pivot between them. The neckline
 * is that middle pivot, and breaking it is what confirms — two equal highs on
 * their own are just a range edge.
 */
function detectDouble(ctx, p, kind) {
  const { atr, bar } = ctx;
  const isTop = kind === 'high';
  const extremes = pivotsModule.recent(ctx.pivots, kind, 2);
  if (extremes.length < 2) return null;

  const [first, second] = extremes;
  const separation = second.index - first.index;
  if (separation < p.doubleMinSeparation || separation > p.doubleMaxSeparation) return null;
  if (Math.abs(second.price - first.price) > p.doubleToleranceAtr * atr) return null;

  // The neckline pivot must sit BETWEEN the two extremes, not before them.
  const opposite = pivotsModule
    .recent(ctx.pivots, isTop ? 'low' : 'high', 8)
    .filter((pv) => pv.index > first.index && pv.index < second.index);
  if (opposite.length === 0) return null;

  const neckline = isTop
    ? Math.min(...opposite.map((o) => o.price))
    : Math.max(...opposite.map((o) => o.price));

  const level = (first.price + second.price) / 2;
  const height = Math.abs(level - neckline);
  if (height < p.minHeightAtr * atr || height > p.maxHeightAtr * atr) return null;

  // Price must not already be through the neckline, or the move is gone.
  if (isTop ? bar.close < neckline : bar.close > neckline) return null;

  return {
    type: isTop ? 'double-top' : 'double-bottom',
    direction: isTop ? 'short' : 'long',
    trigger: neckline,
    geometry: [
      { time: first.time, price: first.price, role: isTop ? 'first-top' : 'first-bottom' },
      { time: opposite[0].time, price: neckline, role: 'neckline' },
      { time: second.time, price: second.price, role: isTop ? 'second-top' : 'second-bottom' },
      { time: bar.time, price: neckline, role: 'neckline-end' },
    ],
    meta: { level, neckline, height, separation },
  };
}

// ---------------------------------------------------------------------------
// Bull / bear flags
// ---------------------------------------------------------------------------

/**
 * An impulse leg of >= 2 ATR followed by a shallow counter-trend channel of
 * 3-10 bars on declining volume.
 *
 * Guarded by a cheap precondition: unless SOMETHING moved 2 ATR inside the scan
 * window there is no impulse to find, and the nested search is skipped
 * entirely. Without that gate this is a ~70-combination scan on every bar of a
 * two-million-bar seed run.
 */
function detectFlag(ctx, p) {
  const { atr, bar, bars } = ctx;
  const window = p.flagScanWindow;
  if (bars.length < window) return null;

  const recent = bars.slice(-window);
  const closes = recent.map((b) => b.close);
  const swing = Math.max(...closes) - Math.min(...closes);
  if (swing < p.impulseAtr * atr) return null;

  const n = recent.length;
  for (let flagLen = p.flagMinBars; flagLen <= p.flagMaxBars; flagLen += 1) {
    const flagStart = n - flagLen;
    if (flagStart <= p.impulseMinBars) break;

    for (let impulseLen = p.impulseMinBars; impulseLen <= p.impulseMaxBars; impulseLen += 1) {
      const impulseStart = flagStart - impulseLen;
      if (impulseStart < 0) break;

      const from = recent[impulseStart];
      const to = recent[flagStart - 1];
      const move = to.close - from.close;
      if (Math.abs(move) < p.impulseAtr * atr) continue;

      const bull = move > 0;
      const flagBars = recent.slice(flagStart);
      const impulseBars = recent.slice(impulseStart, flagStart);

      const flagHigh = Math.max(...flagBars.map((b) => b.high));
      const flagLow = Math.min(...flagBars.map((b) => b.low));

      // The consolidation must lean AGAINST the impulse and give back no more
      // than half of it — a deeper retrace is a reversal, not a pause.
      const retrace = bull ? to.close - flagLow : flagHigh - to.close;
      if (retrace < 0 || retrace > p.flagMaxRetrace * Math.abs(move)) continue;
      if (bull ? flagHigh > to.close + Math.abs(move) * 0.5 : flagLow < to.close - Math.abs(move) * 0.5) {
        continue;
      }

      // Declining participation is what distinguishes a flag from distribution.
      if (mean(flagBars.map((b) => b.volume)) >= mean(impulseBars.map((b) => b.volume))) continue;

      return {
        type: bull ? 'bull-flag' : 'bear-flag',
        direction: bull ? 'long' : 'short',
        trigger: bull ? flagHigh : flagLow,
        geometry: [
          { time: from.time, price: from.close, role: 'impulse-start' },
          { time: to.time, price: to.close, role: 'impulse-end' },
          { time: flagBars[0].time, price: bull ? flagHigh : flagLow, role: 'flag-upper' },
          { time: bar.time, price: bull ? flagLow : flagHigh, role: 'flag-lower' },
        ],
        meta: {
          impulse: Math.abs(move),
          impulseBars: impulseLen,
          flagBars: flagLen,
          flagHigh,
          flagLow,
        },
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Promotion: FORMING -> CONFIRMED
// ---------------------------------------------------------------------------

/**
 * Decides whether a closed bar breaches a forming pattern's trigger, and if so
 * what the resulting target and invalidation are.
 *
 * Targets are measured moves — pattern height projected from the break — never
 * a round number or a fixed R multiple. Invalidation is a decisive move back
 * inside the shape, which is the level at which the geometry that produced the
 * target no longer exists.
 *
 * @returns {{direction: string, target: number, invalidation: number, entry: number}|null}
 */
function promote(pattern, bar, ctx, p) {
  const atr = ctx.atr;
  const margin = p.breakoutAtr * atr;
  const failback = p.failbackAtr * atr;
  const m = pattern.meta;

  switch (pattern.type) {
    case 'range-box': {
      if (bar.close > m.top + margin) {
        return {
          direction: 'long',
          entry: bar.close,
          target: m.top + m.height,
          invalidation: m.top - failback,
        };
      }
      if (bar.close < m.bottom - margin) {
        return {
          direction: 'short',
          entry: bar.close,
          target: m.bottom - m.height,
          invalidation: m.bottom + failback,
        };
      }
      return null;
    }

    case 'ascending-triangle':
    case 'descending-triangle':
    case 'symmetrical-triangle': {
      const upper = m.upperAt ?? pattern.geometry.find((g) => g.role === 'upper-end').price;
      const lower = m.lowerAt ?? pattern.geometry.find((g) => g.role === 'lower-end').price;
      if (bar.close > upper + margin) {
        return {
          direction: 'long',
          entry: bar.close,
          target: bar.close + m.height,
          invalidation: lower,
        };
      }
      if (bar.close < lower - margin) {
        return {
          direction: 'short',
          entry: bar.close,
          target: bar.close - m.height,
          invalidation: upper,
        };
      }
      return null;
    }

    case 'double-top': {
      if (bar.close < m.neckline - margin) {
        return {
          direction: 'short',
          entry: bar.close,
          target: m.neckline - m.height,
          invalidation: m.level + failback,
        };
      }
      return null;
    }

    case 'double-bottom': {
      if (bar.close > m.neckline + margin) {
        return {
          direction: 'long',
          entry: bar.close,
          target: m.neckline + m.height,
          invalidation: m.level - failback,
        };
      }
      return null;
    }

    case 'bull-flag': {
      if (bar.close > m.flagHigh + margin) {
        return {
          direction: 'long',
          entry: bar.close,
          target: bar.close + m.impulse,
          invalidation: m.flagLow,
        };
      }
      return null;
    }

    case 'bear-flag': {
      if (bar.close < m.flagLow - margin) {
        return {
          direction: 'short',
          entry: bar.close,
          target: bar.close - m.impulse,
          invalidation: m.flagHigh,
        };
      }
      return null;
    }

    default:
      return null;
  }
}

/**
 * A forming pattern whose shape has stopped being true should be dropped rather
 * than left on the chart. Returns true if the pattern is now void.
 */
function invalidated(pattern, bar, ctx, p) {
  const m = pattern.meta;
  const slack = p.failbackAtr * ctx.atr;

  switch (pattern.type) {
    case 'range-box':
      // Handled by promote(): leaving the box is a breakout, not a failure.
      return false;
    case 'bull-flag':
      return bar.close < m.flagLow - slack;
    case 'bear-flag':
      return bar.close > m.flagHigh + slack;
    case 'double-top':
      return bar.close > m.level + slack;
    case 'double-bottom':
      return bar.close < m.level - slack;
    default:
      return false;
  }
}

module.exports = {
  DEFAULTS,
  detectRange,
  detectTriangle,
  detectDouble,
  detectFlag,
  promote,
  invalidated,
  priceOn,
};
