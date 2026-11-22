// Le oud : accords, maqamat, noms des notes (quarts de ton), son pincé et manche à l'écran.
// Les hauteurs sont en MIDI décimal et correspondent au son réel.
// Comme pour la guitare, la partition de oud s'écrit une octave au-dessus du son réel.

import type { KeyMark } from './keyboard';
import type { Spelling } from './musicxml';
import { audioOut } from './synth';
import { micInput, refHz } from './mic';
import { pref, setPref } from './storage';
import { pitchToHz } from './pitch';

export const WRITTEN_OFFSET = 12;

// ---------- noms ----------

const NAMES = [
  'Do', 'Do½♯', 'Do♯', 'Ré½♭', 'Ré', 'Ré½♯', 'Mi♭', 'Mi½♭', 'Mi', 'Fa½♭', 'Fa', 'Fa½♯',
  'Fa♯', 'Sol½♭', 'Sol', 'Sol½♯', 'La♭', 'La½♭', 'La', 'La½♯', 'Si♭', 'Si½♭', 'Si', 'Do½♭'
];

/** Nom français d'une hauteur, au quart de ton près. */
export function oudName(p: number, withOctave = false): string {
  const q = Math.round(p * 2);
  const name = NAMES[((q % 24) + 24) % 24];
  return withOctave ? name + String(Math.floor(Math.round(p) / 12) - 2) : name;
}

/** Orthographe sur la portée, cohérente avec oudName (Mi♭ et non Ré♯). */
export function oudSpelling(p: number): Spelling | undefined {
  const accidental: Record<number, [string, number]> = { 1: ['C', 1], 3: ['E', -1], 6: ['F', 1], 8: ['A', -1], 10: ['B', -1] };
  const a = Number.isInteger(p) ? accidental[((p % 12) + 12) % 12] : undefined;
  return a ? { step: a[0], alter: a[1], octave: Math.floor(p / 12) - 1 } : undefined;
}

// ---------- accords de l'instrument ----------

export interface OudTuning { id: string; label: string; strings: number[]; note?: string }

/** Cordes de la plus grave à la plus aiguë. */
export const TUNINGS: OudTuning[] = [
  { id: 'dgadgc', label: 'Arabe — Ré Sol La Ré Sol Do', strings: [38, 43, 45, 50, 55, 60] },
  { id: 'cfadgc', label: 'Arabe (syrien) — Do Fa La Ré Sol Do', strings: [36, 41, 45, 50, 55, 60] },
  {
    id: 'turc', label: 'Turc — Do♯ Fa♯ Si Mi La Ré', strings: [37, 42, 47, 52, 57, 62],
    note: 'Accord plus aigu : sur un oud arabe, il tend trop le manche et les cordes.'
  }
];
export const CUSTOM = 'perso';

export const tuningId = () => pref<string>('oud.tuning', TUNINGS[0].id);
export const customStrings = () => pref<number[]>('oud.custom', TUNINGS[0].strings);
export function currentStrings(): number[] {
  const id = tuningId();
  if (id === CUSTOM) return customStrings();
  return (TUNINGS.find(t => t.id === id) ?? TUNINGS[0]).strings;
}
export function setTuning(id: string, custom?: number[]): void {
  setPref('oud.tuning', id);
  if (custom) setPref('oud.custom', custom);
}

/** Où jouer une note : la corde la plus aiguë qui la permet (position la plus proche du sillet). */
export function positionOf(p: number, strings = currentStrings()): { string: number; offset: number } | null {
  for (let i = strings.length - 1; i >= 0; i--) if (strings[i] <= p + 0.01) return { string: i, offset: p - strings[i] };
  return null;
}

export function positionLabel(p: number): string {
  const strings = currentStrings();
  const pos = positionOf(p, strings);
  if (!pos) return 'sous la corde la plus grave';
  const s = `corde de ${oudName(strings[pos.string])}`;
  if (pos.offset < 0.01) return `${s}, à vide`;
  const tones = pos.offset / 2;
  return `${s}, +${String(tones).replace('.', ',')} ton${tones >= 2 ? 's' : ''}`;
}

