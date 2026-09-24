// One authenticated connection to cTrader Open API (JSON over WebSocket), shared by the candle provider and the live
// stream. cTrader is connection-oriented - no REST - so auth, heartbeats, reconnects, token refresh and the
// historical-request rate limit all live here, and callers just await request() or listen for spot ticks.
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { httpError } = require('../http-error');

const LIVE = (process.env.CTRADER_ENV || 'demo').toLowerCase() === 'live';
const URL_ = process.env.CTRADER_WS_URL || `wss://${LIVE ? 'live' : 'demo'}.ctraderapi.com:5036`;
const CLIENT_ID = process.env.CTRADER_CLIENT_ID || '';
const CLIENT_SECRET = process.env.CTRADER_CLIENT_SECRET || '';
// Refresh tokens rotate on every refresh, so the newest pair is persisted here rather than only living in memory.
const TOKEN_FILE = path.resolve(process.env.CTRADER_TOKEN_FILE || path.join(__dirname, '..', '.ctrader-tokens.json'));
const TIMEOUT_MS = Number(process.env.PROVIDER_TIMEOUT_MS) || 8000;

// Payload types from Spotware's OpenApiModelMessages.proto / OpenApiCommonModelMessages.proto.
const PT = {
  ERROR_RES: 50,
  HEARTBEAT: 51,
  APP_AUTH_REQ: 2100,
  APP_AUTH_RES: 2101,
  ACCOUNT_AUTH_REQ: 2102,
  ACCOUNT_AUTH_RES: 2103,
  SYMBOLS_LIST_REQ: 2114,
  SYMBOLS_LIST_RES: 2115,
  SYMBOL_BY_ID_REQ: 2116,
  SYMBOL_BY_ID_RES: 2117,
  SUBSCRIBE_SPOTS_REQ: 2127,
  SUBSCRIBE_SPOTS_RES: 2128,
  UNSUBSCRIBE_SPOTS_REQ: 2129,
  UNSUBSCRIBE_SPOTS_RES: 2130,
  SPOT_EVENT: 2131,
  SUBSCRIBE_LIVE_TRENDBAR_REQ: 2135,
  UNSUBSCRIBE_LIVE_TRENDBAR_REQ: 2136,
  GET_TRENDBARS_REQ: 2137,
  GET_TRENDBARS_RES: 2138,
  SUBSCRIBE_LIVE_TRENDBAR_RES: 2165,
  UNSUBSCRIBE_LIVE_TRENDBAR_RES: 2166,
  OA_ERROR_RES: 2142,
  TOKEN_INVALIDATED_EVENT: 2147,
  CLIENT_DISCONNECT_EVENT: 2148,
  ACCOUNTS_BY_TOKEN_REQ: 2149,
  ACCOUNTS_BY_TOKEN_RES: 2150,
  ACCOUNT_DISCONNECT_EVENT: 2164,
  REFRESH_TOKEN_REQ: 2173,
  REFRESH_TOKEN_RES: 2174,
};

const HEARTBEAT_MS = 10_000; // cTrader asks for one every 10s; it drops connections idle for 30s
const STALL_MS = 45_000; // it heartbeats back, so this much silence means a dead socket
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
// cTrader allows 5 historical requests/second per connection (50/s for the rest), counted on arrival. Requests are
// spaced evenly rather than sent in bursts of four: a burst delayed in transit lands next to the following one.
const HISTORY_GAP_MS = 250;
const HISTORY_RETRIES = 2;
const HISTORY_TYPES = new Set([PT.GET_TRENDBARS_REQ]);
const AUTH_ERRORS = new Set(['OA_AUTH_TOKEN_EXPIRED', 'CH_ACCESS_TOKEN_INVALID', 'ACCOUNT_NOT_AUTHORIZED']);

let ws = null;
let state = 'idle'; // idle | connecting | ready | closed
let readyPromise = null;
let readyResolve = null;
let readyReject = null;
let retries = 0;
let heartbeatTimer = null;
let stallTimer = null;
let reconnectTimer = null;
let lastMessageAt = 0;
let nextMsgId = 1;
let accountId = process.env.CTRADER_ACCOUNT_ID ? Number(process.env.CTRADER_ACCOUNT_ID) : null;
let brokerName = null;
let tokens = loadTokens();
let lastError = null;

const pending = new Map(); // clientMsgId -> { resolve, reject, timer }
const spotListeners = new Set();
const stateListeners = new Set();
const spotRefs = new Map(); // symbolId -> subscriber count, so a reconnect can resubscribe
const trendbarRefs = new Map(); // `${symbolId}:${period}` -> subscriber count, likewise
const historyQueue = [];
let historyTimer = null;
let lastHistoryAt = 0;

