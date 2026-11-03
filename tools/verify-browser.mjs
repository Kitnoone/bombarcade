import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createBombarcadeServer } from '../server.mjs';
import { lanAddresses } from '../server/net.mjs';
import { distances, distanceAt, hexDistance } from '../public/adventure.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = path.resolve('test-results'); await mkdir(output, { recursive: true });
let offset = 0;
const { server, hub } = createBombarcadeServer({ now: () => performance.now() + offset });
await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
const port = server.address().port;
const address = lanAddresses().find(a => a.recommended)?.address;
assert(address, 'A physical LAN adapter is required for the LAN browser check');
const base = `http://${address}:${port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-proxy-server'] });
const errors = [], external = [], checks = [], messages = [], ackMs = [], sentAt = new Map();
const contexts = [];
function check(name, value = true) { assert(value, name); checks.push(name); console.log('PASS', name); }
async function client(viewport, mobile = false) {
  const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile }); contexts.push(context);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).origin !== base) external.push(request.url()); });
  return page;
}
const host = await client({ width: 1920, height: 1080 });
const phone = await client({ width: 390, height: 844 }, true);
const waitStage = async stage => { await host.waitForFunction(s => document.body.dataset.stage === s, stage); await phone.waitForFunction(s => document.body.dataset.stage === s, stage); };
const advance = async ms => { offset += ms; await new Promise(r => setTimeout(r, 80)); };
let session;
const push = () => session.push(true);
const shot = (page, name) => page.screenshot({ path: path.join(output, name + '.png'), fullPage: true });
const waitText = (page, selector, expected) => page.waitForFunction(({selector,expected}) => document.querySelector(selector).textContent.includes(expected), {selector,expected});
try {
  await host.goto(`${base}/?view=host`); await host.waitForFunction(() => document.querySelector('#phone-link').href.includes('&key='));
  session = [...hub.sessions.values()][0];
  const url = await host.locator('#phone-link').getAttribute('href');
  check('QR URL uses physical LAN address, port, room and join key', new URL(url).hostname === address && new URL(url).searchParams.has('key'));
  check('QR is live SVG', await host.locator('#qr svg').count() === 1);
  await shot(host, 'tv-lobby');
  phone.on('websocket', socket => {
    socket.on('framesent', event => { try { const m = JSON.parse(event.payload); if (m.t === 'cmd') sentAt.set(m.n, performance.now()); } catch {} });
    socket.on('framereceived', event => { try { const m = JSON.parse(event.payload); messages.push(m); if (m.t === 'ack' && sentAt.has(m.n)) { ackMs.push(performance.now() - sentAt.get(m.n)); sentAt.delete(m.n); } } catch {} });
  });
  await phone.goto(url);
  await waitText(host, '#host-connection', 'Телефон подключён'); await waitText(phone, '#phone-connection', 'КАНАЛ АКТИВЕН');
  check('Two independent browser contexts connect over LAN HTTP');
  check('Local HTTP works without secure-context APIs', await phone.evaluate(() => !window.isSecureContext && typeof crypto.randomUUID === 'undefined'));
  check('Wake Lock is hidden on HTTP', await phone.locator('#wake-phone').isHidden());
  await shot(phone, 'phone-lobby-390');
  await host.locator('#start').click(); await waitStage('show');
  const arrows = [...session.engine.sequence];
  await shot(host, 'tv-protocol-1');
  check('Protocol I exposes nine disabled keys during the 10-second display', await phone.locator('#keypad button:visible:disabled').count() === 9 && session.engine.duration() === 10000);
  await host.locator('#pause').click();
  await host.waitForFunction(() => document.body.dataset.paused === 'true');
  const left = session.engine.remaining(); await advance(3000);
  check('Master pauses the 10-second display on both screens', session.engine.remaining() === left && await phone.evaluate(() => document.body.dataset.paused === 'true'));
  await host.locator('#pause').click(); await advance(10020); await waitStage('input');
  check('Protocol I retains 20-second input', session.engine.duration() === 20000);
  await shot(phone, 'phone-protocol-1-390');
  const layout = [...session.engine.layout];
  await phone.locator(`#keypad button[data-symbol="${arrows[0]}"]`).tap();
  await phone.waitForFunction(() => document.querySelectorAll('#phone-progress .filled').length === 1);
  check('A tap applies once and every key reshuffles', session.engine.entered.length === 1 && session.engine.layout.every((symbol,i) => symbol !== layout[i]));
  for (let i = 1; i < arrows.length; i++) {
    await phone.locator(`#keypad button[data-symbol="${arrows[i]}"]`).tap();
    if (i < arrows.length - 1) await phone.waitForFunction(n => document.querySelectorAll('#phone-progress .filled').length === n, i + 1);
  }
  await waitStage('transition'); await advance(1900); await waitStage('explore');
  check('Both screens fade into protocol II without reconnecting', session.engine.attemptsLeft() === 3);
  await shot(host, 'tv-search');
  for (const width of [360,390,430]) {
    await phone.setViewportSize({ width, height: 900 });
    await shot(phone, `phone-search-${width}`);
    const bounds = await phone.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, buttons: [...document.querySelectorAll('#movement button')].map(b => { const r = b.getBoundingClientRect(); return { x:r.x,y:r.y,w:r.width,h:r.height }; }), content: document.querySelector('.phone-terminal').getBoundingClientRect().bottom }));
    check(`Phone ${width}px has no horizontal overflow and large unobstructed controls`, bounds.scroll === bounds.width && bounds.buttons.every(b => b.x >= 0 && b.x + b.w <= bounds.width && b.w >= 55 && b.h >= 65));
  }
  await phone.setViewportSize({ width: 390, height: 844 });
  // Exercise a real chase, visibility boundary, collision and master retry through the UI.
  const e = session.engine;
  e.nodes = e.nodes.map(n => ({ ...n, col: n.target ? 16 : n.col, row: n.target ? 9 : n.row }));
  e.viruses = [{ id: 1, col: e.position.col + 3, row: e.position.row, active: false, nextAt: 0, left: 0 }];
  push();
  await phone.locator('[data-direction="→"]').tap();
  await host.waitForFunction(() => !document.querySelector('#virus-warning').hidden);
  check('Virus is detected at the two-hex boundary', e.viruses[0].active && hexDistance(e.viruses[0],e.position) === 2);
  await shot(host, 'tv-virus-alert');
  await shot(phone, 'phone-alarm-390');
  await host.locator('#pause').click(); await host.waitForFunction(() => document.body.dataset.paused === 'true');
  await shot(host, 'tv-pause');
  const frozenPosition = { ...e.viruses[0] }; await advance(2000);
  check('Pause freezes the chase without spending attempts', e.viruses[0].col === frozenPosition.col && e.attemptsLeft() === 3);
  await host.locator('#pause').click();
  for (let i = 0; i < 2; i++) await phone.locator('[data-direction="←"]').tap();
  await host.waitForFunction(() => document.querySelectorAll('.field-viruses .virus').length === 0);
  const before = e.viruses[0].col; await advance(810);
  check('Virus continues pursuing outside visibility', e.viruses[0].col < before);
  await advance(5000);
  for (let i = 0; i < 12 && e.stage === 'explore'; i++) await advance(810);
  await waitStage('failure');
  check('Virus collision costs exactly one attempt', e.attemptsLeft() === 2);
  await waitText(phone, '#phone-instruction', 'Зонд захвачен');
  await shot(host, 'tv-failure'); await shot(phone, 'phone-failure-390');
  await host.locator('#start').click(); await waitStage('explore');
  check('Retry restarts protocol II directly', e.protocol === 2 && e.attemptNumber() === 2 && e.entered.length === 0);
  // The ordinary in-process engine supplies a deterministic no-threat route for code UI checks.
  e.viruses = []; push();
  const target = e.nodes.find(n => n.target), dist = distances(target);
  while (e.stage === 'explore' && distanceAt(dist,e.position) > 0) {
    const options = { '↑':[0,-1], '↓':[0,1], '←':[-1,0], '→':[1,0] };
    const direction = Object.keys(options).find(k => { const [dc,dr] = options[k]; const p = { col:e.position.col+dc,row:e.position.row+dr }; return p.col>=0 && p.col<18 && p.row>=0 && p.row<12 && distanceAt(dist,p) === distanceAt(dist,e.position)-1; });
    const old = e.layoutVersion; await phone.locator(`[data-direction="${direction}"]`).tap();
    await host.waitForFunction(v => document.querySelector('#field').dataset.position !== v, `${e.position.col - options[direction][0]}:${e.position.row - options[direction][1]}`);
    assert(e.layoutVersion > old);
  }
  await waitStage('show'); const digits = [...e.sequence];
  await shot(host, 'tv-code');
  const virusSnapshot = JSON.stringify(e.viruses); await advance(10020); await waitStage('input');
  check('Protocol II input and timer progress use 40 seconds', e.duration() === 40000 && await phone.locator('#phone-instruction').textContent().then(t => t.includes('40 секунд')) && await phone.locator('#phone-timer-bar').evaluate(el => parseFloat(el.style.width) > 95));
  await shot(phone, 'phone-code-390');
  for (let i = 0; i < digits.length; i++) {
    await phone.locator(`#keypad button[data-symbol="${digits[i]}"]`).tap();
    if (i < digits.length - 1) await phone.waitForFunction(n => document.querySelectorAll('#phone-progress .filled').length === n, i + 1);
  }
  await waitStage('success'); check('Correct eight-digit code completes both screens', JSON.stringify(e.viruses) === virusSnapshot);
  await shot(host, 'tv-success'); await shot(phone, 'phone-success-390');
  await host.locator('#master-toggle').click(); await host.locator('#restart').click(); await waitStage('lobby');
  e.startSearch(); push(); await waitStage('explore');
  for (let i = 0; i < 3; i++) {
    e.fail(i === 0 ? 'symbol' : 'timeout'); push();
    await waitStage(i === 2 ? 'lost' : 'failure');
    if (i < 2) { await host.locator('#start').click(); await waitStage('explore'); }
  }
  check('Third defeat locks normal retry and input', e.attemptsLeft() === 0 && await host.locator('#start').isDisabled() && await phone.locator('#movement').isHidden());
  await shot(host, 'tv-lost'); await shot(phone, 'phone-lost-390');
  await host.locator('#master-toggle').click(); await host.locator('#restart').click(); await waitStage('lobby');
  e.startSearch(); push(); await waitStage('explore');
  await phone.reload(); await phone.waitForFunction(() => document.body.dataset.paused === 'true');
  check('Phone reload reconnects its identity and pauses without costing an attempt', e.paused && e.attemptsLeft() === 3);
  await host.locator('#pause').click(); await phone.waitForFunction(() => document.body.dataset.paused === 'false');
  await host.locator('#master-toggle').click(); await shot(host, 'tv-master-panel');
  const phoneRttMs = session.rtt;
  await host.locator('#release-phone').click(); await waitText(phone, '#phone-error', 'отвязал');
  check('Master can release the phone');
  check('Phone WebSocket snapshots contain no map, coordinates, viruses or solution', messages.filter(m => m.t === 'state').length > 20 && messages.filter(m => m.t === 'state').every(m => ['nodes','viruses','position','sequence','contact'].every(k => !(k in m.s))));
  check('LAN game makes no external network requests', external.length === 0);
  check('Both clients have no JavaScript errors', errors.length === 0);
  const sorted = ackMs.toSorted((a,b) => a-b);
  const commandAck = { samples: sorted.length, medianMs: +sorted[Math.floor(sorted.length / 2)].toFixed(2), p95Ms: +sorted[Math.floor(sorted.length * .95)].toFixed(2), maxMs: +sorted.at(-1).toFixed(2) };
  await writeFile(path.join(output,'browser-report.json'), JSON.stringify({ base, checks, errors, external, phoneRttMs, commandAck, screenshots:'test-results/*.png', physicalPhone:false, measurement:'Chrome contexts on the same computer using its LAN IPv4 address; not a Wi-Fi measurement' },null,2));
  console.log(`Completed ${checks.length} browser checks; screenshots: ${output}`);
} catch (error) {
  await shot(host,'debug-host'); await shot(phone,'debug-phone'); console.error('Browser errors:',errors); throw error;
} finally {
  for (const context of contexts) await context.close();
  await browser.close(); for (const s of hub.sessions.values()) s.close();
  await new Promise(resolve => server.close(resolve)); server.closeAllConnections?.();
}
