const ROOM = /^[A-Z0-9]{6}$/;
const TOKEN = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9-]{8,100}$/;
const TTL = 2 * 60 * 60 * 1000;
const ALLOWED = new Set(['https://kitnoone.github.io', 'https://bombarcade-relay.kittyty.chatgpt.site']);
export class RelayError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
async function hash(token) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function body(req) {
  const reader = req.body?.getReader(); let bytes = 0, chunks = [];
  if (!reader) throw new RelayError(400, 'Пустой запрос.');
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    bytes += value.length;
    if (bytes > 8192) { await reader.cancel(); throw new RelayError(413, 'Запрос слишком большой.'); }
    chunks.push(value);
  }
  const all = new Uint8Array(bytes); let at = 0;
  for (const chunk of chunks) { all.set(chunk, at); at += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(all)); } catch { throw new RelayError(400, 'Неверный формат запроса.'); }
}
function requireToken(token) { if (!TOKEN.test(token || '')) throw new RelayError(403, 'Нет доступа к сеансу.'); }
function packetValid(packet) {
  if (!packet || typeof packet !== 'object') return false;
  if (['hello', 'ping'].includes(packet.kind)) return true;
  return ['key', 'move'].includes(packet.kind) &&
    (packet.kind === 'move' ? ['↑', '↓', '←', '→'] : ['↑', '↓', '←', '→', 'Æ', 'Œ', 'Þ', 'Ð', 'Ƶ', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9']).includes(packet.symbol) &&
    ['round', 'layoutVersion', 'command'].every(k => Number.isSafeInteger(packet[k]) && packet[k] >= 0);
}
export async function relayRequest(req, db, now = Date.now()) {
  const origin = req.headers.get('Origin');
  const allowed = !origin || ALLOWED.has(origin) || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Vary': 'Origin',
    ...(origin && allowed ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Bomb-Token', 'Access-Control-Max-Age': '3600',
  };
  const respond = (value, status = 200) => new Response(JSON.stringify(value), { status, headers });
  if (!allowed) return respond({ error: 'Этот сайт не имеет доступа к игровому каналу.' }, 403);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  const url = new URL(req.url);
  if (url.pathname === '/api/relay/health' && req.method === 'GET') return respond({ ok: true, protocol: 2 });
  try {
    if (!db) throw new RelayError(503, 'Сервер сеансов временно недоступен.');
    if (req.method === 'POST' && url.pathname === '/api/relay/create') {
      const { room, token } = await body(req); requireToken(token);
      if (!ROOM.test(room || '')) throw new RelayError(400, 'Неверный код сеанса.');
      const digest = await hash(token);
      await db.prepare('DELETE FROM relay_rooms WHERE expires < ?').bind(now).run();
      await db.prepare('INSERT OR IGNORE INTO relay_rooms (code, host_hash, host_seen, expires) VALUES (?, ?, ?, ?)').bind(room, digest, now, now + TTL).run();
      const found = await db.prepare('SELECT host_hash FROM relay_rooms WHERE code = ?').bind(room).first();
      if (found?.host_hash !== digest) throw new RelayError(409, 'Этот код уже занят. Создай новый сеанс на начальном экране.');
      return respond({ ok: true });
    }
    const match = url.pathname.match(/^\/api\/relay\/([A-Z0-9]{6})\/(join|host|phone|state|event)$/);
    if (!match) throw new RelayError(404, 'Адрес не найден.');
    const [, code, action] = match;
    const row = await db.prepare('SELECT * FROM relay_rooms WHERE code = ? AND expires > ?').bind(code, now).first();
    if (!row) throw new RelayError(404, 'Сеанс не найден. Проверь код и оставь большой экран открытым.');
    if (req.method === 'POST' && action === 'join') {
      const { clientId, token, requestId } = await body(req); requireToken(token);
      if (!ID.test(clientId || '') || !ID.test(requestId || '')) throw new RelayError(400, 'Неверный идентификатор консоли.');
      const digest = await hash(token);
      const update = await db.prepare('UPDATE relay_rooms SET client_id = ?, phone_hash = ?, phone_seen = ? WHERE code = ? AND (client_id IS NULL OR (client_id = ? AND phone_hash = ?))').bind(clientId, digest, now, code, clientId, digest).run();
      if (!update.meta.changes) throw new RelayError(409, 'К сеансу уже привязана другая консоль. Создай новый сеанс для нового телефона.');
      await db.prepare('INSERT OR IGNORE INTO relay_events (room, request_id, packet) VALUES (?, ?, ?)').bind(code, requestId, '{"kind":"hello"}').run();
      return respond({ ok: true });
    }
    const rawToken = req.headers.get('X-Bomb-Token'); requireToken(rawToken);
    const digest = await hash(rawToken);
    const hostAction = ['host', 'state'].includes(action);
    if (digest !== (hostAction ? row.host_hash : row.phone_hash)) throw new RelayError(403, 'Нет доступа к этой консоли.');
    if (action === 'host' && req.method === 'GET') {
      const after = Math.max(0, Number(url.searchParams.get('after')) || 0);
      await db.prepare('UPDATE relay_rooms SET host_seen = ?, expires = ? WHERE code = ?').bind(now, now + TTL, code).run();
      const events = await db.prepare('SELECT id, packet FROM relay_events WHERE room = ? AND id > ? ORDER BY id LIMIT 100').bind(code, after).all();
      if (after) await db.prepare('DELETE FROM relay_events WHERE room = ? AND id <= ?').bind(code, after).run();
      return respond({ serverNow: now, phoneSeen: row.phone_seen, events: events.results.map(e => ({ id: e.id, packet: JSON.parse(e.packet) })) });
    }
    if (action === 'phone' && req.method === 'GET') {
      await db.prepare('UPDATE relay_rooms SET phone_seen = ? WHERE code = ?').bind(now, code).run();
      const packet = row.packet ? JSON.parse(row.packet) : null;
      if (packet?.state && !packet.state.paused) packet.state.remainingMs = Math.max(0, packet.state.remainingMs - Math.max(0, now - row.packet_at));
      return respond({ serverNow: now, hostSeen: row.host_seen, packet });
    }
    if (action === 'state' && req.method === 'POST') {
      const packet = await body(req);
      if (packet.kind !== 'state' || !packet.state || 'sequence' in packet.state || !Number.isFinite(packet.state.remainingMs)) throw new RelayError(400, 'Неверное состояние испытания.');
      await db.prepare('UPDATE relay_rooms SET packet = ?, packet_at = ?, host_seen = ?, expires = ? WHERE code = ?').bind(JSON.stringify(packet), now, now, now + TTL, code).run();
      return respond({ ok: true });
    }
    if (action === 'event' && req.method === 'POST') {
      const { packet, requestId } = await body(req);
      if (!packetValid(packet) || typeof requestId !== 'string' || requestId.length > 150 || requestId.length < 8) throw new RelayError(400, 'Неверная команда.');
      await db.prepare('INSERT OR IGNORE INTO relay_events (room, request_id, packet) VALUES (?, ?, ?)').bind(code, requestId, JSON.stringify(packet)).run();
      await db.prepare('UPDATE relay_rooms SET phone_seen = ? WHERE code = ?').bind(now, code).run();
      return respond({ ok: true });
    }
    throw new RelayError(405, 'Метод не поддерживается.');
  } catch (error) {
    if (error instanceof RelayError) return respond({ error: error.message }, error.status);
    console.error('Relay storage error:', error);
    return respond({ error: 'Сервер сеансов временно недоступен. Попробуй снова.' }, 503);
  }
}