// ---------- maqamat ----------

export interface Maqam { id: string; label: string; tonic: number; semis: number[] }

/** Échelles montantes sur une octave (écarts en demi-tons, 0,5 = quart de ton). */
export const MAQAMAT: Maqam[] = [
  { id: 'rast', label: 'Rast sur Do', tonic: 48, semis: [0, 2, 3.5, 5, 7, 9, 10.5, 12] },
  { id: 'bayati', label: 'Bayati sur Ré', tonic: 50, semis: [0, 1.5, 3, 5, 7, 8, 10, 12] },
  { id: 'hijaz', label: 'Hijaz sur Ré', tonic: 50, semis: [0, 1, 4, 5, 7, 8, 10, 12] },
  { id: 'nahawand', label: 'Nahawand sur Do', tonic: 48, semis: [0, 2, 3, 5, 7, 8, 11, 12] },
  { id: 'kurd', label: 'Kurd sur Ré', tonic: 50, semis: [0, 1, 3, 5, 7, 8, 10, 12] },
  { id: 'ajam', label: 'Ajam sur Do', tonic: 48, semis: [0, 2, 4, 5, 7, 9, 11, 12] },
  { id: 'saba', label: 'Saba sur Ré', tonic: 50, semis: [0, 1.5, 3, 4, 7, 8, 10, 12] },
  { id: 'sikah', label: 'Sikah sur Mi½♭', tonic: 51.5, semis: [0, 1.5, 3.5, 5.5, 7, 8.5, 10.5, 12] }
];

// ---------- son pincé (synthèse Karplus-Strong) ----------

const plucks = new Map<number, AudioBuffer>();

function pluckBuffer(c: BaseAudioContext, period: number, hz: number): AudioBuffer {
  const cached = plucks.get(period);
  if (cached) return cached;
  const len = Math.floor(c.sampleRate * 2.2);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  const rho = Math.pow(0.001, 1 / (hz * 2.6)); // extinction en 2,6 s environ, quelle que soit la note
  let last = 0;
  for (let i = 0; i < len; i++) {
    if (i <= period) {
      // bruit adouci : l'attaque d'un plectre (risha)
      last = last * 0.45 + (Math.random() * 2 - 1) * 0.55;
      d[i] = last;
    } else {
      d[i] = (rho * (d[i - period] + d[i - period - 1])) / 2;
    }
  }
  for (let i = 0; i < 2000; i++) d[len - 1 - i] *= i / 2000;
  plucks.set(period, buf);
  return buf;
}

/** Joue une note au son de oud (les quarts de ton sont exacts). `when` : temps du contexte audio. */
export function playOud(p: number, durationSec = 1.2, velocity = 80, when = 0): void {
  const { ctx, out } = audioOut();
  const t0 = Math.max(ctx.currentTime, when || ctx.currentTime);
  const hz = pitchToHz(p, refHz());
  // le filtre de la boucle retarde d'un demi-échantillon ; la vitesse de lecture corrige le reste
  const period = Math.max(2, Math.round(ctx.sampleRate / hz - 0.5));
  const actual = ctx.sampleRate / (period + 0.5);
  const src = ctx.createBufferSource();
  src.buffer = pluckBuffer(ctx, period, actual);
  src.playbackRate.value = hz / actual;
  const body = ctx.createBiquadFilter();
  body.type = 'lowpass';
  body.frequency.value = 3200;
  const g = ctx.createGain();
  const level = Math.pow(Math.max(1, velocity) / 127, 1.4) * 1.3;
  const end = t0 + Math.max(0.15, durationSec);
  g.gain.setValueAtTime(level, t0);
  g.gain.setTargetAtTime(0, end, 0.12);
  src.connect(body).connect(g).connect(out);
  src.start(t0);
  src.stop(end + 0.8);
  micInput.mute((t0 - ctx.currentTime + Math.max(0.15, durationSec)) * 1000 + 450);
}

// ---------- manche à l'écran ----------

