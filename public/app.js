import { SYMBOLS } from './game.js';
import { DIGITS } from './adventure.js';
import { renderField } from './field.js';
import { ROOM_PATTERN } from './link.js';
import { randomToken } from './identity.js';
import { detectLocal, SocketConnection, BrowserConnection } from './transport.js';

const $ = id => document.getElementById(id);
const text = (id, value) => { const node = $(id); if (node.textContent !== String(value)) node.textContent = value; };
const show = (id, visible) => { $(id).hidden = !visible; };
const params = new URLSearchParams(location.search);
let role = params.get('view') || 'home';
let room = (params.get('room') || '').toUpperCase();
const demo = params.get('transport') === 'local';
const joinKey = params.get('key') || '';
const isLocal = !demo && await detectLocal();
let connection, state, receivedAt = 0, online = false, previousPhase = '', settingsLoaded = false;
let links = [], selectedUrl = '', alertSeen = 0, warningUntil = 0, command = 0, wakeLock;
const stream = randomToken(16), inFlight = new Map();

function route(view, code = '', key = '') {
  const url = new URL(location.href); url.search = ''; url.hash = '';
  url.searchParams.set('view', view);
  if (code) url.searchParams.set('room', code);
  if (key) url.searchParams.set('key', key);
  if (demo) url.searchParams.set('transport', 'local');
  return url;
}
function status(id, message, good) { text(id, message); $(id).classList.toggle('online', !!good); }
function remaining() { return state ? Math.max(0, state.remainingMs - (state.paused ? 0 : performance.now() - receivedAt)) : 0; }
function seconds(ms) { return String(Math.ceil(ms / 1000)).padStart(2, '0'); }
function active(s = state) { return s && ['show', 'input', 'transition', 'explore'].includes(s.stage); }
function sendMaster(action, extra = {}) { connection?.send({ t: 'master', action, ...extra }); }
function notify(message) { text('announcement', message); }

let sound = false, audio;
function beep(kind = 'key') {
  if (!sound) return;
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)(); audio.resume();
    const oscillator = audio.createOscillator(), gain = audio.createGain();
    oscillator.frequency.value = { failure: 130, lost: 100, success: 1100, show: 540, key: 760 }[kind] || 600;
    gain.gain.setValueAtTime(.045, audio.currentTime); gain.gain.exponentialRampToValueAtTime(.001, audio.currentTime + .16);
    oscillator.connect(gain); gain.connect(audio.destination); oscillator.start(); oscillator.stop(audio.currentTime + .17);
  } catch {}
}
$('sound').onclick = () => { sound = !sound; $('sound').setAttribute('aria-pressed', sound); text('sound', `Звук: ${sound ? 'вкл.' : 'выкл.'}`); beep(); };
let reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
try { reduced = localStorage.getItem('bombarcade-effects') === 'reduced' || reduced; } catch {}
function applyEffects() { document.body.classList.toggle('reduced-effects', reduced); $('effects').setAttribute('aria-pressed', reduced); }
applyEffects();
$('effects').onclick = () => { reduced = !reduced; applyEffects(); try { localStorage.setItem('bombarcade-effects', reduced ? 'reduced' : 'full'); } catch {} };
$('fullscreen').onclick = async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch { notify('Полноэкранный режим недоступен.'); } };
show('fullscreen', !!document.documentElement.requestFullscreen);
$('create').onclick = () => location.assign(route('host'));
$('demo').onclick = () => { const url = route('host'); url.searchParams.set('transport', 'local'); location.assign(url); };
$('join-form').onsubmit = event => { event.preventDefault(); const code = $('room-input').value.trim().toUpperCase(); if (ROOM_PATTERN.test(code)) location.assign(route('phone', code, $('join-key').value.trim())); };
$('room-input').oninput = event => { event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); };
text('transport-description', isLocal ? 'Корабельный сервер в локальной сети. Подключи компьютер и телефон к одному роутеру: игра работает без интернета.' : 'Наблюдатель видит код и карту. Оператор управляет с телефона. Интернет-режим соединяет устройства через ретранслятор.');
show('join-key', isLocal); show('join-key-label', isLocal);

