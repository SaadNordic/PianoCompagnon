// Écran de travail : partition + curseur qui n'avance que si les bonnes notes sont jouées.

import { OpenSheetMusicDisplay, type Note } from 'opensheetmusicdisplay';
import { Keyboard, frName, type KeyMark } from './keyboard';
import { midiInput, statusLabel } from './midiInput';
import { playNote, now, unlockAudio, loadPiano, soundOut } from './synth';
import { savePiece, pref, setPref, type Piece } from './storage';
import { h, toast, openModal } from './ui';
import { renderOriginals } from './originals';

type HandSel = 'both' | 'R' | 'L';
type Part = 'R' | 'L' | 'acc'; // acc = partie jouée par l'appli (autre instrument)

interface StepNote { midi: number; part: Part; wholes: number; note: Note }
interface Step { ts: number; measure: number; notes: StepNote[] }

const COLOR_DONE = '#1a9e55';

export class Player {
  readonly el: HTMLElement;
  private osmd!: OpenSheetMusicDisplay;
  private scoreEl: HTMLDivElement;
  private kb: Keyboard;
  private steps: Step[] = [];
  private idx = 0;
  private cursorIdx = 0;
  private expected = new Set<number>();
  private satisfied = new Set<number>();
  private autoNotes: StepNote[] = [];
  private autoPlayedAt = -1;
  private pending: { timer: number; run: () => void } | null = null;
  private hands: HandSel = pref<HandSel>('hands', 'both');
  private zoom = pref('zoom', 0.85);
  private speed = pref('speed', 1);
  private wrong = 0;
  private hits = 0;
  private startedAt = 0;
  private finished = false;
  private loop: { from: number; to: number } | null = null;
  private listenTimer = 0;
  private listenEnd = 0;
  private listening = false;
  private unsub: (() => void)[] = [];
  private wakeLock: WakeLockSentinel | null = null;
  private infoEl!: HTMLElement;
  private statsEl!: HTMLElement;
  private listenBtn!: HTMLButtonElement;
  private loopBtn!: HTMLButtonElement;
  private midiDot!: HTMLElement;
  private overlay: HTMLElement | null = null;
  private measureCount = 0;

  constructor(private piece: Piece, private onBack: () => void) {
    this.scoreEl = h('div', { class: 'score' }) as HTMLDivElement;
    this.kb = new Keyboard(
      m => { unlockAudio(); playNote(m, 0.9, 85); midiInput.noteOn(m, 85); },
      m => midiInput.noteOff(m)
    );
    this.kb.setLabels(pref('labels', 'c'));
    this.el = h('div', { class: 'player' }, [this.topBar(), this.settingsPanel(), this.scoreEl, this.infoBar(), this.kb.el]);
  }

  // ---------- interface ----------

  private topBar(): HTMLElement {
    const seg = h('div', { class: 'seg' }, (
      [['both', 'Deux mains', '2 mains'], ['R', 'Main droite', 'MD'], ['L', 'Main gauche', 'MG']] as [HandSel, string, string][]
    ).map(([v, label, short]) => {
      const b = h('button', { class: v === this.hands ? 'on' : '', title: label, onclick: () => {
        this.hands = v; setPref('hands', v);
        seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
        this.enterStep(this.idx, false);
      } }, [h('span', { class: 'long' }, label), h('span', { class: 'short' }, short)]) as HTMLButtonElement;
      return b;
    }));
    this.midiDot = h('span', { class: 'midi-dot', title: '' });
    this.listenBtn = h('button', { class: 'icon', title: 'Écouter la partition', onclick: () => (this.listening ? this.stopListen() : this.listen()) }, '▶') as HTMLButtonElement;
    this.loopBtn = h('button', { title: 'Répéter un passage', onclick: () => this.toggleLoop() }, '⟲') as HTMLButtonElement;
    return h('header', { class: 'bar' }, [
      h('button', { class: 'icon', title: 'Bibliothèque', onclick: () => this.onBack() }, '←'),
      h('div', { class: 'title' }, this.piece.title),
      seg,
      this.listenBtn,
      this.loopBtn,
      this.midiDot,
      h('button', { class: 'icon menu-btn', title: 'Menu', onclick: (e: Event) => { e.stopPropagation(); this.toggleMenu(); } }, '⋮')
    ]);
  }

