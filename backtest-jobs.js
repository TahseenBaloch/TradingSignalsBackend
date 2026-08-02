// Backtest job manager.
//
// Each job is a forked child process (scripts/backtest-worker.js). The spec
// requires long jobs never run in a route handler, and the reason is concrete:
// a seed-scale backtest is hundreds of thousands of synchronous bar iterations,
// which would block the event loop and freeze /chart and every live WebSocket
// fan-out for its whole duration.
const path = require('node:path');
const { fork } = require('node:child_process');
const reportStore = require('./store/reports');
const { getSymbol } = require('./symbols');
const { SUPPORTED } = require('./intervals');
const config = require('./engine/config');
const { httpError } = require('./http-error');

const WORKER = path.join(__dirname, 'scripts', 'backtest-worker.js');
const MAX_CONCURRENT = 2; // a backtest is CPU-bound; more would starve the server
const JOB_TIMEOUT_MS = Number(process.env.BACKTEST_TIMEOUT_MS) || 15 * 60 * 1000;
const MAX_RETAINED = 50;

const ENTRY_TIMEFRAMES = new Set(['1m', '5m', '15m']);

const jobs = new Map(); // id -> job record
let running = 0;
const queue = [];
let sequence = 0;

function validate(body) {
  const symbol = getSymbol(body.symbol);
  if (!symbol) throw httpError(400, 'unknown_symbol', `Unknown symbol: ${body.symbol}`);

  const requested = Array.isArray(body.timeframes) ? body.timeframes : [body.timeframe || '5m'];
  for (const tf of requested) {
    if (!SUPPORTED.includes(tf)) {
      throw httpError(400, 'invalid_interval', `Unsupported timeframe: ${tf}`);
    }
    // Bias timeframes are inputs, not entry generators — backtesting one as an
    // entry timeframe would measure something the live engine never does.
    if (!ENTRY_TIMEFRAMES.has(tf)) {
      throw httpError(
        400,
        'not_an_entry_timeframe',
        `${tf} is a bias timeframe. Entry timeframes: ${[...ENTRY_TIMEFRAMES].join(', ')}`
      );
    }
  }

  const preset = body.preset || config.DEFAULT_PRESET;
  if (!config.PRESETS[preset]) {
    throw httpError(400, 'unknown_preset', `Unknown preset: ${preset}`);
  }

  const days = body.days === undefined ? 180 : Number(body.days);
  if (!Number.isFinite(days) || days <= 0 || days > 1095) {
    throw httpError(400, 'invalid_range', 'days must be between 1 and 1095');
  }

  return {
    symbol: symbol.symbol,
    timeframes: requested,
    preset,
    days,
    strategy: body.strategy || 'all',
    walkForward: Boolean(body.walkForward),
    from: body.from,
    to: body.to,
  };
}

function create(body, user) {
  const spec = validate(body);
  // Deterministic-ish and unique without pulling in a uuid dependency.
  const id = `bt-${Date.now().toString(36)}-${(sequence++).toString(36)}`;

  const job = {
    id,
    userId: user ? user.sub : null,
    spec: { ...spec, id },
    status: 'queued',
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    error: null,
    child: null,
    timer: null,
  };

  jobs.set(id, job);
  prune();
  queue.push(job);
  pump();

  return publicView(job);
}

function pump() {
  while (running < MAX_CONCURRENT && queue.length > 0) {
    start(queue.shift());
  }
}

function start(job) {
  if (job.status === 'cancelled') return;

  running += 1;
  job.status = 'running';
  job.startedAt = Date.now();

  const child = fork(WORKER, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  job.child = child;

  const finish = (status, error) => {
    if (job.status !== 'running') return;
    clearTimeout(job.timer);
    job.status = status;
    job.error = error || null;
    job.finishedAt = Date.now();
    job.child = null;
    running -= 1;
    pump();
  };

  job.timer = setTimeout(() => {
    child.kill('SIGKILL');
    finish('failed', `Timed out after ${Math.round(JOB_TIMEOUT_MS / 1000)}s`);
  }, JOB_TIMEOUT_MS);

  child.on('message', async (msg) => {
    if (msg.type === 'done') {
      // The report is written to disk rather than held in memory: a two-year
      // run's trade list is tens of megabytes, and a handful of those retained
      // in the server process is a leak with extra steps.
      await reportStore.saveReport(job.id, msg.result);
      finish('done');
    } else if (msg.type === 'error') {
      finish('failed', msg.message);
    }
  });

  child.on('error', (err) => finish('failed', err.message));
  child.on('exit', (code) => {
    if (job.status === 'running') finish('failed', `Worker exited with code ${code}`);
  });

  child.send(job.spec);
}

function publicView(job) {
  return {
    id: job.id,
    status: job.status,
    symbol: job.spec.symbol,
    timeframes: job.spec.timeframes,
    preset: job.spec.preset,
    strategy: job.spec.strategy,
    days: job.spec.days,
    walkForward: job.spec.walkForward,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
    queuePosition: job.status === 'queued' ? queue.indexOf(job) + 1 : null,
  };
}

async function get(id, user) {
  const job = jobs.get(id);

  if (!job) {
    // A report can outlive its job record across a server restart, so fall back
    // to disk before declaring it missing.
    const report = await reportStore.loadReport(id);
    if (!report) throw httpError(404, 'job_not_found', `No backtest job ${id}`);
    return { id, status: 'done', report };
  }

  if (user && job.userId && job.userId !== user.sub) {
    throw httpError(404, 'job_not_found', `No backtest job ${id}`);
  }

  const view = publicView(job);
  if (job.status !== 'done') return view;
  return { ...view, report: await reportStore.loadReport(id) };
}

function list(user) {
  return [...jobs.values()]
    .filter((j) => !user || !j.userId || j.userId === user.sub)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(publicView);
}

function cancel(id, user) {
  const job = jobs.get(id);
  if (!job) throw httpError(404, 'job_not_found', `No backtest job ${id}`);
  if (user && job.userId && job.userId !== user.sub) {
    throw httpError(404, 'job_not_found', `No backtest job ${id}`);
  }

  if (job.status === 'queued') {
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
    job.status = 'cancelled';
  } else if (job.status === 'running' && job.child) {
    job.child.kill('SIGTERM');
  }
  return publicView(job);
}

/** Keeps the in-memory job table bounded; reports stay on disk regardless. */
function prune() {
  if (jobs.size <= MAX_RETAINED) return;
  const finished = [...jobs.values()]
    .filter((j) => j.status === 'done' || j.status === 'failed' || j.status === 'cancelled')
    .sort((a, b) => a.createdAt - b.createdAt);
  while (jobs.size > MAX_RETAINED && finished.length > 0) {
    jobs.delete(finished.shift().id);
  }
}

function shutdown() {
  for (const job of jobs.values()) {
    clearTimeout(job.timer);
    if (job.child) job.child.kill('SIGKILL');
  }
}

module.exports = { create, get, list, cancel, shutdown, validate };
