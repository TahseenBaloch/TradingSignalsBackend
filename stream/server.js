// WebSocket endpoint at /stream. Clients subscribe to symbol+interval and
// receive live bars fanned out from the shared upstream provider streams.
const { WebSocketServer } = require('ws');
const tickets = require('./tickets');
const upstream = require('../providers/binance-stream');
const { getSymbol } = require('../symbols');
const { resolveInterval, SUPPORTED } = require('../intervals');

const PATH = '/stream';
const MAX_SUBSCRIPTIONS_PER_CLIENT = 4;
const MAX_CONNECTIONS_PER_USER = 8;
const MAX_CONNECTIONS_TOTAL = 64;
const HEARTBEAT_MS = 30_000;

const ALLOWED_ORIGINS = (process.env.STREAM_ALLOWED_ORIGINS || 'http://localhost:8000')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

// Browsers always send Origin on a WebSocket handshake, so an absent Origin
// means a non-browser client. Rejecting it by default is what stops any site
// the user visits from opening an authenticated socket (there is no CORS on
// this server). The escape hatch exists for headless testing.
const ALLOW_NO_ORIGIN = process.env.STREAM_ALLOW_NO_ORIGIN === 'true';

let wss = null;
let heartbeat = null;
// Supplies the analysis snapshot a client needs on (re)subscribe, and the feed
// backlog. Injected by index.js so this module keeps no engine dependency.
let snapshotProvider = null;

