// Live analysis: turns closed bars into SignalEvents and analysis diffs.
//
// Trigger design. The spec suggests a BarCloseScheduler driven by the cache's
// next-close arithmetic. This uses BOTH, because each alone has a failure mode:
//
//   - The upstream kline stream already flags `closed`, which is authoritative
//     and immediate, so it is the primary trigger. Polling a clock would either
//     fire early (on a bar the exchange has not closed) or late.
//   - But a dropped socket means a close that never arrives, and a silent gap in
//     a signal engine is the worst kind. nextBarCloseAt() therefore drives a
//     watchdog that notices a missing close and backfills it over REST.
//
// Everything downstream runs through engine/pipeline.js — the same function the
// backtester drives — so live and backtest cannot compute different things.
const pipeline = require('../engine/pipeline');
const structure = require('../engine/structure');
const patterns = require('../engine/patterns');
const stats = require('../engine/stats');
const qualification = require('../engine/qualification');
const positionState = require('../engine/position-state');
const confluenceFeed = require('../engine/confluence/feed');
const { nextBarCloseAt, INTERVALS } = require('../intervals');

const WARMUP_BARS = 400; // comfortably past the 200-EMA and ADX warmups

/**
 * @param {Object} deps
 * @param {object} deps.config          Resolved engine config.
 * @param {object} deps.store           Probability store from the seed.
 * @param {object} deps.gate            Rule 7 qualification gate.
 * @param {(msg: object) => void} deps.publish  Fan-out to subscribed clients.
 */
function create({ config, store, gate, publish }) {
  return {
    config,
    store: store || stats.create(),
    gate: gate || qualification.create(),
    // Live outcomes accumulate SEPARATELY from the backtest store. Merging them
    // would hide the divergence between measured and realised performance,
    // which is the overfitting alarm the spec asks for.
    liveStats: stats.create(),
    publish: publish || (() => {}),
    analyzers: new Map(), // `${symbol}:${tf}` -> { state, lastBarTime, snapshot }
    open: new Map(), // symbol -> tracked position drawings
    feed: confluenceFeed.create({ capacity: 200 }),
  };
}

const keyOf = (symbol, timeframe) => `${symbol}:${timeframe}`;

function analyzerFor(service, symbol, timeframe) {
  const key = keyOf(symbol, timeframe);
  let entry = service.analyzers.get(key);
  if (!entry) {
    entry = {
      symbol,
      timeframe,
      state: pipeline.createAnalyzer({ symbol, timeframe, config: service.config }),
      lastBarTime: null,
      lastSnapshot: null,
      lastOut: null,
      warmed: false,
    };
    service.analyzers.set(key, entry);
  }
  return entry;
}

/**
 * Replays history so indicators are warm before the first live bar. Without
 * this the first ~200 live bars would silently produce nothing, which looks
 * identical to "the market is quiet".
 */
function warmup(service, symbol, timeframe, bars) {
  const entry = analyzerFor(service, symbol, timeframe);
  const usable = bars.slice(-WARMUP_BARS);
  let last = null;
  for (const bar of usable) {
    last = pipeline.update(entry.state, bar, {
      bias: biasFor(service, symbol, timeframe),
      store: service.store,
    });
    entry.lastBarTime = bar.time;
  }
  entry.warmed = usable.length >= 250;

  // Store the snapshot warmup just produced. Without this, lastSnapshot stays
  // null until the FIRST live close on this timeframe, so a client that
  // subscribes right after boot is handed { full: null } and renders an empty
  // chart — for up to five minutes on 5m, and up to four hours on 4h.
  if (last) {
    entry.lastOut = last;
    entry.lastSnapshot = buildSnapshot(service, symbol, timeframe, last);
  }
  return entry;
}

/**
 * Bias snapshots from this symbol's higher timeframes.
 *
 * Each carries the bar time it describes and is dropped if it has not closed by
 * the consuming bar — the same guard the backtester applies, because a live
 * pipeline can just as easily read a higher-timeframe bar that is still forming.
 */
function biasFor(service, symbol, timeframe, atCloseTime) {
  const bias = {};
  for (const tf of service.config.timeframes.bias) {
    if (tf === timeframe) continue;
    const entry = service.analyzers.get(keyOf(symbol, tf));
    if (!entry) continue;
    const snapshot = pipeline.biasOf(entry.state);
    if (!snapshot) continue;

    if (atCloseTime !== undefined) {
      const otherClose = snapshot.barTime + INTERVALS[tf].seconds;
      if (otherClose > atCloseTime) continue; // would be lookahead
    }
    bias[tf] = snapshot;
  }
  return bias;
}

/**
 * Feeds one CLOSED bar. This is the only entry point that may persist anything.
 *
 * @returns {{event: object|null, diff: object|null}}
 */
