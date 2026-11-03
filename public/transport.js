import { Adventure } from './adventure.js';
import { Link, createRoom } from './link.js';
import { randomToken, sessionValue } from './identity.js';

export async function detectLocal() {
  try {
    const response = await fetch('/api/local', { cache: 'no-store', signal: AbortSignal.timeout(1800) });
    return response.ok && (await response.json()).local === true;
  } catch { return false; }
}

export class SocketConnection {
  constructor(options) {
    Object.assign(this, options);
    this.token = sessionValue(`bombarcade-${this.role}-token`);
    this.clientId = sessionValue('bombarcade-client');
    this.connect();
    this.heartbeat = setInterval(() => {
      if (this.socket?.readyState !== WebSocket.OPEN) return;
      if (performance.now() - this.lastSeen > 6000) { this.socket.close(); return; }
      this.send({ t: 'ping', at: performance.now() });
    }, 1000);
  }
  connect() {
    if (this.closed) return;
    this.onStatus('connecting');
    const ws = this.socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
    ws.onopen = () => {
      this.lastSeen = performance.now();
      this.send(this.role === 'host' ? { t: 'host', token: this.token, room: this.room } :
        { t: 'phone', room: this.room, key: this.joinKey, clientId: this.clientId, token: this.token });
    };
    ws.onmessage = event => {
      let m;
      try { m = JSON.parse(event.data); } catch { return; }
      this.lastSeen = performance.now();
      if (m.t === 'pong') {
        if (this.role === 'phone') this.send({ t: 'rtt', ms: performance.now() - m.at });
        return;
      }
      if (m.t === 'welcome') { this.room = m.room; this.onStatus('connected'); }
      if (m.t === 'error') { this.closed = true; clearInterval(this.heartbeat); this.onStatus('error', m.message); ws.close(); return; }
      this.onMessage(m);
    };
    ws.onclose = () => {
      if (this.closed) return;
      this.onStatus('disconnected', 'Связь прервана. Переподключение… Продолжение подтвердит мастер.');
      this.reconnect = setTimeout(() => this.connect(), 1000);
    };
    ws.onerror = () => { /* onclose owns reconnection. */ };
  }
  send(message) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message)); return true;
  }
  close() { this.closed = true; clearTimeout(this.reconnect); clearInterval(this.heartbeat); this.socket?.close(); }
}

// The existing cloud/BroadcastChannel modes retain a TV-owned engine. They expose
// the same messages as the local server without sending its observer state to phones.
export class BrowserConnection {
  constructor(options) {
    Object.assign(this, options);
    this.room ||= createRoom();
    this.clientId = sessionValue('bombarcade-client');
    this.engine = this.role === 'host' ? new Adventure() : null;
    this.connected = false; this.lastSeen = performance.now(); this.commands = new Map();
    this.connect();
    this.timer = setInterval(() => {
      if (this.connected && performance.now() - this.lastSeen > 6000) {
        this.connected = false; this.engine?.pause('connection'); this.onStatus('disconnected', 'Второй экран не отвечает.');
      }
      if (this.engine) {
        const changed = this.engine.tick();
        this.observer();
        if (changed || performance.now() - (this.lastPush || 0) > 1000) this.publish();
      } else if (performance.now() - (this.lastPing || 0) >= 1000) {
        this.lastPing = performance.now(); this.link?.send({ kind: 'ping' });
      }
    }, 50);
  }
  connect() {
    this.link?.close();
    this.link = new Link({ role: this.role, room: this.room, local: this.demo, clientId: this.clientId,
      onStatus: (status, error) => {
        if (status === 'ready') {
          const url = new URL(location.href); url.search = ''; url.searchParams.set('view', 'phone'); url.searchParams.set('room', this.room);
          if (this.demo) url.searchParams.set('transport', 'local');
          this.onMessage({ t: 'welcome', room: this.room, links: [{ url: url.href, name: this.demo ? 'Другой экран этого браузера' : 'Интернет' }] });
          this.observer();
        }
        if (status === 'connected') this.link?.send({ kind: 'hello' });
        if (['disconnected', 'error'].includes(status)) { this.connected = false; this.engine?.pause('connection'); this.observer(); }
        this.onStatus(status, error);
      },
      onMessage: m => this.receive(m),
    });
    if (!this.engine) this.link.send({ kind: 'hello' });
  }
  observer() {
    if (this.engine) this.onMessage({ t: 'state', s: { ...this.engine.hostState(), link: { phone: this.connected, claimed: this.connected, rtt: null } } });
  }
  publish(ack) {
    this.lastPush = performance.now();
    if (ack !== undefined) this.lastAck = ack;
    this.link?.send({ kind: 'state', state: this.engine.controllerState(), ack: this.lastAck, ackStream: this.ackStream });
  }
  receive(m) {
    if (m?.kind === 'busy') { this.onStatus('error', 'К сеансу уже подключён другой телефон.'); return; }
    if (!m || !['state', 'hello', 'ping', 'key', 'move'].includes(m.kind)) return;
    this.lastSeen = performance.now(); this.connected = true; this.onStatus('connected');
    if (!this.engine) {
      if (m.kind !== 'state') return;
      this.onMessage({ t: 'state', s: { ...m.state, link: { host: true } } });
      if (Number.isSafeInteger(m.ack) && (!m.ackStream || m.ackStream === this.commandStream)) this.onMessage({ t: 'ack', n: m.ack, cumulative: true });
      return;
    }
    if (['key', 'move'].includes(m.kind)) {
      const stream = m.stream || 'legacy', last = this.commands.get(stream) || 0;
      if (Number.isSafeInteger(m.command) && m.command > last) {
        this.commands.set(stream, m.command); this.engine.press(m);
      }
      this.ackStream = m.stream;
      this.publish(m.command);
    } else this.publish();
    this.observer();
  }
  send(m) {
    if (m.t === 'cmd') {
      this.commandStream = m.stream;
      return this.link.send({ kind: m.kind, symbol: m.symbol, round: m.round, layoutVersion: m.layoutVersion, command: m.n, stream: m.stream });
    }
    if (!this.engine || m.t !== 'master') return false;
    const e = this.engine; let ok = false;
    switch (m.action) {
      case 'start': ok = this.connected && e.start({ length: m.length }); break;
      case 'retry': ok = this.connected && e.retryStage(); break;
      case 'restart': ok = e.restart(); break;
      case 'pause': ok = e.pause(m.reason || 'manual'); break;
      case 'resume': ok = this.connected && e.resume(); break;
      case 'settings': if (!(e.protocol === 2 && e.active())) { e.setVirusConfig(m); ok = true; } break;
    }
    this.onMessage({ t: 'result', action: m.action, ok, message: ok ? '' : 'Команда сейчас недоступна.' });
    this.observer(); this.publish(); return true;
  }
  close() { clearInterval(this.timer); this.link.close(); }
}
