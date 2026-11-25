// Clavier à l'écran : affiche les notes attendues / jouées et se joue au doigt.

export type KeyMark = 'R' | 'L' | 'auto';
const BLACK = new Set([1, 3, 6, 8, 10]);
const FR = ['Do', 'Do♯', 'Ré', 'Ré♯', 'Mi', 'Fa', 'Fa♯', 'Sol', 'Sol♯', 'La', 'La♯', 'Si'];

/** Nom français d'une note, convention française : do central (MIDI 60) = Do3. */
export function frName(midi: number, withOctave = true): string {
  return FR[midi % 12] + (withOctave ? String(Math.floor(midi / 12) - 2) : '');
}
export const isBlack = (midi: number) => BLACK.has(midi % 12);

const MAX_SPAN = 7;
const spanPref = () => { try { return Number(localStorage.getItem('pc.kb.span') ?? '0') || 0; } catch { return 0; } };
const setSpanPref = (n: number) => { try { localStorage.setItem('pc.kb.span', String(n)); } catch { /* ignoré */ } };

export class Keyboard {
  /** Le clavier et sa petite barre de réglage (largeur, octave). */
  readonly el: HTMLDivElement;
  private keysEl: HTMLDivElement;
  private infoEl: HTMLSpanElement;
  private keys = new Map<number, HTMLDivElement>();
  private lo = 48;
  private hi = 84;
  private want: [number, number] = [48, 84];
  /** Nombre d'octaves visibles (0 = tout ce dont le morceau a besoin). Commun à tous les écrans. */
  private span = spanPref();
  private start: number | null = null;
  private marks = new Map<number, KeyMark>();
  private pointers = new Map<number, number>();
  labels: 'none' | 'c' | 'all' = 'c';

