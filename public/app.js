import { Trial, SYMBOLS } from './game.js';
import { Link, createRoom, ROOM_PATTERN } from './link.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
let role = params.get('view') || 'home';
let room = (params.get('room') || '').toUpperCase();
const local = params.get('transport') === 'local';
let link, connected = false, ready = false, lastSeen = 0, previousPhase = '', pending = false, command = 0;
let phoneState = null, phoneReceivedAt = 0, lastCommand = 0, wakeLock;
const trial = new Trial();
let clientId;
try { clientId = sessionStorage.getItem('bombarcade-client') || crypto.randomUUID(); sessionStorage.setItem('bombarcade-client', clientId); }
catch { clientId = crypto.randomUUID(); }

function route(view, code = '', demo = false) {
  const url = new URL(location.href);
  url.search = ''; url.hash = '';
  url.searchParams.set('view', view);
  if (code) url.searchParams.set('room', code);
  if (demo) url.searchParams.set('transport', 'local');
  return url;
}
function setText(id, text) { if ($(id).textContent !== text) $(id).textContent = text; }
function show(id, visible) { $(id).hidden = !visible; }
function announce(text) { setText('announcement', text); }
function connection(id, text, good = false) { setText(id, text); $(id).classList.toggle('online', good); }
function leftSeconds(ms) { return Math.max(0, Math.ceil(ms / 1000)).toString().padStart(2, '0'); }
function vibrate(pattern) { try { navigator.vibrate?.(pattern); } catch {} }

let soundEnabled = false, audio;
function beep(kind = 'key') {
  if (!soundEnabled) return;
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const oscillator = audio.createOscillator(), gain = audio.createGain();
    oscillator.type = 'sine'; oscillator.frequency.value = { key: 750, input: 980, failure: 140, success: 1200, show: 540 }[kind] || 600;
    gain.gain.setValueAtTime(.07, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(.001, audio.currentTime + .16);
    oscillator.connect(gain); gain.connect(audio.destination);
    oscillator.start(); oscillator.stop(audio.currentTime + .17);
  } catch {}
}
$('sound').onclick = () => {
  soundEnabled = !soundEnabled;
  $('sound').setAttribute('aria-pressed', String(soundEnabled));
  $('sound').textContent = `Звук: ${soundEnabled ? 'вкл.' : 'выкл.'}`; beep();
};
$('fullscreen').onclick = async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }
  catch { announce('Полноэкранный режим недоступен в этом браузере.'); }
};
if (!document.documentElement.requestFullscreen) $('fullscreen').hidden = true;
$('create').onclick = () => location.assign(route('host'));
$('demo').onclick = () => location.assign(route('host', '', true));
$('join-form').onsubmit = e => {
  e.preventDefault(); const code = $('room-input').value.trim().toUpperCase();
  if (ROOM_PATTERN.test(code)) location.assign(route('phone', code));
};
$('room-input').oninput = e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); };

