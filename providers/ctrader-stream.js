// Live cTrader bars, same subscribe() contract as binance-stream.js / oanda-stream.js.
// The forming bar is the broker's own: a live-trendbar subscription puts it (open, high, low, tick volume) on every spot
// event, and the bid is its close. cTrader's history never includes the bar in progress, so it cannot supply this; it is
// re-read at every bar boundary and every 30s only to confirm closed bars, keeping them identical to what /chart serves.
// If the live trendbar is unavailable, the forming bar is built from ticks, anchored to the last closed bar's real close.
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
  // Held until the first resync has sent the last closed bar: a client must not draw today's bar before yesterday's
  // close arrives, and until then the bar before this one (prevTime, which vouches for weekend gaps) is unknown.
  if (!entry.forming || entry.lastClosedTime === null) return;
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
      entry.lastClosed = { time: bar.time, close: bar.close, closeTime: bar.closeTime };
    }

    // The live bar is newer than any snapshot, so history only replaces it when it has moved on: the bar closed, or
    // its period ran out without a live update to roll it.
    const nowSec = Math.floor(Date.now() / 1000);
    if (entry.forming && (entry.forming.time <= entry.lastClosedTime || entry.forming.closeTime <= nowSec)) {
      entry.forming = null;
      entry.lastBar = null; // never replay a bar that has since closed as if it were forming
    }
    if (entry.forming && entry.formingPrev === null) entry.formingPrev = entry.lastClosedTime;
    const snapshot = bars.find((b) => !b.closed);
    if (snapshot && (!entry.forming || snapshot.time > entry.forming.time)) {
      entry.forming = { ...snapshot };
      entry.formingPrev = entry.lastClosedTime;
    } else if (snapshot && snapshot.time === entry.forming.time) {
      entry.forming.open = snapshot.open;
      entry.forming.high = Math.max(entry.forming.high, snapshot.high);
      entry.forming.low = Math.min(entry.forming.low, snapshot.low);
    }

    // A tick that landed while the request was in flight is newer than anything above.
    const tick = entry.pendingTick;
    entry.pendingTick = null;
    if (tick) applyTick(entry, tick.price, tick.at);
    else if (entry.forming) emitForming(entry);
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

// Ticks can outrun cTrader publishing the bar that just closed; the floor keeps a burst of them to one history request.
function scheduleResync(entry) {
  if (entry.closing || entry.resyncing || entry.tickResyncTimer) return;
  const wait = TICK_RESYNC_MIN_MS - (Date.now() - entry.lastResyncAt);
  if (wait <= 0) resync(entry);
  else entry.tickResyncTimer = setTimeout(() => resync(entry), wait);
}

function applyPrice(bar, price) {
  bar.close = price;
  if (price > bar.high) bar.high = price;
  if (price < bar.low) bar.low = price;
}

/** Sends the forming bar as closed at its boundary, before the next bar opens, as Binance's kline stream does: a client
 * shown the next bar first reads the gap as missed data and refetches history. The live bar is the broker's own, so it
 * is final; the resync that would re-send it from history skips it, and the 30s one reconciles anything missed. */
function closeForming(entry) {
  const bar = entry.forming;
  clearTimeout(entry.emitTimer);
  entry.emitTimer = null;
  entry.forming = null;
  entry.lastBar = null;
  // Before the first resync there is no confirmed bar to follow; history will supply this one instead.
  if (entry.lastClosedTime === null || bar.time <= entry.lastClosedTime) return;
  emit(entry, 'bar', payloadOf(bar, true, entry.formingPrev));
  entry.lastClosedTime = bar.time;
  entry.lastClosed = { time: bar.time, close: bar.close, closeTime: bar.closeTime };
}

/** A bid applied to the forming bar, rolling to the next bar when the tick is past this one's close. */
function applyTick(entry, price, at) {
  if (entry.forming && at < entry.forming.closeTime) {
    applyPrice(entry.forming, price);
    // Provisional when there is no live trendbar to count ticks; its volume replaces this otherwise.
    if (!entry.liveTrendbars) entry.forming.volume += 1;
    scheduleEmit(entry);
    return;
  }
  // The bar in hand has closed; the next one starts from this tick.
  if (entry.forming) closeForming(entry);
  startFormingFromTick(entry, price, at);
}

