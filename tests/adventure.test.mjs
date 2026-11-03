import test from 'node:test';
import assert from 'node:assert/strict';
import { Adventure, DIGITS, FIELD, SECOND, START, TRANSITION_MS, VIRUS_DEFAULTS, hexDistance, neighbours, placeViruses, safeRouteExists, same } from '../public/adventure.js';

function fixture(options = {}) {
  let clock = 100;
  const game = new Adventure({ now: () => clock, ...options });
  return { game, advance(ms) { clock += ms; game.tick(); }, step(ms, slice = 50) { for (let t = 0; t < ms; t += slice) { clock += Math.min(slice, ms - t); game.tick(); } } };
}
const press = (game, symbol, kind = 'key', overrides = {}) => game.press({ kind, symbol, round: game.round, layoutVersion: game.layoutVersion, ...overrides });
const move = (game, symbol, overrides) => press(game, symbol, 'move', overrides);
function unlock(f) {
  f.game.start(); f.advance(10000);
  for (const s of f.game.sequence) assert(press(f.game, s));
}
function reach(game, node) {
  while (game.position.col !== node.col) assert(move(game, game.position.col < node.col ? '→' : '←'));
  while (game.position.row !== node.row) assert(move(game, game.position.row < node.row ? '↓' : '↑'));
}
function search(f, { viruses = [] } = {}) {
  f.game.startSearch(); f.game.viruses = viruses.map((p, i) => ({ id: i + 1, active: false, nextAt: 0, left: 0, ...p }));
  return f.game;
}
const target = game => game.nodes.find(n => n.target);
function toCode(f) { const g = search(f); reach(g, target(g)); return g; }