  constructor(private onPress: (m: number) => void, private onRelease: (m: number) => void) {
    this.keysEl = document.createElement('div');
    this.keysEl.className = 'kb';
    this.keysEl.addEventListener('pointerdown', e => this.down(e));
    this.keysEl.addEventListener('pointermove', e => this.move(e));
    for (const t of ['pointerup', 'pointercancel', 'pointerleave'] as const) this.keysEl.addEventListener(t, e => this.up(e));
    this.keysEl.addEventListener('contextmenu', e => e.preventDefault());
    const btn = (label: string, title: string, fn: () => void) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', fn);
      return b;
    };
    this.infoEl = document.createElement('span');
    this.infoEl.className = 'kb-info';
    const bar = document.createElement('div');
    bar.className = 'kb-ctl';
    bar.append(
      btn('◀', 'Une octave plus grave', () => this.shift(-12)),
      btn('▶', 'Une octave plus aiguë', () => this.shift(12)),
      this.infoEl,
      btn('🔍＋', 'Touches plus grandes (moins d’octaves visibles)', () => this.zoom(-1)),
      btn('🔍－', 'Touches plus petites (plus d’octaves visibles)', () => this.zoom(1))
    );
    this.el = document.createElement('div');
    this.el.className = 'kb-wrap';
    this.el.append(bar, this.keysEl);
  }

  /** Plage voulue par l'écran (élargie à des octaves complètes) ; la largeur choisie par l'utilisateur prime. */
  setRange(lo: number, hi: number): void {
    this.want = [lo, hi];
    this.start = null;
    this.apply();
  }

  private apply(): void {
    let [lo, hi] = this.want;
    lo = Math.max(21, lo - (lo % 12));
    hi = Math.min(108, hi + (11 - (hi % 12)));
    if (hi - lo < 23) hi = Math.min(108, lo + 23);
    if (this.span) {
      const len = this.span * 12;
      // fenêtre centrée sur la plage voulue, sur des do
      if (this.start === null) this.start = Math.max(lo, lo + Math.floor((hi - lo + 1 - len) / 24) * 12);
      this.start = Math.max(12, Math.min(108 - len + 1, this.start));
      lo = this.start;
      hi = Math.min(108, lo + len - 1);
    }
    this.lo = lo;
    this.hi = hi;
    this.render();
  }

  private zoom(d: number): void {
    const cur = this.span || Math.round((this.hi - this.lo + 1) / 12);
    const next = Math.max(1, Math.min(MAX_SPAN, cur + d));
    this.start = this.span ? this.start : this.lo;
    this.span = next;
    setSpanPref(next);
    this.apply();
  }

  private shift(d: number): void {
    if (!this.span) { this.span = Math.round((this.hi - this.lo + 1) / 12); setSpanPref(this.span); }
    this.start = (this.start ?? this.lo) + d;
    this.apply();
  }

  private render(): void {
    this.keysEl.innerHTML = '';
    this.keys.clear();
    const whites: number[] = [];
    for (let m = this.lo; m <= this.hi; m++) if (!isBlack(m)) whites.push(m);
    const w = 100 / whites.length;
    // touches larges : tous les noms sont lisibles
    const labels = this.labels === 'c' && whites.length <= 15 ? 'all' : this.labels;
    let wi = 0;
    for (let m = this.lo; m <= this.hi; m++) {
      const k = document.createElement('div');
      k.dataset.midi = String(m);
      if (isBlack(m)) {
        k.className = 'key black';
        k.style.left = `calc(${wi * w}% - ${w * 0.3}%)`;
        k.style.width = `${w * 0.6}%`;
      } else {
        k.className = 'key white';
        k.style.left = `${wi * w}%`;
        k.style.width = `${w}%`;
        const showLabel = labels === 'all' || (labels === 'c' && m % 12 === 0);
        if (showLabel) {
          const s = document.createElement('span');
          s.textContent = frName(m, m % 12 === 0 || labels === 'all');
          k.appendChild(s);
        }
        wi++;
      }
      this.keys.set(m, k);
      this.keysEl.appendChild(k);
    }
    this.infoEl.textContent = `${frName(this.lo)} – ${frName(this.hi)}`;
    this.paintMarks();
  }

  setLabels(l: 'none' | 'c' | 'all'): void {
    this.labels = l;
    this.render();
  }

  /** Notes attendues (bleu = main droite, orange = main gauche, gris = jouées par l'appli). */
  setExpected(marks: Map<number, KeyMark>): void {
    this.marks = marks;
    // clavier agrandi : il se déplace tout seul vers les notes à jouer
    const ms = [...marks.keys()];
    if (this.span && ms.length && ms.some(m => m < this.lo || m > this.hi)) {
      const len = this.span * 12;
      const min = Math.min(...ms), max = Math.max(...ms);
      let start = min - (min % 12);
      if (max > start + len - 1) start = Math.min(start, Math.ceil((max - len + 1) / 12) * 12);
      this.start = start;
      this.apply();
      return;
    }
    this.paintMarks();
  }

  private paintMarks(): void {
    this.keys.forEach((k, m) => {
      const mark = this.marks.get(m);
      k.classList.toggle('exp-R', mark === 'R');
      k.classList.toggle('exp-L', mark === 'L');
      k.classList.toggle('exp-auto', mark === 'auto');
    });
  }

  clearDone(): void {
    this.keys.forEach(k => k.classList.remove('done'));
  }

  setDone(midi: number, done: boolean): void {
    this.keys.get(midi)?.classList.toggle('done', done);
  }

  setHeld(midi: number, held: boolean): void {
    this.keys.get(midi)?.classList.toggle('held', held);
  }

  flashWrong(midi: number): void {
    const k = this.keys.get(midi);
    if (!k) return;
    k.classList.remove('wrong');
    void k.offsetWidth;
    k.classList.add('wrong');
    setTimeout(() => k.classList.remove('wrong'), 450);
  }

  private keyAt(e: PointerEvent): number | null {
    const t = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const k = t?.closest('.key') as HTMLElement | null;
    return k && this.keysEl.contains(k) ? Number(k.dataset.midi) : null;
  }
  private down(e: PointerEvent): void {
    e.preventDefault();
    const m = this.keyAt(e);
    if (m === null) return;
    this.pointers.set(e.pointerId, m);
    this.onPress(m);
  }
  private move(e: PointerEvent): void {
    if (!this.pointers.has(e.pointerId)) return;
    const m = this.keyAt(e);
    const prev = this.pointers.get(e.pointerId)!;
    if (m !== null && m !== prev) {
      this.onRelease(prev);
      this.pointers.set(e.pointerId, m);
      this.onPress(m);
    }
  }
  private up(e: PointerEvent): void {
    const m = this.pointers.get(e.pointerId);
    if (m === undefined) return;
    this.pointers.delete(e.pointerId);
    this.onRelease(m);
  }
}
