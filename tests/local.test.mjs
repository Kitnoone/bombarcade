import test from 'node:test';
import assert from 'node:assert/strict';
import { createBombarcadeServer } from '../server.mjs';
import { lanAddresses } from '../server/net.mjs';
import { START } from '../public/adventure.js';

const LAN = [{ address: '192.168.1.50', name: 'Wi-Fi', kind: 'wifi', virtual: false, private: true, recommended: true }];
const hex = n => Array.from({ length: n }, (_, i) => 'abcdef0123456789'[(i * 7 + n) % 16]).join('');

async function boot(options = {}) {
  let clock = 1000;
  const { server, hub } = createBombarcadeServer({ interfaces: () => LAN, now: () => clock, tickMs: 5, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const clients = [];
  const client = () => { const c = new Client(`ws://127.0.0.1:${port}/ws`); clients.push(c); return c; };
  return {
    port, hub, client,
    advance: async ms => { clock += ms; await new Promise(r => setTimeout(r, 25)); },
    session: () => [...hub.sessions.values()][0],
    async close() { clients.forEach(c => c.close()); await new Promise(r => server.close(r)); server.closeAllConnections?.(); },
  };
}
class Client {
  constructor(url) {
    this.messages = []; this.waiters = [];
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject; });
    this.ws.onmessage = e => { const m = JSON.parse(e.data); this.messages.push(m); if (m.t === 'state') this.state = m.s; this.waiters = this.waiters.filter(w => !w(m)); };
    this.closed = new Promise(resolve => { this.ws.onclose = resolve; });
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  next(predicate, timeout = 2000) {
    const found = this.messages.find(predicate);
    if (found) { this.messages.splice(this.messages.indexOf(found), 1); return Promise.resolve(found); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for message')), timeout);
      this.waiters.push(m => { if (!predicate(m)) return false; clearTimeout(timer); this.messages.splice(this.messages.indexOf(m), 1); resolve(m); return true; });
    });
  }
  until(predicate, timeout) { return this.state && predicate(this.state) ? Promise.resolve(this.state) : this.next(m => m.t === 'state' && predicate(m.s), timeout).then(m => m.s); }
  close() { try { this.ws.close(); } catch {} }
}
async function pair(t) {
  const host = t.client(); await host.ready;
  host.send({ t: 'host', token: hex(64) });
  const welcome = await host.next(m => m.t === 'welcome');
  const phone = t.client(); await phone.ready;
  const identity = { clientId: 'phone-' + hex(12), token: hex(64) };
  phone.send({ t: 'phone', room: welcome.room, key: welcome.joinKey, ...identity });
  await phone.next(m => m.t === 'welcome');
  await host.until(s => s.link.phone);
  return { host, phone, welcome, identity };
}
let streamN = 0;
function commander(phone) {
  const stream = 'stream-' + hex(10) + (streamN++);
  let n = 0;
  return (kind, symbol, extra = {}) => {
    const s = phone.state;
    phone.send({ t: 'cmd', stream, n: ++n, kind, symbol, round: s.round, layoutVersion: s.layoutVersion, ...extra });
    return phone.next(m => m.t === 'ack' && m.n === (extra.n ?? n));
  };
}

test('only real LAN IPv4 addresses are offered, private physical adapters first', () => {
  const list = lanAddresses({
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    'vEthernet (WSL)': [{ address: '172.20.80.1', family: 'IPv4', internal: false }],
    'Ethernet': [{ address: '192.168.0.12', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }],
    'Wi-Fi': [{ address: '169.254.10.2', family: 'IPv4', internal: false }, { address: '10.0.0.7', family: 4, internal: false }],
  });
  assert.deepEqual(list.map(a => a.address), ['192.168.0.12', '10.0.0.7', '172.20.80.1']);
  assert.equal(list[0].recommended, true); assert.equal(list[0].kind, 'wired'); assert.equal(list[1].kind, 'wifi');
  assert.equal(list[2].virtual, true);
  assert(list.every(a => !a.address.startsWith('127.') && !a.address.startsWith('169.254.')));
});

