// Exercices de oud : même principe que le piano, mais l'appli écoute au micro.

import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import { h } from './ui';
import { pref, setPref, setUpref } from './storage';
import { micInput, micBanner } from './mic';
import { notesToMusicXml } from './musicxml';
import { getStats, type ExerciseInfo } from './learn';
import { MAQAMAT, OudNeck, WRITTEN_OFFSET, currentStrings, oudName, oudSpelling, playOud, positionLabel, type Maqam } from './oud';

export const OUD_EXERCISES: ExerciseInfo[] = [
  { id: 'oud-cordes', icon: '🎯', title: 'Cordes à vide', desc: 'Reconnaître et pincer chaque corde.' },
  { id: 'oud-notes', icon: '🎼', title: 'Notes sur le manche', desc: 'Une note s’affiche : jouez-la, quarts de ton compris.' },
  { id: 'oud-maqam', icon: '🪜', title: 'Maqamat', desc: 'Montez et descendez Rast, Bayati, Hijaz, Saba…' },
  { id: 'oud-oreille', icon: '👂', title: 'Oreille', desc: 'Écoutez une phrase dans un maqam, puis rejouez-la.' }
];

interface Question {
  notes: number[];
  prompt: string;
  title?: string;
  staff?: boolean; // affiche la note sur la portée
  guide: boolean; // montre la position sur le manche
  names: boolean; // écrit le nom des notes à venir
  listen?: boolean; // l'appli joue d'abord la phrase
}
interface OudLevel { label: string; make: (prev: number | null) => Question }

const pickOther = (pool: number[], prev: number | null) => {
  const list = pool.length > 1 ? pool.filter(p => p !== prev) : pool;
  return list[Math.floor(Math.random() * list.length)];
};

function notePool(kind: 'nat' | 'alt' | 'quarter'): number[] {
  const s = currentStrings();
  const out: number[] = [];
  const nat = new Set([0, 2, 4, 5, 7, 9, 11]);
  for (let p = s[1]; p <= s[s.length - 1] + 5; p += 0.5) {
    const pc = ((p % 12) + 12) % 12;
    if (Number.isInteger(p) ? (kind === 'alt' || nat.has(pc)) : kind === 'quarter' && (pc === 3.5 || pc === 10.5)) out.push(p);
  }
  return out;
}

const noteLevel = (label: string, kind: 'nat' | 'alt' | 'quarter', guide: boolean): OudLevel => ({
  label,
  make: prev => {
    const p = pickOther(notePool(kind), prev);
    return { notes: [p], prompt: 'Jouez cette note', title: guide ? oudName(p) : undefined, staff: true, guide, names: false };
  }
});

const maqamLevel = (m: Maqam): OudLevel => ({
  label: m.label,
  make: () => {
    const up = m.semis.map(s => m.tonic + s);
    return { notes: [...up, ...up.slice(0, -1).reverse()], prompt: `Maqam ${m.label} : montez puis redescendez`, guide: true, names: true };
  }
});

function earPhrase(m: Maqam, len: number): number[] {
  const scale = m.semis.map(s => m.tonic + s);
  let i = Math.floor(Math.random() * 4);
  const out = [scale[i]];
  while (out.length < len) {
    const step = Math.random() < 0.75 ? (Math.random() < 0.5 ? -1 : 1) : (Math.random() < 0.5 ? -2 : 2);
    if (i + step < 0 || i + step >= scale.length) continue;
    i += step;
    out.push(scale[i]);
  }
  return out;
}

const earLevel = (label: string, ids: string[], len: number): OudLevel => ({
  label,
  make: () => {
    const m = MAQAMAT.find(x => x.id === ids[Math.floor(Math.random() * ids.length)])!;
    const notes = earPhrase(m, len);
    return { notes, prompt: `${m.label} — écoutez, puis rejouez. Première note : ${oudName(notes[0])}`, guide: false, names: false, listen: true };
  }
});