// Symbol directory, filled once authenticated.
let symbolsByName = null; // upper-cased broker name -> { symbolId, name }
const symbolDetails = new Map(); // symbolId -> { digits }

function configured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET && tokens.accessToken);
}

function loadTokens() {
  const fromEnv = {
    accessToken: process.env.CTRADER_ACCESS_TOKEN || '',
    refreshToken: process.env.CTRADER_REFRESH_TOKEN || '',
  };
  try {
    const saved = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    // A saved pair only wins if it descends from the env pair; a fresh token pasted into .env must replace it.
    if (saved.accessToken && saved.origin === fromEnv.refreshToken) return saved;
  } catch {
    // no saved pair yet
  }
  return { ...fromEnv, origin: fromEnv.refreshToken };
}

function saveTokens() {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  } catch (err) {
    console.warn('[ctrader] could not persist refreshed tokens:', err.message);
  }
}

function setState(next) {
  if (state === next) return;
  state = next;
  for (const listener of stateListeners) {
    try {
      listener(next);
    } catch (err) {
      console.error('[ctrader] state listener threw:', err.message);
    }
  }
}

function rawSend(payloadType, payload, clientMsgId) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  const msg = { payloadType, payload: payload || {} };
  if (clientMsgId) msg.clientMsgId = clientMsgId;
  ws.send(JSON.stringify(msg));
  return true;
}

function upstreamError(code, description) {
  if (code === 'REQUEST_FREQUENCY_EXCEEDED' || code === 'BLOCKED_PAYLOAD_TYPE') {
    return httpError(429, 'rate_limited', 'Market data provider rate limit hit');
  }
  if (AUTH_ERRORS.has(code) || code === 'CH_CLIENT_AUTH_FAILURE' || code === 'CH_OA_CLIENT_NOT_FOUND') {
    return httpError(502, 'upstream_auth', `cTrader rejected the credentials (${code})${description ? `: ${description}` : ''}`);
  }
  const err = httpError(502, 'upstream_error', `Market data provider rejected the request (${code})${description ? `: ${description}` : ''}`);
  err.providerCode = code;
  return err;
}

/** Send one request on the live connection and resolve with its response payload. */
function sendRequest(payloadType, payload) {
  return new Promise((resolve, reject) => {
    const clientMsgId = `m${nextMsgId++}`;
    const timer = setTimeout(() => {
      pending.delete(clientMsgId);
      reject(httpError(504, 'upstream_timeout', 'Market data provider timed out'));
    }, TIMEOUT_MS);
    pending.set(clientMsgId, { resolve, reject, timer });
    if (!rawSend(payloadType, payload, clientMsgId)) {
      clearTimeout(timer);
      pending.delete(clientMsgId);
      reject(httpError(502, 'upstream_unreachable', 'Market data provider unreachable'));
    }
  });
}

// Historical requests go through a queue that sends one every HISTORY_GAP_MS, so a chart opening a dozen timeframes
// queues briefly instead of tripping REQUEST_FREQUENCY_EXCEEDED. A rejection anyway is retried after a pause.
function drainHistory() {
  historyTimer = null;
  if (!historyQueue.length) return;
  const wait = lastHistoryAt + HISTORY_GAP_MS - Date.now();
  if (wait > 0) {
    historyTimer = setTimeout(drainHistory, wait);
    return;
  }
  lastHistoryAt = Date.now();
  const job = historyQueue.shift();
  sendRequest(job.payloadType, job.payload).then(job.resolve, (err) => {
    if (err.code === 'rate_limited' && job.attempts < HISTORY_RETRIES) {
      job.attempts += 1;
      setTimeout(() => {
        historyQueue.unshift(job);
        if (!historyTimer) drainHistory();
      }, 1000 * job.attempts);
      return;
    }
    job.reject(err);
  });
  if (historyQueue.length) historyTimer = setTimeout(drainHistory, HISTORY_GAP_MS);
}

function enqueueHistory(payloadType, payload) {
  return new Promise((resolve, reject) => {
    historyQueue.push({ payloadType, payload, resolve, reject, attempts: 0 });
    if (!historyTimer) drainHistory();
  });
}