function updateLink() {
  const item = links[Number($('address-select').value) || 0];
  selectedUrl = item?.url || '';
  $('phone-link').href = selectedUrl || '#'; text('phone-link', selectedUrl);
  const qr = window.qrcode?.(0, 'M');
  $('qr').replaceChildren();
  if (qr && selectedUrl) { qr.addData(selectedUrl); qr.make(); $('qr').innerHTML = qr.createSvgTag({ cellSize: 5, margin: 12, scalable: true }); }
  show('qr', !!selectedUrl && !demo);
}
$('address-select').onchange = updateLink;
$('phone-link').onclick = event => { if (demo) { event.preventDefault(); window.open(selectedUrl, '_blank', 'popup,width=430,height=850,noopener'); } };
$('copy-link').onclick = async () => {
  if (!selectedUrl) return;
  let ok = false;
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(selectedUrl); ok = true; } } catch {}
  if (!ok) {
    const area = document.createElement('textarea'); area.value = selectedUrl; area.style.cssText = 'position:fixed;left:-9999px'; document.body.append(area); area.select();
    try { ok = document.execCommand('copy'); } catch {} area.remove();
  }
  text('copy-link', ok ? 'Ссылка скопирована' : 'Выдели и скопируй ссылку выше');
};
function welcome(m) {
  room = m.room; text('room-code', room); text('toolbar-room', room); text('phone-room', room);
  history.replaceState(null, '', route(role, room, role === 'phone' ? joinKey : ''));
  if (role !== 'host') return;
  const oldUrl = selectedUrl; links = m.links || [];
  $('address-select').replaceChildren(...links.map((item, i) => {
    const option = document.createElement('option'); option.value = i;
    option.textContent = `${item.name}${item.address ? ' · ' + item.address : ''}${item.recommended ? ' · рекомендуется' : ''}${item.virtual ? ' · виртуальный адаптер' : ''}`;
    return option;
  }));
  const oldIndex = links.findIndex(item => item.url === oldUrl); if (oldIndex >= 0) $('address-select').value = oldIndex;
  updateLink(); show('address-select', links.length > 1); show('address-label', links.length > 1);
  text('lobby-instructions', demo ? 'Открой консоль в отдельном окне этого браузера. Держи оба окна видимыми.' : isLocal ? 'Компьютер и телефон должны быть доступны друг другу через один роутер. Отсканируй QR-код.' : 'Отсканируй QR-код или введи код сеанса на этом же сайте.');
  text('network-help', isLocal ? links.length ? 'Если страница не открывается: выбери другой сетевой адрес и разреши Node.js в брандмауэре для частной сети.' : 'Сетевой адрес не найден. Подключи компьютер к роутеру и перезапусти сервер.' : demo ? 'Проверка в одном браузере · BroadcastChannel' : 'Интернет-режим · HTTPS-ретранслятор');
}

