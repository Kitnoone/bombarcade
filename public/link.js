export const ROOM_PATTERN = /^[A-Z0-9]{6}$/;
const PREFIX = 'bombarcade-v1-';

export function createRoom() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map(b => alphabet[b % alphabet.length]).join('');
}

export class Link {
  constructor({ role, room, local = false, clientId, onMessage, onStatus }) {
    Object.assign(this, { role, room, local, clientId, onMessage, onStatus });
    this.closed = false;
    this.operatorId = null;
    this.conn = null;
    if (local) this.openLocal(); else this.openPeer();
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
  openPeer() {
    if (!globalThis.Peer) { this.onStatus('error', 'Не удалось загрузить модуль связи. Обнови страницу.'); return; }
    const options = { debug: 0 };
    this.peer = this.role === 'host' ? new Peer(PREFIX + this.room, options) : new Peer(undefined, options);
    this.peer.on('open', () => {
      if (this.role === 'host') this.onStatus('ready');
      else this.attach(this.peer.connect(PREFIX + this.room, { reliable: true, serialization: 'json', metadata: { clientId: this.clientId } }));
    });
    if (this.role === 'host') this.peer.on('connection', conn => {
      const id = conn.metadata?.clientId;
      if (typeof id !== 'string' || id.length > 80) { conn.close(); return; }
      if (this.operatorId && id !== this.operatorId) {
        conn.on('open', () => { conn.send({ kind: 'busy' }); setTimeout(() => conn.close(), 100); }); return;
      }
      this.operatorId = id;
      if (this.conn) this.conn.close();
      this.attach(conn);
    });
    this.peer.on('disconnected', () => {
      if (this.closed) return;
      if (!this.conn?.open) this.onStatus('disconnected', 'Канал связи прерван. Восстанови подключение.');
      if (!this.peer.destroyed) { try { this.peer.reconnect(); } catch {} }
    });
    this.peer.on('error', err => {
      const messages = {
        'peer-unavailable': 'Сеанс не найден. Проверь код и оставь большой экран открытым.',
        'unavailable-id': 'Этот код уже занят. Вернись на начальный экран и создай новый сеанс.',
        'network': 'Сервис связи недоступен. Проверь интернет и попробуй снова.',
        'server-error': 'Сервис связи временно недоступен. Попробуй снова.',
        'browser-incompatible': 'Браузер не поддерживает связь между устройствами. Используй актуальный Chrome или Safari.',
        'webrtc': 'Не удалось связать устройства. Подключи их к одной сети Wi-Fi и попробуй снова.',
      };
      this.onStatus('error', messages[err.type] || 'Не удалось установить связь. Проверь сеть и попробуй снова.');
    });
  }
  attach(conn) {
    this.conn = conn;
    conn.on('open', () => { if (this.conn === conn) this.onStatus('connected'); });
    conn.on('data', msg => { if (this.conn === conn) this.onMessage(msg); });
    conn.on('close', () => { if (!this.closed && this.conn === conn) this.onStatus('disconnected', 'Связь с другим экраном потеряна.'); });
    conn.on('error', () => { if (!this.closed && this.conn === conn) this.onStatus('error', 'Ошибка канала. Попробуй подключиться снова.'); });
    if (this.role === 'phone') {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = setTimeout(() => {
        if (!conn.open && !this.closed) this.onStatus('error', 'Подключение занимает слишком долго. Подключи устройства к одной сети Wi-Fi и попробуй снова.');
      }, 15_000);
    }
  }
  send(payload) {
    if (this.closed) return false;
    if (this.local) {
      this.bus?.postMessage({ role: this.role, room: this.room, clientId: this.clientId, target: this.role === 'host' ? this.operatorId : null, payload });
      return true;
    }
    if (!this.conn?.open) return false;
    try { this.conn.send(payload); return true; } catch { return false; }
  }
  close() {
    this.closed = true;
    clearTimeout(this.connectionTimeout);
    this.bus?.close(); this.conn?.close(); this.peer?.destroy();
  }
}