const LEVELS: Record<string, OudLevel[]> = {
  'oud-cordes': [
    {
      label: 'Avec le manche',
      make: prev => { const p = pickOther(currentStrings(), prev); return { notes: [p], prompt: 'Pincez la corde à vide', title: oudName(p, true), guide: true, names: false }; }
    },
    {
      label: 'Nom seulement',
      make: prev => { const p = pickOther(currentStrings(), prev); return { notes: [p], prompt: 'Pincez la corde à vide', title: oudName(p, true), guide: false, names: false }; }
    }
  ],
  'oud-notes': [
    noteLevel('Notes naturelles, avec aide', 'nat', true),
    noteLevel('Notes naturelles, sans aide', 'nat', false),
    noteLevel('Dièses et bémols', 'alt', false),
    noteLevel('Quarts de ton (Mi½♭, Si½♭)', 'quarter', false)
  ],
  'oud-maqam': MAQAMAT.map(maqamLevel),
  'oud-oreille': [
    earLevel('3 notes — Rast', ['rast'], 3),
    earLevel('4 notes — Rast, Bayati', ['rast', 'bayati'], 4),
    earLevel('5 notes — Hijaz, Nahawand', ['hijaz', 'nahawand'], 5),
    earLevel('6 notes — tous les maqamat', MAQAMAT.map(m => m.id), 6)
  ]
};

class OudTrainer {
  readonly el: HTMLElement;
  private neck: OudNeck;
  private level: OudLevel;
  private q!: Question;
  private pos = 0;
  private busy = false;
  private revealed = false;
  private last: number | null = null;
  private good = 0;
  private bad = 0;
  private streak = 0;
  private askedAt = 0;
  private timers: number[] = [];
  private unsub: (() => void)[] = [];
  private osmd: OpenSheetMusicDisplay | null = null;
  private banner = micBanner();
  private promptEl = h('div', { class: 'prompt' });
  private titleEl = h('div', { class: 'big-name' });
  private staffEl = h('div', { class: 'mini-staff', style: 'display:none' });
  private seqEl = h('div', { class: 'seq' });
  private feedback = h('div', { class: 'feedback' });
  private scoreEl = h('div', { class: 'tr-score' });
  private replayBtn: HTMLElement;

  constructor(private info: ExerciseInfo, private levels: OudLevel[], private onBack: () => void) {
    this.level = levels[Math.min(levels.length - 1, pref('level.' + info.id, 0))];
    this.neck = new OudNeck(p => { playOud(p, 0.9); micInput.press(p); });
    const sel = h('select', { onchange: (e: Event) => {
      const i = Number((e.target as HTMLSelectElement).value);
      this.level = this.levels[i];
      setPref('level.' + info.id, i);
      this.next();
    } }, levels.map((l, i) => {
      const o = h('option', { value: String(i) }, l.label) as HTMLOptionElement;
      if (l === this.level) o.selected = true;
      return o;
    }));
    this.replayBtn = h('button', { onclick: () => this.playPhrase() }, '🔊 Réécouter');
    this.el = h('div', { class: 'trainer' }, [
      h('header', { class: 'bar' }, [
        h('button', { class: 'icon', title: 'Retour', onclick: () => this.onBack() }, '←'),
        h('div', { class: 'title' }, `${info.icon} ${info.title}`),
        sel,
        this.scoreEl
      ]),
      this.banner.el,
      h('div', { class: 'tr-body' }, [
        this.promptEl,
        h('div', { class: 'stage' }, [this.titleEl, this.staffEl, this.seqEl]),
        this.feedback,
        h('div', { class: 'tr-actions' }, [
          this.replayBtn,
          h('button', { onclick: () => this.hint() }, '💡 Indice'),
          h('button', { onclick: () => this.next() }, 'Passer')
        ])
      ]),
      this.neck.el
    ]);
  }

  mount(): void {
    this.unsub.push(
      micInput.onNoteOn(p => { this.neck.setHeld(p, true); if (!this.busy) this.onNote(p); }),
      micInput.onNoteOff(p => this.neck.setHeld(p, false))
    );
    void micInput.start();
    this.renderScore();
    this.next();
  }

  destroy(): void {
    this.unsub.forEach(f => f());
    this.timers.forEach(t => clearTimeout(t));
    this.banner.destroy();
    micInput.stop();
    this.osmd?.clear();
  }

  private later(fn: () => void, ms: number): void { this.timers.push(window.setTimeout(fn, ms)); }

