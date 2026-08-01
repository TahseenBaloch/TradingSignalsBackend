// Live kline streams from Binance, one upstream socket per symbol+interval,
// shared by every subscriber. Callers get normalized bars identical in shape to
// providers/binance.js REST bars, plus a `closed` flag.
//
// This module is also the seam for future server-side detectors: anything that
// calls subscribe() receives the same stream a browser does, whether or not a
// browser is connected.
const WebSocket = require('ws');
const { INTERVALS } = require('../intervals');

const BASE = process.env.BINANCE_STREAM_URL || 'wss://stream.binance.com:9443/ws';

// Keep an unsubscribed stream open briefly. Flipping 1m -> 5m -> 1m, or a React
// StrictMode remount, would otherwise pay a full reconnect each time.
const IDLE_LINGER_MS = 30_000;

// Binance sends a ping every 20s and closes idle sockets. If nothing at all
// arrives for this long the connection is half-open and must be torn down.
const STALL_TIMEOUT_MS = 90_000;

// Binance force-closes connections at 24h. Rotate before that, make-before-break.
const ROTATE_AFTER_MS = 23 * 60 * 60 * 1000;

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const DEGRADED_AFTER_RETRIES = 10;

// Binance allows 300 connection attempts per 5 minutes per IP. Leaked sockets
// from repeated restarts can reach that during a day of development, so every
// connect goes through a shared budget.
const CONNECT_BUDGET = 5;
const CONNECT_WINDOW_MS = 10_000;
let connectTimes = [];

const streams = new Map(); // `${providerSymbol}:${binanceInterval}` -> entry

function canConnectNow() {
  const cutoff = Date.now() - CONNECT_WINDOW_MS;
  connectTimes = connectTimes.filter((t) => t > cutoff);
  return connectTimes.length < CONNECT_BUDGET;
}

function normalize(k) {
  return {
    // k.t is the bar's OPEN time. Using k.T (close) would shift every bar by a
    // full period. Milliseconds -> seconds, matching the REST provider.
    time: Math.floor(Number(k.t) / 1000),
    open: Number(k.o),
    high: Number(k.h),
    low: Number(k.l),
    close: Number(k.c),
    // k.v is base-asset volume, the same field providers/binance.js uses. k.q
    // is quote volume; mixing them makes the volume bar jump on every refetch.
    volume: Number(k.v),
    closed: k.x === true,
  };
}

function emit(entry, event, payload) {
  for (const listener of entry.listeners) {
    try {
      listener(event, payload);
    } catch (err) {
      console.error('[stream] listener threw:', err.message);
    }
  }
}

function setState(entry, state) {
  if (entry.state === state) return;
  entry.state = state;
  emit(entry, 'status', { state });
}

function clearTimers(entry) {
  clearTimeout(entry.reconnectTimer);
  clearTimeout(entry.rotateTimer);
  clearInterval(entry.stallTimer);
  entry.reconnectTimer = null;
  entry.rotateTimer = null;
  entry.stallTimer = null;
}

function scheduleReconnect(entry) {
  if (entry.closing || entry.reconnectTimer) return;

  const delay =
    Math.min(RECONNECT_BASE_MS * 2 ** entry.retries, RECONNECT_MAX_MS) +
    Math.floor(Math.random() * 1000);
  entry.retries += 1;

  if (entry.retries >= DEGRADED_AFTER_RETRIES) setState(entry, 'degraded');

  entry.reconnectTimer = setTimeout(() => {
    entry.reconnectTimer = null;
    connect(entry);
  }, delay);
}

