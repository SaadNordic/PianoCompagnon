// Modules d'apprentissage : lecture de notes, accords, gammes, oreille.
// Tout se joue au piano MIDI (ou au clavier à l'écran).

import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import { Keyboard, frName, isBlack, type KeyMark } from './keyboard';
import { midiInput } from './midiInput';
import { playNote, unlockAudio } from './synth';
import { pref, setPref, upref, setUpref } from './storage';
import { h } from './ui';
import {
  CHORDS, SCALES, STEP_PC, STEP_LETTERS, spName, spPc, spell, parseSp, scaleNotes, miniScoreXml, pick,
  keyFifths, keyLabel, placeScale, scaleScoreXml,
  type Sp, type ChordType, type ScaleType
} from './theory';

/** Petite partition OSMD, sans titre ni marges. */
function createMiniOsmd(el: HTMLElement): OpenSheetMusicDisplay {
  const osmd = new OpenSheetMusicDisplay(el, {
    backend: 'svg', autoResize: false, drawTitle: false, drawPartNames: false, drawMeasureNumbers: false,
    drawComposer: false, drawCredits: false, pageBackgroundColor: '#fffdf8'
  });
  osmd.EngravingRules.PageTopMargin = 0;
  osmd.EngravingRules.PageBottomMargin = 0;
  return osmd;
}

/** Recadre le dessin sur la portée pour qu'elle remplisse le cadre. */
function fitStaff(el: HTMLElement): void {
  const svg = el.querySelector('svg');
  if (!svg) return;
  const bb = svg.getBBox();
  svg.setAttribute('viewBox', `${bb.x - 6} ${bb.y - 4} ${bb.width + 12} ${bb.height + 8}`);
  svg.setAttribute('width', '100%');
  svg.removeAttribute('height');
  svg.style.height = 'auto';
}

export interface ExerciseInfo { id: string; icon: string; title: string; desc: string }
export const EXERCISES: ExerciseInfo[] = [
  { id: 'lecture', icon: '🎼', title: 'Lecture de notes', desc: 'Une note s\'affiche sur la portée : jouez-la.' },
  { id: 'accords', icon: '🎹', title: 'Accords', desc: 'Jouez l\'accord demandé, du majeur aux renversements et septièmes.' },
  { id: 'gammes', icon: '🪜', title: 'Gammes', desc: 'Jouez la gamme montante, majeure ou mineure.' },
  { id: 'oreille', icon: '👂', title: 'Oreille', desc: 'Écoutez une petite mélodie, puis rejouez-la.' }
];

interface Stats { total: number; best: number }
export const getStats = (id: string) => upref<Stats>('stats.' + id, { total: 0, best: 0 });

interface Level { label: string }

/** Socle commun : en-tête, niveau, score, zone de consigne, clavier. */
abstract class Trainer<L extends Level> {
  readonly el: HTMLElement;
  protected stage = h('div', { class: 'stage' });
  protected prompt = h('div', { class: 'prompt' });
  protected feedback = h('div', { class: 'feedback' });
  protected actions = h('div', { class: 'tr-actions' });
  protected kb: Keyboard;
  protected level: L;
  protected busy = false; // pendant une transition ou une écoute
  protected errors = 0; // erreurs sur la question en cours
  private scoreEl = h('div', { class: 'tr-score' });
  private streak = 0;
  private good = 0;
  private bad = 0;
  private unsub: (() => void)[] = [];
  private timers: number[] = [];
  protected askedAt = 0;

  constructor(protected info: ExerciseInfo, protected levels: L[], private onBack: () => void) {
    this.level = levels[Math.min(levels.length - 1, pref('level.' + info.id, 0))];
    this.kb = new Keyboard(
      m => { unlockAudio(); playNote(m, 0.8, 85); midiInput.noteOn(m, 85); },
      m => midiInput.noteOff(m)
    );
    this.kb.setLabels(pref('labels', 'c'));
    const sel = h('select', { onchange: (e: Event) => {
      const i = Number((e.target as HTMLSelectElement).value);
      this.level = this.levels[i];
      setPref('level.' + info.id, i);
      this.setup();
      this.next();
    } }, levels.map((l, i) => {
      const o = h('option', { value: String(i) }, l.label) as HTMLOptionElement;
      if (l === this.level) o.selected = true;
      return o;
    }));
    this.el = h('div', { class: 'trainer' }, [
      h('header', { class: 'bar' }, [
        h('button', { class: 'icon', title: 'Retour', onclick: () => this.onBack() }, '←'),
        h('div', { class: 'title' }, `${info.icon} ${info.title}`),
        sel,
        this.scoreEl
      ]),
      h('div', { class: 'tr-body' }, [this.prompt, this.stage, this.feedback, this.actions]),
      this.kb.el
    ]);
  }

