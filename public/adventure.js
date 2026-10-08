import { Trial, ARROWS, SYMBOLS, DEFAULTS, shuffle } from './game.js';

export const DIGITS = ['1','2','3','4','5','6','7','8','9','0'];
export const FIELD = Object.freeze({ columns: 18, rows: 12, radius: 2 });
export const TRANSITION_MS = 1800;
export function hexDistance(a, b) {
  const q = p => p.col - Math.floor(p.row / 2);
  const dq = q(a) - q(b), dr = a.row - b.row;
  return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr));
}
export class Adventure extends Trial {
  constructor(options = {}) {
    super(options);
    this.protocol = 1;
    this.nodes = [];
    this.position = { col: 2, row: 5 };
    this.contact = '';
  }
  start(config = DEFAULTS) {
    if (this.protocol === 2 && this.stage !== 'success') return this.startSearch();
    if (this.protocol === 2) this.layout = shuffle(SYMBOLS, this.random);
    this.protocol = 1;
    this.nodes = [];
    super.start(config);
  }
  startSearch() {
    this.protocol = 2;
    this.round++;
    this.layoutVersion++;
    this.stage = 'explore';
    this.paused = false;
    this.reason = '';
    this.sequence = [];
    this.entered = [];
    this.config = { ...DEFAULTS, length: 8 };
    this.layout = [...DIGITS];
    this.position = { col: 2, row: 5 };
    this.contact = 'Найди целевой узел ◇. Обзор: два гекса вокруг зонда.';
    const cells = Array.from({ length: FIELD.columns * FIELD.rows }, (_, i) => ({ col: i % FIELD.columns, row: Math.floor(i / FIELD.columns) }));
    const candidates = shuffle(cells.filter(p => hexDistance(p, this.position) >= 6), this.random);
    this.nodes = candidates.slice(0, 6).map((p, i) => ({ ...p, target: i === 0, sign: i === 0 ? '◇' : ['○','△','✣','□','⊕'][i - 1] }));
    this.deadline = 0;
  }
  active() { return super.active() || this.stage === 'transition' || this.stage === 'explore'; }
  remaining() { return this.stage === 'explore' ? 0 : super.remaining(); }
  tick() {
    if (this.stage === 'explore') return false;
    if (this.stage === 'transition') {
      if (this.paused || this.remaining() > 0) return false;
      this.startSearch();
      return true;
    }
    return super.tick();
  }
  press(msg) {
    this.tick();
    if (this.paused || msg.round !== this.round || msg.layoutVersion !== this.layoutVersion) return false;
    if (this.protocol === 2 && this.stage === 'explore') {
      if (msg.kind !== 'move' || !ARROWS.includes(msg.symbol)) return false;
      const moves = { '↑': [0,-1], '↓': [0,1], '←': [-1,0], '→': [1,0] };
      const [dc, dr] = moves[msg.symbol];
      this.position = { col: Math.max(0, Math.min(FIELD.columns - 1, this.position.col + dc)), row: Math.max(0, Math.min(FIELD.rows - 1, this.position.row + dr)) };
      this.layoutVersion++;
      const node = this.nodes.find(n => n.col === this.position.col && n.row === this.position.row);
      this.contact = node ? node.target ? 'Целевой узел найден. Запомни восемь цифр.' : `Узел ${node.sign} не является целью. Продолжай поиск ◇.` : 'Передавай оператору направление движения. Цель: ◇.';
      if (node?.target) {
        this.sequence = Array.from({ length: 8 }, () => String(this.random(10)));
        this.entered = [];
        this.stage = 'show';
        this.deadline = this.now() + DEFAULTS.showMs;
      }
      return true;
    }
    if (msg.kind === 'move') return false;
    const digitLayout = this.protocol === 2 ? [...this.layout] : null;
    const accepted = super.press(msg);
    if (digitLayout) this.layout = digitLayout;
    if (accepted && this.protocol === 1 && this.stage === 'success') {
      this.stage = 'transition';
      this.deadline = this.now() + TRANSITION_MS;
    }
    return accepted;
  }
  controllerState() {
    // Field, coordinates, node signs and solution belong only to the TV.
    return { ...super.controllerState(), protocol: this.protocol };
  }
}
