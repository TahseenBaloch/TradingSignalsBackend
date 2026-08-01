// Shared plumbing for the indicator library.
//
// The contract every indicator follows:
//
//   init(params)        -> state          pure, no I/O, no wall-clock reads
//   update(state, x)    -> value | null   MUTATES state, returns this step's value
//   clone(state)        -> state          deep enough to fork a simulation
//   batch(series, opts) -> (value|null)[] one entry per input, aligned by index
//
// `update` mutates rather than returning a fresh state because the backtester
// pushes ~2M bars through ~15 indicators per symbol; allocating a new state per
// bar per indicator is the difference between a seed run of minutes and one of
// hours. Determinism (Rule 6) is unaffected: the same inputs in the same order
// always produce the same outputs. `clone` exists for the cases that genuinely
// need to fork — walk-forward windows and no-lookahead tests.
//
// `batch` is ALWAYS implemented as a loop over `update` (see makeBatch). That
// is not laziness: it makes it structurally impossible for the backtest path
// and the live path to compute different numbers, which is Rule 3.

/** Returned by update() during an indicator's warmup period (Rule 2). */
const WARMUP = null;

/**
 * Builds the `batch` half of an indicator from its `init`/`update` half, so the
 * two can never diverge.
 *
 * @template S, V, X
 * @param {(params?: any) => S} init
 * @param {(state: S, input: X) => V|null} update
 * @returns {(series: readonly X[], params?: any) => (V|null)[]}
 */
function makeBatch(init, update) {
  return function batch(series, params) {
    const state = init(params);
    const out = new Array(series.length);
    for (let i = 0; i < series.length; i += 1) out[i] = update(state, series[i]);
    return out;
  };
}

/**
 * A fixed-size ring buffer with a running sum, for rolling-window indicators.
 * Kept O(1) per bar: the value leaving the window is subtracted rather than the
 * whole window being re-summed.
 *
 * The running sum is refreshed from scratch every `RESYNC_EVERY` pushes. Adding
 * and subtracting floats for hundreds of thousands of bars accumulates drift,
 * and an indicator that is subtly wrong deep into a backtest is exactly the
 * kind of silent lie these rules exist to prevent.
 */
const RESYNC_EVERY = 4096;

class Window {
  /** @param {number} size */
  constructor(size) {
    if (!Number.isInteger(size) || size < 1) {
      throw new Error(`Window size must be a positive integer, got ${size}`);
    }
    this.size = size;
    /** @type {number[]} */
    this.buf = new Array(size);
    this.count = 0; // values pushed so far, capped at size
    this.head = 0; // next write position
    this.sum = 0;
    this.pushes = 0;
  }

  /** @returns {boolean} true once the window holds a full `size` values. */
  get full() {
    return this.count === this.size;
  }

  /**
   * @param {number} value
   * @returns {number|null} the value evicted from the window, if it was full.
   */
  push(value) {
    const evicted = this.count === this.size ? this.buf[this.head] : null;
    if (evicted !== null) this.sum -= evicted;
    else this.count += 1;

    this.buf[this.head] = value;
    this.sum += value;
    this.head = (this.head + 1) % this.size;

    this.pushes += 1;
    if (this.pushes % RESYNC_EVERY === 0) this.resync();

    return evicted;
  }

  /** Recomputes `sum` from the buffer, discarding accumulated float drift. */
  resync() {
    let total = 0;
    for (let i = 0; i < this.count; i += 1) total += this.buf[i];
    this.sum = total;
  }

  /** @returns {number|null} mean of the window, or null until it is full. */
  mean() {
    return this.count === this.size ? this.sum / this.size : null;
  }

  /** Values in chronological order. Allocates — not for use on the hot path. */
  values() {
    if (this.count < this.size) return this.buf.slice(0, this.count);
    const out = new Array(this.size);
    for (let i = 0; i < this.size; i += 1) out[i] = this.buf[(this.head + i) % this.size];
    return out;
  }

  /** Highest value currently in the window. O(size) — windows here are small. */
  max() {
    if (this.count === 0) return null;
    let m = -Infinity;
    for (let i = 0; i < this.count; i += 1) if (this.buf[i] > m) m = this.buf[i];
    return m;
  }

  /**
   * Population variance of the window about a supplied mean.
   *
   * Two-pass rather than the E[x²] − E[x]² shortcut, and non-allocating rather
   * than going through values(): the shortcut loses precision through
   * catastrophic cancellation exactly where it matters here — a tight 20-bar
   * band around a five-figure BTC price — and this runs on every bar of a
   * multi-million-bar backtest.
   *
   * @param {number} mean
   * @returns {number|null}
   */
  varianceAbout(mean) {
    if (this.count === 0) return null;
    let acc = 0;
    for (let i = 0; i < this.count; i += 1) {
      const d = this.buf[i] - mean;
      acc += d * d;
    }
    return acc / this.count;
  }

  /** Lowest value currently in the window. */
  min() {
    if (this.count === 0) return null;
    let m = Infinity;
    for (let i = 0; i < this.count; i += 1) if (this.buf[i] < m) m = this.buf[i];
    return m;
  }

  clone() {
    const copy = new Window(this.size);
    copy.buf = this.buf.slice();
    copy.count = this.count;
    copy.head = this.head;
    copy.sum = this.sum;
    copy.pushes = this.pushes;
    return copy;
  }
}

/**
 * Wilder's smoothing, the recursive average used by RSI, ATR and ADX:
 *   next = (prev * (period - 1) + value) / period
 *
 * @param {number} prev
 * @param {number} value
 * @param {number} period
 */
function wilder(prev, value, period) {
  return (prev * (period - 1) + value) / period;
}

/**
 * True Range. `prevClose` is null on the very first bar, where TR degenerates
 * to the bar's own range.
 *
 * @param {import('../types').Bar} bar
 * @param {number|null} prevClose
 */
function trueRange(bar, prevClose) {
  const range = bar.high - bar.low;
  if (prevClose === null) return range;
  return Math.max(range, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
}

/**
 * Validates and freezes an indicator's resolved parameters.
 *
 * @template {Record<string, unknown>} P
 * @param {P} defaults
 * @param {Partial<P>|undefined} params
 * @returns {P}
 */
function resolveParams(defaults, params) {
  const merged = { ...defaults, ...(params || {}) };
  for (const [key, value] of Object.entries(merged)) {
    if (typeof defaults[key] === 'number' && (!Number.isFinite(value) || value <= 0)) {
      throw new Error(`Indicator parameter "${key}" must be a positive number, got ${value}`);
    }
  }
  return merged;
}

/** UTC day index for a bar time in unix seconds. Time is data, never `Date.now()`. */
function utcDayIndex(timeSeconds) {
  return Math.floor(timeSeconds / 86400);
}

module.exports = {
  WARMUP,
  Window,
  makeBatch,
  wilder,
  trueRange,
  resolveParams,
  utcDayIndex,
};