  mount(): void {
    this.unsub.push(
      midiInput.onNoteOn(m => {
        this.kb.setHeld(m, true);
        if (!this.busy) this.onNote(m);
      }),
      midiInput.onNoteOff(m => this.kb.setHeld(m, false))
    );
    this.setup();
    this.renderScore();
    this.next();
  }

  destroy(): void {
    this.unsub.forEach(f => f());
    this.timers.forEach(t => clearTimeout(t));
  }

  protected later(fn: () => void, ms: number): void {
    this.timers.push(window.setTimeout(fn, ms));
  }

  /** Préparation à chaque changement de niveau (plage du clavier, etc.). */
  protected abstract setup(): void;
  protected abstract ask(): void;
  protected abstract onNote(m: number): void;

  protected next(): void {
    this.errors = 0;
    this.busy = false;
    this.feedback.textContent = '';
    this.feedback.className = 'feedback';
    this.kb.setExpected(new Map());
    this.kb.clearDone();
    this.askedAt = performance.now();
    this.ask();
  }

  protected success(msg: string, delay = 900): void {
    this.busy = true;
    this.good++;
    this.streak++;
    const st = getStats(this.info.id);
    st.total++;
    st.best = Math.max(st.best, this.streak);
    setUpref('stats.' + this.info.id, st);
    const secs = ((performance.now() - this.askedAt) / 1000).toFixed(1).replace('.', ',');
    this.feedback.textContent = `✔ ${msg}  ·  ${secs} s`;
    this.feedback.className = 'feedback ok';
    this.renderScore();
    this.later(() => this.next(), delay);
  }

  protected fail(m: number, msg = ''): void {
    this.bad++;
    this.errors++;
    this.streak = 0;
    this.kb.flashWrong(m);
    this.feedback.textContent = msg || `✘ ${frName(m)}`;
    this.feedback.className = 'feedback bad';
    this.renderScore();
  }

  private renderScore(): void {
    this.scoreEl.innerHTML = '';
    this.scoreEl.append(
      h('span', { class: 'g' }, `✔ ${this.good}`),
      h('span', { class: 'b' }, `✘ ${this.bad}`),
      h('span', { class: 's', title: 'Série en cours' }, `🔥 ${this.streak}`)
    );
  }

  protected button(label: string, fn: () => void): HTMLButtonElement {
    return h('button', { onclick: fn }, label) as HTMLButtonElement;
  }

  protected mark(midis: number[], kind: KeyMark = 'R'): void {
    this.kb.setExpected(new Map(midis.map(m => [m, kind])));
  }
}

// =====================================================================
// Lecture de notes
// =====================================================================

interface ReadLevel extends Level { clef: 'G' | 'F' | 'both'; G: [number, number]; F: [number, number]; acc: boolean }
const READ_LEVELS: ReadLevel[] = [
  { label: 'Clé de sol — Do3 à Sol4', clef: 'G', G: [60, 79], F: [0, 0], acc: false },
  { label: 'Clé de fa — Fa1 à Do3', clef: 'F', G: [0, 0], F: [41, 60], acc: false },
  { label: 'Les deux clés', clef: 'both', G: [60, 79], F: [41, 60], acc: false },
  { label: 'Lignes supplémentaires', clef: 'both', G: [57, 88], F: [33, 64], acc: false },
  { label: 'Dièses et bémols', clef: 'both', G: [60, 79], F: [41, 60], acc: true }
];

class ReadingTrainer extends Trainer<ReadLevel> {
  private osmd!: OpenSheetMusicDisplay;
  private staffEl = h('div', { class: 'mini-staff' });
  private target = 60;
  private targetSp: Sp = { step: 0, alter: 0 };
  private last = -1;

