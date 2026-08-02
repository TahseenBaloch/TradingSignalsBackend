// The TP/SL ladder. Applies to EVERY strategy — no signal ships without all
// six levels plus an entry.
//
//   SL3  invalidation: the thesis is dead
//   SL2  structural: beyond the nearest zone or swing pivot, padded
//   SL1  execution: the strategy's own stop. R is ALWAYS |entry - SL1|.
//   TP1  entry + 1R
//   TP2  nearer of 2R or the next structural target, never closer than 1.5R
//   TP3  measured move / next major zone / 3R fallback
//
// Longs and shorts share one code path by working in "favourable" space: every
// price is multiplied by the direction sign, so for both sides a larger number
// is simply better for the trade and every comparison is a plain `>`. Mirroring
// the logic by hand instead is how sign bugs get into stop placement, and a
// sign bug here silently inverts risk on half of all signals.

/**
 * @typedef {Object} Ladder
 * @property {number} entry
 * @property {[number, number, number]} stops    [SL1, SL2, SL3]
 * @property {[number, number, number]} targets  [TP1, TP2, TP3]
 * @property {number} r            Risk unit, |entry − SL1|.
 * @property {number} rewardRisk   (TP1 − entry) / R, i.e. always 1 by construction.
 * @property {string[]} sources    Where each non-derived level came from.
 */

/**
 * @param {Object} input
 * @param {'long'|'short'} input.direction
 * @param {number} input.entry
 * @param {number} input.sl1           Strategy's own execution stop.
 * @param {number} input.atr
 * @param {Object} [input.config]      config.ladder
 * @param {number|null} [input.structuralStop]    Nearest zone/pivot beyond SL1.
 * @param {number|null} [input.patternInvalidation]
 * @param {number|null} [input.vwap3Sigma]        Far VWAP band.
 * @param {number|null} [input.biasSupertrend]
 * @param {number|null} [input.structuralTarget]  Opposing zone / band / range edge.
 * @param {number|null} [input.measuredTarget]    Pattern measured move.
 * @returns {Ladder}
 */
