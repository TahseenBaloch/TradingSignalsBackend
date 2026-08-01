// Shared type vocabulary for the whole engine, as JSDoc typedefs.
//
// This file is deliberately runtime-empty: it exists so every other engine
// module can `@typedef {import('../types').Bar}` instead of redeclaring shapes.
// The engine is plain CommonJS with JSDoc types rather than TypeScript so that
// the CJS backend and the Next frontend can both consume it with no build step.

/**
 * One OHLCV bar. Identical in shape to what providers/binance.js returns and
 * what /chart serves, so bars flow from the API into the engine untouched.
 *
 * `time` is the bar's OPEN time in unix SECONDS (not milliseconds, not close
 * time) — matching providers/binance.js normalize().
 *
 * @typedef {Object} Bar
 * @property {number} time   Bar open time, unix seconds.
 * @property {number} open
 * @property {number} high
 * @property {number} low
 * @property {number} close
 * @property {number} volume Base-asset volume.
 */

/**
 * An indicator that consumes a scalar series (EMA, SMA). Used both directly on
 * closes and internally on derived series such as the MACD line.
 *
 * @template S, V
 * @typedef {Object} ScalarIndicator
 * @property {(params?: any) => S} init
 * @property {(state: S, value: number) => V|null} update
 * @property {(state: S) => S} clone
 * @property {(values: readonly number[], params?: any) => (V|null)[]} batch
 */

/**
 * An indicator that consumes whole bars (ATR, ADX, VWAP, ...).
 *
 * @template S, V
 * @typedef {Object} BarIndicator
 * @property {(params?: any) => S} init
 * @property {(state: S, bar: Bar) => V|null} update
 * @property {(state: S) => S} clone
 * @property {(bars: readonly Bar[], params?: any) => (V|null)[]} batch
 */

module.exports = {};