  protected setup(): void {
    if (!this.osmd) {
      this.stage.append(this.staffEl);
      this.osmd = createMiniOsmd(this.staffEl);
      this.actions.append(this.button('💡 Indice', () => this.reveal()));
    }
    const lo = this.level.clef === 'G' ? this.level.G[0] : this.level.F[0];
    const hi = this.level.clef === 'F' ? this.level.F[1] : this.level.G[1];
    this.kb.setRange(lo, hi);
  }

  protected ask(): void {
    const clef: 'G' | 'F' = this.level.clef === 'both' ? (Math.random() < 0.5 ? 'G' : 'F') : this.level.clef;
    const [lo, hi] = this.level[clef];
    let m: number;
    do { m = lo + Math.floor(Math.random() * (hi - lo + 1)); } while (m === this.last || (!this.level.acc && isBlack(m)));
    this.last = m;
    this.target = m;
    const pc = m % 12;
    let sp: Sp;
    if (!isBlack(m)) sp = { step: STEP_PC.indexOf(pc), alter: 0 };
    else if (Math.random() < 0.5) sp = { step: STEP_PC.indexOf(pc - 1), alter: 1 };
    else sp = { step: STEP_PC.indexOf(pc + 1), alter: -1 };
    this.targetSp = sp;
    const octave = Math.floor((m - sp.alter) / 12) - 1;
    this.prompt.textContent = 'Jouez cette note';
    void this.draw(miniScoreXml([{ sp, octave }], clef));
  }

  private async draw(xml: string): Promise<void> {
    await this.osmd.load(xml);
    this.osmd.Zoom = 1;
    this.osmd.render();
    fitStaff(this.staffEl);
  }

  private reveal(): void {
    this.mark([this.target]);
    this.feedback.textContent = `C'est un ${spName(this.targetSp)} (${frName(this.target)})`;
    this.feedback.className = 'feedback hint';
  }

  protected onNote(m: number): void {
    if (m === this.target) {
      this.kb.setDone(m, true);
      this.success(`${spName(this.targetSp)} (${frName(this.target)})`, 700);
    } else if (m % 12 === this.target % 12) {
      this.fail(m, '≈ Bonne note, mauvaise octave');
    } else {
      this.fail(m);
      if (this.errors >= 2) this.reveal();
    }
  }
}

// =====================================================================
// Accords
// =====================================================================

interface ChordLevel extends Level { types: string[]; roots: string[]; inversions?: boolean }
const WHITE_ROOTS = ['Do', 'Ré', 'Mi', 'Fa', 'Sol', 'La', 'Si'];
const ALL_ROOTS = [...WHITE_ROOTS, 'Do♯', 'Ré♭', 'Mi♭', 'Fa♯', 'La♭', 'Si♭'];
const CHORD_LEVELS: ChordLevel[] = [
  { label: 'Majeurs', types: ['maj'], roots: ['Do', 'Ré', 'Mi', 'Fa', 'Sol', 'La'] },
  { label: 'Majeurs et mineurs', types: ['maj', 'min'], roots: WHITE_ROOTS.slice(0, 6) },
  { label: 'Majeurs et mineurs, toutes tonalités', types: ['maj', 'min'], roots: ALL_ROOTS },
  { label: 'Diminués, augmentés, sus', types: ['dim', 'aug', 'sus2', 'sus4', 'maj', 'min'], roots: WHITE_ROOTS },
  { label: 'Accords de septième', types: ['dom7', 'maj7', 'min7'], roots: ALL_ROOTS },
  { label: 'Renversements', types: ['maj', 'min'], roots: WHITE_ROOTS.slice(0, 6), inversions: true }
];

const INV_LABEL = ['position fondamentale', '1er renversement', '2e renversement', '3e renversement'];

class ChordTrainer extends Trainer<ChordLevel> {
  private notes: Sp[] = [];
  private pcs = new Set<number>();
  private bassPc: number | null = null;
  private recent = new Map<number, number>();
  private type!: ChordType;
  private root!: Sp;
  private title = h('div', { class: 'big-name' });
  private sub = h('div', { class: 'sub-name' });
  private spelled = h('div', { class: 'spelled' });