/** Authenticated request. Waits for the connection, applies the history rate limit, retries once after a token refresh. */
async function request(payloadType, payload = {}, { account = true } = {}) {
  if (!configured()) {
    throw httpError(503, 'provider_unconfigured', 'cTrader is not configured: set CTRADER_CLIENT_ID, CTRADER_CLIENT_SECRET and CTRADER_ACCESS_TOKEN');
  }
  await ready();
  const body = account ? { ctidTraderAccountId: accountId, ...payload } : payload;
  const send = () => (HISTORY_TYPES.has(payloadType) ? enqueueHistory(payloadType, body) : sendRequest(payloadType, body));
  try {
    return await send();
  } catch (err) {
    if (err.code === 'upstream_auth' && tokens.refreshToken) {
      await refreshAndReauth();
      return send();
    }
    throw err;
  }
}

function handleMessage(raw) {
  lastMessageAt = Date.now();
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  const { payloadType, payload = {}, clientMsgId } = msg || {};

  if (clientMsgId && pending.has(clientMsgId)) {
    const job = pending.get(clientMsgId);
    pending.delete(clientMsgId);
    clearTimeout(job.timer);
    if (payloadType === PT.OA_ERROR_RES || payloadType === PT.ERROR_RES) {
      job.reject(upstreamError(payload.errorCode, payload.description));
    } else {
      job.resolve(payload);
    }
    return;
  }

  if (payloadType === PT.SPOT_EVENT) {
    for (const listener of spotListeners) {
      try {
        listener(payload);
      } catch (err) {
        console.error('[ctrader] spot listener threw:', err.message);
      }
    }
    return;
  }

  if (payloadType === PT.TOKEN_INVALIDATED_EVENT || payloadType === PT.ACCOUNT_DISCONNECT_EVENT) {
    console.warn('[ctrader] account session ended:', payload.reason || payloadType);
    refreshAndReauth().catch((err) => console.warn('[ctrader] re-authentication failed:', err.message));
    return;
  }

  if (payloadType === PT.CLIENT_DISCONNECT_EVENT) {
    console.warn('[ctrader] server is disconnecting us:', payload.reason || '(no reason)');
  }
  // Heartbeats and anything unrecognized only count as liveness.
}

function failPending(err) {
  for (const [id, job] of pending) {
    clearTimeout(job.timer);
    job.reject(err);
    pending.delete(id);
  }
}

async function authenticate() {
  await sendRequest(PT.APP_AUTH_REQ, { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });

  if (!accountId) {
    const res = await sendRequest(PT.ACCOUNTS_BY_TOKEN_REQ, { accessToken: tokens.accessToken });
    const accounts = res.ctidTraderAccount || [];
    const match = accounts.find((a) => Boolean(a.isLive) === LIVE);
    if (!match) {
      throw httpError(502, 'upstream_auth', `This cTrader token has no ${LIVE ? 'live' : 'demo'} account (found ${accounts.length})`);
    }
    accountId = Number(match.ctidTraderAccountId);
    brokerName = match.brokerTitleShort || null;
  }

  await sendRequest(PT.ACCOUNT_AUTH_REQ, { ctidTraderAccountId: accountId, accessToken: tokens.accessToken });

  if (!brokerName) {
    const res = await sendRequest(PT.ACCOUNTS_BY_TOKEN_REQ, { accessToken: tokens.accessToken }).catch(() => null);
    const me = res && (res.ctidTraderAccount || []).find((a) => Number(a.ctidTraderAccountId) === accountId);
    brokerName = (me && me.brokerTitleShort) || null;
  }

  await loadSymbols();

  // Resubscribe whatever the stream layer had open before a reconnect.
  const ids = [...spotRefs.keys()];
  if (ids.length) {
    await sendRequest(PT.SUBSCRIBE_SPOTS_REQ, { ctidTraderAccountId: accountId, symbolId: ids, subscribeToSpotTimestamp: true });
  }
  // Live trendbars ride on the spot subscription, so they go second. One failing must not fail the whole reconnect.
  for (const key of trendbarRefs.keys()) {
    const [symbolId, period] = key.split(':').map(Number);
    await sendRequest(PT.SUBSCRIBE_LIVE_TRENDBAR_REQ, { ctidTraderAccountId: accountId, symbolId, period }).catch((err) => {
      if (err.providerCode !== 'ALREADY_SUBSCRIBED') console.warn(`[ctrader] live trendbar ${key} resubscribe failed:`, err.message);
    });
  }
}

async function loadSymbols() {
  const list = await sendRequest(PT.SYMBOLS_LIST_REQ, { ctidTraderAccountId: accountId, includeArchivedSymbols: false });
  symbolsByName = new Map();
  for (const s of list.symbol || []) {
    if (s.enabled === false || !s.symbolName) continue;
    symbolsByName.set(normalizeName(s.symbolName), { symbolId: Number(s.symbolId), name: s.symbolName });
  }
}