  private next(): void {
    this.timers.forEach(t => clearTimeout(t));
    this.timers = [];
    this.q = this.level.make(this.last);
    this.last = this.q.notes[0];
    this.pos = 0;
    this.busy = false;
    this.revealed = false;
    this.askedAt = performance.now();
    this.feedback.textContent = '';
    this.feedback.className = 'feedback';
    this.promptEl.textContent = this.q.prompt;
    this.titleEl.textContent = this.q.title ?? '';
    this.titleEl.style.display = this.q.title ? '' : 'none';
    this.replayBtn.style.display = this.q.listen ? '' : 'none';
    this.staffEl.style.display = this.q.staff ? '' : 'none';
    if (this.q.staff) void this.drawStaff(this.q.notes[0]);
    this.paint();
    if (this.q.listen) this.later(() => this.playPhrase(), 400);
  }

  private async drawStaff(p: number): Promise<void> {
    if (!this.osmd) {
      this.osmd = new OpenSheetMusicDisplay(this.staffEl, {
        backend: 'svg', autoResize: false, drawTitle: false, drawPartNames: false, drawMeasureNumbers: false,
        drawComposer: false, drawCredits: false, pageBackgroundColor: '#fffdf8'
      });
      this.osmd.EngravingRules.PageTopMargin = 0;
      this.osmd.EngravingRules.PageBottomMargin = 0;
    }
    const written = p + WRITTEN_OFFSET;
    const xml = notesToMusicXml([{ midi: written, start: 0, dur: 4, hand: 'R', spelling: oudSpelling(written) }], { title: '', single: true, exact: true });
    try {
      await this.osmd.load(xml);
      if (this.q.notes[0] === p) this.osmd.render();
    } catch { /* la note reste donnée par l'indice */ }
  }

  /** Affiche la progression et la prochaine note sur le manche. */
  private paint(): void {
    const { notes, names, guide } = this.q;
    if (notes.length > 1) {
      this.seqEl.replaceChildren(...notes.map((p, i) => h('span', {
        class: i < this.pos ? 'done' : i === this.pos ? 'cur' : ''
      }, i < this.pos || names || this.revealed || i === 0 ? oudName(p) : '●')));
    } else this.seqEl.replaceChildren();
    const want = notes[this.pos];
    micInput.setTargets(want === undefined ? [] : [want]);
    const show = want !== undefined && (guide || this.revealed);
    this.neck.setExpected(new Map(show ? [[want, 'R' as const]] : []));
  }

  private playPhrase(): void {
    const notes = this.q.notes;
    this.busy = true;
    const gap = 520;
    notes.forEach((p, i) => this.later(() => playOud(p, 0.5, 85), i * gap));
    this.later(() => { this.busy = false; }, notes.length * gap + 300);
  }

  private hint(): void {
    this.revealed = true;
    const want = this.q.notes[this.pos];
    if (want === undefined) return;
    this.feedback.textContent = `${oudName(want)} — ${positionLabel(want)}`;
    this.feedback.className = 'feedback hint';
    this.paint();
  }

  private onNote(p: number): void {
    const want = this.q.notes[this.pos];
    if (want === undefined) return;
    if (Math.abs(p - want) > 0.01) {
      this.bad++;
      this.streak = 0;
      this.neck.flashWrong(p);
      this.feedback.textContent = `✘ Entendu : ${oudName(p)}`;
      this.feedback.className = 'feedback bad';
      this.renderScore();
      return;
    }
    this.pos++;
    this.feedback.textContent = '';
    this.feedback.className = 'feedback';
    if (this.pos < this.q.notes.length) { this.paint(); return; }
    this.paint();
    this.success();
  }

  private success(): void {
    this.busy = true;
    this.good++;
    this.streak++;
    const st = getStats(this.info.id);
    st.total++;
    st.best = Math.max(st.best, this.streak);
    setUpref('stats.' + this.info.id, st);
    const secs = ((performance.now() - this.askedAt) / 1000).toFixed(1).replace('.', ',');
    this.feedback.textContent = `✔ Juste  ·  ${secs} s`;
    this.feedback.className = 'feedback ok';
    this.renderScore();
    this.later(() => this.next(), 1100);
  }

  private renderScore(): void {
    this.scoreEl.replaceChildren(
      h('span', { class: 'g' }, `✔ ${this.good}`),
      h('span', { class: 'b' }, `✘ ${this.bad}`),
      h('span', { class: 's', title: 'Série en cours' }, `🔥 ${this.streak}`)
    );
  }
}

export function createOudTrainer(id: string, onBack: () => void): OudTrainer | null {
  const info = OUD_EXERCISES.find(e => e.id === id);
  return info ? new OudTrainer(info, LEVELS[id], onBack) : null;
}