  protected setup(): void {
    if (!this.stage.childElementCount) {
      this.stage.append(this.title, this.sub, this.spelled);
      this.actions.append(this.button('💡 Indice', () => this.hint()), this.button('Passer', () => this.next()));
    }
    this.kb.setRange(48, 83);
  }

  protected ask(): void {
    this.type = CHORDS[pick(this.level.types)];
    let rootName = pick(this.level.roots);
    // évite les fondamentales qui donneraient des doubles altérations
    if (this.type.id === 'dim' && rootName.endsWith('♭')) rootName = rootName.slice(0, -1);
    if (this.type.id === 'aug' && rootName.endsWith('♯')) rootName = rootName.slice(0, -1);
    this.root = parseSp(rootName);
    this.notes = spell(this.root, this.type.steps, this.type.semis);
    this.pcs = new Set(this.notes.map(spPc));
    this.recent.clear();
    const inv = this.level.inversions ? Math.floor(Math.random() * this.notes.length) : 0;
    this.bassPc = this.level.inversions ? spPc(this.notes[inv]) : null;
    const intl = STEP_LETTERS[this.root.step] + (this.root.alter === 1 ? '#' : this.root.alter === -1 ? 'b' : '') +
      (this.type.symbol === '7M' ? 'maj7' : this.type.symbol);
    const symbol = `${spName(this.root)}${this.type.symbol}  ·  ${intl}`;
    this.prompt.textContent = 'Jouez l\'accord';
    this.title.textContent = `${spName(this.root)} ${this.type.label}`;
    this.sub.textContent = this.level.inversions
      ? `${INV_LABEL[inv]}${inv ? ` — ${spName(this.notes[inv])} à la basse` : ''}`
      : symbol;
    this.spelled.textContent = '';
  }

  private chordMidis(): number[] {
    const inv = this.bassPc === null ? 0 : this.notes.findIndex(n => spPc(n) === this.bassPc);
    const order = [...this.notes.slice(inv), ...this.notes.slice(0, inv)];
    let prev = 59 + ((spPc(order[0]) - 59 % 12 + 12) % 12) - 12;
    if (prev < 52) prev += 12;
    return order.map((n, i) => {
      if (i === 0) return prev;
      const m = prev + ((spPc(n) - prev % 12 + 12) % 12 || 12);
      prev = m;
      return m;
    });
  }

  private hint(): void {
    this.mark(this.chordMidis());
    this.spelled.textContent = this.notes.map(spName).join(' – ');
  }

  protected onNote(m: number): void {
    const t = performance.now();
    this.recent.set(m, t);
    if (!this.pcs.has(m % 12)) {
      this.recent.delete(m); // une fausse note ne « pollue » pas la suite
      this.fail(m);
      if (this.errors >= 3) this.hint();
      return;
    }
    this.kb.setDone(m, true);
    const active = [...this.recent.entries()].filter(([k, at]) => midiInput.held.has(k) || t - at < 1500).map(([k]) => k);
    const pcsPlayed = new Set(active.map(k => k % 12));
    const complete = [...this.pcs].every(p => pcsPlayed.has(p)) && [...pcsPlayed].every(p => this.pcs.has(p));
    if (!complete) return;
    if (this.bassPc !== null && Math.min(...active) % 12 !== this.bassPc) {
      const bass = this.notes.find(n => spPc(n) === this.bassPc)!;
      this.fail(Math.min(...active), `≈ Bon accord, mais il faut ${spName(bass)} à la basse`);
      this.recent.clear();
      return;
    }
    this.spelled.textContent = this.notes.map(spName).join(' – ');
    this.success(`${spName(this.root)} ${this.type.label}`, 1300);
  }
}

// =====================================================================
// Gammes
// =====================================================================

interface ScaleLevel extends Level { type: string; roots: string[] }
const SCALE_LEVELS: ScaleLevel[] = [
  { label: 'Majeures : Do, Sol, Ré, Fa', type: 'major', roots: ['Do', 'Sol', 'Ré', 'Fa'] },
  { label: 'Toutes les majeures', type: 'major', roots: ['Do', 'Sol', 'Ré', 'La', 'Mi', 'Si', 'Fa♯', 'Fa', 'Si♭', 'Mi♭', 'La♭', 'Ré♭'] },
  { label: 'Mineures harmoniques', type: 'harm', roots: ['La', 'Mi', 'Ré', 'Si', 'Sol', 'Do', 'Fa♯', 'Fa'] }
];