function setSnapshotProvider(provider) {
  snapshotProvider = provider;
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function reject(socket, status, reason) {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function originAllowed(origin) {
  if (!origin) return ALLOW_NO_ORIGIN;
  return ALLOWED_ORIGINS.includes(origin);
}

function countConnections(userId) {
  let total = 0;
  let mine = 0;
  for (const client of wss.clients) {
    total += 1;
    if (client.user && client.user.sub === userId) mine += 1;
  }
  return { total, mine };
}

function handleSubscribe(ws, msg) {
  const symbol = getSymbol(msg.symbol);
  if (!symbol) {
    return send(ws, { t: 'error', code: 'unknown_symbol', message: `Unknown symbol: ${msg.symbol}` });
  }

  // resolveInterval returns '1D' for an empty token but null for a bad one, so
  // this must test against null rather than falsiness.
  const interval = resolveInterval(msg.interval);
  if (interval === null) {
    return send(ws, {
      t: 'error',
      code: 'invalid_interval',
      message: `Unsupported interval: ${msg.interval}. Supported: ${SUPPORTED.join(', ')}`,
    });
  }

  const key = `${symbol.symbol}:${interval}`;
  if (ws.subs.has(key)) return send(ws, { t: 'sub_ok', symbol: symbol.symbol, interval });

  if (ws.subs.size >= MAX_SUBSCRIPTIONS_PER_CLIENT) {
    return send(ws, { t: 'error', code: 'too_many_subscriptions', message: 'Subscription limit reached' });
  }

  const unsubscribe = upstream.subscribe(symbol.providerSymbol, interval, (event, payload) => {
    // Every message names its symbol and interval so the client can discard
    // bars that arrive after it switched away - otherwise an in-flight BTC bar
    // can paint an ETH candle at a BTC price.
    if (event === 'bar') {
      send(ws, {
        t: 'bar',
        symbol: symbol.symbol,
        interval,
        closed: payload.closed,
        bar: {
          time: payload.time,
          open: payload.open,
          high: payload.high,
          low: payload.low,
          close: payload.close,
          volume: payload.volume,
        },
      });
    } else if (event === 'status') {
      send(ws, { t: 'status', symbol: symbol.symbol, interval, state: payload.state });
    }
  });

  ws.subs.set(key, unsubscribe);
  send(ws, { t: 'sub_ok', symbol: symbol.symbol, interval });

  // A fresh subscriber gets the FULL analysis state, then diffs from there.
  // Starting straight on diffs would leave a client that joined mid-session
  // with an empty chart until every zone happened to change.
  if (snapshotProvider) {
    const snapshot = snapshotProvider.analysis(symbol.symbol, interval);
    if (snapshot) send(ws, snapshot);
  }
}

function handleUnsubscribe(ws, msg) {
  const symbol = getSymbol(msg.symbol);
  const interval = resolveInterval(msg.interval);
  if (!symbol || interval === null) return;

  const key = `${symbol.symbol}:${interval}`;
  const unsubscribe = ws.subs.get(key);
  if (unsubscribe) {
    unsubscribe();
    ws.subs.delete(key);
  }
}

function attach(server) {
  wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

  // noServer rather than { server }: the ticket and Origin checks must run
  // before any socket state exists.
  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host}`);
    } catch {
      return reject(socket, 400, 'Bad Request');
    }

    // An upgrade on an unhandled path must be destroyed explicitly, or Node
    // holds the socket open forever.
    if (url.pathname !== PATH) return reject(socket, 404, 'Not Found');

    if (!originAllowed(req.headers.origin)) {
      console.warn('[stream] rejected origin:', req.headers.origin || '(none)');
      return reject(socket, 403, 'Forbidden');
    }

    const payload = tickets.consume(url.searchParams.get('ticket'));
    if (!payload) return reject(socket, 401, 'Unauthorized');

    const { total, mine } = countConnections(payload.sub);
    if (total >= MAX_CONNECTIONS_TOTAL || mine >= MAX_CONNECTIONS_PER_USER) {
      return reject(socket, 503, 'Too Many Connections');
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.user = payload;
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    ws.subs = new Map();
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('error', (err) => console.warn('[stream] client socket error:', err.message));

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return send(ws, { t: 'error', code: 'bad_message', message: 'Malformed JSON' });
      }
      if (!msg || typeof msg.t !== 'string') return;

      if (msg.t === 'sub') handleSubscribe(ws, msg);
      else if (msg.t === 'unsub') handleUnsubscribe(ws, msg);
      // The Signal Feed spans every symbol and timeframe, which is far more
      // than MAX_SUBSCRIPTIONS_PER_CLIENT allows. It is a separate, non
      // symbol-scoped channel precisely so it does not consume that budget:
      // the server already computes these events for all pairs regardless of
      // who is watching, so this is a pure fan-out with no upstream cost.
      else if (msg.t === 'sub_signals') {
        ws.signalsSubscribed = true;
        send(ws, { t: 'signals_ok' });
        if (snapshotProvider) {
          for (const row of snapshotProvider.feed()) send(ws, { t: 'signal_row', row });
        }
      } else if (msg.t === 'unsub_signals') {
        ws.signalsSubscribed = false;
      }
    });

    ws.on('close', () => {
      for (const unsubscribe of ws.subs.values()) unsubscribe();
      ws.subs.clear();
    });

    send(ws, { t: 'ready' });
  });

  // Reap sockets whose peer vanished without a close frame - a closed laptop
  // lid leaves the connection open indefinitely otherwise.
  heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  console.log(`[stream] websocket endpoint ready at ${PATH}`);
  return wss;
}

/**
 * Fans an engine message out to the clients that asked for it.
 *
 * Analysis diffs go only to clients watching that exact symbol+interval, since
 * they are useless anywhere else. Signals additionally reach anyone on the
 * signals channel — that is the whole point of the feed.
 */
function broadcast(msg) {
  if (!wss) return;
  const key = msg.symbol && msg.interval ? `${msg.symbol}:${msg.interval}` : null;

  for (const ws of wss.clients) {
    if (ws.readyState !== ws.OPEN) continue;
    const watching = key !== null && ws.subs && ws.subs.has(key);
    const wantsFeed = ws.signalsSubscribed === true;

    if (msg.t === 'analysis') {
      if (watching) send(ws, msg);
    } else if (msg.t === 'signal' || msg.t === 'outcome') {
      if (watching || wantsFeed) send(ws, msg);
    }
  }
}

function close() {
  clearInterval(heartbeat);
  if (wss) {
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    wss = null;
  }
  upstream.closeAll();
}

module.exports = { attach, close, broadcast, setSnapshotProvider, PATH };
