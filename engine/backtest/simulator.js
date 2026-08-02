// Event-driven trade simulator.
//
// Everything here exists to stop the backtest flattering itself:
//
// - Entries fill at the NEXT bar's open plus slippage, never at the signal
//   bar's close. Rule 2: the close that produced the signal was not tradeable
//   at that price.
// - When one bar touches both the stop and a target, the STOP counts. Real
//   intrabar order is unknowable from OHLC, so the pessimistic branch is the
//   only honest one, and it matches how Phase 4 resolves pattern outcomes.
// - Fees and slippage are charged on every side and every partial fill (Rule 4),
//   and reported separately so the cost drag is visible rather than buried.
//
// Results are in R-multiples: each trade risks exactly 1R, sized so that a move
// from the actual FILL price to SL1 loses exactly 1. That makes results
// comparable across symbols whose prices differ by six orders of magnitude.

const OUTCOMES = {
  TP1: 'tp1',
  TP2: 'tp2',
  TP3: 'tp3',
  STOP: 'stop',
  BREAKEVEN: 'breakeven',
  TRAIL: 'trail',
  EXPIRED: 'expired',
};

const DEFAULTS = {
  maxBarsHeld: 500,
  variant: 'ladder', // 'ladder' | 'simple'
};

/** Slippage in price terms: the greater of a rate and one tick. */
function slippageFor(price, costs, symbol) {
  const tick = costs.tickSize[symbol] ?? costs.tickSizeDefault;
  return Math.max(price * costs.slippageRate, tick * costs.minSlippageTicks);
}

/**
 * Opens a position from a SignalEvent, filling at `fillBar`'s open.
 *
 * @returns {object|null} null when the trade cannot be sized honestly — a gap
 *   straight through SL1 leaves no risk distance to size against, and inventing
 *   one would manufacture a trade that could never have been taken.
 */
function open(event, fillBar, costs, options) {
  const sign = event.direction === 'long' ? 1 : -1;
  const slip = slippageFor(fillBar.open, costs, event.symbol);
  const fillPrice = fillBar.open + sign * slip;

  const sl1 = event.stops[0];
  const rPrice = (fillPrice - sl1) * sign;
  if (!(rPrice > 0)) return null;

  // Risk exactly one unit of account, so P&L reads directly in R.
  const size = 1 / rPrice;
  const entryFee = costs.takerFeeRate * fillPrice * size;

  return {
    id: `${event.id}#${fillBar.time}`,
    symbol: event.symbol,
    timeframe: event.timeframe,
    strategyId: dominantStrategyId(event),
    strategies: event.strategies.map((s) => s.id),
    direction: event.direction,
    level: event.level,
    score: event.score,
    regime: event.regime,
    variant: options.variant,

    signalBarTime: event.barTime,
    entryTime: fillBar.time,
    entryPrice: fillPrice,
    stops: event.stops.slice(),
    targets: event.targets.slice(),
    rPrice,
    size,

    remaining: 1, // fraction of the position still open
    activeStop: sl1,
    filled: { tp1: false, tp2: false, tp3: false },
    fills: [],
    grossR: 0,
    costR: entryFee,
    barsHeld: 0,
    open: true,
    outcome: null,
    exitTime: null,
    exitPrice: null,
  };
}

function dominantStrategyId(event) {
  const dominant = event.strategies.find((s) => s.dominant);
  return dominant ? dominant.id : event.strategies[0] ? event.strategies[0].id : 'unknown';
}

/** Books a partial or full exit and charges its fee. */
function fill(trade, { price, fraction, time, label, costs }) {
  const sign = trade.direction === 'long' ? 1 : -1;
  const portion = Math.min(fraction, trade.remaining);
  if (portion <= 0) return;

  const gross = (price - trade.entryPrice) * sign * trade.size * portion;
  const fee = costs.takerFeeRate * price * trade.size * portion;

  trade.grossR += gross;
  trade.costR += fee;
  trade.remaining -= portion;
  trade.fills.push({ label, time, price, fraction: portion, grossR: gross, feeR: fee });

  if (trade.remaining <= 1e-9) {
    trade.open = false;
    trade.exitTime = time;
    trade.exitPrice = price;
  }
}

/**
 * Advances an open trade by one bar.
 *
 * The stop is evaluated against the level that was active AT BAR OPEN, before
 * any target on this same bar can move it. Letting a target fill first and then
 * testing the loosened stop would quietly assume a favourable intrabar path.
 */
function step(trade, bar, costs, plan, options) {
  if (!trade.open) return;
  trade.barsHeld += 1;

  const sign = trade.direction === 'long' ? 1 : -1;
  const stopAtOpen = trade.activeStop;
  const slip = slippageFor(bar.open, costs, trade.symbol);

  const stopHit = sign === 1 ? bar.low <= stopAtOpen : bar.high >= stopAtOpen;
  if (stopHit) {
    // Stops are market orders once triggered, so they suffer slippage too.
    const price = stopAtOpen - sign * slip;
    const label = trade.filled.tp1 ? (trade.filled.tp2 ? OUTCOMES.TRAIL : OUTCOMES.BREAKEVEN) : OUTCOMES.STOP;
    fill(trade, { price, fraction: trade.remaining, time: bar.time, label, costs });
    trade.outcome = label;
    return;
  }

  if (options.variant === 'simple') {
    const tp1 = trade.targets[0];
    const hit = sign === 1 ? bar.high >= tp1 : bar.low <= tp1;
    if (hit) {
      fill(trade, { price: tp1, fraction: trade.remaining, time: bar.time, label: OUTCOMES.TP1, costs });
      trade.outcome = OUTCOMES.TP1;
    }
  } else {
    for (const rung of plan) {
      const index = rung.level === 'tp1' ? 0 : rung.level === 'tp2' ? 1 : 2;
      if (trade.filled[rung.level]) continue;

      const target = trade.targets[index];
      const hit = sign === 1 ? bar.high >= target : bar.low <= target;
      if (!hit) break; // targets are ordered; if this one is unreached, so are the rest

      fill(trade, { price: target, fraction: rung.fraction, time: bar.time, label: rung.level, costs });
      trade.filled[rung.level] = true;
      trade.outcome = rung.level;

      if (rung.moveStopTo === 'entry') trade.activeStop = trade.entryPrice;
      else if (rung.moveStopTo === 'tp1') trade.activeStop = trade.targets[0];

      if (!trade.open) break;
    }
  }

  if (trade.open && trade.barsHeld >= options.maxBarsHeld) {
    const price = bar.close - sign * slip;
    fill(trade, { price, fraction: trade.remaining, time: bar.time, label: OUTCOMES.EXPIRED, costs });
    trade.outcome = trade.outcome || OUTCOMES.EXPIRED;
  }
}

/** Final accounting once a trade has closed. */
function settle(trade) {
  trade.netR = trade.grossR - trade.costR;
  // Won is decided on the NET result. A trade that reached its target and then
  // handed the whole gain back in fees is not a win, and counting it as one is
  // precisely how a high "win rate" hides a losing system.
  trade.won = trade.netR > 0;
  return trade;
}

module.exports = { open, step, settle, fill, slippageFor, OUTCOMES, DEFAULTS };