const phases = { lobby: 'ОЖИДАНИЕ', show: 'СЧИТЫВАНИЕ', input: 'ВВОД КОДА', explore: 'ЗОНД АКТИВЕН', transition: 'ПЕРЕХОД', failure: 'СБОЙ', lost: 'ДОСТУП ЗАКРЫТ', success: 'ПОДТВЕРЖДЕНО' };
function validState(s) {
  if (!s || !Object.hasOwn(phases, s.stage) || ![1, 2].includes(s.protocol) || typeof s.paused !== 'boolean' || !Number.isFinite(s.remainingMs) || !Number.isFinite(s.durationMs) || !Number.isInteger(s.round) || !Number.isInteger(s.layoutVersion)) return false;
  if (role === 'host') return Array.isArray(s.nodes) && Array.isArray(s.viruses) && Array.isArray(s.sequence);
  const symbols = s.protocol === 2 ? DIGITS : SYMBOLS;
  return Array.isArray(s.layout) && s.layout.length === symbols.length && new Set(s.layout).size === symbols.length && s.layout.every(k => symbols.includes(k)) && Array.isArray(s.entered) && s.entered.length <= s.length && s.entered.every(k => symbols.includes(k));
}
function receive(m) {
  if (m.t === 'welcome') welcome(m);
  if (m.t === 'ack') {
    if (m.cumulative) for (const n of inFlight.keys()) { if (n <= m.n) inFlight.delete(n); }
    else inFlight.delete(m.n);
    render();
  }
  if (m.t === 'result') {
    text('host-error', m.ok ? '' : m.message || 'Команда сейчас недоступна.');
    if (m.action === 'settings' && m.ok) { settingsLoaded = false; text('settings-note', 'Настройки применены. Новая расстановка создаётся при запуске поиска.'); }
  }
  if (m.t !== 'state' || !validState(m.s)) return;
  if (state && (m.s.round < state.round || m.s.round === state.round && m.s.layoutVersion < state.layoutVersion)) return;
  if (state && m.s.round !== state.round) inFlight.clear();
  state = m.s; receivedAt = performance.now();
  render();
}
function networkStatus(statusName, message = '') {
  online = ['connected', 'ready'].includes(statusName);
  if (!online) inFlight.clear();
  if (role === 'host') text('host-error', message);
  else { text('phone-error', message); show('reconnect-phone', ['disconnected', 'error'].includes(statusName)); }
  render();
}
function createConnection() {
  connection?.close(); inFlight.clear(); online = false;
  const options = { role, room, joinKey, demo, onMessage: receive, onStatus: networkStatus };
  connection = isLocal ? new SocketConnection(options) : new BrowserConnection(options);
}

