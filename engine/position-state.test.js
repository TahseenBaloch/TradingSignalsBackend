const test = require('node:test');
const assert = require('node:assert/strict');

const positionState = require('./position-state');

const long = (status = 'active') => ({
  direction: 'long',
  entryPrice: 100,
  stops: [98, 97, 96],
  targets: [102, 104, 106],
  status,
});

const short = (status = 'active') => ({
  direction: 'short',
  entryPrice: 100,
  stops: [102, 103, 104],
  targets: [98, 96, 94],
  status,
});

const bar = (high, low) => ({ high, low });

test('reaching TP1 moves the drawing into its partial-filled state', () => {
  assert.equal(positionState.advance(long(), bar(102.5, 99.5)), 'tp1');
  assert.equal(positionState.advance(short(), bar(100.5, 97.5)), 'tp1');
});

test('a bar touching both stop and target resolves as a LOSS', () => {
  // Same pessimistic rule the backtester and the pattern engine use. If the
  // chart resolved this optimistically it would show a win the simulator
  // recorded as a loss.
  assert.equal(positionState.advance(long(), bar(103, 97.5)), 'lost');
  assert.equal(positionState.advance(short(), bar(102.5, 97), bar), 'lost');
});

test('stopping out at breakeven after TP1 is a win, not a loss', () => {
  // The first scale-out was already banked, and the stop only sits at entry
  // because TP1 filled — which is exactly how the backtester books it.
  assert.equal(positionState.advance(long('tp1'), bar(101, 99.5)), 'won');
  assert.equal(positionState.advance(short('tp1'), bar(100.5, 99)), 'won');
});

test('reaching TP3 wins outright', () => {
  assert.equal(positionState.advance(long(), bar(106.5, 99.5)), 'won');
  assert.equal(positionState.advance(long('tp1'), bar(106.5, 100.5)), 'won');
});

test('a resolved drawing never changes again', () => {
  for (const status of ['won', 'lost']) {
    assert.equal(positionState.advance(long(status), bar(200, 1)), status);
    assert.equal(positionState.isResolved(status), true);
  }
  assert.equal(positionState.isResolved('active'), false);
  assert.equal(positionState.isResolved('tp1'), false);
});

test('an untouched bar leaves the state alone', () => {
  assert.equal(positionState.advance(long(), bar(101, 99)), 'active');
  assert.equal(positionState.advance(long('tp1'), bar(103, 100.5)), 'tp1');
});