function normalizeName(name) {
  return String(name).toUpperCase().replace(/[^A-Z0-9]/g, ''); // "EUR/USD" and "EURUSD" are the same symbol
}

function connect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  setState('connecting');

  const socket = new WebSocket(URL_);
  ws = socket;
  lastMessageAt = Date.now();

  socket.on('error', (err) => {
    lastError = err.message;
    console.warn('[ctrader] socket error:', err.message);
  });

  socket.on('message', handleMessage);

  socket.on('open', () => {
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => rawSend(PT.HEARTBEAT, {}), HEARTBEAT_MS);
    clearInterval(stallTimer);
    stallTimer = setInterval(() => {
      if (Date.now() - lastMessageAt > STALL_MS) {
        console.warn('[ctrader] connection stalled, reconnecting');
        socket.terminate();
      }
    }, STALL_MS / 3);

    const onReady = () => {
      retries = 0;
      lastError = null;
      setState('ready');
      if (readyResolve) readyResolve();
      readyResolve = readyReject = null;
      console.log(`[ctrader] connected to ${LIVE ? 'live' : 'demo'} account ${accountId}${brokerName ? ` (${brokerName})` : ''}, ${symbolsByName.size} symbols`);
    };

    authenticate()
      .then(onReady)
      .catch(async (err) => {
        lastError = err.message;
        // An expired access token is recoverable once, with the refresh token.
        if (err.code === 'upstream_auth' && tokens.refreshToken && !socket.refreshTried) {
          socket.refreshTried = true;
          try {
            await refreshTokens();
            await authenticate();
            onReady();
            return;
          } catch (refreshErr) {
            lastError = refreshErr.message;
          }
        }
        console.warn('[ctrader] authentication failed:', lastError);
        if (readyReject) readyReject(err);
        readyPromise = readyResolve = readyReject = null;
        socket.terminate();
      });
  });

  socket.on('close', () => {
    if (ws !== socket) return;
    clearInterval(heartbeatTimer);
    clearInterval(stallTimer);
    failPending(httpError(502, 'upstream_unreachable', 'Market data provider connection lost'));
    ws = null;
    if (state === 'closed') return;
    setState('connecting');
    if (readyReject) readyReject(httpError(502, 'upstream_unreachable', `cTrader connection failed${lastError ? `: ${lastError}` : ''}`));
    readyPromise = readyResolve = readyReject = null;
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (reconnectTimer || state === 'closed') return;
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** retries, RECONNECT_MAX_MS) + Math.floor(Math.random() * 1000);
  retries += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    // Reconnect only if someone still needs the connection; the next request() reopens it otherwise.
    if (spotRefs.size > 0) ready().catch(() => {});
  }, delay);
}

/** Resolves once connected, authenticated and the symbol list is loaded. Opens the connection on first use. */
function ready() {
  if (state === 'ready' && ws && ws.readyState === WebSocket.OPEN) return Promise.resolve();
  if (!configured()) {
    return Promise.reject(httpError(503, 'provider_unconfigured', 'cTrader is not configured'));
  }
  if (!readyPromise) {
    readyPromise = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    readyPromise.catch(() => {}); // callers get the rejection; this only stops an unhandled-rejection warning
    if (!ws) connect();
  }
  return readyPromise;
}

async function refreshTokens() {
  if (!tokens.refreshToken) throw httpError(502, 'upstream_auth', 'cTrader access token expired and no refresh token is set');
  const res = await sendRequest(PT.REFRESH_TOKEN_REQ, { refreshToken: tokens.refreshToken });
  tokens = { accessToken: res.accessToken, refreshToken: res.refreshToken, origin: tokens.origin, expiresIn: res.expiresIn, refreshedAt: new Date().toISOString() };
  saveTokens();
  console.log('[ctrader] access token refreshed');
}

