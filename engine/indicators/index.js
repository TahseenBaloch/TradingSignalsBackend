// The indicator library.
//
// Every module here is pure: no I/O, no wall-clock reads, no randomness. Time
// enters only as `bar.time`. The same functions serve the live pipeline and the
// backtester (Rule 3), and `batch` is built from `update` so the two cannot
// drift apart.
//
// Two shapes, by input type:
//
//   SCALAR  (update(state, number))  sma, ema
//     Reusable primitives. They run on closes, on volume, and on derived series
//     such as the MACD line, so they take whatever series the caller means.
//
//   BAR     (update(state, bar))     everything else
//     These need more than one field — highs and lows, or volume, or bar time —
//     so they take the whole bar and select what they need.
//
// Warmup (Rule 2): every indicator returns null until it has genuinely seen
// enough bars. Some return a partial object afterwards — MACD's `signal`, ADX's
// `adx`, Stochastic's `d` warm later than their siblings and are null until
// they do. Callers must handle that null rather than read it as zero.
//
//   indicator       first non-null at bar index   fully warm at
//   ema/sma         period − 1                    same
//   rsi             period                        same
//   atr             period − 1                    same
//   macd            slowPeriod − 1                + signalPeriod − 1
//   adx             period (DIs)                  2 x period − 1 (adx)
//   bollinger       period − 1                    same
//   stochastic      period + smoothK − 2 (k)      + smoothD − 1 (d)
//   supertrend      atrPeriod − 1                 same
//   volume          period − 1                    same
//   vwapSession     first bar with volume         n/a (resets daily)
//   vwapRolling     period − 1                    same

const sma = require('./sma');
const ema = require('./ema');
const rsi = require('./rsi');
const macd = require('./macd');
const atr = require('./atr');
const adx = require('./adx');
const bollinger = require('./bollinger');
const vwapSession = require('./vwap-session');
const vwapRolling = require('./vwap-rolling');
const supertrend = require('./supertrend');
const stochastic = require('./stochastic');
const volume = require('./volume');
const util = require('./util');

/** Indicators driven by a scalar series. */
const SCALAR = { sma, ema };

/** Indicators driven by whole bars. */
const BAR = {
  rsi,
  macd,
  atr,
  adx,
  bollinger,
  vwapSession,
  vwapRolling,
  supertrend,
  stochastic,
  volume,
};

module.exports = {
  ...SCALAR,
  ...BAR,
  SCALAR,
  BAR,
  Window: util.Window,
  trueRange: util.trueRange,
  wilder: util.wilder,
  utcDayIndex: util.utcDayIndex,
};
