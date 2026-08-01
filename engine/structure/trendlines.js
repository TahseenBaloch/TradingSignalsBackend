// Trendlines fitted through confirmed swing pivots.
//
// Fitting is RANSAC-flavoured rather than a plain least-squares over all
// pivots: one outlying pivot would drag a global fit into a line that touches
// nothing. Instead every pair of pivots proposes a line, the proposal keeping
// the most pivots within tolerance wins, and only then is it refined by least
// squares over its own inliers.
//
// Refitting happens ONLY on a bar that confirms a new pivot. Between pivots the
// line cannot change, so all that is needed is reprojecting its right-hand end
// to the current bar. That turns an O(pivots^2) fit per bar into one every ten
// or twenty bars, which is the difference between a seed backtest that finishes
// and one that does not.
const { resolveParams } = require('../indicators/util');
const pivotsModule = require('./pivots');

const DEFAULTS = {
  poolSize: 8, // most recent pivots considered per side
  minTouches: 3, // spec: a trendline needs >= 3 aligned pivots
  toleranceAtr: 0.35, // max residual for a pivot to count as on the line
  breakAtr: 0.25, // close beyond the line by this x ATR marks it broken
};

/**
 * @typedef {Object} TrendlineAnchor
 * @property {number} index
 * @property {number} time
 * @property {number} price
 */

/**
 * @typedef {Object} Trendline
 * @property {'resistance'|'support'} kind  Through pivot highs, or pivot lows.
 * @property {number} slope      Price change per bar.
 * @property {number} intercept  Price at bar index 0.
 * @property {number} touches
 * @property {number} meanResidual
 * @property {TrendlineAnchor[]} anchors     The inlier pivots, oldest first.
 * @property {TrendlineAnchor} from          First anchor — segment start.
 * @property {TrendlineAnchor} to            Projection at the current bar.
 * @property {boolean} broken    A close has pushed decisively through it.
 * @property {number} fittedAtIndex
 */

/**
 * @typedef {Object} TrendlineState
 * @property {typeof DEFAULTS} params
 * @property {Trendline|null} resistance
 * @property {Trendline|null} support
 */

/**
 * @param {Partial<typeof DEFAULTS>} [params]
 * @returns {TrendlineState}
 */
function init(params) {
  return { params: resolveParams(DEFAULTS, params), resistance: null, support: null };
}

/** Least-squares fit over inlier pivots. @returns {{slope: number, intercept: number}} */
function leastSquares(points) {
  const n = points.length;
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;
  for (const p of points) {
    sx += p.index;
    sy += p.price;
    sxy += p.index * p.price;
    sxx += p.index * p.index;
  }
  const denominator = n * sxx - sx * sx;
  // Distinct pivots always have distinct indices, so this cannot be zero in
  // practice — but a degenerate fit must not produce Infinity.
  if (denominator === 0) return { slope: 0, intercept: sy / n };
  const slope = (n * sxy - sx * sy) / denominator;
  return { slope, intercept: (sy - slope * sx) / n };
}

/**
 * Best line through >= minTouches of the supplied pivots.
 *
 * @param {import('./pivots').Pivot[]} pool
 * @param {number} atr
 * @param {typeof DEFAULTS} p
 * @returns {{slope: number, intercept: number, inliers: import('./pivots').Pivot[], meanResidual: number}|null}
 */