let refreshing = null;
function refreshAndReauth() {
  if (!refreshing) {
    refreshing = (async () => {
      await refreshTokens();
      await sendRequest(PT.ACCOUNT_AUTH_REQ, { ctidTraderAccountId: accountId, accessToken: tokens.accessToken }).catch((err) => {
        if (err.providerCode !== 'ALREADY_LOGGED_IN') throw err;
      });
    })().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

/** Resolve a registry symbol ('XTIUSD|USOIL' = try each broker name in turn) to the broker's symbol, or null. */
function resolveSymbol(candidates) {
  if (!symbolsByName) return null;
  for (const name of String(candidates).split('|')) {
    const hit = symbolsByName.get(normalizeName(name));
    if (hit) return hit;
  }
  return null;
}

async function symbolInfo(candidates) {
  await ready();
  const symbol = resolveSymbol(candidates);
  if (!symbol) {
    throw httpError(502, 'upstream_error', `This cTrader account has no symbol named ${String(candidates).replace(/\|/g, ' or ')}`);
  }
  if (!symbolDetails.has(symbol.symbolId)) {
    const res = await request(PT.SYMBOL_BY_ID_REQ, { symbolId: [symbol.symbolId] });
    const detail = (res.symbol || [])[0];
    symbolDetails.set(symbol.symbolId, { digits: detail ? Number(detail.digits) : 5 });
  }
  return { ...symbol, ...symbolDetails.get(symbol.symbolId) };
}

/** Load display digits for every symbol in one request, so /tickers can report precision. */
async function preloadDetails(candidateList) {
  await ready();
  const ids = [...new Set(candidateList.map(resolveSymbol).filter(Boolean).map((s) => s.symbolId))].filter((id) => !symbolDetails.has(id));
  if (!ids.length) return;
  const res = await request(PT.SYMBOL_BY_ID_REQ, { symbolId: ids });
  for (const detail of res.symbol || []) symbolDetails.set(Number(detail.symbolId), { digits: Number(detail.digits) });
}

async function subscribeSpots(symbolId) {
  const count = spotRefs.get(symbolId) || 0;
  spotRefs.set(symbolId, count + 1);
  if (count > 0) return;
  try {
    await request(PT.SUBSCRIBE_SPOTS_REQ, { symbolId: [symbolId], subscribeToSpotTimestamp: true });
  } catch (err) {
    if (err.providerCode !== 'ALREADY_SUBSCRIBED') {
      spotRefs.delete(symbolId);
      throw err;
    }
  }
}

async function unsubscribeSpots(symbolId) {
  const count = spotRefs.get(symbolId) || 0;
  if (count > 1) return spotRefs.set(symbolId, count - 1);
  spotRefs.delete(symbolId);
  if (state === 'ready') await request(PT.UNSUBSCRIBE_SPOTS_REQ, { symbolId: [symbolId] }).catch(() => {});
}

/** The broker's own forming bar for this period, delivered as `trendbar` on the symbol's spot events. Needs the spot subscription first. */
async function subscribeLiveTrendbar(symbolId, period) {
  const key = `${symbolId}:${period}`;
  const count = trendbarRefs.get(key) || 0;
  trendbarRefs.set(key, count + 1);
  if (count > 0) return;
  try {
    await request(PT.SUBSCRIBE_LIVE_TRENDBAR_REQ, { symbolId, period });
  } catch (err) {
    if (err.providerCode !== 'ALREADY_SUBSCRIBED') {
      trendbarRefs.delete(key);
      throw err;
    }
  }
}

async function unsubscribeLiveTrendbar(symbolId, period) {
  const key = `${symbolId}:${period}`;
  const count = trendbarRefs.get(key) || 0;
  if (count > 1) return trendbarRefs.set(key, count - 1);
  trendbarRefs.delete(key);
  if (state === 'ready') await request(PT.UNSUBSCRIBE_LIVE_TRENDBAR_REQ, { symbolId, period }).catch(() => {});
}

function onSpot(listener) {
  spotListeners.add(listener);
  return () => spotListeners.delete(listener);
}

function onState(listener) {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

function close() {
  setState('closed');
  clearTimeout(reconnectTimer);
  clearInterval(heartbeatTimer);
  clearInterval(stallTimer);
  failPending(httpError(502, 'upstream_unreachable', 'Shutting down'));
  if (ws) {
    ws.removeAllListeners();
    ws.on('error', () => {});
    ws.terminate();
    ws = null;
  }
}

module.exports = {
  PT,
  configured,
  ready,
  request,
  resolveSymbol,
  symbolInfo,
  preloadDetails,
  subscribeSpots,
  unsubscribeSpots,
  subscribeLiveTrendbar,
  unsubscribeLiveTrendbar,
  onSpot,
  onState,
  close,
  state: () => state,
  broker: () => brokerName,
  digitsFor: (candidates) => {
    const s = resolveSymbol(candidates);
    const d = s && symbolDetails.get(s.symbolId);
    return d ? d.digits : null;
  },
  isListed: (candidates) => (symbolsByName ? Boolean(resolveSymbol(candidates)) : true),
};
