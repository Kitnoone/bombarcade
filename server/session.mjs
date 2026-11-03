// The local server is the single source of truth: the engine runs here, phones send
// commands, the TV renders the state it receives. Decorative animation stays on devices.
import { randomBytes } from 'node:crypto';
import { Adventure, DIGITS } from '../public/adventure.js';
import { SYMBOLS } from '../public/game.js';

const KEYS = [...SYMBOLS, ...DIGITS];

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TOKEN = /^[a-f0-9]{32,64}$/;
const ID = /^[a-zA-Z0-9-]{8,100}$/;
export const ROOM = /^[A-Z0-9]{6}$/;
export const LIVENESS_MS = 6000;
export const SYNC_MS = 1000;

const hex = bytes => randomBytes(bytes).toString('hex');
function roomCode(taken) {
  for (;;) {
    const code = [...randomBytes(6)].map(b => ALPHABET[b % 32]).join('');
    if (!taken.has(code)) return code;
  }
}
// Liveness is network time, independent of the (injectable) game clock.
const wall = () => performance.now();
const withoutClock = state => JSON.stringify({ ...state, remainingMs: 0 });

export class Hub {
  constructor({ now = () => performance.now(), virus, links = () => [], idleMs = 2 * 60 * 60 * 1000, random } = {}) {
    Object.assign(this, { now, virus, links, idleMs, random });
    this.sessions = new Map();
  }
  connect(socket) {
    socket.lastSeen = wall();
    socket.on('message', message => this.route(socket, message));
    socket.on('close', () => socket.session?.detach(socket));
  }
  route(socket, m) {
    socket.lastSeen = wall();
    if (m.t === 'ping') { socket.send({ t: 'pong', id: m.id, at: m.at }); return; }
    if (socket.session) { socket.session.message(socket, m); return; }
    if (m.t === 'host') this.host(socket, m);
    else if (m.t === 'phone') this.phone(socket, m);
    else socket.send({ t: 'error', code: 'hello', message: 'Сначала нужно представиться серверу.' });
  }
  host(socket, { token, room }) {
    if (!TOKEN.test(token || '')) return socket.send({ t: 'error', code: 'token', message: 'Неверный ключ большого экрана.' });
    let session = ROOM.test(room || '') ? this.sessions.get(room) : null;
    if (session && session.hostToken !== token) session = null;
    if (!session) {
      session = new Session(this, roomCode(this.sessions), token);
      this.sessions.set(session.code, session);
    }
    session.attachHost(socket);
  }
  phone(socket, { room, key, clientId, token }) {
    const session = this.sessions.get(String(room || '').toUpperCase());
    if (!session) return socket.send({ t: 'error', code: 'not-found', message: 'Сеанс не найден. Отсканируй QR-код с большого экрана ещё раз.' });
    if (key !== session.joinKey) return socket.send({ t: 'error', code: 'key', message: 'Ключ подключения устарел. Отсканируй QR-код с большого экрана.' });
    if (!ID.test(clientId || '') || !TOKEN.test(token || '')) return socket.send({ t: 'error', code: 'token', message: 'Неверный идентификатор консоли.' });
    session.attachPhone(socket, { clientId, token });
  }
  tick() {
    const now = this.now();
    for (const [code, session] of this.sessions) {
      session.tick(now);
      if (!session.host && now - session.hostLeft > this.idleMs) { session.close(); this.sessions.delete(code); }
    }
  }
}