test('the server serves the game and its network endpoint locally', async () => {
  const t = await boot();
  try {
    const page = await fetch(`http://127.0.0.1:${t.port}/?view=phone`);
    assert.equal(page.status, 200); assert.match(await page.text(), /Bombarcade/);
    const info = await (await fetch(`http://127.0.0.1:${t.port}/api/local`)).json();
    assert.equal(info.local, true); assert.equal(info.addresses[0].address, '192.168.1.50');
    assert.notEqual((await fetch(`http://127.0.0.1:${t.port}/%2e%2e/server.mjs`)).status, 200);
    const style = await fetch(`http://127.0.0.1:${t.port}/style.css`);
    assert.equal(style.status, 200); assert.match(style.headers.get('content-type'), /text\/css/);
  } finally { await t.close(); }
});

test('the QR link carries the LAN address, port, room and join key — never localhost', async () => {
  const t = await boot();
  try {
    const host = t.client(); await host.ready; host.send({ t: 'host', token: hex(64) });
    const w = await host.next(m => m.t === 'welcome');
    assert.match(w.room, /^[A-Z0-9]{6}$/);
    const url = new URL(w.links[0].url);
    assert.equal(url.hostname, '192.168.1.50'); assert.equal(Number(url.port), t.port);
    assert.equal(url.searchParams.get('room'), w.room); assert.equal(url.searchParams.get('key'), w.joinKey);
    assert(!/localhost|127\.0\.0\.1/.test(w.links.map(l => l.url).join(' ')));
  } finally { await t.close(); }
});

test('phones need the join key; a second phone cannot take the slot; the master can release it', async () => {
  const t = await boot();
  try {
    const { host, welcome } = await pair(t);
    const wrong = t.client(); await wrong.ready;
    wrong.send({ t: 'phone', room: welcome.room, key: 'nope', clientId: 'intruder-123456', token: hex(64) });
    assert.equal((await wrong.next(m => m.t === 'error')).code, 'key');
    const second = t.client(); await second.ready;
    second.send({ t: 'phone', room: welcome.room, key: welcome.joinKey, clientId: 'second-phone-123', token: hex(48) });
    assert.equal((await second.next(m => m.t === 'error')).code, 'busy');
    host.send({ t: 'master', action: 'release-phone' }); await host.next(m => m.t === 'result' && m.ok);
    const third = t.client(); await third.ready;
    third.send({ t: 'phone', room: welcome.room, key: welcome.joinKey, clientId: 'second-phone-123', token: hex(48) });
    assert.equal((await third.next(m => m.t === 'welcome' || m.t === 'error')).t, 'welcome');
  } finally { await t.close(); }
});

test('protocol I over WebSocket: the server judges; the shuffled keypad never double-applies a tap', async () => {
  const t = await boot();
  try {
    const { host, phone } = await pair(t);
    host.send({ t: 'master', action: 'start', length: 8 });
    const shown = await host.until(s => s.stage === 'show');
    assert.equal(shown.sequence.length, 8); assert.equal(shown.durationMs, 10000);
    const phoneShow = await phone.until(s => s.stage === 'show');
    assert.equal('sequence' in phoneShow, false);
    await t.advance(10000);
    const input = await phone.until(s => s.stage === 'input');
    assert.equal(input.durationMs, 20000); assert.equal(input.layout.length, 9);
    const cmd = commander(phone);
    // A tap on a stale layout is refused rather than guessed.
    const firstLayout = phone.state.layoutVersion;
    const ack1 = await cmd('key', shown.sequence[0]); assert.equal(ack1.ok, true);
    await phone.until(s => s.layoutVersion > firstLayout);
    const stale = await cmd('key', shown.sequence[1], { layoutVersion: firstLayout }); assert.equal(stale.ok, false);
    assert.equal(phone.state.entered.length, 1);
    for (const symbol of shown.sequence.slice(1)) {
      const before = phone.state.layout;
      const ack = await cmd('key', symbol); assert.equal(ack.ok, true);
      const after = phone.state.layout;
      if (phone.state.stage === 'input') assert(after.every((k, i) => k !== before[i]), 'every key moves');
    }
    await host.until(s => s.stage === 'transition');
    assert.equal(t.session().engine.entered.length, 8);
  } finally { await t.close(); }
});

