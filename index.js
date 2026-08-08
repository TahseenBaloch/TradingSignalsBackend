require('dotenv').config({ quiet: true });
const express = require('express');
const bcrypt = require('bcryptjs');

const { findUserByEmail } = require('./users');
const { signToken, requireAuth } = require('./auth');
const { searchTickers } = require('./symbols');
const { getChart } = require('./chart-service');
const stream = require('./stream/server');
const tickets = require('./stream/tickets');
const backtestJobs = require('./backtest-jobs');
const liveRunner = require('./live/runner');
const analysisService = require('./live/analysis-service');
const engineConfig = require('./engine/config');
const statsStore = require('./engine/stats');
const qualification = require('./engine/qualification');
const reportStore = require('./store/reports');

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

// Exchanges a normal bearer token for a short-lived ticket the browser can put
// in a WebSocket URL, since a WebSocket cannot carry an Authorization header.
app.post('/stream/ticket', requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(tickets.issue(req.user));
});

// Backtests run in a forked worker, never here: a seed-scale run is hundreds of
// thousands of synchronous bar iterations and would block the event loop, which
// on this server also means freezing every live WebSocket fan-out.
app.post('/backtest', requireAuth, (req, res, next) => {
  try {
    res.status(202).json(backtestJobs.create(req.body || {}, req.user));
  } catch (err) {
    next(err);
  }
});

app.get('/backtest', requireAuth, (req, res) => {
  res.json({ jobs: backtestJobs.list(req.user) });
});

app.get('/backtest/:id', requireAuth, async (req, res, next) => {
  try {
    res.json(await backtestJobs.get(req.params.id, req.user));
  } catch (err) {
    next(err);
  }
});

app.delete('/backtest/:id', requireAuth, (req, res, next) => {
  try {
    res.json(backtestJobs.cancel(req.params.id, req.user));
  } catch (err) {
    next(err);
  }
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

// Live signal engine. Opt-in via env: it holds 35 keep-alive upstream sockets
// and warms 35 series on boot, which is the wrong default for someone who just
// wants the chart to come up.
let live = null;
if (process.env.LIVE_ENGINE === 'true') {
  (async () => {
    const config = engineConfig.resolve(process.env.LIVE_PRESET || engineConfig.DEFAULT_PRESET);
    // Both files are written by scripts/seed.js. Without them the probability
    // store is empty (every signal reads "insufficient data", per Rule 5) and
    // the qualification gate is empty — which correctly disables everything
    // rather than shipping unmeasured strategies live.
    const store = statsStore.create((await reportStore.loadStats()) || {});
    const gate = qualification.create((await reportStore.loadQualification()) || {});

    const summary = qualification.summary(gate);
    console.log(`[live] qualification gate: ${summary.qualified}/${summary.total} configs active`);

    // Restricting the watch set matters in development: the full 7 symbols x 5
    // timeframes means 35 warmup fetches and 35 staggered connects before the
    // first signal, which is a long wait when you are checking one chart.
    const watched = process.env.LIVE_SYMBOLS
      ? process.env.LIVE_SYMBOLS.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;

    live = liveRunner.create({ config, store, gate, publish: stream.broadcast, symbols: watched });

    stream.setSnapshotProvider({
      analysis: (symbol, interval) => analysisService.snapshotFor(live.analysis, symbol, interval),
      feed: () => analysisService.feedRows(live.analysis, { limit: 50 }),
    });

    await liveRunner.start(live);
  })().catch((err) => console.error('[live] failed to start:', err.message));
} else {
  console.log('[live] signal engine disabled (set LIVE_ENGINE=true to enable)');
}

// Without this, every nodemon restart leaks its upstream Binance sockets, and
// Binance caps connection attempts at 300 per 5 minutes per IP.
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[shutdown] ${signal} received, closing connections`);
    stream.close();
    if (live) liveRunner.stop(live);
    backtestJobs.shutdown(); // orphaned workers would outlive the server
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