export class Session {
  constructor(hub, code, hostToken) {
    this.hub = hub; this.code = code; this.hostToken = hostToken;
    this.joinKey = hex(12);
    this.engine = new Adventure({ now: hub.now, virus: hub.virus, ...(hub.random ? { random: hub.random } : {}) });
    this.host = null; this.phone = null; this.slot = null;
    this.streams = new Map();
    this.rtt = null; this.signatures = { host: '', phone: '' }; this.lastSync = 0; this.hostLeft = hub.now();
  }
  links() { return this.hub.links().map(link => ({ ...link, url: `http://${link.address}:${link.port}/?view=phone&room=${this.code}&key=${this.joinKey}` })); }
  attachHost(socket) {
    if (this.host && this.host !== socket) { this.host.send({ t: 'error', code: 'replaced', message: 'Большой экран открыт в другом окне.' }); this.host.session = null; this.host.close(4000, 'replaced'); }
    this.host = socket; socket.session = this; socket.role = 'host';
    socket.send({ t: 'welcome', role: 'host', room: this.code, joinKey: this.joinKey, links: this.links() });
    this.push(true);
  }
  attachPhone(socket, { clientId, token }) {
    if (this.slot && (this.slot.clientId !== clientId || this.slot.token !== token)) {
      socket.send({ t: 'error', code: 'busy', message: 'К сеансу уже привязана другая консоль. Мастер может отвязать её на большом экране.' });
      return;
    }
    this.slot = { clientId, token };
    if (this.phone && this.phone !== socket) { this.phone.session = null; this.phone.close(4000, 'replaced'); }
    this.phone = socket; socket.session = this; socket.role = 'phone';
    socket.send({ t: 'welcome', role: 'phone', room: this.code });
    this.push(true);
  }
  detach(socket) {
    if (socket.session !== this) return;
    socket.session = null;
    if (socket === this.host) { this.host = null; this.hostLeft = this.hub.now(); this.engine.pause('host'); }
    if (socket === this.phone) { this.phone = null; this.rtt = null; this.engine.pause('connection'); }
    this.push(true);
  }
  message(socket, m) {
    if (m.t === 'cmd' && socket === this.phone) return this.command(socket, m);
    if (m.t === 'rtt' && socket === this.phone && Number.isFinite(m.ms)) { this.rtt = Math.max(0, Math.min(10000, Math.round(m.ms))); return; }
    if (m.t === 'master' && socket === this.host) return this.master(socket, m);
  }
  command(socket, m) {
    const valid = ['move', 'key'].includes(m.kind) && KEYS.includes(m.symbol) && ID.test(m.stream || '') &&
      ['n', 'round', 'layoutVersion'].every(k => Number.isSafeInteger(m[k]) && m[k] >= 0);
    if (!valid) return socket.send({ t: 'ack', n: m.n, ok: false, reason: 'invalid' });
    // Duplicate delivery of the same command never applies it twice.
    const last = this.streams.get(m.stream) || 0;
    if (m.n <= last) return socket.send({ t: 'ack', n: m.n, ok: false, reason: 'duplicate' });
    this.streams.set(m.stream, m.n);
    if (this.streams.size > 50) this.streams.delete(this.streams.keys().next().value);
    const ok = this.engine.press({ kind: m.kind, symbol: m.symbol, round: m.round, layoutVersion: m.layoutVersion });
    this.push();
    socket.send({ t: 'ack', n: m.n, ok, reason: ok ? '' : m.round !== this.engine.round ? 'stale' : 'rejected', round: this.engine.round, layoutVersion: this.engine.layoutVersion });
  }
  master(socket, m) {
    const e = this.engine, both = !!(this.host && this.phone);
    let ok = false, message = '';
    switch (m.action) {
      case 'start': ok = both && !e.active() && e.stage !== 'lost' && !(e.protocol === 2 && e.stage === 'success') ? !!e.start({ length: m.length }) : false;
        if (!ok) message = both ? 'Сейчас запуск недоступен.' : 'Сначала подключи телефон.'; break;
      case 'retry': ok = both && e.retryStage(); if (!ok) message = both ? 'Повтор этапа недоступен.' : 'Сначала подключи телефон.'; break;
      case 'restart': ok = e.restart(); break;
      case 'pause': ok = e.pause('manual'); break;
      case 'resume': ok = both && e.resume(); if (!ok && !both) message = 'Продолжить можно, когда подключены оба экрана.'; break;
      case 'settings': if (e.protocol === 2 && e.active()) { message = 'Настройки вирусов меняются между попытками.'; break; }
        e.setVirusConfig({ count: m.count, stepMs: m.stepMs }); ok = true; break;
      case 'release-phone': if (e.active() && !e.paused) e.pause('connection');
        this.slot = null; this.rtt = null; this.streams.clear(); if (this.phone) { this.phone.send({ t: 'error', code: 'released', message: 'Мастер отвязал эту консоль.' }); this.phone.session = null; this.phone.close(4001, 'released'); this.phone = null; }
        ok = true; break;
    }
    socket.send({ t: 'result', action: m.action, ok, message });
    this.push(true);
  }
  tick(now) {
    for (const socket of [this.host, this.phone]) if (socket && wall() - socket.lastSeen > LIVENESS_MS) { socket.close(4002, 'timeout'); this.detach(socket); }
    const changed = this.engine.tick();
    this.push(changed ? false : now - this.lastSync >= SYNC_MS);
  }
  push(force = false) {
    if (force) this.lastSync = this.hub.now();
    const host = { ...this.engine.hostState(), link: { phone: !!this.phone, claimed: !!this.slot, rtt: this.rtt } };
    const phone = { ...this.engine.controllerState(), link: { host: !!this.host } };
    for (const [role, socket, state] of [['host', this.host, host], ['phone', this.phone, phone]]) {
      if (!socket) continue;
      const signature = withoutClock(state);
      if (!force && signature === this.signatures[role]) continue;
      this.signatures[role] = signature;
      socket.send({ t: 'state', s: state, at: Date.now() });
    }
  }
  close() { this.host?.close(1001, 'expired'); this.phone?.close(1001, 'expired'); }
}
