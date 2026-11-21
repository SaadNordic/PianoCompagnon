// Clavier à l'écran : affiche les notes attendues / jouées et se joue au doigt.

export type KeyMark = 'R' | 'L' | 'auto';
const BLACK = new Set([1, 3, 6, 8, 10]);
const FR = ['Do', 'Do♯', 'Ré', 'Ré♯', 'Mi', 'Fa', 'Fa♯', 'Sol', 'Sol♯', 'La', 'La♯', 'Si'];

/** Nom français d'une note, convention française : do central (MIDI 60) = Do3. */
export function frName(midi: number, withOctave = true): string {
  return FR[midi % 12] + (withOctave ? String(Math.floor(midi / 12) - 2) : '');
}
export const isBlack = (midi: number) => BLACK.has(midi % 12);

export class Keyboard {
  readonly el: HTMLDivElement;
  private keys = new Map<number, HTMLDivElement>();
  private lo = 48;
  private hi = 84;
  private pointers = new Map<number, number>();
  labels: 'none' | 'c' | 'all' = 'c';

  constructor(private onPress: (m: number) => void, private onRelease: (m: number) => void) {
    this.el = document.createElement('div');
    this.el.className = 'kb';
    this.el.addEventListener('pointerdown', e => this.down(e));
    this.el.addEventListener('pointermove', e => this.move(e));
    for (const t of ['pointerup', 'pointercancel', 'pointerleave'] as const) this.el.addEventListener(t, e => this.up(e));
    this.el.addEventListener('contextmenu', e => e.preventDefault());
  }

  /** Plage affichée, élargie à des octaves complètes (do à si). */
  setRange(lo: number, hi: number): void {
    lo = Math.max(21, lo - (lo % 12));
    hi = Math.min(108, hi + (11 - (hi % 12)));
    if (hi - lo < 23) hi = Math.min(108, lo + 23);
    this.lo = lo;
    this.hi = hi;
    this.render();
  }

  private render(): void {
    this.el.innerHTML = '';
    this.keys.clear();
    const whites: number[] = [];
    for (let m = this.lo; m <= this.hi; m++) if (!isBlack(m)) whites.push(m);
    const w = 100 / whites.length;
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
        const showLabel = this.labels === 'all' || (this.labels === 'c' && m % 12 === 0);
        if (showLabel) {
          const s = document.createElement('span');
          s.textContent = frName(m, m % 12 === 0);
          k.appendChild(s);
        }
        wi++;
      }
      this.keys.set(m, k);
      this.el.appendChild(k);
    }
  }

  setLabels(l: 'none' | 'c' | 'all'): void {
    this.labels = l;
    this.render();
  }

  /** Notes attendues (bleu = main droite, orange = main gauche, gris = jouées par l'appli). */
  setExpected(marks: Map<number, KeyMark>): void {
    this.keys.forEach((k, m) => {
      const mark = marks.get(m);
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
    return k && this.el.contains(k) ? Number(k.dataset.midi) : null;
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
