require('dotenv').config({ quiet: true });
const express = require('express');
const bcrypt = require('bcryptjs');

const { findUserByEmail } = require('./users');
const { signToken, requireAuth } = require('./auth');
const { searchTickers } = require('./symbols');
const { getChart } = require('./chart-service');
const { getFlow } = require('./flow-service');
const stream = require('./stream/server');
const tickets = require('./stream/tickets');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/auth/login', (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const user = findUserByEmail(email);
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const token = signToken(user);
  res.json({ token, user: { id: user.id, email: user.email } });
});

app.get('/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

app.get('/tickers', requireAuth, (req, res) => {
  const { q } = req.query;
  res.json({ tickers: searchTickers(q) });
});

// Closed OHLCV bars from the upstream market data provider, Redis-cached.
// The bar currently forming is never returned - see chart-service.js.
app.get('/chart', requireAuth, async (req, res, next) => {
  try {
    const { symbol, interval, limit } = req.query;
    res.json(await getChart({ symbol, interval, limit }));
  } catch (err) {
    next(err);
  }
});

// Per-bar order flow from aggregated trades: the buy/sell split at each price
// level, plus bar delta and cumulative delta. Separate from /chart because it
// is a different upstream endpoint with a much heavier payload, and only the
// Flow tools need it.
app.get('/flow', requireAuth, async (req, res, next) => {
  try {
    const { symbol, interval, bars, bucket } = req.query;
    res.json(await getFlow({ symbol, interval, bars, bucket }));
  } catch (err) {
    next(err);
  }
});

// Exchanges a normal bearer token for a short-lived ticket the browser can put
// in a WebSocket URL, since a WebSocket cannot carry an Authorization header.
app.post('/stream/ticket', requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(tickets.issue(req.user));
});

// Terminal error handler. Without one, Express answers with an HTML error page
// that the frontend proxy cannot parse into a useful message.
app.use((err, req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[error]', err.code || 'internal_error', err.message);
  res.status(status).json({
    error: err.expose ? err.message : 'Internal server error',
    code: err.code || 'internal_error',
  });
});

const server = app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

stream.attach(server);

// Without this, every nodemon restart leaks its upstream Binance sockets, and
// Binance caps connection attempts at 300 per 5 minutes per IP.
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[shutdown] ${signal} received, closing connections`);
    stream.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
