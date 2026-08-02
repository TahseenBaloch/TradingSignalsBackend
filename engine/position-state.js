// State machine for a live position drawing on the chart.
//
// This lives in the engine, not in the frontend primitive that renders it,
// because it encodes the SAME intrabar precedence the backtester uses: when one
// bar touches both the stop and a target, the stop wins. Duplicating that rule
// in the chart layer would let the drawing show a win the simulator recorded as
// a loss — the two would drift the first time either was touched, which is the
// divergence Rule 3 exists to prevent.
//
// The state transitions also mirror the backtester's ladder exit model: the stop
// moves to breakeven once TP1 fills, so a drawing that later stops out after a
// TP1 partial is a WIN (the first scale-out was banked), not a loss.

/** @typedef {'active'|'tp1'|'won'|'lost'} PositionStatus */

/**
 * @param {{direction: 'long'|'short', entryPrice: number, stops: number[], targets: number[], status: PositionStatus}} position
 * @param {{high: number, low: number}} bar
 * @returns {PositionStatus}
 */
function advance(position, bar) {
  if (position.status === 'won' || position.status === 'lost') return position.status;

  const long = position.direction === 'long';
  // After a TP1 partial the stop sits at entry, exactly as the simulator moves it.
  const activeStop = position.status === 'tp1' ? position.entryPrice : position.stops[0];

  // Checked FIRST, and before any target on this bar can move it. Real intrabar
  // order is unknowable from OHLC, so the pessimistic branch is the honest one.
  const stopHit = long ? bar.low <= activeStop : bar.high >= activeStop;
  if (stopHit) return position.status === 'tp1' ? 'won' : 'lost';

  const tp3Hit = long ? bar.high >= position.targets[2] : bar.low <= position.targets[2];
  if (tp3Hit) return 'won';

  const tp1Hit = long ? bar.high >= position.targets[0] : bar.low <= position.targets[0];
  if (tp1Hit && position.status === 'active') return 'tp1';

  return position.status;
}

/** True once a drawing should collapse to its compact outcome tag. */
const isResolved = (status) => status === 'won' || status === 'lost';

module.exports = { advance, isResolved };