test('first success fades for 1.8 seconds then starts search with three attempts', () => {
  const f = fixture(); unlock(f); assert.equal(f.game.stage, 'transition');
  assert.equal(move(f.game, '↑'), false);
  f.advance(TRANSITION_MS - 1); assert.equal(f.game.protocol, 1);
  f.advance(1); assert.equal(f.game.protocol, 2); assert.equal(f.game.stage, 'explore');
  assert.equal(f.game.nodes.length, 6); assert.equal(f.game.nodes.filter(n => n.target).length, 1);
  assert(hexDistance(f.game.position, target(f.game)) >= 6);
  assert.equal(f.game.viruses.length, VIRUS_DEFAULTS.count);
  const phone = f.game.controllerState();
  assert.equal(phone.attempt, 1); assert.equal(phone.attemptsTotal, 3); assert.equal(phone.attemptsLeft, 3);
});
test('pause freezes the transition and blocks exploration', () => {
  const f = fixture(); unlock(f); f.advance(700); f.game.pause('connection');
  f.advance(60000); assert.equal(f.game.stage, 'transition'); assert.equal(f.game.remaining(), 1100);
  f.game.resume(); f.advance(1100); const pos = { ...f.game.position };
  f.game.pause(); assert.equal(move(f.game, '→'), false); assert.deepEqual(f.game.position, pos);
  f.game.resume(); f.advance(90000); assert.equal(f.game.stage, 'explore');
});
test('movement stays inside the field; commands from an earlier attempt are ignored', () => {
  const f = fixture(); const g = search(f);
  for (let i = 0; i < 30; i++) move(g, '←'); assert.equal(g.position.col, 0);
  for (let i = 0; i < 30; i++) move(g, '↑'); assert.equal(g.position.row, 0);
  const pos = { ...g.position }; assert.equal(move(g, '↓', { round: g.round - 1 }), false); assert.deepEqual(g.position, pos);
  assert.equal(move(g, '0'), false); assert.equal(press(g, '1'), false);
  // Back-to-back moves need no layout round trip during a chase.
  const version = g.layoutVersion; assert(move(g, '→')); assert(move(g, '→', { layoutVersion: version }));
  assert.equal(g.position.col, 2);
});
test('target contact shows eight digits for 10 seconds, then allows 40 seconds of input', () => {
  const f = fixture(); const g = toCode(f);
  assert.equal(g.stage, 'show'); assert.match(g.sequence.join(''), /^\d{8}$/);
  assert.equal(g.duration(), 10000);
  assert.equal(move(g, '↑'), false); assert.equal(press(g, '0'), false);
  f.advance(9999); assert.equal(g.stage, 'show'); f.advance(1);
  assert.equal(g.stage, 'input'); assert.equal(g.remaining(), 40000); assert.equal(g.duration(), 40000);
  assert.equal(SECOND.inputMs, 40000);
  f.advance(20000); assert.equal(g.stage, 'input', 'the old 20-second limit must not end the input');
  f.advance(19999); assert.equal(g.stage, 'input'); f.advance(1);
  assert.equal(g.stage, 'failure'); assert.equal(g.reason, 'timeout'); assert.equal(g.attemptsLeft(), 2);
});
test('decimal input includes zero, keeps the keypad stable and completes protocol two', () => {
  const f = fixture(); const g = toCode(f); f.advance(10000);
  g.sequence = ['0', '1', '2', '3', '4', '5', '6', '9'];
  for (const s of g.sequence) { assert(press(g, s)); assert.deepEqual(g.layout, DIGITS); }
  assert.equal(g.stage, 'success'); assert.equal(g.protocol, 2);
});
test('two retries are allowed; the third defeat is final and only a full restart remains', () => {
  const f = fixture(); let g = toCode(f); f.advance(10000);
  assert(press(g, g.sequence[0] === '0' ? '1' : '0')); assert.equal(g.stage, 'failure'); assert.equal(g.attemptsLeft(), 2);
  assert.equal(g.controllerState().attempt, 1);
  assert(g.retryStage()); assert.equal(g.stage, 'explore'); assert.equal(g.protocol, 2); assert.equal(g.attemptNumber(), 2);
  g.viruses = []; reach(g, target(g)); f.advance(10000); f.advance(40000);
  assert.equal(g.stage, 'failure'); assert.equal(g.reason, 'timeout'); assert.equal(g.attemptsLeft(), 1);
  assert(g.retryStage()); assert.equal(g.attemptNumber(), 3);
  g.viruses = [{ id: 1, col: START.col + 1, row: START.row, active: true, nextAt: 1e12, left: 0 }];
  assert(move(g, '→')); assert.equal(g.reason, 'caught');
  assert.equal(g.stage, 'lost'); assert.equal(g.attemptsLeft(), 0);
  assert.equal(g.retryStage(), false); assert.equal(g.start(), false); assert.equal(move(g, '←'), false); assert.equal(press(g, '1'), false);
  assert(g.restart()); assert.equal(g.stage, 'lobby'); assert.equal(g.protocol, 1); assert.equal(g.failures, 0);
  g.start(); assert.equal(g.stage, 'show'); assert.equal(g.protocol, 1); assert(g.layout.every(k => !DIGITS.includes(k)));
});
test('a retry restarts the search: probe, fog, viruses, node, digits and timers are fresh', () => {
  const f = fixture(); const g = search(f);
  move(g, '→'); move(g, '→');
  const old = { round: g.round, nodes: JSON.stringify(g.nodes) };
  g.fail('caught');
  assert(g.retryStage());
  assert.deepEqual(g.position, START); assert.equal(g.round, old.round + 1);
  assert.notEqual(JSON.stringify(g.nodes), old.nodes);
  assert(g.viruses.every(v => !v.active)); assert.equal(g.viruses.length, 3);
  assert.deepEqual(g.sequence, []); assert.deepEqual(g.entered, []); assert.equal(g.remaining(), 0);
  assert.equal(move(g, '→', { round: old.round }), false, 'a stale command from the lost attempt must not move the new probe');
  assert.deepEqual(g.position, START);
});
test('virus placement avoids the start, its scan, nodes and the target, and keeps a safe route', () => {
  for (let i = 0; i < 300; i++) {
    const f = fixture(); const g = f.game; g.startSearch();
    const t = target(g);
    assert.equal(g.viruses.length, 3);
    for (const v of g.viruses) {
      assert(!same(v, START) && !same(v, t)); assert(hexDistance(v, START) > FIELD.radius);
      assert(!g.nodes.some(n => same(n, v)));
      assert(v.col >= 0 && v.col < FIELD.columns && v.row >= 0 && v.row < FIELD.rows);
    }
    assert(safeRouteExists(START, t, g.viruses));
  }
  assert.throws(() => placeViruses({ count: 300, nodes: [], random: n => 0 }));
});
test('a virus wakes exactly when its cell enters the two-hex scan', () => {
  const f = fixture(); const g = search(f, { viruses: [{ col: 7, row: 5 }] });
  assert.equal(hexDistance(START, g.viruses[0]), 5);
  move(g, '→'); move(g, '→'); assert.equal(hexDistance(g.position, g.viruses[0]), 3);
  assert.equal(g.viruses[0].active, false); assert.equal(g.alert, 0);
  f.advance(5000); assert.deepEqual({ col: g.viruses[0].col, row: g.viruses[0].row }, { col: 7, row: 5 }, 'a sleeping virus stays put');
  move(g, '→'); assert.equal(hexDistance(g.position, g.viruses[0]), 2);
  assert.equal(g.viruses[0].active, true); assert.equal(g.alert, 1); assert.match(g.contact, /ВИРУС ОБНАРУЖЕН/);
  assert.equal(g.controllerState().alarm, 1);
});
test('an awake virus keeps chasing after it leaves the scan, one legal step every 2500 ms by default', () => {
  const f = fixture(); const g = search(f, { viruses: [{ col: 6, row: 5 }] });
  move(g, '→'); move(g, '→'); assert(g.viruses[0].active);
  for (let i = 0; i < 6; i++) move(g, '←');
  for (let i = 0; i < 4; i++) move(g, '↓');
  assert(hexDistance(g.position, g.viruses[0]) > FIELD.radius, 'the virus is outside the scan');
  let previous = { col: g.viruses[0].col, row: g.viruses[0].row };
  f.advance(2499); assert(same(previous, g.viruses[0]), 'no step before 2500 ms');
  for (let i = 0; i < 4; i++) {
    const before = Math.abs(previous.col - g.position.col) + Math.abs(previous.row - g.position.row);
    f.advance(i === 0 ? 1 : 2500);
    const now = { col: g.viruses[0].col, row: g.viruses[0].row };
    assert(neighbours(previous).some(p => same(p, now)), 'one adjacent step, no teleport');
    assert.equal(Math.abs(now.col - g.position.col) + Math.abs(now.row - g.position.row), before - 1, 'shortest path');
    previous = now;
  }
});
test('the player can outrun a chasing virus with timely moves', () => {
  const f = fixture({ virus: { stepMs: 800 } }); const g = search(f, { viruses: [{ col: 6, row: 5 }] });
  move(g, '→'); move(g, '→'); assert(g.viruses[0].active);
  for (let i = 0; i < 8; i++) { f.step(400); move(g, i < 2 ? '←' : '↓'); }
  assert.equal(g.stage, 'explore');
  assert(Math.abs(g.viruses[0].col - g.position.col) + Math.abs(g.viruses[0].row - g.position.row) >= 2);
});
test('collision when the probe walks into a virus', () => {
  const f = fixture(); const g = search(f, { viruses: [{ col: 3, row: 5, active: true, nextAt: 1e12 }] });
  assert(move(g, '→')); assert.equal(g.stage, 'failure'); assert.equal(g.reason, 'caught'); assert.equal(g.attemptsLeft(), 2);
  assert.equal(move(g, '→'), false);
});
test('collision when a virus steps onto the probe', () => {
  const f = fixture(); const g = search(f, { viruses: [{ col: 3, row: 5, active: true, nextAt: 900 }] });
  f.advance(799); assert.equal(g.stage, 'explore'); f.advance(1);
  assert.equal(g.stage, 'failure'); assert.equal(g.reason, 'caught'); assert.equal(g.failures, 1);
});
test('several viruses catching the probe at once cost a single attempt', () => {
  const f = fixture(); const g = search(f, { viruses: [
    { col: 3, row: 5, active: true, nextAt: 900 }, { col: 1, row: 5, active: true, nextAt: 900 }, { col: 2, row: 4, active: true, nextAt: 900 },
  ] });
  f.advance(800);
  assert.equal(g.stage, 'failure'); assert.equal(g.failures, 1); assert.equal(g.attemptsLeft(), 2);
  assert.equal(g.fail('timeout'), false); assert.equal(g.failures, 1);
});
test('a wrong digit exactly at the deadline costs one attempt, not two', () => {
  const f = fixture(); const g = toCode(f); f.advance(10000); f.advance(40000 - 1);
  // The clock passes the deadline between the tick and the command.
  f.game.now = () => 1e15;
  press(g, g.sequence[0] === '0' ? '1' : '0');
  assert.equal(g.stage, 'failure'); assert.equal(g.reason, 'timeout'); assert.equal(g.failures, 1);
});
test('viruses freeze while the code is shown and typed', () => {
  const f = fixture(); const g = search(f, { viruses: [{ col: 12, row: 0, active: true, nextAt: 900 }] });
  g.nodes = [{ col: 3, row: 5, target: true, kind: 'target' }];
  move(g, '→'); assert.equal(g.stage, 'show');
  const frozen = JSON.stringify(g.viruses);
  f.step(10000); assert.equal(g.stage, 'input'); f.step(20000);
  assert.equal(JSON.stringify(g.viruses), frozen); assert.deepEqual(g.position, { col: 3, row: 5 });
  assert.equal(move(g, '←'), false);
});
test('pause and lost connection freeze viruses and timers, also during the 10-second code display', () => {
  const f = fixture(); const g = search(f, { viruses: [{ col: 8, row: 5, active: true, nextAt: 900 }] });
  f.advance(400); g.pause('connection');
  const at = { col: g.viruses[0].col, row: g.viruses[0].row };
  f.step(30000); assert(same(at, g.viruses[0])); assert.equal(g.failures, 0);
  g.resume(); f.advance(399); assert(same(at, g.viruses[0])); f.advance(1); assert(!same(at, g.viruses[0]));
  g.viruses = []; reach(g, target(g)); f.advance(4000);
  g.pause(); f.advance(60000); assert.equal(g.stage, 'show'); assert.equal(g.remaining(), 6000);
  g.resume(); f.advance(6000); assert.equal(g.stage, 'input'); assert.equal(g.remaining(), 40000);
});
test('virus count and speed come from settings', () => {
  const f = fixture({ virus: { count: 5, stepMs: 1200 } }); const g = f.game;
  assert.deepEqual(g.virusConfig, { count: 5, stepMs: 1200 });
  g.startSearch(); assert.equal(g.viruses.length, 5);
  g.setVirusConfig({ count: 0 }); g.startSearch(); assert.equal(g.viruses.length, 0);
  assert.deepEqual(g.setVirusConfig({ count: 99, stepMs: 5 }), { count: 6, stepMs: 300 });
});
test('phone state never exposes the field, viruses, probe coordinates or the solution', () => {
  const f = fixture(); const g = search(f, { viruses: [{ col: 3, row: 3, active: true, nextAt: 1e12 }] });
  const explore = g.controllerState();
  for (const key of ['sequence', 'nodes', 'position', 'viruses', 'field', 'contact', 'deadline']) assert.equal(key in explore, false);
  g.viruses = []; reach(g, target(g));
  const show = g.controllerState();
  assert.equal(JSON.stringify(show).includes(g.sequence.join('')), false);
  assert.equal(show.protocol, 2); assert.deepEqual(show.layout, DIGITS); assert.equal(show.durationMs, 10000);
  assert.deepEqual(g.hostState().sequence, g.sequence);
});
