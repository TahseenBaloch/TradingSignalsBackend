// Live OANDA bars by polling the candles endpoint, one poller per instrument+interval shared by every subscriber.
// Same subscribe() contract as binance-stream.js. Polling rather than OANDA's tick stream means every live bar is
// OANDA's own candle - identical to what /chart later serves - instead of one rebuilt from ticks that could drift.
const { INTERVALS } = require('../intervals');
const oanda = require('./oanda');

// OANDA allows 120 requests/second per token; a poll a second per open chart is far inside that.
const POLL_MS = Number(process.env.OANDA_POLL_MS) || 1000;
// No forming candle means the market is shut (weekend, daily break): check back slowly until it reopens.
const CLOSED_POLL_MS = 15_000;
const IDLE_LINGER_MS = 30_000;
const BACKOFF_MAX_MS = 30_000;
const DEGRADED_AFTER_FAILURES = 5;
// Enough to include the forming bar and the closed one before it, even right after a close.
const POLL_BARS = 3;

const streams = new Map(); // `${instrument}:${interval}` -> entry

function emit(entry, event, payload) {
  for (const listener of entry.listeners) {
    try {
      listener(event, payload);
    } catch (err) {
      console.error('[stream:oanda] listener threw:', err.message);
    }
  }
}

function setState(entry, state) {
  if (entry.state === state) return;
  entry.state = state;
  emit(entry, 'status', { state });
}

function sameBar(a, b) {
  return (
    a && b && a.time === b.time && a.open === b.open && a.high === b.high &&
    a.low === b.low && a.close === b.close && a.volume === b.volume
  );
}

// `prevTime` is the bar before this one. Markets with a daily break or a weekend put gaps between bars, so the
// client cannot assume the previous bar is exactly one interval back; this lets it tell a gap from missed data.
function toPayload(bar, closed, prevTime) {
  return { ...bar, closed, prevTime };
}

async function poll(entry) {
  entry.timer = null;
  if (entry.closing) return;

  let delay = POLL_MS;
  try {
    const { bars } = await oanda.fetchCandles({
      providerSymbol: entry.instrument,
      interval: entry.interval,
      limit: POLL_BARS,
    });
    if (entry.closing) return;

    entry.failures = 0;
    setState(entry, 'live');

    const firstPoll = entry.lastClosedTime === null;
    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      if (!bar.closed) continue;
      if (!firstPoll && bar.time <= entry.lastClosedTime) continue;
      // On the first poll only the newest closed bar is worth sending; history already has the older ones.
      const newest = !bars.slice(i + 1).some((b) => b.closed);
      if (!firstPoll || newest) {
        const { closed, ...ohlcv } = bar;
        emit(entry, 'bar', toPayload(ohlcv, true, i > 0 ? bars[i - 1].time : null));
      }
      entry.lastClosedTime = bar.time;
    }

    const formingIndex = bars.findIndex((b) => !b.closed);
    if (formingIndex === -1) {
      // Never replay a bar that has since closed to a new subscriber as if it were still forming.
      entry.lastBar = null;
      delay = CLOSED_POLL_MS;
    } else {
      const { closed, ...ohlcv } = bars[formingIndex];
      const prevTime = formingIndex > 0 ? bars[formingIndex - 1].time : null;
      if (!sameBar(entry.lastBar, ohlcv)) {
        entry.lastBar = toPayload(ohlcv, false, prevTime);
        emit(entry, 'bar', entry.lastBar);
      }
    }
  } catch (err) {
    if (entry.closing) return;
    entry.failures += 1;
    if (entry.failures === 1 || entry.failures === DEGRADED_AFTER_FAILURES) {
      console.warn(`[stream:oanda] ${entry.key} poll failed (${entry.failures}x):`, err.message);
    }
    if (entry.failures >= DEGRADED_AFTER_FAILURES) setState(entry, 'degraded');
    delay = Math.min(POLL_MS * 2 ** entry.failures, BACKOFF_MAX_MS);
  }

  if (!entry.closing) entry.timer = setTimeout(() => poll(entry), delay);
}

function destroy(entry) {
  entry.closing = true;
  clearTimeout(entry.timer);
  clearTimeout(entry.idleTimer);
  streams.delete(entry.key);
}

/**
 * Subscribe to live bars for one instrument+interval. Bars carry `closed` and `prevTime`.
 *
 * @param providerSymbol OANDA instrument, e.g. 'XAU_USD'
 * @param interval       our interval token, e.g. '1m'
 * @param listener       (event, payload) => void, event is 'bar' | 'status'
 * @param opts.keepAlive keep polling with zero subscribers
 * @returns unsubscribe function
 */
function subscribe(providerSymbol, interval, listener, opts = {}) {
  if (!INTERVALS[interval]) throw new Error(`Unsupported interval: ${interval}`);

  const key = `${providerSymbol}:${interval}`;
  let entry = streams.get(key);

  if (!entry) {
    entry = {
      key,
      instrument: providerSymbol,
      interval,
      listeners: new Set(),
      lastBar: null,
      lastClosedTime: null,
      state: 'connecting',
      failures: 0,
      closing: false,
      keepAlive: false,
      timer: null,
      idleTimer: null,
    };
    streams.set(key, entry);
    poll(entry);
  }

  if (opts.keepAlive) entry.keepAlive = true;

  clearTimeout(entry.idleTimer);
  entry.idleTimer = null;
  entry.listeners.add(listener);

  listener('status', { state: entry.state });
  if (entry.lastBar) listener('bar', entry.lastBar);

  let released = false;
  return function unsubscribe() {
    if (released) return;
    released = true;
    entry.listeners.delete(listener);

    if (entry.listeners.size > 0 || entry.keepAlive) return;
    entry.idleTimer = setTimeout(() => {
      if (entry.listeners.size === 0 && !entry.keepAlive) destroy(entry);
    }, IDLE_LINGER_MS);
  };
}

function closeAll() {
  for (const entry of [...streams.values()]) destroy(entry);
}

function stats() {
  return [...streams.values()].map((e) => ({
    key: e.key,
    state: e.state,
    listeners: e.listeners.size,
    lastBarTime: e.lastBar ? e.lastBar.time : null,
  }));
}

module.exports = { name: 'oanda', subscribe, closeAll, stats };