function fit(pool, atr, p) {
  if (pool.length < p.minTouches) return null;
  const tolerance = p.toleranceAtr * atr;
  let best = null;

  for (let i = 0; i < pool.length - 1; i += 1) {
    for (let j = i + 1; j < pool.length; j += 1) {
      const a = pool[i];
      const b = pool[j];
      const span = b.index - a.index;
      if (span === 0) continue;

      const slope = (b.price - a.price) / span;
      const intercept = a.price - slope * a.index;

      const inliers = [];
      let residualSum = 0;
      for (const pivot of pool) {
        const residual = Math.abs(pivot.price - (slope * pivot.index + intercept));
        if (residual <= tolerance) {
          inliers.push(pivot);
          residualSum += residual;
        }
      }

      if (inliers.length < p.minTouches) continue;
      const meanResidual = residualSum / inliers.length;

      // More touches always wins; a tighter fit breaks ties. Both comparisons
      // are total orders over deterministic values, so the winner is stable.
      if (
        best === null ||
        inliers.length > best.inliers.length ||
        (inliers.length === best.inliers.length && meanResidual < best.meanResidual)
      ) {
        best = { slope, intercept, inliers, meanResidual };
      }
    }
  }

  if (best === null) return null;

  // Refine on the inliers alone, then re-measure. The pair that proposed the
  // line was just a seed; the fit that gets drawn should use every touch.
  const refined = leastSquares(best.inliers);
  let residualSum = 0;
  for (const pivot of best.inliers) {
    residualSum += Math.abs(pivot.price - (refined.slope * pivot.index + refined.intercept));
  }

  return {
    slope: refined.slope,
    intercept: refined.intercept,
    inliers: best.inliers,
    meanResidual: residualSum / best.inliers.length,
  };
}

/** Price the line predicts at a given bar index. */
function priceAt(line, index) {
  return line.slope * index + line.intercept;
}

function build(kind, fitted, index, bar) {
  const anchors = fitted.inliers.map((p) => ({ index: p.index, time: p.time, price: p.price }));
  return {
    kind,
    slope: fitted.slope,
    intercept: fitted.intercept,
    touches: anchors.length,
    meanResidual: fitted.meanResidual,
    anchors,
    from: anchors[0],
    to: { index, time: bar.time, price: fitted.slope * index + fitted.intercept },
    broken: false,
    fittedAtIndex: index,
  };
}

/**
 * @param {TrendlineState} state
 * @param {import('../types').Bar} bar
 * @param {{index: number, atr: number, pivots: import('./pivots').PivotState}} ctx
 * @param {import('./pivots').Pivot[]} [newPivots]
 * @returns {{resistance: Trendline|null, support: Trendline|null}}
 */
function update(state, bar, ctx, newPivots = []) {
  const p = state.params;
  const { index, atr } = ctx;
  if (!Number.isFinite(atr) || atr <= 0) return { resistance: null, support: null };

  for (const kind of ['high', 'low']) {
    const slot = kind === 'high' ? 'resistance' : 'support';

    if (newPivots.some((pv) => pv.kind === kind)) {
      const pool = pivotsModule.recent(ctx.pivots, kind, p.poolSize);
      const fitted = fit(pool, atr, p);
      state[slot] = fitted ? build(slot, fitted, index, bar) : null;
    }

    const line = state[slot];
    if (!line) continue;

    // Reproject the free end onto the current bar so the drawn segment always
    // reaches the right edge of the chart.
    line.to = { index, time: bar.time, price: priceAt(line, index) };

    // A resistance line is broken by a close above it, support by a close
    // below. Once broken it stays broken until a new pivot forces a refit —
    // an unbroken redraw would be repainting.
    const margin = p.breakAtr * atr;
    if (!line.broken) {
      line.broken =
        slot === 'resistance' ? bar.close > line.to.price + margin : bar.close < line.to.price - margin;
    }
  }

  return { resistance: state.resistance, support: state.support };
}

/** @param {TrendlineState} state @returns {TrendlineState} */
function clone(state) {
  const copyLine = (l) =>
    l === null ? null : { ...l, anchors: l.anchors.map((a) => ({ ...a })), from: { ...l.from }, to: { ...l.to } };
  return {
    params: { ...state.params },
    resistance: copyLine(state.resistance),
    support: copyLine(state.support),
  };
}

module.exports = { init, update, clone, fit, priceAt, leastSquares, DEFAULTS };
