import { Trial, ARROWS, SYMBOLS, DEFAULTS, shuffle } from './game.js';

export const DIGITS = ['1','2','3','4','5','6','7','8','9','0'];
export const FIELD = Object.freeze({ columns: 18, rows: 12, radius: 2 });
export const TRANSITION_MS = 1800;
// Second protocol: eight digits, 10 s on the TV, then 40 s to type them on the phone.
export const SECOND = Object.freeze({ length: 8, showMs: 10_000, inputMs: 40_000, attempts: 3 });
export const VIRUS_DEFAULTS = Object.freeze({ count: 3, stepMs: 800 });
export const START = Object.freeze({ col: 2, row: 5 });
export const MOVES = Object.freeze({ '↑': [0, -1], '↓': [0, 1], '←': [-1, 0], '→': [1, 0] });
export const NODE_KINDS = ['spire', 'gear', 'antenna', 'forge', 'skull'];

export function hexDistance(a, b) {
  const q = p => p.col - Math.floor(p.row / 2);
  const dq = q(a) - q(b), dr = a.row - b.row;
  return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr));
}
export const same = (a, b) => a.col === b.col && a.row === b.row;
export const inField = p => p.col >= 0 && p.col < FIELD.columns && p.row >= 0 && p.row < FIELD.rows;
const index = p => p.row * FIELD.columns + p.col;
// The probe and the viruses use exactly the same four transitions as the phone arrows.
export function neighbours(p) {
  return Object.values(MOVES).map(([dc, dr]) => ({ col: p.col + dc, row: p.row + dr })).filter(inField);
}
export function stepFrom(p, symbol) {
  const [dc, dr] = MOVES[symbol];
  return { col: Math.max(0, Math.min(FIELD.columns - 1, p.col + dc)), row: Math.max(0, Math.min(FIELD.rows - 1, p.row + dr)) };
}
// Breadth-first distances over the allowed moves; `blocked` cells are never entered.
export function distances(from, blocked = () => false) {
  const dist = new Int16Array(FIELD.columns * FIELD.rows).fill(-1);
  if (blocked(from)) return dist;
  const queue = [from]; dist[index(from)] = 0;
  for (let head = 0; head < queue.length; head++) {
    const cell = queue[head];
    for (const next of neighbours(cell)) {
      if (dist[index(next)] !== -1 || blocked(next)) continue;
      dist[index(next)] = dist[index(cell)] + 1; queue.push(next);
    }
  }
  return dist;
}
export const distanceAt = (dist, p) => dist[index(p)];
const allCells = () => Array.from({ length: FIELD.columns * FIELD.rows }, (_, i) => ({ col: i % FIELD.columns, row: Math.floor(i / FIELD.columns) }));

export function safeRouteExists(start, target, viruses) {
  const seen = p => viruses.some(v => hexDistance(v, p) <= FIELD.radius);
  return distanceAt(distances(start, seen), target) >= 0;
}
// Viruses never start on the probe, the target, a node or in the first scan; the target must
// stay reachable along a route that never wakes a virus, so a start is never a forced loss.
export function placeViruses({ start = START, nodes = [], count = VIRUS_DEFAULTS.count, random }) {
  const target = nodes.find(n => n.target);
  if (count <= 0) return [];
  const rules = [{ start: 5, target: 3, apart: 3 }, { start: 4, target: 3, apart: 2 }, { start: FIELD.radius + 1, target: 2, apart: 1 }];
  for (const rule of rules) {
    for (let attempt = 0; attempt < 120; attempt++) {
      const picked = [];
      for (const cell of shuffle(allCells(), random)) {
        if (picked.length === count) break;
        if (hexDistance(cell, start) < rule.start || nodes.some(n => same(n, cell))) continue;
        if (target && hexDistance(cell, target) < rule.target) continue;
        if (picked.some(v => hexDistance(v, cell) < rule.apart)) continue;
        picked.push(cell);
      }
      if (picked.length < count) continue;
      if (target && !safeRouteExists(start, target, picked)) continue;
      return picked.map((p, i) => ({ id: i + 1, col: p.col, row: p.row, active: false, nextAt: 0, left: 0 }));
    }
  }
  throw new Error('Не удалось расставить вирусы с безопасным стартом. Уменьши их количество.');
}