const phaseCopy = {
  lobby: ['ОЖИДАНИЕ ОПЕРАТОРА', 'Канал управления закрыт'],
  show: ['СЧИТЫВАНИЕ / 10 СЕКУНД', 'Передай последовательность'],
  input: ['ВВОД / 15 СЕКУНД', 'Оператор, вводи код'],
  success: ['ПРОТОКОЛ ПОДТВЕРЖДЁН', 'Первый шлюз открыт'],
  failure: ['ПРОТОКОЛ ОТКЛОНЁН', 'Попытка прервана'],
};
function sequence(container, symbols, entered = []) {
  const signature = symbols.join('') + '/' + entered.join('');
  if (container.dataset.signature === signature) return;
  container.dataset.signature = signature;
  container.replaceChildren(...symbols.map((s, i) => {
    const tile = document.createElement('div'); tile.className = 'sequence-tile';
    if (entered.length > i) tile.classList.add(entered[i] === s ? 'accepted' : 'wrong');
    const symbol = document.createElement('span'); symbol.textContent = s;
    const index = document.createElement('small'); index.textContent = String(i + 1).padStart(2, '0');
    tile.append(symbol, index); return tile;
  }));
}
function progress(container, count, entered, characters = false) {
  const signature = count + ':' + entered.join('') + ':' + characters;
  if (container.dataset.signature === signature) return;
  container.dataset.signature = signature;
  container.replaceChildren(...Array.from({ length: count }, (_, i) => {
    const slot = document.createElement('span'); slot.className = 'progress-slot';
    slot.classList.toggle('filled', i < entered.length);
    slot.textContent = i < entered.length ? (characters ? entered[i] : '◆') : '·';
    return slot;
  }));
}
function sendState(ack) { link?.send({ kind: 'state', state: trial.controllerState(), ...(ack !== undefined ? { ack } : {}) }); }
function renderHost() {
  const stage = trial.stage;
  document.body.dataset.stage = stage;
  const [phase, title] = phaseCopy[stage];
  setText('host-phase', phase); setText('host-title', title);
  setText('attempt', 'ПОПЫТКА ' + String(trial.round).padStart(2, '0'));
  const remaining = trial.remaining();
  setText('host-timer', trial.active() ? leftSeconds(remaining) : '—');
  setText('host-timer-label', trial.active() ? (trial.paused ? 'ПАУЗА' : stage === 'show' ? 'СЧИТЫВАНИЕ' : 'ВВОД') : 'ДО ЗАПУСКА');
  $('host-timer-bar').style.width = (trial.active() ? remaining / (stage === 'show' ? 10_000 : 15_000) * 100 : 0) + '%';
  $('host-timer').classList.toggle('urgent', stage === 'input' && remaining < 5000 && !trial.paused);
  show('lobby-content', stage === 'lobby'); show('sequence-zone', stage === 'show'); show('input-zone', stage === 'input');
  show('result-zone', stage === 'success' || stage === 'failure'); show('host-paused', trial.paused);
  if (stage === 'show') sequence($('sequence'), trial.sequence);
  else { $('sequence').replaceChildren(); delete $('sequence').dataset.signature; }
  if (stage === 'input') progress($('host-progress'), trial.config.length, trial.entered);
  if (stage === 'success' || stage === 'failure') {
    const success = stage === 'success';
    setText('result-mark', success ? '✓' : '×');
    setText('result-title', success ? 'Доступ к устройству получен' : 'Сбой последовательности');
    setText('result-text', success ? 'Первое испытание пройдено. Дальнейшие действия определяет мастер.' : trial.reason === 'timeout' ? 'Время на ввод истекло. Мастер может запустить новую попытку.' : 'Введён неверный символ. Мастер может запустить новую попытку.');
    sequence($('result-sequence'), trial.sequence, trial.entered);
  }
  setText('pause-explanation', trial.pauseReason === 'connection' ? 'Связь с телефоном потеряна. После подключения нажми «Продолжить».' : trial.pauseReason === 'hidden' ? 'Большой экран был свёрнут. Нажми «Продолжить», когда оба оператора готовы.' : 'Мастер поставил испытание на паузу.');
  $('start').disabled = !connected || !ready || trial.active();
  setText('start', trial.round ? 'Новая попытка' : 'Начать испытание');
  $('length').disabled = trial.active();
  $('pause').disabled = !trial.active() || (trial.paused && !connected);
  setText('pause', trial.paused ? 'Продолжить' : 'Пауза');
  setText('host-status', trial.stage === 'input' ? `Принято символов: ${trial.entered.length} / ${trial.config.length}` : 'Доступ к устройству / блок 01');
  if (stage !== previousPhase) { previousPhase = stage; announce(title); if (stage !== 'lobby') beep(stage); }
}
function hostMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.kind === 'hello' || msg.kind === 'ping' || msg.kind === 'key') {
    lastSeen = performance.now();
    connected = true;
    connection('host-connection', 'Телефон подключён', true);
    setText('host-error', '');
  }
  if (msg.kind === 'hello') { lastCommand = 0; sendState(); }
  if (msg.kind === 'ping') sendState();
  if (msg.kind === 'key') {
    if (!Number.isSafeInteger(msg.command) || msg.command <= lastCommand) { sendState(msg.command); return; }
    lastCommand = msg.command;
    const accepted = trial.press(msg);
    if (accepted && trial.stage === 'input') beep('key');
    sendState(msg.command); renderHost();
  }
}
function hostStatus(status, error = '') {
  if (status === 'ready') { ready = true; connection('host-connection', connected ? 'Телефон подключён' : 'Ожидание телефона', connected); setText('host-error', ''); }
  if (status === 'connected') { connected = true; lastSeen = performance.now(); connection('host-connection', 'Телефон подключён', true); sendState(); }
  if (status === 'disconnected' || status === 'error') {
    connected = false; trial.pause('connection'); connection('host-connection', 'Нет связи с телефоном');
    setText('host-error', error); show('reconnect-host', status === 'error' && !link?.conn?.open); sendState();
  }
  renderHost();
}
function initHost() {
  if (!ROOM_PATTERN.test(room)) room = createRoom();
  history.replaceState(null, '', route('host', room, local));
  setText('room-code', room); show('demo-label', local);
  const phoneUrl = route('phone', room, local);
  $('phone-link').href = phoneUrl;
  if (local) {
    setText('lobby-instructions', 'Открой консоль в отдельном окне этого браузера. Поставь два окна рядом: свёрнутый большой экран останавливает таймер.');
    setText('phone-link', 'Открыть консоль в отдельном окне'); show('qr', false);
    $('phone-link').onclick = e => { e.preventDefault(); window.open(phoneUrl.href, '_blank', 'popup,width=430,height=850,noopener'); };
  } else {
    const qr = window.qrcode?.(0, 'M');
    if (qr) { qr.addData(phoneUrl.href); qr.make(); $('qr').innerHTML = qr.createSvgTag({ cellSize: 5, margin: 12, scalable: true }); }
    else setText('qr', 'Введи код сеанса на телефоне');
  }
  const connect = () => {
    link?.close(); connected = false; ready = false;
    connection('host-connection', 'Создание канала…'); show('reconnect-host', false);
    link = new Link({ role: 'host', room, local, onMessage: hostMessage, onStatus: hostStatus });
  };
  connect(); $('reconnect-host').onclick = connect;
  $('copy-link').onclick = async () => {
    try { await navigator.clipboard.writeText(phoneUrl.href); setText('copy-link', 'Ссылка скопирована'); }
    catch { setText('host-error', 'Скопируй адрес через ссылку «Открыть телефонную консоль».'); }
  };
  $('start').onclick = () => { if (!connected || !ready || trial.active()) return; trial.start({ length: $('length').value }); sendState(); renderHost(); };
  $('pause').onclick = () => {
    if (trial.paused && connected) trial.resume(); else trial.pause();
    sendState(); renderHost();
  };
  renderHost();
}