function onBarClosed(service, symbol, timeframe, bar) {
  const entry = analyzerFor(service, symbol, timeframe);

  // Idempotent: a reconnect can replay the same close, and counting it twice
  // would double-post to the feed and double-count the stats.
  if (entry.lastBarTime !== null && bar.time <= entry.lastBarTime) return { event: null, diff: null };

  const closeTime = bar.time + INTERVALS[timeframe].seconds;
  const out = pipeline.update(entry.state, bar, {
    bias: biasFor(service, symbol, timeframe, closeTime),
    store: service.store,
  });
  entry.lastBarTime = bar.time;

  advanceOpenPositions(service, symbol, bar);

  entry.lastOut = out;
  const snapshot = buildSnapshot(service, symbol, timeframe, out);
  const diff = diffSnapshots(entry.lastSnapshot, snapshot);
  entry.lastSnapshot = snapshot;

  let event = out.event;
  if (event && event.actionable) {
    // Rule 7, enforced at the point of emission rather than in the UI: an
    // unqualified configuration produces context, never a tradeable signal.
    const active = qualification.isActive(service.gate, {
      symbol,
      timeframe,
      preset: service.config.preset,
      strategyId: null,
    });

    if (!active) {
      const why = qualification.describe(service.gate, {
        symbol,
        timeframe,
        preset: service.config.preset,
        strategyId: null,
      });
      event = { ...event, actionable: false, suppressed: true, suppressedReason: why.reasons.join('; ') };
    } else if (entry.warmed) {
      // Live only because someone forced it. The flag travels with the event so
      // every consumer — feed row, HUD, position drawing — can say so, rather
      // than presenting a failing configuration as a qualified one.
      const forced = qualification.describe(service.gate, {
        symbol,
        timeframe,
        preset: service.config.preset,
        strategyId: null,
      });
      if (forced.override) {
        event = {
          ...event,
          overridden: true,
          overrideNote: forced.overrideNote,
          failedReasons: forced.failedReasons || [],
        };
      }
      confluenceFeed.add(service.feed, event);
      trackPosition(service, symbol, event);
    }
  }

  if (diff) service.publish({ t: 'analysis', symbol, interval: timeframe, diff });
  if (event) service.publish({ t: 'signal', symbol, interval: timeframe, signal: event });

  return { event, diff };
}

/**
 * Cross-timeframe summary for the HUD's MTF matrix.
 *
 * Sent with every analysis payload because the client subscribes to exactly ONE
 * timeframe: without this the matrix could only ever fill the row it is already
 * looking at, which defeats the point of a "check the other timeframes before
 * you act" view. The server analyses all of them anyway, so this is free.
 */
function mtfSummary(service, symbol) {
  return service.config.timeframes.seconds
    ? ['1m', '5m', '15m', '1h', '4h'].map((tf) => {
        const entry = service.analyzers.get(keyOf(symbol, tf));
        const ctx = entry && entry.state.latest;
        if (!ctx) return { timeframe: tf, trend: null, regime: null, rsi: null, macd: null, supertrend: null };
        return {
          timeframe: tf,
          trend: ctx.structure.trend.state,
          regime: ctx.structure.regime.primary,
          rsi: ctx.rsi,
          macd: ctx.macd && ctx.macd.histogram !== null ? (ctx.macd.histogram > 0 ? 'up' : 'down') : null,
          supertrend: ctx.supertrend ? ctx.supertrend.direction : null,
        };
      })
    : [];
}

/** The client-facing projection of one bar's analysis. */
function buildSnapshot(service, symbol, timeframe, out) {
  const view = structure.snapshot(out.ctx.structure);
  const patternView = patterns.snapshot(out.patterns);

  return {
    symbol,
    timeframe,
    mtf: mtfSummary(service, symbol),
    barTime: out.ctx.bar.time,
    zones: view.zones.map((z) => ({
      id: z.id,
      low: z.low,
      high: z.high,
      role: z.role,
      strength: z.strength,
      touches: z.touches,
    })),
    trendlines: ['support', 'resistance']
      .map((kind) => {
        const line = view.trendlines[kind];
        if (!line) return null;
        return {
          id: `${kind}`,
          kind,
          from: { time: line.from.time, price: line.from.price },
          to: { time: line.to.time, price: line.to.price },
          confirmed: line.touches >= 3,
          broken: line.broken,
          touches: line.touches,
        };
      })
      .filter(Boolean),
    patterns: patternView.open.map((p) => ({
      id: p.id,
      type: p.type,
      status: p.status,
      direction: p.direction,
      geometry: p.geometry,
      target: p.target,
      invalidation: p.invalidation,
    })),
    candles: out.candles.map((c) => ({ type: c.type, bias: c.bias, strength: c.strength, time: c.time })),
    trend: view.trend.state,
    regime: view.regime.primary,
    events: patternView.events,
  };
}

/**
 * Structural diff by id. Sending the full snapshot on every 1m close across 35
 * series is a lot of redundant bytes for a payload that usually changes in one
 * zone; the spec asks for diffs and this is where they are produced.
 */