class ScaleTrainer extends Trainer<ScaleLevel> {
  private notes: Sp[] = [];
  private pos = 0;
  private prev = 0;
  private played: number[] = [];
  private title = h('div', { class: 'big-name' });
  private seq = h('div', { class: 'seq' });
  private staffEl = h('div', { class: 'mini-staff scale-staff' });
  private keyInfo = h('div', { class: 'key-info' });
  private osmd!: OpenSheetMusicDisplay;
  private staffNotes: Element[] = [];
  private drawId = 0; // ignore un dessin devenu obsolète (« Passer » rapide)
  private type!: ScaleType;
  private root!: Sp;
  private showAll = false;

  protected setup(): void {
    if (!this.stage.childElementCount) {
      this.stage.classList.add('scale-stage');
      this.stage.append(this.title, this.staffEl, this.keyInfo, this.seq);
      this.osmd = createMiniOsmd(this.staffEl);
      this.actions.append(
        this.button('💡 Montrer les notes', () => { this.showAll = true; this.renderSeq(); }),
        this.button('↺ Recommencer', () => { this.pos = 0; this.played = []; this.kb.clearDone(); this.renderSeq(); }),
        this.button('Passer', () => this.next())
      );
    }
    this.kb.setRange(48, 84);
  }

  protected ask(): void {
    this.type = SCALES[this.level.type];
    this.root = parseSp(pick(this.level.roots));
    this.notes = scaleNotes(this.root, this.type);
    this.pos = 0;
    this.played = [];
    this.showAll = false;
    this.prompt.textContent = 'Lisez la portée et jouez la gamme montante (une octave)';
    this.title.textContent = `${spName(this.root)} ${this.type.label}`;
    const fifths = keyFifths(this.root, this.type);
    const leading = this.notes[6];
    this.keyInfo.textContent = `Armure : ${keyLabel(fifths)}` +
      (this.type.id === 'harm' ? ` · 7e note haussée : ${spName(leading)}${leading.alter ? '' : '♮'}` : '');
    this.staffNotes = [];
    this.renderSeq();
    void this.drawStaff(fifths);
  }

  private async drawStaff(fifths: number): Promise<void> {
    const id = ++this.drawId;
    await this.osmd.load(scaleScoreXml(placeScale(this.notes), fifths));
    if (id !== this.drawId) return;
    this.osmd.Zoom = 1;
    // dessin à largeur fixe puis mis à l'échelle : sur petit écran, les deux mesures restent sur une seule ligne
    this.staffEl.style.width = '640px';
    this.osmd.render();
    this.staffEl.style.width = '';
    fitStaff(this.staffEl);
    this.staffNotes = [...this.staffEl.querySelectorAll('.vf-stavenote')];
    this.renderSeq();
  }

  private renderSeq(): void {
    this.seq.innerHTML = '';
    this.notes.forEach((n, i) => {
      const done = i < this.pos;
      this.seq.append(h('span', { class: done ? 'done' : i === this.pos ? 'cur' : '' }, done || this.showAll ? spName(n) : '?'));
    });
    this.staffNotes.forEach((g, i) => {
      g.classList.toggle('done', i < this.pos);
      g.classList.toggle('cur', i === this.pos);
    });
  }

  protected onNote(m: number): void {
    const want = spPc(this.notes[this.pos]);
    const ok = m % 12 === want && (this.pos === 0 || (m > this.prev && m - this.prev <= 3));
    if (!ok) {
      this.fail(m, m % 12 === want ? '✘ Montez : la note suivante est juste au-dessus' : `✘ ${frName(m, false)} — attendu : ${this.showAll ? spName(this.notes[this.pos]) : 'la note suivante de la gamme'}`);
      if (this.errors >= 3) { this.showAll = true; this.renderSeq(); }
      return;
    }
    this.prev = m;
    this.played.push(m);
    this.kb.setDone(m, true);
    this.pos++;
    this.feedback.textContent = '';
    this.renderSeq();
    if (this.pos === this.notes.length) this.success(`Gamme de ${spName(this.root)} ${this.type.label}`, 1500);
  }
}