function sequence(symbols) {
  const node = $('sequence'), signature = symbols.join(',');
  if (node.dataset.signature === signature) return;
  node.dataset.signature = signature;
  node.style.setProperty('--tiles', Math.min(symbols.length, 8));
  node.replaceChildren(...symbols.map((symbol, i) => {
    const tile = document.createElement('div'); tile.className = 'sequence-tile';
    const glyph = document.createElement('span'); glyph.textContent = symbol;
    const index = document.createElement('small'); index.textContent = String(i + 1).padStart(2, '0'); tile.append(glyph, index); return tile;
  }));
}
function progress(id, count, entered, reveal = false) {
  const node = $(id), signature = `${count}/${entered.join(',')}/${reveal}`;
  if (node.dataset.signature === signature) return;
  node.dataset.signature = signature;
  node.replaceChildren(...Array.from({ length: count }, (_, i) => {
    const slot = document.createElement('span'); slot.className = 'progress-slot' + (i < entered.length ? ' filled' : '');
    slot.textContent = i < entered.length ? reveal ? entered[i] : '◆' : '·'; return slot;
  }));
}
const reasons = { caught: 'Зонд захвачен вирусом.', timeout: 'Время на ввод истекло.', symbol: 'Введён неверный символ.' };
function attemptLabel(s) { return s.protocol === 2 ? `ПОПЫТКА ${s.attempt} / ${s.attemptsTotal}` : 'ПРОТОКОЛ I / МНЕМОНИЧЕСКИЙ ШЛЮЗ'; }
function phaseEffects() {
  const signature = `${state.round}:${state.stage}`;
  document.body.dataset.stage = state.stage; document.body.dataset.protocol = state.protocol; document.body.dataset.paused = state.paused;
  if (signature !== previousPhase) {
    previousPhase = signature; notify(phases[state.stage]); beep(state.stage);
    if (['failure', 'lost'].includes(state.stage)) {
      document.body.classList.remove('defeat-flash'); void document.body.offsetWidth; document.body.classList.add('defeat-flash');
      try { navigator.vibrate?.([80, 40, 120]); } catch {}
    }
  }
  const alert = role === 'host' ? state.alert : state.alarm;
  if (alert < alertSeen) { alertSeen = alert; warningUntil = 0; }
  if (alert > alertSeen) { alertSeen = alert; warningUntil = performance.now() + 3000; }
}
function renderHost() {
  status('host-connection', online ? state?.link.phone ? 'Телефон подключён' : 'Ожидание телефона' : 'Нет связи с сервером', online && state?.link.phone);
  if (!state) return;
  const { stage, protocol, paused } = state, second = protocol === 2, timed = ['show', 'input'].includes(stage), ms = remaining();
  phaseEffects();
  text('protocol-title', second ? 'ПРОТОКОЛ II / ПОИСК УЗЛА' : 'ПРОТОКОЛ I / МНЕМОНИЧЕСКИЙ ШЛЮЗ');
  text('host-phase', paused ? 'ПАУЗА' : phases[stage]); text('attempt', attemptLabel(state) + (second ? ` · ОСТАЛОСЬ ${state.attemptsLeft}` : ''));
  const titles = { lobby: 'Ожидание оператора', show: second ? 'Целевой узел найден: запомни цифры' : 'Запомни последовательность стрелок', input: 'Передавай код по памяти', explore: 'Цель: янтарный ромб ◇', transition: 'Первый шлюз открыт', failure: 'Попытка прервана', lost: 'Три попытки исчерпаны', success: 'Доступ подтверждён' };
  text('host-title', titles[stage]); text('host-timer', timed ? seconds(ms) : '—');
  text('host-timer-label', paused ? 'ПАУЗА' : timed ? `${stage === 'show' ? 'ПОКАЗ' : 'ВВОД'} / ${state.durationMs / 1000} СЕК.` : stage === 'explore' ? 'ОБЗОР / 2 ГЕКСА' : 'ДО ЗАПУСКА');
  $('host-timer-bar').style.width = `${timed ? Math.min(100, ms / state.durationMs * 100) : 0}%`;
  $('host-timer').classList.toggle('urgent', stage === 'input' && ms < 5000 && !paused);
  show('lobby-content', stage === 'lobby'); show('sequence-zone', stage === 'show'); show('input-zone', stage === 'input'); show('transition-zone', stage === 'transition');
  show('field-zone', second && ['explore', 'show', 'input'].includes(stage)); show('result-zone', ['failure', 'lost', 'success'].includes(stage));
  sequence(stage === 'show' ? state.sequence : []);
  if (stage === 'input') progress('host-progress', state.length, state.entered);
  if (second && ['explore', 'show', 'input'].includes(stage)) {
    renderField($('field'), state); text('field-contact', state.contact); text('probe-position', `ЗОНД ${String(state.position.col + 1).padStart(2, '0')}:${String(state.position.row + 1).padStart(2, '0')}`);
  }
  if (['failure', 'lost', 'success'].includes(stage)) {
    text('result-mark', stage === 'success' ? '✓' : '×'); text('result-title', stage === 'success' ? 'Оба протокола подтверждены' : stage === 'lost' ? 'Доступ окончательно закрыт' : 'Попытка прервана');
    text('result-text', stage === 'success' ? 'Система разблокирована. Дальнейшие действия определяет мастер.' : (reasons[state.reason] || 'Протокол отклонён.') + (stage === 'lost' ? ' Новый полный запуск доступен в панели мастера.' : ' Повтор запускает мастер.'));
    text('result-attempts', second && stage !== 'success' ? `ОСТАЛОСЬ ПОПЫТОК: ${state.attemptsLeft} / ${state.attemptsTotal}` : '');
  }
  show('host-paused', paused || !online && active());
  text('pause-explanation', !online ? 'Связь с локальным сервером прервана. Ожидаем переподключения.' : state.pauseReason === 'connection' ? 'Телефон отключился. После восстановления связи нажми «Продолжить».' : state.pauseReason === 'host' ? 'Большой экран переподключился. Продолжи испытание, когда оба оператора готовы.' : 'Таймер и вирусы остановлены.');
  $('start').disabled = !online || !state.link.phone || active() || ['lost', 'success'].includes(stage);
  text('start', stage === 'failure' ? second ? 'Повторить этап' : 'Повторить испытание' : 'Начать испытание');
  $('pause').disabled = !online || !active() || paused && !state.link.phone; text('pause', paused ? 'Продолжить' : 'Пауза');
  $('retry').disabled = !online || !state.link.phone || !second || stage !== 'failure';
  $('restart').disabled = !online; $('release-phone').disabled = !online || !state.link.claimed;
  show('release-phone', isLocal); $('length').disabled = active();
  const settingsDisabled = !online || second && active();
  for (const id of ['virus-count', 'virus-speed', 'save-settings']) $(id).disabled = settingsDisabled;
  if (!settingsLoaded) { $('virus-count').value = state.virusConfig.count; $('virus-speed').value = state.virusConfig.stepMs; settingsLoaded = true; }
  show('virus-warning', performance.now() < warningUntil && stage === 'explore' && !paused);
  const rtt = state.link.rtt === null || state.link.rtt === undefined ? '—' : `${state.link.rtt} МС`;
  text('host-status', `ДИАГНОСТИКА: ЗОНД-712  //  ${second ? `ПОПЫТКА ${state.attempt}/3` : 'MNEMO-01'}  //  ШУМ: НОРМА  //  КАНАЛ: ${isLocal ? 'ЛОКАЛЬНЫЙ' : demo ? 'ПРОВЕРКА' : 'ИНТЕРНЕТ'}  //  RTT: ${rtt}  //  ${paused ? 'ПАУЗА' : phases[stage]}`);
}