function connect(entry) {
  if (entry.closing) return;

  if (!canConnectNow()) {
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = null;
      connect(entry);
    }, CONNECT_WINDOW_MS / CONNECT_BUDGET);
    return;
  }
  connectTimes.push(Date.now());

  if (entry.state !== 'degraded') setState(entry, 'connecting');

  const url = `${BASE}/${entry.providerSymbol.toLowerCase()}@kline_${entry.binanceInterval}`;
  const ws = new WebSocket(url);
  entry.ws = ws;
  entry.lastMessageAt = Date.now();

  // Mandatory: an unhandled 'error' event on an EventEmitter terminates the
  // process. Same hazard cache.js documents for Redis.
  ws.on('error', (err) => {
    console.warn(`[stream] ${entry.key} socket error:`, err.message);
  });

  ws.on('message', (raw) => {
    entry.lastMessageAt = Date.now();

    // Reset backoff on real data, not on 'open'. Binance can accept a
    // connection and then never send anything.
    entry.retries = 0;
    setState(entry, 'live');

    // A rotation replacement proves itself by delivering data; only then do we
    // retire the old socket, so there is no visible gap.
    if (entry.previousWs) {
      const old = entry.previousWs;
      entry.previousWs = null;
      old.removeAllListeners();
      old.close();
    }

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || msg.e !== 'kline' || !msg.k) return;

    const bar = normalize(msg.k);
    if (!Number.isFinite(bar.time) || !Number.isFinite(bar.close)) return;

    entry.lastBar = bar;
    emit(entry, 'bar', bar);
  });

  ws.on('close', () => {
    if (entry.closing || entry.ws !== ws) return; // superseded by a rotation
    setState(entry, 'connecting');
    scheduleReconnect(entry);
  });

  clearInterval(entry.stallTimer);
  entry.stallTimer = setInterval(() => {
    if (Date.now() - entry.lastMessageAt <= STALL_TIMEOUT_MS) return;
    console.warn(`[stream] ${entry.key} stalled, terminating`);
    // terminate() not close(): a graceful close waits for a handshake that a
    // half-open socket will never complete.
    ws.terminate();
  }, STALL_TIMEOUT_MS / 3);

  clearTimeout(entry.rotateTimer);
  entry.rotateTimer = setTimeout(() => rotate(entry), ROTATE_AFTER_MS);
}

// Open a replacement ahead of Binance's 24h forced close. The old socket keeps
// serving until the new one delivers its first message (see 'message' above).
function rotate(entry) {
  if (entry.closing || !entry.ws) return;
  console.log(`[stream] ${entry.key} rotating connection`);
  entry.previousWs = entry.ws;
  entry.previousWs.removeAllListeners('close');
  entry.previousWs.on('close', () => {});
  connect(entry);
}

function destroy(entry) {
  entry.closing = true;
  clearTimers(entry);
  if (entry.previousWs) {
    entry.previousWs.removeAllListeners();
    entry.previousWs.terminate();
    entry.previousWs = null;
  }
  if (entry.ws) {
    entry.ws.removeAllListeners();
    entry.ws.terminate();
    entry.ws = null;
  }
  streams.delete(entry.key);
}

/**
 * Subscribe to live bars for one symbol+interval.
 *
 * @param providerSymbol upstream symbol, e.g. 'BTCUSDT'
 * @param interval       our interval token, e.g. '1m' (see intervals.js)
 * @param listener       (event, payload) => void, event is 'bar' | 'status'
 * @param opts.keepAlive keep the upstream open with zero subscribers - for
 *                       server-side consumers that must not miss data
 * @returns unsubscribe function
 */
function subscribe(providerSymbol, interval, listener, opts = {}) {
  const spec = INTERVALS[interval];
  if (!spec) throw new Error(`Unsupported interval: ${interval}`);

  const key = `${providerSymbol}:${spec.binance}`;
  let entry = streams.get(key);

  if (!entry) {
    entry = {
      key,
      providerSymbol,
      binanceInterval: spec.binance,
      ws: null,
      previousWs: null,
      listeners: new Set(),
      lastBar: null,
      lastMessageAt: 0,
      retries: 0,
      state: 'connecting',
      closing: false,
      keepAlive: false,
      reconnectTimer: null,
      rotateTimer: null,
      stallTimer: null,
      idleTimer: null,
    };
    streams.set(key, entry);
    connect(entry);
  }

  if (opts.keepAlive) entry.keepAlive = true;

  clearTimeout(entry.idleTimer);
  entry.idleTimer = null;
  entry.listeners.add(listener);

  // Hand over the current state and last known bar immediately, so a new
  // subscriber on a warm stream renders at once instead of waiting for a tick.
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

module.exports = { subscribe, closeAll, stats };