const NECK_SPAN = 14; // demi-tons affichés après le sillet
const neckX = (n: number) => ((1 - Math.pow(2, -n / 12)) / (1 - Math.pow(2, -NECK_SPAN / 12))) * 100;
const neckN = (x: number) => -12 * Math.log2(1 - (x / 100) * (1 - Math.pow(2, -NECK_SPAN / 12)));

/** Le manche, grave en haut (comme on le voit en jouant) ; même rôle que le clavier du piano. */
export class OudNeck {
  readonly el: HTMLDivElement;
  labels: 'none' | 'c' | 'all' = 'none';
  private board: HTMLDivElement;
  private strings: number[] = currentStrings();
  private marks = new Map<number, HTMLDivElement>();
  private heard: HTMLDivElement | null = null;

  constructor(private onTap: (p: number) => void) {
    this.el = document.createElement('div');
    this.el.className = 'neck';
    this.board = document.createElement('div');
    this.board.className = 'neck-board';
    this.el.appendChild(this.board);
    this.el.addEventListener('pointerdown', e => this.tap(e));
    this.el.addEventListener('contextmenu', e => e.preventDefault());
    this.render();
  }

  setRange(): void { /* le manche est toujours affiché en entier */ }
  setLabels(): void { /* les noms de cordes sont toujours visibles */ }

  /** À rappeler si l'accord de l'instrument a changé. */
  refresh(): void {
    this.strings = currentStrings();
    this.render();
  }

  private render(): void {
    this.board.replaceChildren();
    this.marks.clear();
    this.heard = null;
    for (let n = 1; n <= NECK_SPAN; n++) {
      const l = document.createElement('div');
      l.className = 'neck-pos' + ([5, 7, 12].includes(n) ? ' strong' : '');
      l.style.left = `${neckX(n)}%`;
      this.board.appendChild(l);
    }
    this.strings.forEach((open, i) => {
      const y = this.rowY(i);
      const line = document.createElement('div');
      line.className = 'neck-string';
      line.style.top = `${y}%`;
      this.board.appendChild(line);
      const lab = document.createElement('span');
      lab.className = 'neck-label';
      lab.style.top = `${y}%`;
      lab.textContent = oudName(open);
      this.board.appendChild(lab);
    });
  }

  private rowY(i: number): number { return ((i + 0.5) / this.strings.length) * 100; }

  private dot(p: number, cls: string): HTMLDivElement | null {
    const pos = positionOf(p, this.strings);
    if (!pos || pos.offset > NECK_SPAN) return null;
    const d = document.createElement('div');
    d.className = `neck-dot ${cls}`;
    d.style.left = `${neckX(pos.offset)}%`;
    d.style.top = `${this.rowY(pos.string)}%`;
    d.textContent = oudName(p);
    this.board.appendChild(d);
    return d;
  }

  setExpected(marks: Map<number, KeyMark>): void {
    this.marks.forEach(d => d.remove());
    this.marks.clear();
    marks.forEach((mark, p) => {
      const d = this.dot(p, mark === 'auto' ? 'auto' : 'expected');
      if (d) this.marks.set(p, d);
    });
  }

  clearDone(): void { this.marks.forEach(d => d.classList.remove('done')); }
  setDone(p: number, done: boolean): void { this.marks.get(p)?.classList.toggle('done', done); }

  setHeld(p: number, held: boolean): void {
    this.heard?.remove();
    this.heard = held ? this.dot(p, 'heard') : null;
  }

  flashWrong(p: number): void {
    const d = this.dot(p, 'wrong');
    if (d) setTimeout(() => d.remove(), 500);
  }

  private tap(e: PointerEvent): void {
    e.preventDefault();
    const r = this.board.getBoundingClientRect();
    const row = Math.max(0, Math.min(this.strings.length - 1, Math.floor(((e.clientY - r.top) / r.height) * this.strings.length)));
    const x = ((e.clientX - r.left) / r.width) * 100;
    const n = x <= 1.5 ? 0 : Math.round(neckN(Math.min(100, x)) * 2) / 2;
    this.onTap(this.strings[row] + n);
  }
}
