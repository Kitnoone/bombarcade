import { RELAY_URL } from './config.js';
export const ROOM_PATTERN = /^[A-Z0-9]{6}$/;
const PREFIX = 'bombarcade-v2-';

export function createRoom() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return [...crypto.getRandomValues(new Uint8Array(6))].map(b => alphabet[b % 32]).join('');
}
function secret() { return [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2,'0')).join(''); }

export class Link {
  constructor({ role, room, local = false, clientId, onMessage, onStatus }) {
    Object.assign(this, { role, room, local, clientId, onMessage, onStatus });
    this.closed = false; this.operatorId = null; this.cursor = 0;
    this.streamId = crypto.randomUUID(); this.queue = []; this.controllers = new Set();
    this.lastHeartbeat = 0; this.pendingState = null; this.publishing = false;
    const key = PREFIX + role + '-' + room;
    try { this.token = sessionStorage.getItem(key) || secret(); sessionStorage.setItem(key, this.token); }
    catch { this.token = secret(); }
    if (local) this.openLocal(); else this.openRelay();
  }
  openLocal() {
    if (!globalThis.BroadcastChannel) { this.onStatus('error', 'Этот браузер не поддерживает локальную проверку.'); return; }
    this.bus = new BroadcastChannel(PREFIX + this.room);
    this.bus.onmessage = ({ data }) => {
      if (!data || data.role === this.role || data.room !== this.room) return;
      if (this.role === 'host') {
        if (typeof data.clientId !== 'string') return;
        if (this.operatorId && data.clientId !== this.operatorId) {
          this.bus.postMessage({ role: 'host', room: this.room, target: data.clientId, payload: { kind: 'busy' } }); return;
        }
        this.operatorId = data.clientId;
      } else if (data.target && data.target !== this.clientId) return;
      this.onMessage(data.payload);
    };
    this.onStatus(this.role === 'host' ? 'ready' : 'connecting');
  }
  async request(path, body) {
    const controller = new AbortController(); this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 4500);
    try {
      const response = await fetch(RELAY_URL + '/api/relay/' + path, {
        method: body === undefined ? 'GET' : 'POST', cache: 'no-store', credentials: 'omit',
        headers: { 'X-Bomb-Token': this.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal,
      });
      let data;
      try { data = await response.json(); } catch { throw new Error('Сервер связи не ответил. Проверь интернет и попробуй снова.'); }
      if (!response.ok) throw new Error(data.error || 'Сервер связи временно недоступен.');
      return data;
    } finally { clearTimeout(timeout); this.controllers.delete(controller); }
  }
  fail(error) {
    if (!this.closed) this.onStatus('error', error?.name === 'AbortError' ? 'Сервер связи не отвечает. Проверь интернет и попробуй снова.' : error.message || 'Ошибка связи с сервером.');
  }
  async openRelay() {
    try {
      if (this.role === 'host') await this.request('create', { room: this.room, token: this.token });
      else await this.request(this.room + '/join', { clientId: this.clientId, token: this.token, requestId: this.streamId });
      if (this.closed) return;
      this.started = true;
      this.onStatus(this.role === 'host' ? 'ready' : 'connected');
      this.poll();
    } catch (error) { this.fail(error); }
  }
  async poll() {
    if (this.closed || !this.started) return;
    let delay = 250;
    try {
      if (this.role === 'host') {
        const data = await this.request(this.room + '/host?after=' + this.cursor);
        if (this.closed) return;
        for (const event of data.events) {
          this.onMessage(event.packet); this.cursor = event.id;
        }
        if (data.phoneSeen && data.serverNow - data.phoneSeen < 4500) {
          this.phoneAlive = true;
          if (performance.now() - this.lastHeartbeat >= 1000) {
            this.lastHeartbeat = performance.now(); this.onMessage({ kind: 'ping' });
          }
        } else if (this.phoneAlive) {
          this.phoneAlive = false;
          this.onStatus('disconnected', 'Телефон не отвечает. Таймер остановлен до восстановления связи.');
        }
      } else {
        const data = await this.request(this.room + '/phone');
        if (this.closed) return;
        if (data.serverNow - data.hostSeen > 4500) this.onStatus('disconnected', 'Большой экран не отвечает. Оставь его открытым и восстанови связь.');
        else if (data.packet) this.onMessage(data.packet);
      }
    } catch (error) { this.fail(error); delay = 1000; }
    if (!this.closed) this.pollTimer = setTimeout(() => this.poll(), delay);
  }
  send(payload) {
    if (this.closed) return false;
    if (this.local) {
      this.bus?.postMessage({ role: this.role, room: this.room, clientId: this.clientId, target: this.role === 'host' ? this.operatorId : null, payload });
      return true;
    }
    if (!this.started) return false;
    if (this.role === 'host') {
      if (payload.kind !== 'state') return false;
      this.pendingState = payload; this.publish(); return true;
    }
    // Polling is the heartbeat; it does not need an extra queued ping packet.
    if (payload.kind === 'ping') return true;
    if (!['key', 'hello'].includes(payload.kind)) return false;
    this.queue.push({ packet: payload, requestId: this.streamId + '-' + crypto.randomUUID() });
    this.flush(); return true;
  }
  async publish() {
    if (this.publishing || this.closed) return;
    this.publishing = true;
    while (this.pendingState && !this.closed) {
      const packet = this.pendingState; this.pendingState = null;
      try { await this.request(this.room + '/state', packet); }
      catch (error) {
        this.fail(error);
        if (!this.pendingState) this.pendingState = packet;
        this.publishTimer = setTimeout(() => this.publish(), 1000); break;
      }
    }
    this.publishing = false;
  }
  async flush() {
    if (this.flushing || this.closed) return;
    this.flushing = true;
    while (this.queue.length && !this.closed) {
      try { await this.request(this.room + '/event', this.queue[0]); this.queue.shift(); }
      catch (error) { this.fail(error); this.flushTimer = setTimeout(() => this.flush(), 1000); break; }
    }
    this.flushing = false;
  }
  close() {
    this.closed = true;
    clearTimeout(this.pollTimer); clearTimeout(this.publishTimer); clearTimeout(this.flushTimer);
    for (const controller of this.controllers) controller.abort();
    this.bus?.close();
  }
}