/** The fallback forming bar, on the grid of the broker's own last closed bar, so session-aligned daily bars line up. */
function startFormingFromTick(entry, price, at) {
  const anchor = entry.forming || entry.lastClosed;
  if (!anchor || at < anchor.closeTime) {
    // Nothing to anchor to yet: wait for history to say where the bars are.
    entry.pendingTick = { price, at };
    scheduleResync(entry);
    return;
  }
  const step = INTERVALS[entry.interval].seconds;
  const periods = Math.floor((at - anchor.closeTime) / step);
  const openSec = anchor.closeTime + periods * step;
  // The bar straight after the last close opens at that close (FX and metals trade continuously); after a gap - a
  // weekend, a halt - it opens at the first price seen.
  const open = periods === 0 ? anchor.close : price;
  entry.formingPrev = anchor.time;
  entry.forming = {
    time: ctrader.labelFor(entry.interval, openSec),
    open,
    high: Math.max(open, price),
    low: Math.min(open, price),
    close: price,
    volume: 1,
    closeTime: openSec + step,
  };
  scheduleEmit(entry);
}

/** The broker's forming bar from a spot event: authoritative open, high, low and tick volume; the bid is the close. */
function applyLiveTrendbar(entry, bar, bid) {
  if (bar.time <= (entry.lastClosedTime ?? -Infinity)) return; // an event for a bar history already closed
  entry.liveTrendbars = true;
  const same = entry.forming && entry.forming.time === bar.time;
  const close = bar.hasClose ? bar.close : bid ?? (same ? entry.forming.close : bar.open);

  if (!entry.forming || bar.time > entry.forming.time) {
    // A new bar: the one before it has closed.
    if (entry.forming) closeForming(entry);
    entry.formingPrev = entry.lastClosedTime;
  } else if (!same) {
    return; // older than the bar in hand
  }
  entry.forming = {
    time: bar.time,
    open: bar.open,
    high: Math.max(bar.high, close),
    low: Math.min(bar.low, close),
    close,
    volume: bar.volume,
    closeTime: bar.closeTime,
  };
  scheduleEmit(entry);
}

const PERIOD_BY_NAME = { M1: 1, M5: 5, M15: 7, H1: 9, H4: 10, D1: 12, W1: 13 };

// One spot listener for the whole module, fanned out to the entries on that symbol.
client.onSpot((spot) => {
  const symbolId = Number(spot.symbolId);
  const at = spot.timestamp ? Math.floor(Number(spot.timestamp) / 1000) : Math.floor(Date.now() / 1000);
  const hasBid = spot.bid !== undefined && spot.bid !== null; // ask-only updates carry no bar price: bars are bid-based
  const trendbars = Array.isArray(spot.trendbar) ? spot.trendbar : [];

  for (const entry of streams.values()) {
    if (entry.symbolId !== symbolId || entry.closing) continue;
    const bid = hasBid ? Number((Number(spot.bid) / 100000).toFixed(entry.digits)) : null;
    if (bid !== null && !Number.isFinite(bid)) continue;

    const raw = trendbars.find((t) => (PERIOD_BY_NAME[t.period] ?? Number(t.period)) === entry.period);
    const live = raw && ctrader.decodeTrendbar(raw, entry.interval, entry.digits, at);
    if (live) {
      applyLiveTrendbar(entry, live, bid);
      continue;
    }
    if (bid === null) continue;
    if (entry.resyncing) {
      entry.pendingTick = { price: bid, at };
      continue;
    }
    applyTick(entry, bid, at);
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
    try {
      await client.subscribeLiveTrendbar(info.symbolId, entry.period);
      entry.trendbarSubscribed = true;
    } catch (err) {
      console.warn(`[stream:ctrader] ${entry.key} live trendbar unavailable, building the forming bar from ticks:`, err.message);
    }
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
  if (entry.trendbarSubscribed) {
    entry.trendbarSubscribed = false;
    client.unsubscribeLiveTrendbar(entry.symbolId, entry.period).catch(() => {});
  }
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
      period: ctrader.PERIOD[interval],
      symbolId: null,
      digits: 5,
      listeners: new Set(),
      forming: null,
      formingPrev: null,
      lastBar: null,
      lastClosedTime: null,
      lastClosed: null,
      pendingTick: null,
      liveTrendbars: false,
      trendbarSubscribed: false,
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
    liveTrendbars: e.liveTrendbars,
  }));
}

module.exports = { name: 'ctrader', subscribe, closeAll, stats };