  private settingsEl!: HTMLElement;

  // un toucher hors du menu le referme
  private menuAway = (e: Event) => {
    const t = e.target as HTMLElement;
    if (!this.settingsEl.contains(t) && !t.closest?.('.menu-btn')) this.toggleMenu(false);
  };

  private toggleMenu(open = !this.settingsEl.classList.contains('open')): void {
    this.settingsEl.classList.toggle('open', open);
    document.removeEventListener('pointerdown', this.menuAway, true);
    if (open) setTimeout(() => document.addEventListener('pointerdown', this.menuAway, true), 0);
  }

  private showOriginal(): void {
    const box = h('div', { class: 'orig-box' });
    const close = openModal('Partition originale', box, [h('span', { class: 'spacer' }), h('button', { onclick: () => close() }, 'Fermer')]);
    void renderOriginals(box, this.piece.id);
  }

  private settingsPanel(): HTMLElement {
    const action = (icon: string, label: string, run: () => void) =>
      h('button', { class: 'menu-action', onclick: () => { this.toggleMenu(false); run(); } }, [h('span', { class: 'mrow-icon' }, icon), label]);
    const select = <T extends string | number>(value: T, options: [T, string][], onChange: (v: string) => void) => {
      const el = h('select', { onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value) },
        options.map(([v, t]) => {
          const o = h('option', { value: String(v) }, t) as HTMLOptionElement;
          if (v === value) o.selected = true;
          return o;
        }));
      return el;
    };
    this.settingsEl = h('div', { class: 'settings' }, [
      action('⏮', 'Recommencer au début', () => this.restart()),
      this.piece.hasOriginal ? action('📄', 'Voir la partition originale', () => this.showOriginal()) : null,
      action('←', 'Retour à la bibliothèque', () => this.onBack()),
      h('div', { class: 'menu-sep' }),
      h('label', {}, ["Vitesse d'écoute", select(this.speed, [[0.5, '50 %'], [0.75, '75 %'], [1, '100 %'], [1.25, '125 %']], v => {
        this.speed = Number(v); setPref('speed', this.speed);
      })]),
      h('label', {}, ['Son de l’appli', select(soundOut(), [['auto', 'Piano numérique s’il est branché'], ['device', 'Toujours cet appareil']], v => {
        setPref('soundOut', v);
      })]),
      h('label', {}, ['Noms sur le clavier', select(this.kb.labels, [['c', 'Do seulement'], ['all', 'Toutes les notes'], ['none', 'Aucun']], v => {
        setPref('labels', v); this.kb.setLabels(v as 'none' | 'c' | 'all'); this.enterStep(this.idx, false);
      })]),
      h('label', {}, ['Taille de la partition', h('div', { class: 'row' }, [
        h('button', { class: 'icon', onclick: () => this.setZoom(this.zoom - 0.1) }, '−'),
        h('button', { class: 'icon', onclick: () => this.setZoom(this.zoom + 0.1) }, '+')
      ])])
    ]);
    return this.settingsEl;
  }

  private infoBar(): HTMLElement {
    this.infoEl = h('div', { class: 'info' });
    this.statsEl = h('div', { class: 'stats' });
    return h('div', { class: 'infobar' }, [this.infoEl, this.statsEl]);
  }

  // ---------- chargement ----------

  async mount(): Promise<void> {
    this.osmd = new OpenSheetMusicDisplay(this.scoreEl, {
      backend: 'svg',
      autoResize: true,
      drawTitle: false,
      drawComposer: false,
      drawCredits: false,
      drawPartNames: false,
      followCursor: true,
      autoBeam: this.piece.source !== 'musicxml',
      pageBackgroundColor: '#fffdf8',
      cursorsOptions: [{ type: 0, color: '#3d7cf2', alpha: 0.35, follow: true }]
    });
    this.osmd.EngravingRules.PageTopMargin = 1;
    this.scoreEl.innerHTML = '<div class="loading">Chargement de la partition…</div>';
    try {
      await this.osmd.load(this.piece.xml, this.piece.title);
      this.scoreEl.querySelector('.loading')?.remove();
      this.osmd.Zoom = this.zoom;
      this.osmd.render();
    } catch (e) {
      this.scoreEl.innerHTML = `<div class="error">Impossible d'afficher cette partition.<br><small>${String((e as Error).message ?? e)}</small></div>`;
      return;
    }
    this.collectSteps();
    if (!this.steps.length) {
      this.scoreEl.insertAdjacentHTML('beforeend', '<div class="error">Aucune note jouable trouvée.</div>');
      return;
    }
    let lo = 127, hi = 0;
    for (const s of this.steps) for (const n of s.notes) if (n.part !== 'acc') { lo = Math.min(lo, n.midi); hi = Math.max(hi, n.midi); }
    if (lo > hi) { lo = 48; hi = 84; }
    this.kb.setRange(lo, hi);

    this.osmd.cursor.show();
    this.scoreEl.addEventListener('click', e => this.onScoreClick(e));
    this.unsub.push(
      midiInput.onNoteOn(m => this.onNoteOn(m)),
      midiInput.onNoteOff(m => this.kb.setHeld(m, false)),
      midiInput.onStatus(s => {
        this.midiDot.classList.toggle('on', s.state === 'connected');
        this.midiDot.title = statusLabel(s);
      })
    );
    window.addEventListener('resize', this.onResize);
    void this.keepAwake();
    this.piece.lastPlayedAt = Date.now();
    void savePiece(this.piece);
    this.enterStep(0, false);
  }

  destroy(): void {
    document.removeEventListener('pointerdown', this.menuAway, true);
    this.stopListen();
    this.clearPending();
    this.unsub.forEach(f => f());
    window.removeEventListener('resize', this.onResize);
    void this.wakeLock?.release().catch(() => {});
    this.osmd?.clear();
  }

  private onResize = () => {
    // autoResize redessine la partition : on replace le curseur et les couleurs
    setTimeout(() => this.refreshCursor(), 400);
  };

  private async keepAwake(): Promise<void> {
    try { this.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* facultatif */ }
  }

  /** Parcourt toute la partition une fois et retient, pour chaque position, les notes à jouer. */
  private collectSteps(): void {
    const instruments = this.osmd.Sheet.Instruments;
    const pianos = instruments.filter(i => i.Staves.length >= 2);
    const partOf = (n: Note): Part => {
      const staff = n.ParentStaff;
      const inst = staff.ParentInstrument;
      if (pianos.length) {
        if (!pianos.includes(inst)) return 'acc';
        return inst.Staves.indexOf(staff) === 0 ? 'R' : 'L';
      }
      const ii = instruments.indexOf(inst);
      if (instruments.length === 2) return ii === 0 ? 'R' : 'L';
      return ii === 0 ? 'R' : 'acc';
    };
    const cursor = this.osmd.cursor;
    cursor.reset();
    const it = cursor.Iterator;
    let guard = 0;
    while (!it.EndReached && guard++ < 100000) {
      const notes: StepNote[] = [];
      for (const ve of it.CurrentVoiceEntries) {
        if (ve.IsGrace) continue;
        for (const n of ve.Notes) {
          if (n.isRest() || !n.Pitch) continue;
          const tie = n.NoteTie;
          if (tie && tie.StartNote !== n) continue; // suite d'une liaison : ne se rejoue pas
          const wholes = tie ? tie.Notes.reduce((s, x) => s + x.Length.RealValue, 0) : n.Length.RealValue;
          notes.push({ midi: n.halfTone + 12, part: partOf(n), wholes, note: n });
        }
      }
      this.steps.push({ ts: it.CurrentEnrolledTimestamp.RealValue, measure: it.CurrentMeasureIndex, notes });
      this.measureCount = Math.max(this.measureCount, it.CurrentMeasureIndex + 1);
      cursor.next();
    }
    cursor.reset();
    this.cursorIdx = 0;
  }

  // ---------- déplacement ----------

  private moveCursor(i: number): void {
    const c = this.osmd.cursor;
    if (i < this.cursorIdx) { c.reset(); this.cursorIdx = 0; }
    while (this.cursorIdx < i) { c.next(); this.cursorIdx++; }
  }

  private refreshCursor(): void {
    if (!this.osmd?.cursor) return;
    const target = this.cursorIdx;
    this.osmd.cursor.reset();
    this.cursorIdx = 0;
    this.moveCursor(target);
    this.osmd.cursor.show();
  }

  private practiced(p: Part): boolean {
    if (p === 'acc') return false;
    return this.hands === 'both' || this.hands === p;
  }

  private secPerWhole(): number {
    const bpm = this.osmd.Sheet.DefaultStartTempoInBpm || 100;
    return (4 * 60) / bpm;
  }

  /** Arrive sur une position : prépare les notes attendues ou joue l'accompagnement. */
  private enterStep(i: number, fromAdvance = true): void {
    this.clearPending();
    if (this.loop && fromAdvance) {
      const atEnd = i >= this.steps.length || this.steps[i].measure > this.loop.to;
      if (atEnd) i = this.firstStepOfMeasure(this.loop.from);
    }
    if (i >= this.steps.length) { this.finish(); return; }
    this.idx = i;
    this.moveCursor(i);
    const step = this.steps[i];
    this.expected = new Set(step.notes.filter(n => this.practiced(n.part)).map(n => n.midi));
    this.satisfied = new Set();
    this.autoNotes = step.notes.filter(n => !this.practiced(n.part));
    this.autoPlayedAt = -1;

    const marks = new Map<number, KeyMark>();
    for (const n of step.notes) {
      if (this.practiced(n.part)) marks.set(n.midi, n.part as KeyMark);
      else if (!marks.has(n.midi)) marks.set(n.midi, 'auto');
    }
    this.kb.setExpected(marks);
    this.kb.clearDone();
    this.updateInfo();

    if (this.expected.size === 0) {
      // rien à jouer ici pour l'élève : l'appli joue l'accompagnement au bon moment puis avance
      const prev = this.steps[i - 1];
      const delay = this.autoNotes.length && prev && fromAdvance
        ? Math.min(4, (step.ts - prev.ts) * this.secPerWhole()) * 1000
        : 0;
      const run = () => {
        this.pending = null;
        this.playAuto();
        this.enterStep(i + 1);
      };
      if (delay > 30) this.pending = { timer: window.setTimeout(run, delay), run };
      else run();
    }
  }

  private clearPending(): void {
    if (this.pending) { clearTimeout(this.pending.timer); this.pending = null; }
  }

  private playAuto(): void {
    if (this.autoPlayedAt === this.idx) return;
    this.autoPlayedAt = this.idx;
    const spw = this.secPerWhole();
    for (const n of this.autoNotes) playNote(n.midi, n.wholes * spw, 70);
  }

  private firstStepOfMeasure(m: number): number {
    const i = this.steps.findIndex(s => s.measure >= m);
    return i < 0 ? 0 : i;
  }

  // ---------- jeu ----------

  private onNoteOn(m: number): void {
    this.kb.setHeld(m, true);
    if (this.listening || this.finished || !this.steps.length) return;
    if (this.pending) this.pending.run(); // l'élève joue avant la fin de l'accompagnement : on rattrape
    if (this.expected.has(m)) {
      if (this.satisfied.has(m)) return;
      if (!this.startedAt) this.startedAt = performance.now();
      this.satisfied.add(m);
      this.hits++;
      this.kb.setDone(m, true);
      this.playAuto();
      if (this.satisfied.size === this.expected.size) {
        this.colorStep(this.steps[this.idx]);
        this.enterStep(this.idx + 1);
      }
    } else {
      this.wrong++;
      this.kb.flashWrong(m);
      this.updateInfo();
    }
  }

  private colorStep(step: Step): void {
    for (const n of step.notes) {
      if (!this.practiced(n.part)) continue;
      try {
        const g = (this.osmd.EngravingRules.GNote(n.note) as unknown as { getSVGGElement?: () => SVGGElement })?.getSVGGElement?.();
        g?.querySelectorAll('path').forEach(p => { p.setAttribute('fill', COLOR_DONE); p.setAttribute('stroke', COLOR_DONE); });
      } catch { /* coloration facultative */ }
    }
  }

  private clearColors(): void {
    this.scoreEl.querySelectorAll(`path[fill="${COLOR_DONE}"]`).forEach(p => {
      p.removeAttribute('fill'); p.removeAttribute('stroke');
    });
  }

  private updateInfo(): void {
    const step = this.steps[this.idx];
    if (!step) return;
    const want = step.notes.filter(n => this.practiced(n.part));
    const fmt = (p: Part) => want.filter(n => n.part === p).sort((a, b) => b.midi - a.midi).map(n => frName(n.midi)).join(' ');
    const r = fmt('R'), l = fmt('L');
    const parts = [r && `MD : ${r}`, l && `MG : ${l}`].filter(Boolean).join('  ·  ');
    this.infoEl.textContent = `Mesure ${step.measure + 1}/${this.measureCount}` + (parts ? `  —  ${parts}` : '');
    this.statsEl.textContent = this.wrong ? `${this.wrong} fausse${this.wrong > 1 ? 's' : ''} note${this.wrong > 1 ? 's' : ''}` : '';
  }

  private restart(): void {
    this.stopListen();
    this.closeOverlay();
    this.clearColors();
    this.wrong = 0; this.hits = 0; this.startedAt = 0; this.finished = false;
    this.enterStep(this.loop ? this.firstStepOfMeasure(this.loop.from) : 0, false);
  }

  private finish(): void {
    this.finished = true;
    this.kb.setExpected(new Map());
    const secs = this.startedAt ? Math.round((performance.now() - this.startedAt) / 1000) : 0;
    const total = this.hits + this.wrong;
    const acc = total ? Math.round((this.hits / total) * 100) : 100;
    const best = this.piece.bestRun;
    const isBest = !best || this.wrong < best.wrong || (this.wrong === best.wrong && secs < best.seconds);
    this.piece.playCount = (this.piece.playCount ?? 0) + 1;
    if (isBest && this.hits > 0) this.piece.bestRun = { wrong: this.wrong, seconds: secs };
    void savePiece(this.piece);
    const mmss = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    this.overlay = h('div', { class: 'overlay' }, [
      h('div', { class: 'card done' }, [
        h('div', { class: 'big' }, this.wrong === 0 ? '🎉 Parfait !' : '👏 Bravo !'),
        h('p', {}, `Morceau terminé en ${mmss}.`),
        h('p', {}, `${this.wrong} fausse${this.wrong > 1 ? 's' : ''} note${this.wrong > 1 ? 's' : ''} — précision ${acc} %.`),
        isBest && this.hits > 0 ? h('p', { class: 'best' }, 'Nouveau record personnel !') : h('span'),
        h('div', { class: 'row' }, [
          h('button', { class: 'primary', onclick: () => this.restart() }, 'Rejouer'),
          h('button', { onclick: () => this.onBack() }, 'Bibliothèque')
        ])
      ])
    ]);
    this.el.appendChild(this.overlay);
  }

  private closeOverlay(): void {
    this.overlay?.remove();
    this.overlay = null;
  }

  // ---------- navigation dans la partition ----------

  private onScoreClick(e: MouseEvent): void {
    if (this.listening) return;
    const list = this.osmd.GraphicSheet?.MeasureList;
    if (!list) return;
    for (let m = 0; m < list.length; m++) {
      for (const gm of list[m] ?? []) {
        const g = (gm as unknown as { getSVGGElement?: () => SVGGElement | undefined })?.getSVGGElement?.();
        if (!g) continue;
        const r = g.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top - 10 && e.clientY <= r.bottom + 10) {
          this.goToMeasure(m);
          return;
        }
      }
    }
  }

  private goToMeasure(m: number): void {
    this.closeOverlay();
    this.finished = false;
    this.enterStep(this.firstStepOfMeasure(m), false);
    toast(`Mesure ${m + 1}`);
  }

  private toggleLoop(): void {
    if (this.loop) {
      this.loop = null;
      this.loopBtn.classList.remove('on');
      this.loopBtn.textContent = '⟲';
      return;
    }
    const cur = (this.steps[this.idx]?.measure ?? 0) + 1;
    const from = Number(prompt('Répéter à partir de la mesure :', String(cur)));
    if (!from) return;
    const to = Number(prompt('Jusqu\'à la mesure :', String(Math.min(this.measureCount, from + 3))));
    if (!to || to < from) return;
    this.loop = { from: Math.max(1, from) - 1, to: Math.min(this.measureCount, to) - 1 };
    this.loopBtn.classList.add('on');
    this.loopBtn.textContent = `⟲ ${from}–${to}`;
    this.goToMeasure(this.loop.from);
  }

  private setZoom(z: number): void {
    this.zoom = Math.min(2, Math.max(0.4, Math.round(z * 100) / 100));
    setPref('zoom', this.zoom);
    this.osmd.Zoom = this.zoom;
    this.osmd.render();
    this.refreshCursor();
    for (let i = 0; i < this.idx; i++) this.colorStep(this.steps[i]);
  }

  // ---------- écoute ----------

  private async listen(): Promise<void> {
    unlockAudio();
    this.clearPending();
    this.closeOverlay();
    this.listening = true;
    this.listenBtn.textContent = '■';
    this.listenBtn.classList.add('on');
    await loadPiano(); // le vrai son de piano dès la première note
    if (!this.listening) return;
    const startIdx = this.finished ? 0 : this.idx;
    this.finished = false;
    const spw = this.secPerWhole() / this.speed;
    const base = this.steps[startIdx].ts;
    const t0 = now() + 0.15;
    const endMeasure = this.loop?.to ?? Infinity;
    let next = startIdx;
    const tick = () => {
      const horizon = now() + 0.35;
      while (next < this.steps.length && this.steps[next].measure <= endMeasure) {
        const s = this.steps[next];
        const at = t0 + (s.ts - base) * spw;
        if (at > horizon) break;
        for (const n of s.notes) playNote(n.midi, n.wholes * spw, 75, at);
        const i = next;
        setTimeout(() => {
          if (!this.listening) return;
          this.idx = i;
          this.moveCursor(i);
          const marks = new Map<number, KeyMark>();
          for (const n of s.notes) marks.set(n.midi, n.part === 'acc' ? 'auto' : n.part);
          this.kb.setExpected(marks);
          this.updateInfo();
        }, Math.max(0, (at - now()) * 1000));
        next++;
      }
      if (next >= this.steps.length || this.steps[next].measure > endMeasure) {
        clearInterval(this.listenTimer);
        if (!this.listenEnd) {
          const last = this.steps[next - 1];
          const endAt = t0 + (last.ts - base) * spw + Math.max(0.25, ...last.notes.map(n => n.wholes)) * spw;
          this.listenEnd = window.setTimeout(() => this.stopListen(), Math.max(0, (endAt - now()) * 1000));
        }
        return false;
      }
      return true;
    };
    if (tick()) this.listenTimer = window.setInterval(tick, 100);
  }

  private stopListen(): void {
    if (!this.listening) return;
    this.listening = false;
    clearInterval(this.listenTimer);
    clearTimeout(this.listenEnd);
    this.listenEnd = 0;
    this.listenBtn.textContent = '▶';
    this.listenBtn.classList.remove('on');
    this.enterStep(Math.min(this.idx, this.steps.length - 1), false);
  }
}