function feedback(button) {
  button.classList.remove('pressed'); void button.offsetWidth; button.classList.add('pressed'); setTimeout(() => button.classList.remove('pressed'), 170);
}
function bindKey(button, callback) {
  button.addEventListener('pointerdown', event => { if (event.button !== 0 || button.disabled) return; event.preventDefault(); feedback(button); callback(); });
  button.addEventListener('click', event => { if (event.detail === 0 && !button.disabled) { feedback(button); callback(); } });
}
const keys = Array.from({ length: 10 }, () => {
  const key = document.createElement('button'); key.className = 'key'; key.type = 'button'; key.disabled = true;
  const span = document.createElement('span'); key.append(span); bindKey(key, () => press(key.dataset.symbol)); return key;
});
$('keypad').append(...keys);
const moves = [...document.querySelectorAll('[data-direction]')];
for (const key of moves) bindKey(key, () => press(key.dataset.direction, 'move'));
function press(symbol, kind = 'key') {
  if (!online || !state || state.paused || !state.link.host) return;
  if (kind === 'move' ? state.stage !== 'explore' || inFlight.size >= 3 : state.stage !== 'input' || remaining() <= 0 || inFlight.size > 0) return;
  const n = ++command; inFlight.set(n, performance.now());
  const sent = connection.send({ t: 'cmd', stream, n, kind, symbol, round: state.round, layoutVersion: state.layoutVersion });
  if (!sent) { inFlight.delete(n); networkStatus('disconnected', 'Команда не отправлена. Восстанавливаем связь.'); }
  else { beep(); try { navigator.vibrate?.(10); } catch {} }
  renderPhone();
}
function renderPhone() {
  const stage = state?.stage || 'lobby', second = state?.protocol === 2, timed = ['show', 'input'].includes(stage), ms = remaining();
  const linked = online && state?.link.host;
  status('phone-connection', linked ? 'КАНАЛ АКТИВЕН' : 'НЕТ СВЯЗИ', linked);
  if (state) phaseEffects();
  text('phone-protocol', second ? 'NODUS / 02' : 'MNEMO / 01'); text('phone-phase', state?.paused ? 'ПАУЗА' : phases[stage]);
  text('phone-attempt', state ? second ? `${attemptLabel(state)} · ОСТ. ${state.attemptsLeft}` : 'ПРОТОКОЛ I' : '');
  text('phone-timer', timed ? seconds(ms) : '—'); $('phone-timer').classList.toggle('urgent', stage === 'input' && ms < 5000 && !state?.paused);
  $('phone-timer-bar').style.width = `${timed && state ? Math.min(100, ms / state.durationMs * 100) : 0}%`;
  const controls = linked && !state.paused;
  const layout = state?.layout || SYMBOLS;
  show('movement', second && stage === 'explore'); show('phone-radar', stage === 'explore' || stage === 'lobby');
  show('keypad', ['show', 'input'].includes(stage)); show('phone-progress', ['show', 'input'].includes(stage)); show('phone-transition', stage === 'transition');
  $('keypad').classList.toggle('numeric', second); $('keypad').setAttribute('aria-label', second ? 'Цифровая клавиатура' : 'Клавиатура 3 на 3');
  keys.forEach((key, i) => {
    const symbol = layout[i]; key.hidden = symbol === undefined;
    key.firstChild.textContent = symbol || ''; key.dataset.symbol = symbol || '';
    key.setAttribute('aria-label', second ? 'Цифра ' + symbol : ({ '↑': 'Вверх', '↓': 'Вниз', '←': 'Влево', '→': 'Вправо' }[symbol] || 'Глиф ' + symbol));
    key.disabled = !controls || stage !== 'input' || ms <= 0 || inFlight.size > 0;
  });
  moves.forEach(key => { key.disabled = !controls || stage !== 'explore' || inFlight.size >= 3; });
  progress('phone-progress', state?.length || 8, state?.entered || [], true);
  text('phone-counter', stage === 'explore' ? 'ЗОНД / УПРАВЛЕНИЕ' : `${String(state?.entered.length || 0).padStart(2, '0')} / ${String(state?.length || 8).padStart(2, '0')}`);
  let title = 'Ожидание запуска', instruction = 'Когда оба игрока готовы, мастер запускает испытание на телевизоре.';
  if (!linked) { title = 'Соединение с кораблём'; instruction = 'Оставь телевизионный экран открытым. Ожидаем подключения.'; }
  else if (state.paused) { title = 'Система на паузе'; instruction = 'Таймер и угрозы остановлены. Продолжение подтверждает мастер.'; }
  else if (stage === 'explore') { title = 'Поисковый зонд'; instruction = 'Слушай наблюдателя. Одно нажатие — один шаг.'; }
  else if (stage === 'show') { title = 'Слушай наблюдателя'; instruction = second ? 'Восемь цифр показаны только на телевизоре. 10 секунд на запоминание.' : 'Стрелки видит только наблюдатель. Клавиши пока заблокированы.'; }
  else if (stage === 'input') { title = second ? 'Введи код узла' : 'Введи последовательность'; instruction = second ? '40 секунд. Восемь цифр в порядке, который передаёт наблюдатель.' : '20 секунд. После нажатия все девять клавиш меняют места.'; }
  else if (stage === 'transition') { title = 'Первый шлюз открыт'; instruction = 'Подключение поискового зонда…'; }
  else if (stage === 'success') { title = 'Доступ подтверждён'; instruction = 'Оба протокола пройдены. Дождись указаний мастера.'; }
  else if (stage === 'failure' || stage === 'lost') { title = stage === 'lost' ? 'Доступ закрыт' : 'Попытка прервана'; instruction = (reasons[state.reason] || 'Ошибка протокола.') + (second ? ` Осталось попыток: ${state.attemptsLeft} / 3.` : '') + (stage === 'lost' ? ' Новый полный запуск доступен мастеру.' : ' Повтор запускает мастер.'); }
  text('phone-title', title); text('phone-instruction', instruction);
  text('key-state', inFlight.size ? 'ПЕРЕДАЧА…' : !controls ? 'УПРАВЛЕНИЕ ЗАКРЫТО' : stage === 'explore' ? 'ДВИЖЕНИЕ РАЗРЕШЕНО' : stage === 'input' ? 'ВВОД РАЗРЕШЁН' : 'ОЖИДАНИЕ');
  text('phone-help', second ? 'Карта, координаты и цель доступны наблюдателю. Направление узнавай по голосу.' : 'Вводи только стрелки. Остальные пять символов служат помехой.');
  show('phone-alarm', stage === 'explore' && performance.now() < warningUntil && !state?.paused);
}
function render() { if (role === 'host') renderHost(); else if (role === 'phone') renderPhone(); }
function panel(open) { show('master-panel', open); $('master-toggle').setAttribute('aria-expanded', open); }
$('master-toggle').onclick = () => panel($('master-panel').hidden); $('master-close').onclick = () => panel(false);
$('start').onclick = () => { if (!$('start').disabled) sendMaster(state?.protocol === 2 && state.stage === 'failure' ? 'retry' : 'start', { length: Number($('length').value) }); };
$('pause').onclick = () => { if (!$('pause').disabled) sendMaster(state?.paused ? 'resume' : 'pause'); };
$('retry').onclick = () => sendMaster('retry'); $('restart').onclick = () => { sendMaster('restart'); panel(false); };
$('release-phone').onclick = () => sendMaster('release-phone');
$('save-settings').onclick = () => { if ($('virus-count').reportValidity() && $('virus-speed').reportValidity()) sendMaster('settings', { count: Number($('virus-count').value), stepMs: Number($('virus-speed').value) }); };
$('reconnect-phone').onclick = createConnection;
show('wake-phone', !!navigator.wakeLock && window.isSecureContext);
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock.request('screen'); text('wake-phone', 'Экран останется включённым'); wakeLock.addEventListener('release', () => { text('wake-phone', 'Не гасить экран телефона'); }); }
  catch { text('wake-phone', 'Отключи автоблокировку в настройках телефона'); }
}
$('wake-phone').onclick = keepAwake;
document.addEventListener('keydown', event => {
  if (role !== 'host' || /INPUT|SELECT|TEXTAREA|BUTTON|A/.test(event.target.tagName) || event.repeat) return;
  if (event.code === 'Space') { event.preventDefault(); $('pause').click(); }
  if (event.code === 'Enter') { event.preventDefault(); $('start').click(); }
  if (event.code === 'Escape') panel(false);
});
document.addEventListener('visibilitychange', () => {
  if (role === 'host' && document.hidden && active() && !state.paused) sendMaster('pause', { reason: 'hidden' });
  if (role === 'phone' && !document.hidden && wakeLock) keepAwake();
});
window.addEventListener('pagehide', () => connection?.close());
function resizeTV() { const rect = $('tv-viewport').getBoundingClientRect(); $('tv-scene').style.setProperty('--tv-scale', Math.min(rect.width / 1920, rect.height / 1080)); }
window.addEventListener('resize', resizeTV);
if (role === 'phone' && !ROOM_PATTERN.test(room)) { role = 'home'; text('home-error', 'Нужен шестизначный код с большого экрана.'); }
if (!['host', 'phone'].includes(role)) role = 'home';
document.body.dataset.role = role; document.body.dataset.transport = isLocal ? 'lan' : demo ? 'demo' : 'relay';
show('home', role === 'home'); show('host', role === 'host'); show('phone', role === 'phone');
text('phone-room', room); resizeTV();
if (role !== 'home') createConnection();
setInterval(render, 50);