// =====================================================================
// Oreille : répéter une mélodie
// =====================================================================

interface EarLevel extends Level { len: number; leap: number; chromatic: boolean }
const EAR_LEVELS: EarLevel[] = [
  { label: '3 notes, pas conjoints', len: 3, leap: 1, chromatic: false },
  { label: '4 notes', len: 4, leap: 2, chromatic: false },
  { label: '5 notes', len: 5, leap: 2, chromatic: false },
  { label: '6 notes avec sauts', len: 6, leap: 4, chromatic: false },
  { label: '4 notes chromatiques', len: 4, leap: 3, chromatic: true }
];
const C_MAJOR = [60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79];

class EarTrainer extends Trainer<EarLevel> {
  private melody: number[] = [];
  private pos = 0;
  private dots = h('div', { class: 'seq' });

  protected setup(): void {
    if (!this.stage.childElementCount) {
      this.stage.append(this.dots);
      this.actions.append(this.button('🔊 Réécouter', () => this.play()), this.button('💡 Indice', () => this.hint()), this.button('Passer', () => this.next()));
    }
    this.kb.setRange(57, 81);
  }

  protected ask(): void {
    const mel: number[] = [];
    if (this.level.chromatic) {
      let m = 62 + Math.floor(Math.random() * 10);
      for (let i = 0; i < this.level.len; i++) {
        mel.push(m);
        do { m = mel[mel.length - 1] + (Math.floor(Math.random() * 9) - 4); } while (m === mel[mel.length - 1] || m < 57 || m > 81);
      }
    } else {
      let i = 1 + Math.floor(Math.random() * 6);
      for (let k = 0; k < this.level.len; k++) {
        mel.push(C_MAJOR[i]);
        let step;
        do { step = Math.floor(Math.random() * (2 * this.level.leap + 1)) - this.level.leap; } while (step === 0 || i + step < 0 || i + step >= C_MAJOR.length);
        i += step;
      }
    }
    this.melody = mel;
    this.pos = 0;
    this.prompt.textContent = `Écoutez, puis rejouez — première note : ${frName(mel[0])}`;
    this.mark([mel[0]], 'auto');
    this.renderDots();
    this.later(() => this.play(), 400);
  }

  private renderDots(): void {
    this.dots.innerHTML = '';
    this.melody.forEach((m, i) => this.dots.append(h('span', { class: i < this.pos ? 'done' : i === this.pos ? 'cur' : '' }, i < this.pos ? frName(m, false) : '●')));
  }

  private play(): void {
    unlockAudio();
    this.busy = true;
    const gap = 0.55;
    this.melody.forEach((m, i) => this.later(() => playNote(m, gap * 0.95, 90), i * gap * 1000));
    this.later(() => { this.busy = false; }, this.melody.length * gap * 1000);
  }

  private hint(): void {
    this.mark([this.melody[this.pos]]);
  }

  protected onNote(m: number): void {
    if (m !== this.melody[this.pos]) {
      this.fail(m, m % 12 === this.melody[this.pos] % 12 ? '≈ Bonne note, mauvaise octave' : `✘ ${frName(m)} — ${m < this.melody[this.pos] ? 'plus haut' : 'plus bas'}`);
      return;
    }
    this.pos++;
    this.kb.setDone(m, true);
    this.feedback.textContent = '';
    this.kb.setExpected(new Map());
    this.renderDots();
    if (this.pos === this.melody.length) this.success('Mélodie retrouvée', 1300);
  }
}

// =====================================================================

export function createTrainer(id: string, onBack: () => void): { el: HTMLElement; mount(): void; destroy(): void } | null {
  const info = EXERCISES.find(e => e.id === id);
  if (!info) return null;
  switch (id) {
    case 'lecture': return new ReadingTrainer(info, READ_LEVELS, onBack);
    case 'accords': return new ChordTrainer(info, CHORD_LEVELS, onBack);
    case 'gammes': return new ScaleTrainer(info, SCALE_LEVELS, onBack);
    case 'oreille': return new EarTrainer(info, EAR_LEVELS, onBack);
  }
  return null;
}

