import test from 'node:test';
import assert from 'node:assert/strict';
import { Trial, SYMBOLS, DEFAULTS, reshuffle } from '../public/game.js';

function fixture() {
  let clock = 100;
  const game = new Trial({ now: () => clock });
  return { game, advance: ms => { clock += ms; game.tick(); } };
}
function press(game, symbol, overrides = {}) {
  return game.press({ symbol, round: game.round, layoutVersion: game.layoutVersion, ...overrides });
}
test('10 seconds of display, then a full 20-second input window', () => {
  const { game, advance } = fixture(); game.start();
  assert.equal(game.stage, 'show'); assert.equal(game.remaining(), DEFAULTS.showMs);
  assert.equal(press(game, game.sequence[0]), false);
  advance(9999); assert.equal(game.stage, 'show');
  advance(1); assert.equal(game.stage, 'input'); assert.equal(game.remaining(), 20000);
  advance(19999); assert.equal(game.stage, 'input');
  advance(1); assert.equal(game.stage, 'failure'); assert.equal(game.reason, 'timeout');
});
test('every key moves on every press; all nine symbols remain unique', () => {
  for (let i = 0; i < 500; i++) {
    const next = reshuffle(SYMBOLS);
    assert.deepEqual([...next].sort(), [...SYMBOLS].sort());
    assert(next.every((s, j) => s !== SYMBOLS[j]));
  }
});
test('fallback shuffle also moves every key', () => {
  const next = reshuffle(SYMBOLS, max => max - 1);
  assert(next.every((s, j) => s !== SYMBOLS[j]));
});
test('correct sequence succeeds, stale commands cannot insert an extra symbol', () => {
  const { game, advance } = fixture(); game.start(); advance(10000);
  const staleVersion = game.layoutVersion;
  assert(press(game, game.sequence[0]));
  assert.equal(press(game, game.sequence[1], { layoutVersion: staleVersion }), false);
  assert.equal(game.entered.length, 1);
  for (const symbol of game.sequence.slice(1)) assert(press(game, symbol));
  assert.equal(game.stage, 'success');
  assert.equal(press(game, '↑'), false);
});
test('wrong arrow or decoy glyph fails immediately and still reshuffles', () => {
  for (const symbol of ['Æ', 'Œ', 'Þ', 'Ð', 'Ƶ']) {
    const { game, advance } = fixture(); game.start(); advance(10000);
    const old = [...game.layout]; assert(press(game, symbol));
    assert.equal(game.stage, 'failure'); assert.equal(game.reason, 'symbol');
    assert(game.layout.every((s, i) => s !== old[i]));
  }
  const { game, advance } = fixture(); game.start(); advance(10000);
  press(game, ['↑', '↓', '←', '→'].find(s => s !== game.sequence[0]));
  assert.equal(game.stage, 'failure');
});
test('pause freezes time in both phases and rejects input', () => {
  const { game, advance } = fixture(); game.start(); advance(3000);
  game.pause('connection'); advance(60000);
  assert.equal(game.remaining(), 7000); assert.equal(game.stage, 'show');
  game.resume(); advance(7000); assert.equal(game.stage, 'input');
  advance(4000); game.pause(); advance(60000);
  assert.equal(game.remaining(), 16000); assert.equal(press(game, game.sequence[0]), false);
  game.resume(); advance(15999); assert.equal(game.stage, 'input'); advance(1); assert.equal(game.stage, 'failure');
});
test('exact deadline rejects input and earlier rounds cannot change a new attempt', () => {
  const { game, advance } = fixture(); game.start(); const oldRound = game.round;
  advance(10000); advance(20000); assert.equal(press(game, game.sequence[0]), false);
  game.start({ length: 10 }); advance(10000);
  assert.equal(game.sequence.length, 10); assert.equal(press(game, game.sequence[0], { round: oldRound }), false);
});
test('phone snapshots contain no answer or timer wall-clock dependency', () => {
  const { game } = fixture(); game.start(); const state = game.controllerState();
  assert.equal('sequence' in state, false); assert.equal('deadline' in state, false);
  state.layout[0] = 'HACK'; assert(!game.layout.includes('HACK'));
});