function diffSnapshots(previous, next) {
  if (!previous) return { full: next };

  const byId = (list) => new Map(list.map((item) => [item.id, item]));
  const section = (prevList, nextList) => {
    const before = byId(prevList);
    const after = byId(nextList);
    const upserted = [];
    for (const [id, item] of after) {
      const was = before.get(id);
      if (!was || JSON.stringify(was) !== JSON.stringify(item)) upserted.push(item);
    }
    const removed = [...before.keys()].filter((id) => !after.has(id));
    return upserted.length || removed.length ? { upserted, removed } : null;
  };

  const diff = {
    barTime: next.barTime,
    zones: section(previous.zones, next.zones),
    trendlines: section(previous.trendlines, next.trendlines),
    patterns: section(previous.patterns, next.patterns),
  };

  // Per-bar values are always sent; they are small and always change.
  diff.candles = next.candles;
  diff.mtf = next.mtf;
  if (previous.trend !== next.trend) diff.trend = next.trend;
  if (previous.regime !== next.regime) diff.regime = next.regime;
  if (next.events.length) diff.events = next.events;

  const meaningful =
    diff.zones ||
    diff.trendlines ||
    diff.patterns ||
    diff.trend ||
    diff.regime ||
    diff.events ||
    diff.candles.length ||
    JSON.stringify(previous.mtf) !== JSON.stringify(next.mtf);
  return meaningful ? diff : null;
}

/** Starts tracking a confirmed signal so its live outcome can be measured. */
function trackPosition(service, symbol, event) {
  if (!event.stops || !event.targets) return;
  const list = service.open.get(symbol) || [];
  list.push({
    id: event.id,
    symbol,
    timeframe: event.timeframe,
    direction: event.direction,
    entryPrice: event.entry,
    entryTime: event.barTime,
    stops: event.stops,
    targets: event.targets,
    strategyId: (event.strategies.find((s) => s.dominant) || event.strategies[0] || {}).id,
    regime: event.regime,
    status: 'active',
  });
  service.open.set(symbol, list.slice(-50));
}

/**
 * Advances tracked signals and records resolved ones.
 *
 * Live win rates accumulate next to the backtest's so a divergence between them
 * is visible — that gap is the overfitting alarm.
 */
function advanceOpenPositions(service, symbol, bar) {
  const list = service.open.get(symbol);
  if (!list || list.length === 0) return;

  for (const position of list) {
    if (positionState.isResolved(position.status)) continue;
    const before = position.status;
    position.status = positionState.advance(position, bar);
    if (before === position.status || !positionState.isResolved(position.status)) continue;

    const won = position.status === 'won';
    stats.record(service.liveStats, {
      strategyId: position.strategyId,
      direction: position.direction,
      regime: position.regime,
      won,
      // R is unknown until the fill model runs; the live store measures hit
      // rate, and the backtest store owns expectancy.
      r: won ? 1 : -1,
    });
    service.publish({ t: 'outcome', symbol, signalId: position.id, outcome: position.status });
  }

  service.open.set(
    symbol,
    list.filter((p) => !positionState.isResolved(p.status) || p.entryTime > bar.time - 86_400)
  );
}

/**
 * Rebuilds an analyzer's snapshot from its current state, without feeding a bar.
 *
 * Needed after a batch warmup: snapshots built mid-warmup captured whichever
 * sibling timeframes happened to be warm at that moment.
 */
function refreshSnapshot(service, symbol, timeframe) {
  const entry = service.analyzers.get(keyOf(symbol, timeframe));
  if (!entry || !entry.lastOut) return null;
  entry.lastSnapshot = buildSnapshot(service, symbol, timeframe, entry.lastOut);
  return entry.lastSnapshot;
}

/** Full state for a client that has just subscribed or reconnected. */
function snapshotFor(service, symbol, timeframe) {
  const entry = service.analyzers.get(keyOf(symbol, timeframe));
  return {
    t: 'analysis',
    symbol,
    interval: timeframe,
    diff: { full: entry && entry.lastSnapshot ? entry.lastSnapshot : null },
  };
}

const feedRows = (service, filter) => confluenceFeed.list(service.feed, filter);

/** Live vs backtest hit rate for one bucket — the divergence check. */
function divergence(service, query) {
  const backtest = stats.lookup(service.store, query);
  const live = stats.lookup(service.liveStats, query);
  return {
    backtest,
    live,
    gap:
      backtest.winRate !== null && live.winRate !== null ? live.winRate - backtest.winRate : null,
  };
}

module.exports = {
  create,
  warmup,
  refreshSnapshot,
  onBarClosed,
  snapshotFor,
  feedRows,
  divergence,
  diffSnapshots,
  buildSnapshot,
  biasFor,
  analyzerFor,
  WARMUP_BARS,
};
