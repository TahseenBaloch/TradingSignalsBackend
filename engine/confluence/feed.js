// The Signal Feed: a bounded, newest-first log of confirmed signals across
// every symbol and timeframe.
//
// This is how an hourly signal on a chart you are not looking at reaches you.
// It holds DATA only — the scrolling panel, the level badges and the
// click-to-jump behaviour are Phase 8's job.
//
// Provisional (forming-bar) events are rejected outright. Rule 1: a provisional
// signal must never be persisted or counted, and the feed is persistence.

const DEFAULTS = { capacity: 200 };

function create(params = {}) {
  return { capacity: params.capacity ?? DEFAULTS.capacity, items: [], seen: new Set() };
}

/**
 * @param {ReturnType<create>} feed
 * @param {object} event  A SignalEvent from engine/confluence.
 * @returns {boolean} whether it was accepted.
 */
function add(feed, event) {
  if (!event || event.provisional || !event.actionable) return false;
  if (feed.seen.has(event.id)) return false; // a bar close must not double-post

  feed.seen.add(event.id);
  feed.items.unshift(compact(event));

  while (feed.items.length > feed.capacity) {
    const dropped = feed.items.pop();
    feed.seen.delete(dropped.id);
  }
  return true;
}

/**
 * The row shape the panel renders: level badge, symbol, timeframe, score, bar
 * time, the ladder one-liner, and the single most important reason.
 */
function compact(event) {
  const dominant = event.strategies.find((s) => s.dominant) || event.strategies[0];
  const topReason = dominant && dominant.reasons.length > 0 ? dominant.reasons[0] : null;

  return {
    id: event.id,
    symbol: event.symbol,
    timeframe: event.timeframe,
    barTime: event.barTime,
    level: event.level,
    direction: event.direction,
    score: Math.round(event.score),
    entry: event.entry,
    stops: event.stops,
    targets: event.targets,
    strategyId: dominant ? dominant.id : null,
    topReason: topReason ? `${topReason.label}: ${topReason.detail}` : null,
    probability: event.probability,
    regime: event.regime,
  };
}

/**
 * @param {ReturnType<create>} feed
 * @param {{levels?: string[], symbol?: string, timeframe?: string, limit?: number}} [filter]
 */
function list(feed, filter = {}) {
  let out = feed.items;
  if (filter.levels) out = out.filter((i) => filter.levels.includes(i.level));
  if (filter.symbol) out = out.filter((i) => i.symbol === filter.symbol);
  if (filter.timeframe) out = out.filter((i) => i.timeframe === filter.timeframe);
  return filter.limit ? out.slice(0, filter.limit) : out.slice();
}

function clone(feed) {
  return { capacity: feed.capacity, items: feed.items.slice(), seen: new Set(feed.seen) };
}

module.exports = { create, add, list, clone, compact, DEFAULTS };
