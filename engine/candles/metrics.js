// Bar geometry, measured once per bar and shared by every detector.
//
// Everything sizeable is expressed BOTH as a fraction of the bar's own range
// and as a multiple of ATR. Ratios answer "what shape is this bar"; ATR answers
// "is this bar big enough to care about". A detector needs both — a textbook
// hammer whose whole range is a tenth of an ATR is noise, and a huge bar with
// no distinctive shape is not a pattern.

/**
 * @typedef {Object} BarMetrics
 * @property {number} body        |close − open|
 * @property {number} range       high − low
 * @property {number} upperWick
 * @property {number} lowerWick
 * @property {number} bodyTop     max(open, close)
 * @property {number} bodyBottom  min(open, close)
 * @property {1|-1|0} direction   Up, down, or a perfectly flat body.
 * @property {number} bodyRatio   body / range, 0..1. 0 when the range is 0.
 * @property {number} upperRatio  upperWick / range.
 * @property {number} lowerRatio  lowerWick / range.
 * @property {number} rangeAtr    range / ATR.
 * @property {number} bodyAtr     body / ATR.
 * @property {number} midpoint    (high + low) / 2
 */

/**
 * @param {import('../types').Bar} bar
 * @param {number} atr  Must be positive; callers gate on ATR warmup.
 * @returns {BarMetrics}
 */
function metrics(bar, atr) {
  const body = Math.abs(bar.close - bar.open);
  const range = bar.high - bar.low;
  const bodyTop = Math.max(bar.open, bar.close);
  const bodyBottom = Math.min(bar.open, bar.close);

  // A zero-range bar is a real thing on an illiquid minute. Ratios against it
  // would be 0/0, so they collapse to 0 and every shape test then fails —
  // which is the correct answer for a bar with no shape.
  const safeRange = range > 0 ? range : 0;
  const ratio = (x) => (safeRange > 0 ? x / safeRange : 0);

  return {
    body,
    range,
    upperWick: bar.high - bodyTop,
    lowerWick: bodyBottom - bar.low,
    bodyTop,
    bodyBottom,
    direction: bar.close > bar.open ? 1 : bar.close < bar.open ? -1 : 0,
    bodyRatio: ratio(body),
    upperRatio: ratio(bar.high - bodyTop),
    lowerRatio: ratio(bodyBottom - bar.low),
    rangeAtr: atr > 0 ? range / atr : 0,
    bodyAtr: atr > 0 ? body / atr : 0,
    midpoint: (bar.high + bar.low) / 2,
  };
}

module.exports = { metrics };
