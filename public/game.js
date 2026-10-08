export const SYMBOLS = ['↑', '↓', '←', '→', 'Æ', 'Œ', 'Þ', 'Ð', 'Ƶ'];
export const ARROWS = SYMBOLS.slice(0, 4);
export const DEFAULTS = Object.freeze({ length: 8, showMs: 10_000, inputMs: 15_000 });

export function randomInt(max) {
  const limit = Math.floor(0x100000000 / max) * max;
  const sample = new Uint32Array(1);
  do { crypto.getRandomValues(sample); } while (sample[0] >= limit);
  return sample[0] % max;
}

export function shuffle(keys, random = randomInt) {
  const next = [...keys];
  for (let i = next.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
}

// A derangement makes every key move, including the arrow just pressed.
export function reshuffle(keys, random = randomInt) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const next = shuffle(keys, random);
    if (next.every((key, i) => key !== keys[i])) return next;
  }
  return [...keys.slice(1), keys[0]];
}

export class Trial {
  constructor({ now = () => performance.now(), random = randomInt } = {}) {
    this.now = now;
    this.random = random;
    this.stage = 'lobby';
    this.paused = false;
    this.round = 0;
    this.layoutVersion = 0;
    this.sequence = [];
    this.entered = [];
    this.layout = shuffle(SYMBOLS, random);
    this.reason = '';
    this.config = { ...DEFAULTS };
    this.deadline = 0;
    this.savedRemaining = 0;
  }
  start(config = DEFAULTS) {
    this.config = {
      length: Math.max(4, Math.min(12, Number(config.length) || 8)),
      showMs: DEFAULTS.showMs,
      inputMs: DEFAULTS.inputMs,
    };
    this.round++;
    this.sequence = Array.from({ length: this.config.length }, () => ARROWS[this.random(4)]);
    this.entered = [];
    this.layout = reshuffle(this.layout, this.random);
    this.layoutVersion++;
    this.stage = 'show';
    this.reason = '';
    this.paused = false;
    this.deadline = this.now() + this.config.showMs;
  }
  active() { return this.stage === 'show' || this.stage === 'input'; }
  remaining() { return Math.max(0, this.paused ? this.savedRemaining : this.deadline - this.now()); }
  tick() {
    if (!this.active() || this.paused || this.remaining() > 0) return false;
    if (this.stage === 'show') {
      this.stage = 'input';
      // Give a full input window even if the TV tab was briefly throttled.
      this.deadline = this.now() + this.config.inputMs;
    } else this.fail('timeout');
    return true;
  }
  pause(reason = 'manual') {
    if (!this.active() || this.paused) return false;
    this.savedRemaining = this.remaining();
    this.paused = true;
    this.pauseReason = reason;
    return true;
  }
  resume() {
    if (!this.paused) return false;
    this.deadline = this.now() + this.savedRemaining;
    this.paused = false;
    return true;
  }
  fail(reason) { this.stage = 'failure'; this.reason = reason; this.deadline = this.now(); }
  press({ symbol, round, layoutVersion }) {
    this.tick();
    if (this.stage !== 'input' || this.paused || round !== this.round || layoutVersion !== this.layoutVersion || !this.layout.includes(symbol)) return false;
    this.layout = reshuffle(this.layout, this.random);
    this.layoutVersion++;
    this.entered.push(symbol);
    if (symbol !== this.sequence[this.entered.length - 1]) this.fail('symbol');
    else if (this.entered.length === this.sequence.length) {
      this.stage = 'success'; this.deadline = this.now();
    }
    return true;
  }
  // The controller never receives the solution, even while the TV shows it.
  controllerState() {
    return {
      stage: this.stage, paused: this.paused, pauseReason: this.pauseReason || '',
      round: this.round, layoutVersion: this.layoutVersion,
      layout: [...this.layout], entered: [...this.entered],
      length: this.config.length, remainingMs: this.remaining(), reason: this.reason,
    };
  }
}
