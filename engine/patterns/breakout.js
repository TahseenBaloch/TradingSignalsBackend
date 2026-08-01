// Breakout / breakdown with retest — one state machine per S/R zone.
//
//   APPROACH -> BREAK -> RETEST (optional) -> CONTINUATION
//                  |
//                  +--> FAILED_BREAK
//
// The FAILED_BREAK branch is not an error path. A break that closes back inside
// the zone within a few bars is a trap that just stranded everyone who chased
// it, and the snap-back is tradeable in the OPPOSITE direction — so it emits a
// reversal-risk event rather than being silently discarded.
//
// A break needs volume as well as distance. Price drifting a quarter-ATR past a
// level on nothing is how the classic false-breakout detector generates its
// noise, and the volume gate is most of what separates the two.
const base = require('./base');

const DEFAULTS = {
  approachAtr: 1.0, // start watching a zone within this x ATR
  breakAtr: 0.25, // spec: close beyond the zone by >= 0.25 ATR
  minRelativeVolume: 1.5, // spec: ...with relative volume >= 1.5
  failWindowBars: 3, // spec: back inside within 3 bars is a failed break
  retestAtr: 0.25, // price coming back this close to the band is a retest
  continuationAtr: 1.0, // ...and running this far past it is continuation
  fallbackTargetAtr: 2.0, // used when no further zone lies in the break direction
  maxAge: 60, // give up tracking after this many bars
};

const PHASE = {
  APPROACH: 'approach',
  BREAK: 'break',
  RETEST: 'retest',
  CONTINUATION: 'continuation',
  FAILED: 'failed-break',
};

function init(params) {
  return { params: { ...DEFAULTS, ...(params || {}) }, machines: new Map(), seq: 0 };
}

/**
 * Advances every zone's machine by one closed bar.
 *
 * @returns {{patterns: object[], events: object[]}} newly created patterns and
 *   reversal-risk events raised on this bar.
 */
function update(state, bar, ctx) {
  const p = state.params;
  const { index, atr, zones, relativeVolume } = ctx;
  const patterns = [];
  const events = [];
  if (!Number.isFinite(atr) || atr <= 0) return { patterns, events };

  const live = new Set();

  for (const zone of zones) {
    live.add(zone.id);
    let machine = state.machines.get(zone.id);

    const distance =
      bar.close < zone.low ? zone.low - bar.close : bar.close > zone.high ? bar.close - zone.high : 0;

    if (!machine) {
      if (distance > p.approachAtr * atr) continue;
      machine = { zoneId: zone.id, phase: PHASE.APPROACH, direction: null, breakIndex: null, pattern: null };
      state.machines.set(zone.id, machine);
    }

    switch (machine.phase) {
      case PHASE.APPROACH: {
        const margin = p.breakAtr * atr;
        const above = bar.close > zone.high + margin;
        const below = bar.close < zone.low - margin;
        if (!above && !below) break;

        // Distance without participation is drift, not a break.
        if (!(typeof relativeVolume === 'number' && relativeVolume >= p.minRelativeVolume)) break;

        const direction = above ? 'long' : 'short';
        const next = above ? ctx.nextAbove : ctx.nextBelow;
        const target = next
          ? above
            ? next.low
            : next.high
          : above
            ? bar.close + p.fallbackTargetAtr * atr
            : bar.close - p.fallbackTargetAtr * atr;

        const pattern = base.create({
          type: 'breakout-retest',
          direction,
          index,
          time: bar.time,
          trigger: above ? zone.high : zone.low,
          seq: state.seq++,
          geometry: [
            { time: bar.time, price: zone.high, role: 'zone-top' },
            { time: bar.time, price: zone.low, role: 'zone-bottom' },
            { time: bar.time, price: bar.close, role: 'break' },
          ],
          meta: {
            zoneId: zone.id,
            zoneHigh: zone.high,
            zoneLow: zone.low,
            phase: PHASE.BREAK,
            relativeVolume,
          },
        });

        // The break IS the trigger, so this pattern is born confirmed — unlike
        // a triangle, there is no earlier shape to draw and wait on.
        base.confirm(pattern, {
          index,
          time: bar.time,
          direction,
          entry: bar.close,
          target,
          invalidation: above ? zone.low - margin : zone.high + margin,
        });

        machine.phase = PHASE.BREAK;
        machine.direction = direction;
        machine.breakIndex = index;
        machine.breakPrice = bar.close;
        machine.pattern = pattern;
        patterns.push(pattern);
        break;
      }

      case PHASE.BREAK:
      case PHASE.RETEST: {
        const long = machine.direction === 'long';
        const backInside = long ? bar.close <= zone.high : bar.close >= zone.low;

        if (backInside && index - machine.breakIndex <= p.failWindowBars) {
          machine.phase = PHASE.FAILED;
          if (machine.pattern) {
            machine.pattern.meta.phase = PHASE.FAILED;
            base.resolve(machine.pattern, 'invalidation', { index, time: bar.time });
          }
          // The trap is the signal: everyone who chased the break is now offside.
          events.push({
            type: 'failed-break',
            zoneId: zone.id,
            brokeDirection: machine.direction,
            reversalDirection: long ? 'short' : 'long',
            index,
            time: bar.time,
            price: bar.close,
          });
          break;
        }

        const past = long ? bar.close - zone.high : zone.low - bar.close;
        if (past >= p.continuationAtr * atr) {
          machine.phase = PHASE.CONTINUATION;
          if (machine.pattern) machine.pattern.meta.phase = PHASE.CONTINUATION;
          break;
        }

        // A wick back into the band that still closes beyond it is the retest
        // the spec marks optional — the strongest version of this setup.
        const touched = long ? bar.low <= zone.high + p.retestAtr * atr : bar.high >= zone.low - p.retestAtr * atr;
        if (machine.phase === PHASE.BREAK && touched && !backInside) {
          machine.phase = PHASE.RETEST;
          if (machine.pattern) {
            machine.pattern.meta.phase = PHASE.RETEST;
            machine.pattern.meta.retestIndex = index;
            machine.pattern.geometry.push({ time: bar.time, price: bar.close, role: 'retest' });
          }
        }
        break;
      }

      default:
        break;
    }

    // Retire machines that have run their course so a long backtest does not
    // accumulate one per zone forever.
    if (
      (machine.phase === PHASE.CONTINUATION || machine.phase === PHASE.FAILED) &&
      index - machine.breakIndex > p.maxAge
    ) {
      state.machines.delete(zone.id);
    }
  }

  for (const zoneId of [...state.machines.keys()]) {
    if (!live.has(zoneId)) state.machines.delete(zoneId);
  }

  return { patterns, events };
}

function clone(state) {
  const machines = new Map();
  for (const [k, v] of state.machines) machines.set(k, { ...v });
  return { params: { ...state.params }, machines, seq: state.seq };
}

module.exports = { init, update, clone, PHASE, DEFAULTS };
