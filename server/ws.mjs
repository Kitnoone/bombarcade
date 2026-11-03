// Minimal RFC 6455 WebSocket server: text frames, ping/pong, close. No npm dependencies,
// so the Windows launcher only needs Node.js and the game keeps working offline.
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 64 * 1024;

export class Socket extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket; this.buffer = Buffer.alloc(0); this.parts = []; this.open = true;
    socket.setNoDelay(true); // Small game frames go out immediately (no Nagle delay).
    socket.setKeepAlive(true, 5000);
    socket.on('data', chunk => this.receive(chunk));
    socket.on('close', () => this.finish(1006));
    socket.on('error', () => this.finish(1006));
  }
  receive(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.open) {
      const b = this.buffer;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, opcode = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      let length = b[1] & 0x7f, at = 2;
      if (length === 126) { if (b.length < 4) return; length = b.readUInt16BE(2); at = 4; }
      else if (length === 127) {
        if (b.length < 10) return;
        if (b.readUInt32BE(2) !== 0) return this.close(1009, 'too big');
        length = b.readUInt32BE(6); at = 10;
      }
      if (!masked) return this.close(1002, 'unmasked');
      if (length > MAX_MESSAGE) return this.close(1009, 'too big');
      if (b.length < at + 4 + length) return;
      const mask = b.subarray(at, at + 4), payload = Buffer.from(b.subarray(at + 4, at + 4 + length));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buffer = b.subarray(at + 4 + length);
      this.frame(fin, opcode, payload);
    }
  }
  frame(fin, opcode, payload) {
    if (opcode === 0x8) { this.close(payload.length >= 2 ? payload.readUInt16BE(0) : 1000); return; }
    if (opcode === 0x9) { this.write(0xa, payload); return; }
    if (opcode === 0xa) return;
    if (opcode === 0x1 || opcode === 0x0) {
      if (opcode === 0x1) this.parts = [];
      this.parts.push(payload);
      if (this.parts.reduce((n, p) => n + p.length, 0) > MAX_MESSAGE) return this.close(1009, 'too big');
      if (!fin) return;
      const text = Buffer.concat(this.parts).toString('utf8'); this.parts = [];
      let message;
      try { message = JSON.parse(text); } catch { return; }
      if (message && typeof message === 'object') this.emit('message', message);
      return;
    }
    this.close(1003, 'unsupported');
  }
  write(opcode, payload) {
    if (!this.open || this.socket.destroyed) return false;
    const length = payload.length;
    const head = length < 126 ? Buffer.from([0x80 | opcode, length])
      : length < 65536 ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 255])
      : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | opcode; h[1] = 127; h.writeUInt32BE(0, 2); h.writeUInt32BE(length, 6); return h; })();
    this.socket.write(Buffer.concat([head, payload]));
    return true;
  }
  send(message) { return this.write(0x1, Buffer.from(JSON.stringify(message))); }
  close(code = 1000, reason = '') {
    if (!this.open) return;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason)); payload.writeUInt16BE(code, 0); payload.write(reason, 2);
    this.write(0x8, payload);
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref();
    this.finish(code);
  }
  finish(code) {
    if (!this.open) return;
    this.open = false;
    this.emit('close', code);
  }
}

// Same-origin only: a page from another site must not drive the game from the master's browser.
export function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

export function attach(server, path, onConnection) {
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://local');
    const key = req.headers['sec-websocket-key'];
    if (url.pathname !== path || !key || String(req.headers.upgrade).toLowerCase() !== 'websocket' || !originAllowed(req)) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return;
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    onConnection(new Socket(socket), req);
  });
}