export class Adventure extends Trial {
  constructor(options = {}) {
    super(options);
    this.protocol = 1;
    this.nodes = [];
    this.viruses = [];
    this.position = { ...START };
    this.contact = '';
    this.failures = 0;
    this.alert = 0;
    this.virusConfig = { ...VIRUS_DEFAULTS };
    this.setVirusConfig(options.virus);
  }
  setVirusConfig(config = {}) {
    const count = Number(config.count ?? this.virusConfig.count), stepMs = Number(config.stepMs ?? this.virusConfig.stepMs);
    this.virusConfig = {
      count: Number.isInteger(count) ? Math.max(0, Math.min(6, count)) : VIRUS_DEFAULTS.count,
      stepMs: Number.isFinite(stepMs) ? Math.max(300, Math.min(3000, Math.round(stepMs))) : VIRUS_DEFAULTS.stepMs,
    };
    return this.virusConfig;
  }
  attemptsLeft() { return this.protocol === 2 ? SECOND.attempts - this.failures : 0; }
  attemptNumber() {
    if (this.protocol !== 2) return 0;
    return Math.min(SECOND.attempts, this.failures + (['failure', 'lost'].includes(this.stage) ? 0 : 1));
  }

  // Protocol I: a fresh mnemonic attempt (unlimited, as before).
  begin(config = DEFAULTS) {
    if (this.protocol === 2) this.layout = shuffle(SYMBOLS, this.random);
    this.protocol = 1; this.nodes = []; this.viruses = []; this.failures = 0; this.alert = 0;
    super.start(config);
    return true;
  }
  // Generic master button: retries protocol II while attempts remain, otherwise protocol I.
  start(config = DEFAULTS) {
    if (this.protocol === 2 && this.stage === 'failure') return this.retryStage();
    if (this.protocol === 2 && (this.active() || this.stage === 'lost' || this.stage === 'success')) return false;
    if (this.active()) return false;
    return this.begin(config);
  }
  retryStage() {
    if (this.protocol !== 2 || this.stage !== 'failure' || this.attemptsLeft() <= 0) return false;
    this.startSearch({ fresh: false });
    return true;
  }
  // Explicit full restart: back to the lobby before protocol I.
  restart() {
    this.protocol = 1; this.stage = 'lobby'; this.paused = false; this.pauseReason = ''; this.reason = '';
    this.round++; this.layoutVersion++;
    this.sequence = []; this.entered = []; this.nodes = []; this.viruses = [];
    this.failures = 0; this.alert = 0; this.contact = ''; this.deadline = 0;
    this.position = { ...START };
    this.layout = shuffle(SYMBOLS, this.random);
    this.config = { ...DEFAULTS };
    return true;
  }
  startSearch({ fresh = true } = {}) {
    if (fresh) this.failures = 0;
    this.protocol = 2;
    this.round++;
    this.layoutVersion++;
    this.stage = 'explore';
    this.paused = false;
    this.reason = '';
    this.sequence = [];
    this.entered = [];
    this.pauseReason = '';
    this.config = { ...SECOND };
    this.layout = [...DIGITS];
    this.position = { ...START };
    this.contact = 'Найди целевой узел ◇. Обзор: два гекса вокруг зонда.';
    const candidates = shuffle(allCells().filter(p => hexDistance(p, this.position) >= 6), this.random);
    const kinds = shuffle(NODE_KINDS, this.random);
    this.nodes = candidates.slice(0, 6).map((p, i) => ({ ...p, target: i === 0, kind: i === 0 ? 'target' : kinds[i - 1] }));
    this.viruses = placeViruses({ start: this.position, nodes: this.nodes, count: this.virusConfig.count, random: this.random });
    this.deadline = 0;
  }
  active() { return super.active() || this.stage === 'transition' || this.stage === 'explore'; }
  remaining() { return this.stage === 'explore' ? 0 : super.remaining(); }
  duration() {
    if (this.stage === 'transition') return TRANSITION_MS;
    if (this.stage === 'show') return this.config.showMs;
    if (this.stage === 'input') return this.config.inputMs;
    return 0;
  }
  // One defeat costs one attempt: once the stage has left play nothing else can fail it.
  fail(reason) {
    if (!this.active()) return false;
    super.fail(reason);
    if (this.protocol === 2) {
      this.failures = Math.min(SECOND.attempts, this.failures + 1);
      if (this.failures >= SECOND.attempts) this.stage = 'lost';
      this.contact = reason === 'caught' ? 'Зонд захвачен вирусом.' : reason === 'timeout' ? 'Время ввода кода истекло.' : 'Введена неверная цифра.';
    }
    return true;
  }
  pause(reason = 'manual') {
    const now = this.now();
    if (!super.pause(reason)) return false;
    for (const v of this.viruses) v.left = Math.max(0, v.nextAt - now);
    return true;
  }
  resume() {
    if (!super.resume()) return false;
    const now = this.now();
    for (const v of this.viruses) if (v.active) v.nextAt = now + v.left;
    return true;
  }
  tick() {
    if (this.stage === 'explore') return this.stepViruses();
    if (this.stage === 'transition') {
      if (this.paused || this.remaining() > 0) return false;
      this.startSearch();
      return true;
    }
    return super.tick();
  }
  caught() { return this.viruses.some(v => same(v, this.position)); }
  // Each awake virus takes at most one step per tick, along a shortest path to the probe.
  stepViruses() {
    if (this.paused || this.stage !== 'explore') return false;
    const now = this.now();
    const due = this.viruses.filter(v => v.active && v.nextAt <= now).sort((a, b) => a.nextAt - b.nextAt || a.id - b.id);
    if (!due.length) return false;
    const dist = distances(this.position);
    for (const virus of due) {
      const here = distanceAt(dist, virus);
      const options = neighbours(virus).filter(p => distanceAt(dist, p) === here - 1);
      const free = options.filter(p => same(p, this.position) || !this.viruses.some(o => o !== virus && same(o, p)));
      if (free.length) { const next = free[this.random(free.length)]; virus.col = next.col; virus.row = next.row; }
      virus.nextAt += this.virusConfig.stepMs;
      if (virus.nextAt <= now) virus.nextAt = now + this.virusConfig.stepMs;
      if (this.caught()) { this.fail('caught'); break; }
    }
    return true;
  }
  wake() {
    const now = this.now();
    let woke = 0;
    for (const v of this.viruses) {
      if (v.active || hexDistance(v, this.position) > FIELD.radius) continue;
      v.active = true; v.nextAt = now + this.virusConfig.stepMs; woke++;
    }
    if (woke) { this.alert++; this.contact = 'ВИРУС ОБНАРУЖЕН. Уводи зонд от угрозы.'; }
    return woke;
  }
  press(msg) {
    this.tick();
    if (this.paused || msg.round !== this.round) return false;
    if (this.protocol === 2 && this.stage === 'explore') {
      // Moves do not depend on a layout, so they may be sent back to back during a chase.
      if (msg.kind !== 'move' || !ARROWS.includes(msg.symbol)) return false;
      this.position = stepFrom(this.position, msg.symbol);
      this.layoutVersion++;
      if (this.caught()) { this.fail('caught'); return true; }
      const woke = this.wake();
      const node = this.nodes.find(n => same(n, this.position));
      if (!woke) this.contact = node ? node.target ? 'Целевой узел найден.' : 'Узел не является целью. Продолжай поиск ◇.' : 'Передавай оператору направление движения. Цель: ◇.';
      if (node?.target) {
        this.contact = 'Целевой узел найден. Запомни восемь цифр.';
        this.sequence = Array.from({ length: SECOND.length }, () => String(this.random(10)));
        this.entered = [];
        this.stage = 'show';
        this.deadline = this.now() + SECOND.showMs;
      }
      return true;
    }
    if (msg.kind === 'move' || msg.layoutVersion !== this.layoutVersion) return false;
    const digitLayout = this.protocol === 2 ? [...this.layout] : null;
    const accepted = super.press(msg);
    if (digitLayout) this.layout = digitLayout;
    if (accepted && this.protocol === 1 && this.stage === 'success') {
      this.stage = 'transition';
      this.deadline = this.now() + TRANSITION_MS;
    }
    return accepted;
  }
  common() {
    return {
      protocol: this.protocol, stage: this.stage, paused: this.paused, pauseReason: this.pauseReason || '',
      round: this.round, layoutVersion: this.layoutVersion, length: this.config.length,
      remainingMs: this.remaining(), durationMs: this.duration(), reason: this.reason,
      entered: [...this.entered], attempt: this.attemptNumber(), attemptsTotal: SECOND.attempts, attemptsLeft: this.attemptsLeft(),
    };
  }
  // The TV is the observer: it gets the field, but the renderer only draws what the scan sees.
  hostState() {
    const reveal = ['show', 'failure', 'lost', 'success'].includes(this.stage);
    return {
      ...this.common(),
      sequence: reveal ? [...this.sequence] : [],
      position: { ...this.position }, contact: this.contact,
      nodes: this.nodes.map(n => ({ col: n.col, row: n.row, target: n.target, kind: n.kind })),
      viruses: this.viruses.map(v => ({ id: v.id, col: v.col, row: v.row, active: v.active })),
      alert: this.alert, virusConfig: { ...this.virusConfig },
    };
  }
  // Field, coordinates, node kinds, virus positions and the solution belong only to the TV.
  controllerState() {
    return { ...super.controllerState(), ...this.common(), layout: [...this.layout], alarm: this.alert };
  }
}
