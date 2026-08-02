// Performance metrics over a set of closed trades.
//
// Everything is computed on NET R (after fees and slippage). The gross figures
// are reported alongside, and their difference is the cost drag — kept as a
// first-class number because on low timeframes it is frequently the whole
// story, and burying it inside the net result is how a scalping backtest
// convinces you it works.

const EMPTY = {
  trades: 0,
  wins: 0,
  losses: 0,
  winRate: null,
  profitFactor: null,
  expectancyR: null,
  grossExpectancyR: null,
  costPerTradeR: null,
  costDragPercent: null,
  totalR: 0,
  grossTotalR: 0,
  totalCostR: 0,
  avgWinR: null,
  avgLossR: null,
  payoffRatio: null,
  maxDrawdownR: 0,
  sharpe: null,
  avgBarsHeld: null,
  equity: [],
};

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length === 0 ? null : sum(xs) / xs.length);

function stdev(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1));
}

/**
 * @param {object[]} trades  Closed, settled trades.
 * @param {{spanSeconds?: number, signals?: number}} [context]
 * @returns {object}
 */
function summarise(trades, context = {}) {
  if (trades.length === 0) return { ...EMPTY, ...cadenceOf(0, context) };

  const netR = trades.map((t) => t.netR);
  const wins = trades.filter((t) => t.won);
  const losses = trades.filter((t) => !t.won);

  const grossProfit = sum(wins.map((t) => t.netR));
  const grossLoss = Math.abs(sum(losses.map((t) => t.netR)));

  const totalR = sum(netR);
  const grossTotalR = sum(trades.map((t) => t.grossR));
  const totalCostR = sum(trades.map((t) => t.costR));

  // Equity curve in R, one point per trade, for the Backtest page's line series.
  const equity = [];
  let running = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const trade of trades) {
    running += trade.netR;
    peak = Math.max(peak, running);
    maxDrawdown = Math.max(maxDrawdown, peak - running);
    equity.push({ time: trade.exitTime, value: running });
  }

  const deviation = stdev(netR);

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: wins.length / trades.length,

    // Undefined rather than Infinity when there are no losses at all: a
    // "profit factor of Infinity" over nine trades is not a result.
    profitFactor: grossLoss === 0 ? null : grossProfit / grossLoss,

    expectancyR: mean(netR),
    grossExpectancyR: mean(trades.map((t) => t.grossR)),
    costPerTradeR: mean(trades.map((t) => t.costR)),
    // How much of the gross edge fees and slippage consume.
    costDragPercent: grossTotalR === 0 ? null : (totalCostR / Math.abs(grossTotalR)) * 100,

    totalR,
    grossTotalR,
    totalCostR,

    avgWinR: mean(wins.map((t) => t.netR)),
    avgLossR: mean(losses.map((t) => t.netR)),
    payoffRatio:
      wins.length && losses.length ? Math.abs(mean(wins.map((t) => t.netR)) / mean(losses.map((t) => t.netR))) : null,

    maxDrawdownR: maxDrawdown,
    // Per-trade Sharpe, not annualised: annualising across timeframes that
    // trade at wildly different rates would compare 1m to 4h dishonestly.
    sharpe: deviation && deviation > 0 ? mean(netR) / deviation : null,
    avgBarsHeld: mean(trades.map((t) => t.barsHeld)),

    outcomes: countBy(trades, (t) => t.outcome),
    equity,
    ...cadenceOf(trades.length, context),
  };
}

function cadenceOf(tradeCount, context) {
  const days = context.spanSeconds ? context.spanSeconds / 86_400 : null;
  return {
    spanDays: days,
    signals: context.signals ?? null,
    // The Signal Frequency Requirement is verified from these two, so they are
    // part of every report rather than a separate diagnostic.
    signalsPerDay: days && context.signals != null ? context.signals / days : null,
    tradesPerDay: days ? tradeCount / days : null,
    signalsPerHour: days && context.signals != null ? context.signals / (days * 24) : null,
  };
}

function countBy(items, keyOf) {
  const out = {};
  for (const item of items) {
    const key = keyOf(item) || 'unknown';
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

/**
 * Rule 7's bar. A configuration only qualifies as active on OUT-OF-SAMPLE
 * results; in-sample numbers never grant it.
 */
function qualifies(metrics, rule) {
  const reasons = [];
  if (metrics.trades < rule.minTrades) {
    reasons.push(`only ${metrics.trades} trades (need ${rule.minTrades})`);
  }
  if (metrics.profitFactor === null || metrics.profitFactor < rule.minProfitFactor) {
    const shown = metrics.profitFactor === null ? 'n/a' : metrics.profitFactor.toFixed(2);
    reasons.push(`profit factor ${shown} (need ${rule.minProfitFactor})`);
  }
  return { ok: reasons.length === 0, reasons };
}

/** Groups trades and summarises each group — per strategy, per regime, etc. */
function groupBy(trades, keyOf, context) {
  const groups = new Map();
  for (const trade of trades) {
    const key = keyOf(trade);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trade);
  }

  const out = {};
  for (const [key, list] of groups) out[key] = summarise(list, context);
  return out;
}

module.exports = { summarise, qualifies, groupBy, countBy, EMPTY };
