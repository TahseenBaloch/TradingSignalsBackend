const test = require('node:test');
const assert = require('node:assert/strict');

const qualification = require('./qualification');
const config = require('./config');

const RULE = config.BACKTEST.qualification; // PF >= 1.2, >= 50 trades
const spec = { symbol: 'BTCUSD', timeframe: '5m', preset: 'Balanced', strategyId: null };

test('an unmeasured configuration is NOT active', () => {
  // The default has to be disabled. Defaulting to enabled would ship any
  // strategy that was never backtested — or whose seed run silently produced
  // zero trades, as S6's once did — live on no evidence at all.
  const gate = qualification.create();
  assert.equal(qualification.isActive(gate, spec), false);

  const described = qualification.describe(gate, spec);
  assert.equal(described.qualified, false);
  assert.deepEqual(described.reasons, ['never backtested']);
});

test('a config clearing both bars becomes active', () => {
  const gate = qualification.create();
  qualification.record(gate, spec, { trades: 120, profitFactor: 1.45, expectancyR: 0.12, winRate: 0.5 }, RULE);

  assert.equal(qualification.isActive(gate, spec), true);
  assert.deepEqual(qualification.describe(gate, spec).reasons, []);
});

test('failing either bar keeps it disabled, with the reason retained', () => {
  const gate = qualification.create();

  qualification.record(gate, spec, { trades: 20, profitFactor: 3.0, expectancyR: 1 }, RULE);
  assert.equal(qualification.isActive(gate, spec), false);
  assert.match(qualification.describe(gate, spec).reasons[0], /only 20 out-of-sample trades/);

  qualification.record(gate, spec, { trades: 500, profitFactor: 0.36, expectancyR: -0.5 }, RULE);
  assert.equal(qualification.isActive(gate, spec), false);
  assert.match(qualification.describe(gate, spec).reasons[0], /profit factor 0.36/);

  // Nothing is hidden: the measured numbers survive alongside the verdict.
  const entry = qualification.describe(gate, spec);
  assert.equal(entry.trades, 500);
  assert.equal(entry.profitFactor, 0.36);
  assert.equal(entry.expectancyR, -0.5);
});

test('a null profit factor does not sneak past the gate', () => {
  const gate = qualification.create();
  qualification.record(gate, spec, { trades: 500, profitFactor: null, expectancyR: 0 }, RULE);
  assert.equal(qualification.isActive(gate, spec), false);
});

test('a symbol-specific verdict beats the general one', () => {
  const gate = qualification.create();
  qualification.record(
    gate,
    { symbol: null, timeframe: '5m', preset: 'Balanced', strategyId: null },
    { trades: 900, profitFactor: 1.6, expectancyR: 0.2 },
    RULE
  );
  qualification.record(gate, spec, { trades: 400, profitFactor: 0.3, expectancyR: -0.4 }, RULE);

  assert.equal(qualification.isActive(gate, spec), false, 'BTCUSD failed on its own numbers');
  assert.equal(
    qualification.isActive(gate, { ...spec, symbol: 'ETHUSD' }),
    true,
    'ETHUSD falls back to the general verdict'
  );
});

test('the listing surfaces qualified configs first and counts them', () => {
  const gate = qualification.create();
  qualification.record(gate, spec, { trades: 400, profitFactor: 0.3, expectancyR: -0.4 }, RULE);
  qualification.record(
    gate,
    { ...spec, symbol: 'ETHUSD' },
    { trades: 400, profitFactor: 1.9, expectancyR: 0.3 },
    RULE
  );

  const all = qualification.list(gate);
  assert.equal(all.length, 2);
  assert.equal(all[0].qualified, true, 'qualified configs sort first');
  assert.deepEqual(qualification.summary(gate), { total: 2, qualified: 1 });
});