const keypadButtons = Array.from({ length: 9 }, (_, i) => {
  const key = document.createElement('button'); key.className = 'key'; key.type = 'button'; key.disabled = true;
  const symbol = document.createElement('span'), index = document.createElement('small'); index.textContent = `0${i + 1}`;
  key.append(symbol, index);
  key.onclick = () => press(key.dataset.symbol);
  return key;
});
$('keypad').append(...keypadButtons);
const labels = { '↑': 'Вверх', '↓': 'Вниз', '←': 'Влево', '→': 'Вправо' };
function press(symbol) {
  if (!connected || pending || !phoneState || phoneState.stage !== 'input' || phoneState.paused || phoneRemaining() <= 0) return;
  pending = true; command++;
  const sent = link.send({ kind: 'key', symbol, round: phoneState.round, layoutVersion: phoneState.layoutVersion, command });
  if (!sent) { pending = false; phoneStatus('disconnected', 'Команда не отправлена. Восстанови связь.'); return; }
  beep(); vibrate(12); renderPhone();
}
function phoneRemaining() {
  if (!phoneState) return 0;
  return Math.max(0, phoneState.remainingMs - (phoneState.paused ? 0 : performance.now() - phoneReceivedAt));
}
function renderPhone() {
  const state = phoneState;
  const stage = state?.stage || 'lobby';
  document.body.dataset.stage = stage;
  const seconds = phoneRemaining();
  setText('phone-timer', state && ['show', 'input'].includes(stage) ? leftSeconds(seconds) : '—');
  $('phone-timer').classList.toggle('urgent', stage === 'input' && seconds < 5000 && !state?.paused);
  const blocked = !connected || !state || state.paused || stage !== 'input' || seconds <= 0;
  const layout = state?.layout || SYMBOLS;
  keypadButtons.forEach((key, i) => {
    const symbol = layout[i];
    key.firstChild.textContent = symbol; key.dataset.symbol = symbol;
    key.classList.toggle('glyph', !labels[symbol]);
    key.setAttribute('aria-label', labels[symbol] || `Глиф ${symbol}`);
    key.disabled = blocked || pending;
  });
  progress($('phone-progress'), state?.length || 8, state?.entered || [], true);
  setText('phone-counter', `${String(state?.entered.length || 0).padStart(2, '0')} / ${String(state?.length || 8).padStart(2, '0')}`);
  let title = 'Ожидание запуска', instruction = 'Когда оба игрока готовы, мастер запускает испытание на большом экране.', phase = 'ОЖИДАНИЕ';
  if (!connected) { title = 'Нет связи с кораблём'; instruction = 'Оставь большой экран открытым и восстанови подключение.'; phase = 'НЕТ СВЯЗИ'; }
  else if (state?.paused) { title = 'Протокол на паузе'; instruction = 'Таймер остановлен. Продолжение запускается на большом экране.'; phase = 'ПАУЗА'; }
  else if (stage === 'show') { title = 'Слушай наблюдателя'; instruction = 'Код виден только на большом экране. Сейчас клавиши заблокированы.'; phase = 'СЧИТЫВАНИЕ'; }
  else if (stage === 'input') { title = 'Вводи последовательность'; instruction = 'Найди нужную стрелку. После нажатия клавиши переместятся.'; phase = 'ВВОД'; }
  else if (stage === 'success') { title = 'Шлюз открыт'; instruction = 'Первое испытание пройдено. Дождись указаний мастера.'; phase = 'ПОДТВЕРЖДЕНО'; }
  else if (stage === 'failure') { title = 'Попытка прервана'; instruction = state.reason === 'timeout' ? 'Время истекло. Новую попытку запускает мастер.' : 'Введён неверный символ. Новую попытку запускает мастер.'; phase = 'ОТКЛОНЕНО'; }
  setText('phone-title', title); setText('phone-instruction', instruction); setText('phone-phase', phase);
  setText('key-state', blocked ? 'КЛАВИШИ ЗАБЛОКИРОВАНЫ' : pending ? 'ПЕРЕДАЧА КОМАНДЫ…' : 'ВВОД РАЗРЕШЁН');
  if (stage !== previousPhase) {
    previousPhase = stage; announce(title);
    if (stage === 'input') { beep('input'); vibrate([30, 40, 30]); }
    if (stage === 'failure') { beep('failure'); vibrate([80, 60, 80]); }
    if (stage === 'success') { beep('success'); vibrate(60); }
  }
}
function validState(s) {
  return s && phaseCopy[s.stage] && typeof s.paused === 'boolean' && Number.isFinite(s.remainingMs) &&
    Number.isInteger(s.round) && Number.isInteger(s.layoutVersion) && s.layout?.length === 9 &&
    new Set(s.layout).size === 9 && s.layout.every(k => SYMBOLS.includes(k)) &&
    Number.isInteger(s.length) && s.length >= 4 && s.length <= 12 &&
    Array.isArray(s.entered) && s.entered.length <= s.length && s.entered.every(k => SYMBOLS.includes(k));
}
function phoneMessage(msg) {
  if (msg?.kind === 'busy') { phoneStatus('error', 'К сеансу уже привязана другая консоль. Создай новый сеанс для нового телефона.'); return; }
  if (msg?.kind !== 'state' || !validState(msg.state)) return;
  lastSeen = performance.now(); connected = true;
  if (phoneState && msg.state.round === phoneState.round && msg.state.layoutVersion < phoneState.layoutVersion) return;
  const changed = !phoneState || msg.state.round !== phoneState.round || msg.state.layoutVersion !== phoneState.layoutVersion;
  if (changed || msg.ack === command) pending = false;
  phoneState = msg.state; phoneReceivedAt = performance.now();
  connection('phone-connection', 'Связь установлена', true); setText('phone-error', ''); show('reconnect-phone', false);
  renderPhone();
}
function phoneStatus(status, error = '') {
  if (status === 'connected') { link?.send({ kind: 'hello' }); connection('phone-connection', 'Синхронизация…'); }
  if (status === 'connecting') connection('phone-connection', 'Подключение…');
  if (status === 'error' || status === 'disconnected') {
    connected = false; pending = false; connection('phone-connection', 'Нет связи');
    setText('phone-error', error); show('reconnect-phone', true);
  }
  renderPhone();
}
function initPhone() {
  if (!ROOM_PATTERN.test(room)) {
    role = 'home'; setText('home-error', 'Нужен шестизначный код с большого экрана.'); return;
  }
  setText('phone-room', room);
  const connect = () => {
    link?.close(); connected = false; pending = false; lastSeen = performance.now();
    setText('phone-error', ''); show('reconnect-phone', false);
    link = new Link({ role: 'phone', room, local, clientId, onMessage: phoneMessage, onStatus: phoneStatus });
  };
  connect(); $('reconnect-phone').onclick = connect;
  renderPhone();
}