function build(input) {
  const p = {
    minGapAtr: 0.05,
    structuralPadAtr: 0.5,
    sl3FallbackR: 2.0,
    tp2MinR: 1.5,
    tp2DefaultR: 2.0,
    tp3FallbackR: 3.0,
    ...(input.config || {}),
  };

  const sign = input.direction === 'long' ? 1 : -1;
  const fav = (price) => sign * price;
  const unfav = (value) => sign * value;

  const atr = Number.isFinite(input.atr) && input.atr > 0 ? input.atr : 0;
  const gap = Math.max(atr * p.minGapAtr, Math.abs(input.entry) * 1e-6);
  const pad = atr * p.structuralPadAtr;

  const entryF = fav(input.entry);
  let sl1F = fav(input.sl1);

  // A stop on the wrong side of entry is a strategy bug, but it must not
  // propagate into a signal with inverted risk. Clamp it to one gap away and
  // let the caller's own tests catch the root cause.
  if (!(sl1F < entryF)) sl1F = entryF - gap;

  const r = entryF - sl1F;
  const sources = [];

  // --- SL2: structural -----------------------------------------------------
  let sl2F = null;
  if (Number.isFinite(input.structuralStop)) {
    const candidate = fav(input.structuralStop) - pad;
    if (candidate < sl1F - gap) {
      sl2F = candidate;
      sources.push('sl2:structure');
    }
  }
  if (sl2F === null) {
    // Nothing structural is far enough out; fall back to half an R beyond SL1.
    sl2F = sl1F - Math.max(gap, r * 0.5);
    sources.push('sl2:fallback');
  }

  // --- SL3: invalidation ---------------------------------------------------
  // Take the FURTHEST applicable thesis-killer, since SL3 is by definition the
  // level past which nothing about the setup is still true.
  const sl3Candidates = [];
  if (Number.isFinite(input.patternInvalidation)) {
    sl3Candidates.push({ v: fav(input.patternInvalidation), src: 'sl3:pattern' });
  }
  if (Number.isFinite(input.vwap3Sigma)) {
    sl3Candidates.push({ v: fav(input.vwap3Sigma), src: 'sl3:vwap-3sigma' });
  }
  if (Number.isFinite(input.biasSupertrend)) {
    sl3Candidates.push({ v: fav(input.biasSupertrend), src: 'sl3:supertrend' });
  }

  const usable = sl3Candidates.filter((c) => c.v < sl2F - gap);
  let sl3F;
  if (usable.length > 0) {
    const furthest = usable.reduce((a, b) => (b.v < a.v ? b : a));
    sl3F = furthest.v;
    sources.push(furthest.src);
  } else {
    sl3F = entryF - p.sl3FallbackR * r;
    sources.push('sl3:2R-fallback');
  }

  // --- TP1: exactly 1R -----------------------------------------------------
  const tp1F = entryF + r;

  // --- TP2: nearer of 2R or structure, floored at 1.5R ---------------------
  let tp2F = entryF + p.tp2DefaultR * r;
  if (Number.isFinite(input.structuralTarget)) {
    const structural = fav(input.structuralTarget);
    if (structural < tp2F) {
      tp2F = structural;
      sources.push('tp2:structure');
    }
  }
  const tp2Floor = entryF + p.tp2MinR * r;
  if (tp2F < tp2Floor) {
    tp2F = tp2Floor;
    sources.push('tp2:1.5R-floor');
  }

  // --- TP3: measured move / far structure / 3R -----------------------------
  let tp3F = null;
  if (Number.isFinite(input.measuredTarget)) {
    const measured = fav(input.measuredTarget);
    if (measured > tp2F + gap) {
      tp3F = measured;
      sources.push('tp3:measured-move');
    }
  }
  if (tp3F === null) {
    tp3F = Math.max(entryF + p.tp3FallbackR * r, tp2F + gap);
    sources.push('tp3:3R-fallback');
  }

  // --- enforce strict monotonicity ----------------------------------------
  // Everything above already aims for the right order, but structural inputs
  // can collide after padding. This is the guarantee, not the intention.
  sl2F = Math.min(sl2F, sl1F - gap);
  sl3F = Math.min(sl3F, sl2F - gap);
  tp2F = Math.max(tp2F, tp1F + gap);
  tp3F = Math.max(tp3F, tp2F + gap);

  return {
    entry: input.entry,
    stops: [unfav(sl1F), unfav(sl2F), unfav(sl3F)],
    targets: [unfav(tp1F), unfav(tp2F), unfav(tp3F)],
    r,
    rewardRisk: 1,
    sources,
  };
}

/**
 * Verifies the ordering invariant. Used by the strategy tests and again by the
 * confluence engine, which re-validates the dominant strategy's ladder before
 * it goes into a SignalEvent.
 *
 * @returns {{ok: boolean, reason?: string}}
 */
function validate(direction, entry, stops, targets) {
  const sign = direction === 'long' ? 1 : -1;
  const fav = (x) => sign * x;

  const ordered = [
    ['SL3', fav(stops[2])],
    ['SL2', fav(stops[1])],
    ['SL1', fav(stops[0])],
    ['entry', fav(entry)],
    ['TP1', fav(targets[0])],
    ['TP2', fav(targets[1])],
    ['TP3', fav(targets[2])],
  ];

  for (const [name, value] of ordered) {
    if (!Number.isFinite(value)) return { ok: false, reason: `${name} is not a finite price` };
  }
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i][1] <= ordered[i - 1][1]) {
      return { ok: false, reason: `${ordered[i][0]} is not beyond ${ordered[i - 1][0]}` };
    }
  }
  return { ok: true };
}

/**
 * The compact one-line form the Signal Feed shows:
 *   E 43,210 - SL 43,050/42,900/42,700 - TP 43,370/43,530/43,750
 */
function format(ladder, digits = 2) {
  const n = (x) => x.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return [
    `E ${n(ladder.entry)}`,
    `SL ${ladder.stops.map(n).join('/')}`,
    `TP ${ladder.targets.map(n).join('/')}`,
  ].join(' · ');
}

module.exports = { build, validate, format };
