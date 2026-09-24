// Live cTrader bars, same subscribe() contract as binance-stream.js / oanda-stream.js.
// Ticks (bid) move the forming bar in real time; at every bar boundary, and every 30s regardless, the bar is re-read
// from cTrader's own trendbars. That keeps live bars identical to what /chart serves - authoritative closes, cTrader's
// tick volume - instead of trusting a bar rebuilt from ticks, and it needs no knowledge of the broker's session clock.
const { INTERVALS } = require('../intervals');
const client = require('./ctrader-client');
const ctrader = require('./ctrader');

const RESYNC_MS = 30_000;
const EMIT_MIN_MS = 250; // gold can tick 10+ times a second; the chart needs a few paints a second at most
const IDLE_LINGER_MS = 30_000;
const DEGRADED_AFTER_FAILURES = 3;
// Ticks can outrun cTrader creating the next bar; without a floor every tick would spend one of the 5 history
// requests/second the whole connection shares.
const TICK_RESYNC_MIN_MS = 2_000;

const streams = new Map(); // `${providerSymbol}:${interval}` -> entry

function emit(entry, event, payload) {
  for (const listener of entry.listeners) {
    try {
      listener(event, payload);
    } catch (err) {
      console.error('[stream:ctrader] listener threw:', err.message);
    }
  }
}

function setState(entry, state) {
  if (entry.state === state) return;
  entry.state = state;
  emit(entry, 'status', { state });
}

function payloadOf(bar, closed, prevTime) {
  return { time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume, closed, prevTime };
}

function emitForming(entry) {
  clearTimeout(entry.emitTimer);
  entry.emitTimer = null;
  if (!entry.forming) return;
  entry.lastEmitAt = Date.now();
  entry.lastBar = payloadOf(entry.forming, false, entry.formingPrev);
  emit(entry, 'bar', entry.lastBar);
}

function scheduleEmit(entry) {
  const wait = EMIT_MIN_MS - (Date.now() - entry.lastEmitAt);
  if (wait <= 0) return emitForming(entry);
  if (!entry.emitTimer) entry.emitTimer = setTimeout(() => emitForming(entry), wait);
}

async function resync(entry) {
  if (entry.closing || entry.resyncing) return;
  entry.resyncing = true;
  entry.lastResyncAt = Date.now();
  clearTimeout(entry.tickResyncTimer);
  entry.tickResyncTimer = null;
  try {
    const { bars } = await ctrader.fetchCandles({ providerSymbol: entry.providerSymbol, interval: entry.interval, limit: 3 });
    if (entry.closing) return;
    entry.failures = 0;

    const firstSync = entry.lastClosedTime === null;
    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      if (!bar.closed) continue;
      if (!firstSync && bar.time <= entry.lastClosedTime) continue;
      // On the first sync only the newest closed bar is sent; history already has the older ones.
      const newest = !bars.slice(i + 1).some((b) => b.closed);
      if (!firstSync || newest) emit(entry, 'bar', payloadOf(bar, true, i > 0 ? bars[i - 1].time : null));
      entry.lastClosedTime = bar.time;
    }

    const index = bars.findIndex((b) => !b.closed);
    if (index === -1) {
      entry.forming = null;
      entry.lastBar = null; // never replay a bar that has since closed as if it were forming
    } else {
      entry.forming = { ...bars[index] };
      entry.formingPrev = index > 0 ? bars[index - 1].time : null;
      // A tick that landed while the request was in flight is newer than the snapshot: keep its price.
      const tick = entry.pendingTick;
      const step = INTERVALS[entry.interval].seconds;
      if (tick && tick.at >= entry.forming.closeTime - step && tick.at < entry.forming.closeTime) applyPrice(entry.forming, tick.price);
      emitForming(entry);
    }
    entry.pendingTick = null;
    setState(entry, 'live');
  } catch (err) {
    entry.failures += 1;
    if (entry.failures === 1 || entry.failures === DEGRADED_AFTER_FAILURES) {
      console.warn(`[stream:ctrader] ${entry.key} resync failed (${entry.failures}x):`, err.message);
    }
    if (entry.failures >= DEGRADED_AFTER_FAILURES) setState(entry, 'degraded');
    // Retry soon rather than at the next 30s resync, backing off; a chart with no bar yet should not sit empty.
    if (!entry.closing && !entry.tickResyncTimer) {
      entry.tickResyncTimer = setTimeout(() => resync(entry), Math.min(3000 * entry.failures, 30_000));
    }
  } finally {
    entry.resyncing = false;
  }
}

function applyPrice(bar, price) {
  bar.close = price;
  if (price > bar.high) bar.high = price;
  if (price < bar.low) bar.low = price;
}