async function keepAwake() {
  try {
    if (!navigator.wakeLock) { setText('wake-phone', 'Отключи автоблокировку в настройках телефона'); return; }
    wakeLock = await navigator.wakeLock.request('screen');
    setText('wake-phone', 'Экран останется включённым');
    wakeLock.addEventListener('release', () => { wakeLock = null; setText('wake-phone', 'Не гасить экран телефона'); });
  } catch { setText('wake-phone', 'Не удалось отключить автоблокировку'); }
}
$('wake-phone').onclick = keepAwake;
document.addEventListener('visibilitychange', () => {
  if (role === 'host' && document.hidden) { if (trial.pause('hidden')) { sendState(); renderHost(); } }
  if (role === 'phone' && !document.hidden) { link?.send({ kind: 'hello' }); if (wakeLock) keepAwake(); }
});
window.addEventListener('pagehide', () => link?.close());

if (role === 'host') initHost(); else if (role === 'phone') initPhone(); else role = 'home';
show('home', role === 'home'); show('host', role === 'host'); show('phone', role === 'phone');
document.body.dataset.role = role;

setInterval(() => {
  if (role === 'host') {
    if (connected && performance.now() - lastSeen > 4500) {
      connected = false; trial.pause('connection'); connection('host-connection', 'Телефон не отвечает'); sendState();
    }
    if (trial.tick()) sendState();
    renderHost();
  } else if (role === 'phone') {
    if (connected && performance.now() - lastSeen > 4500) phoneStatus('disconnected', 'Большой экран не отвечает. Таймер будет остановлен на стороне мастера.');
    renderPhone();
  }
}, 50);
setInterval(() => {
  if (role === 'phone') link?.send({ kind: phoneState ? 'ping' : 'hello' });
}, 1000);