test('duplicates and commands from a previous attempt are dropped after a restart', async () => {
  const t = await boot({ virus: { count: 0, stepMs: 800 } });
  try {
    const { host, phone } = await pair(t);
    t.session().engine.startSearch(); t.session().push(true);
    await phone.until(s => s.protocol === 2 && s.stage === 'explore');
    const stream = 'dup-stream-123456', base = { t: 'cmd', stream, kind: 'move', symbol: '→', round: phone.state.round, layoutVersion: 0 };
    phone.send({ ...base, n: 1 }); phone.send({ ...base, n: 1 });
    assert.equal((await phone.next(m => m.t === 'ack' && m.n === 1)).ok, true);
    assert.equal((await phone.next(m => m.t === 'ack' && m.n === 1)).reason, 'duplicate');
    assert.equal(t.session().engine.position.col, START.col + 1);
    const oldRound = phone.state.round;
    t.session().engine.fail('caught'); t.session().push(true);
    await host.until(s => s.stage === 'failure' && s.attemptsLeft === 2);
    host.send({ t: 'master', action: 'retry' }); await host.next(m => m.t === 'result' && m.action === 'retry' && m.ok);
    await phone.until(s => s.stage === 'explore' && s.round > oldRound);
    const stale = { ...base, n: 2, round: oldRound };
    phone.send(stale);
    const ack = await phone.next(m => m.t === 'ack' && m.n === 2);
    assert.equal(ack.ok, false); assert.equal(ack.reason, 'stale');
    assert.deepEqual(t.session().engine.position, START);
  } finally { await t.close(); }
});

test('three defeats end the run; retry is refused; only an explicit restart begins again', async () => {
  const t = await boot();
  try {
    const { host } = await pair(t); const e = t.session().engine;
    e.startSearch();
    for (let i = 0; i < 3; i++) {
      e.fail('caught'); t.session().push(true);
      if (i < 2) { host.send({ t: 'master', action: 'retry' }); assert((await host.next(m => m.t === 'result' && m.action === 'retry')).ok); }
    }
    const lost = await host.until(s => s.stage === 'lost');
    assert.equal(lost.attemptsLeft, 0);
    host.send({ t: 'master', action: 'retry' }); assert.equal((await host.next(m => m.t === 'result' && m.action === 'retry')).ok, false);
    host.send({ t: 'master', action: 'start' }); assert.equal((await host.next(m => m.t === 'result' && m.action === 'start')).ok, false);
    host.send({ t: 'master', action: 'restart' }); assert((await host.next(m => m.t === 'result' && m.action === 'restart')).ok);
    await host.until(s => s.stage === 'lobby' && s.protocol === 1);
  } finally { await t.close(); }
});

test('a dropped phone pauses timers and viruses without costing an attempt; the master resumes', async () => {
  const t = await boot();
  try {
    const { host, phone, welcome, identity } = await pair(t); const e = t.session().engine;
    e.startSearch(); e.viruses = [{ id: 1, col: 9, row: 5, active: true, nextAt: 1e9, left: 0 }]; t.session().push(true);
    phone.close(); await phone.closed;
    const paused = await host.until(s => s.paused && s.pauseReason === 'connection');
    assert.equal(paused.link.phone, false); assert.equal(paused.attemptsLeft, 3);
    host.send({ t: 'master', action: 'resume' }); assert.equal((await host.next(m => m.t === 'result' && m.action === 'resume')).ok, false);
    const back = t.client(); await back.ready;
    back.send({ t: 'phone', room: welcome.room, key: welcome.joinKey, ...identity });
    await back.next(m => m.t === 'welcome');
    const resumedState = await back.until(s => s.paused);
    assert.equal(resumedState.attemptsLeft, 3);
    host.send({ t: 'master', action: 'resume' }); assert((await host.next(m => m.t === 'result' && m.action === 'resume')).ok);
    await back.until(s => !s.paused && s.stage === 'explore');
  } finally { await t.close(); }
});

test('ping/pong measures round trip; the phone report reaches the TV diagnostics', async () => {
  const t = await boot();
  try {
    const { host, phone } = await pair(t);
    const times = [];
    for (let i = 0; i < 20; i++) {
      const at = performance.now(); phone.send({ t: 'ping', id: i, at });
      await phone.next(m => m.t === 'pong' && m.id === i); times.push(performance.now() - at);
    }
    const median = times.sort((a, b) => a - b)[10];
    phone.send({ t: 'rtt', ms: median });
    await t.advance(1100);
    const s = await host.until(st => st.link.rtt !== null);
    assert.equal(s.link.rtt, Math.round(median));
    console.log(`  loopback WebSocket RTT median ${median.toFixed(2)} ms (this is not a Wi-Fi measurement)`);
  } finally { await t.close(); }
});