// One spot listener for the whole module, fanned out to the entries on that symbol.
client.onSpot((spot) => {
  if (spot.bid === undefined || spot.bid === null) return; // ask-only update: bars are bid-based
  const symbolId = Number(spot.symbolId);
  const at = spot.timestamp ? Math.floor(Number(spot.timestamp) / 1000) : Math.floor(Date.now() / 1000);

  for (const entry of streams.values()) {
    if (entry.symbolId !== symbolId || entry.closing) continue;
    const price = Number((Number(spot.bid) / 100000).toFixed(entry.digits));
    if (!Number.isFinite(price)) continue;

    if (entry.resyncing) {
      entry.pendingTick = { price, at };
      continue;
    }
    // No forming bar (market was shut) or the tick belongs to the next bar: let cTrader say what the new bar is.
    if (!entry.forming || at >= entry.forming.closeTime) {
      entry.pendingTick = { price, at };
      const wait = TICK_RESYNC_MIN_MS - (Date.now() - entry.lastResyncAt);
      if (wait <= 0) resync(entry);
      else if (!entry.tickResyncTimer) entry.tickResyncTimer = setTimeout(() => resync(entry), wait);
      continue;
    }
    applyPrice(entry.forming, price);
    entry.forming.volume += 1; // provisional; the next resync replaces it with cTrader's own count
    scheduleEmit(entry);
  }
});

// After a reconnect the client has resubscribed spots; bars may have closed meanwhile, so re-read them.
client.onState((state) => {
  for (const entry of streams.values()) {
    if (state === 'ready') resync(entry);
    else if (state === 'connecting' && entry.state === 'live') setState(entry, 'connecting');
  }
});

async function start(entry) {
  try {
    const info = await client.symbolInfo(entry.providerSymbol);
    if (entry.closing) return;
    entry.symbolId = info.symbolId;
    entry.digits = info.digits;
    await client.subscribeSpots(info.symbolId);
    entry.spotSubscribed = true;
    if (entry.closing) return release(entry);
    await resync(entry);
  } catch (err) {
    console.warn(`[stream:ctrader] ${entry.key} could not start:`, err.message);
    setState(entry, 'degraded');
    // Try again later: the connection may simply not be up yet.
    if (!entry.closing) entry.retryTimer = setTimeout(() => start(entry), 15_000);
    return;
  }
  entry.resyncTimer = setInterval(() => resync(entry), RESYNC_MS);
}

function release(entry) {
  if (entry.spotSubscribed) {
    entry.spotSubscribed = false;
    client.unsubscribeSpots(entry.symbolId).catch(() => {});
  }
}

function destroy(entry) {
  entry.closing = true;
  clearTimeout(entry.emitTimer);
  clearTimeout(entry.idleTimer);
  clearTimeout(entry.retryTimer);
  clearTimeout(entry.tickResyncTimer);
  clearInterval(entry.resyncTimer);
  release(entry);
  streams.delete(entry.key);
}

/**
 * Subscribe to live bars for one symbol+interval. Bars carry `closed` and `prevTime`.
 *
 * @param providerSymbol broker symbol name(s), e.g. 'XAUUSD' or 'XTIUSD|USOIL'
 * @param interval       our interval token, e.g. '1m'
 * @param listener       (event, payload) => void, event is 'bar' | 'status'
 * @returns unsubscribe function
 */
function subscribe(providerSymbol, interval, listener, opts = {}) {
  if (!INTERVALS[interval]) throw new Error(`Unsupported interval: ${interval}`);

  const key = `${providerSymbol}:${interval}`;
  let entry = streams.get(key);

  if (!entry) {
    entry = {
      key,
      providerSymbol,
      interval,
      symbolId: null,
      digits: 5,
      listeners: new Set(),
      forming: null,
      formingPrev: null,
      lastBar: null,
      lastClosedTime: null,
      pendingTick: null,
      state: 'connecting',
      failures: 0,
      resyncing: false,
      spotSubscribed: false,
      closing: false,
      keepAlive: false,
      lastEmitAt: 0,
      lastResyncAt: 0,
      emitTimer: null,
      tickResyncTimer: null,
      resyncTimer: null,
      retryTimer: null,
      idleTimer: null,
    };
    streams.set(key, entry);
    start(entry);
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
  client.close();
}

function stats() {
  return [...streams.values()].map((e) => ({
    key: e.key,
    state: e.state,
    listeners: e.listeners.size,
    lastBarTime: e.lastBar ? e.lastBar.time : null,
  }));
}

module.exports = { name: 'ctrader', subscribe, closeAll, stats };
