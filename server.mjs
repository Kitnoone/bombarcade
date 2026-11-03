// Bombarcade local server: serves the game and carries commands over one WebSocket
// per device inside the local network. No cloud relay and no npm packages are used.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { exec } from 'node:child_process';
import path from 'node:path';
import { attach } from './server/ws.mjs';
import { Hub } from './server/session.mjs';
import { lanAddresses } from './server/net.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, 'public');
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

export function loadConfig(file = path.join(here, 'bombarcade.config.json')) {
  let config = {};
  try { if (existsSync(file)) config = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { console.warn('Не удалось прочитать bombarcade.config.json, использую значения по умолчанию:', error.message); }
  return {
    port: Number(process.env.PORT || config.port || 4173),
    virus: { count: Number(config.virusCount ?? 3), stepMs: Number(config.virusStepMs ?? 800) },
    openBrowser: config.openBrowser !== false,
  };
}

export function createBombarcadeServer({ virus, interfaces = () => lanAddresses(), tickMs = 20, now } = {}) {
  let port = 0;
  const hub = new Hub({ virus, now, links: () => interfaces().map(entry => ({ ...entry, port })) });
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local');
      if (url.pathname === '/api/local') {
        res.writeHead(200, { 'Content-Type': types['.json'], 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ local: true, protocol: 1, port, addresses: interfaces() }));
        return;
      }
      const name = decodeURIComponent(url.pathname);
      const target = path.resolve(root, `.${name.endsWith('/') ? name + 'index.html' : name}`);
      if (!target.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
      const bytes = await readFile(target);
      res.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      res.end(bytes);
    } catch { res.writeHead(404, { 'Content-Type': types['.txt'] }).end('Не найдено'); }
  });
  attach(server, '/ws', socket => hub.connect(socket));
  const timer = setInterval(() => hub.tick(), tickMs);
  server.on('close', () => clearInterval(timer));
  server.on('listening', () => { port = server.address().port; });
  return { server, hub };
}

function listen(server, port, attempts = 10) {
  return new Promise((resolve, reject) => {
    const tryPort = (p, left) => {
      const onError = error => {
        server.off('listening', onListening);
        if (error.code === 'EADDRINUSE' && left > 0) tryPort(p + 1, left - 1); else reject(error);
      };
      const onListening = () => { server.off('error', onError); resolve(server.address().port); };
      server.once('error', onError); server.once('listening', onListening);
      server.listen(p, '0.0.0.0');
    };
    tryPort(port, attempts);
  });
}

function openBrowser(url) {
  const command = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(command, () => {});
}

async function main() {
  const config = loadConfig();
  const args = process.argv.slice(2);
  const portArg = args.find(a => a.startsWith('--port='));
  if (portArg) config.port = Number(portArg.slice(7));
  const { server } = createBombarcadeServer({ virus: config.virus });
  let port;
  try { port = await listen(server, config.port); }
  catch (error) { console.error('\nНе удалось запустить сервер:', error.message); process.exit(1); }
  const addresses = lanAddresses();
  const hostUrl = `http://localhost:${port}/?view=host`;
  console.log('\n  BOMBARCADE · КОРАБЕЛЬНЫЙ ТЕРМИНАЛ');
  console.log('  Локальный сервер работает. Не закрывай это окно во время игры.\n');
  console.log('  Большой экран (на этом компьютере):  ' + hostUrl);
  if (addresses.length) {
    console.log('  Адреса для телефона в локальной сети:');
    for (const a of addresses) console.log(`    http://${a.address}:${port}/   ${a.name}${a.virtual ? ' (виртуальный адаптер)' : ''}${a.recommended ? '  ← рекомендуется' : ''}`);
  } else console.log('  ВНИМАНИЕ: не найден сетевой адрес. Подключи компьютер к роутеру кабелем или по Wi-Fi.');
  console.log('\n  Если телефон не открывает страницу: разреши Node.js в брандмауэре Windows для частных сетей.');
  console.log('  Остановка сервера: Ctrl+C или закрытие окна.\n');
  if (config.openBrowser && !args.includes('--no-open')) openBrowser(hostUrl);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
