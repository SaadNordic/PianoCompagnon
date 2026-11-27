// Écran de travail : partition + curseur qui n'avance que si les bonnes notes sont jouées.

import { OpenSheetMusicDisplay, type Note } from 'opensheetmusicdisplay';
import { Keyboard, frName, type KeyMark } from './keyboard';
import { midiInput, statusLabel } from './midiInput';
import { playNote, now, unlockAudio, loadPiano, soundOut } from './synth';
import { savePiece, pref, setPref, type Piece } from './storage';
import { h, toast, openModal } from './ui';
import { renderOriginals } from './originals';
import { micInput, micBanner, micLabel } from './mic';
import { OudNeck, WRITTEN_OFFSET, loadOud, oudName, playOud, positionLabel } from './oud';
import { createTuner } from './oudTuner';
import { stripXmlInvalid } from './musicxml';

type HandSel = 'both' | 'R' | 'L';
type Part = 'R' | 'L' | 'acc'; // acc = partie jouée par l'appli (autre instrument)

interface StepNote { midi: number; part: Part; wholes: number; note: Note }
// beat : temps dans la mesure (1 = début), anchors : toutes les notes et silences dessinés à cette position
interface Step { ts: number; measure: number; beat: number; notes: StepNote[]; anchors: Note[] }
type Bound = 'from' | 'to';

const COLOR_DONE = '#1a9e55';

export class Player {
  readonly el: HTMLElement;
  private osmd!: OpenSheetMusicDisplay;
  private scoreEl: HTMLDivElement;
  private kb: Keyboard | OudNeck;
  private readonly oud: boolean; // oud : on écoute au micro au lieu du MIDI
  private tuning = false; // accordeur ouvert : les notes entendues ne font pas avancer la partition
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
  private section: { from: number; to: number } | null = null; // passage choisi : positions (indices de steps), bornes incluses
  private sectionOn = true; // désactivé : le passage est gardé, on joue tout le morceau
  private sectionRepeat = pref('sectionRepeat', true); // à la fin du passage : reprendre ou s'arrêter
  private picking: Bound | null = null; // borne à choisir au toucher sur la partition
  private pickingNew = false; // création : après le début, on enchaîne sur la fin
  private pickBackup: { from: number; to: number } | null = null; // pour « Annuler » pendant le choix
  private barOpen = false;
  private partial = false; // tout le morceau n'a pas été joué : pas de record
  private listenTimer = 0;
  private listenEnd = 0;
  private listening = false;
  private unsub: (() => void)[] = [];
  private wakeLock: WakeLockSentinel | null = null;
  private infoEl!: HTMLElement;
  private statsEl!: HTMLElement;
  private listenBtn!: HTMLButtonElement;
  private sectionBtn!: HTMLButtonElement;
  private sectionBarEl!: HTMLElement;
  private sectionLabel!: HTMLElement;
  private sectionTools!: HTMLElement;
  private pickTools!: HTMLElement;
  private pickOkBtn!: HTMLButtonElement;
  private onBtn!: HTMLButtonElement;
  private fromLbl!: HTMLButtonElement;
  private toLbl!: HTMLButtonElement;
  private wholeBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;
  private repeatBtn!: HTMLButtonElement;
  private midiDot!: HTMLElement;
  private overlay: HTMLElement | null = null;
  private measureCount = 0;

  constructor(private piece: Piece, private onBack: () => void) {
    this.oud = piece.instrument === 'oud';
    if (this.oud) this.hands = 'R'; // une seule ligne à jouer
    this.scoreEl = h('div', { class: 'score' }) as HTMLDivElement;
    if (this.oud) {
      this.kb = new OudNeck(p => { unlockAudio(); playOud(p, 0.9); micInput.press(p); });
    } else {
      const kb = new Keyboard(
        m => { unlockAudio(); playNote(m, 0.9, 85); midiInput.noteOn(m, 85); },
        m => midiInput.noteOff(m)
      );
      kb.setLabels(pref('labels', 'c'));
      this.kb = kb;
    }
    const banner = this.oud ? micBanner() : null;
    if (banner) this.unsub.push(banner.destroy);
    this.el = h('div', { class: 'player' }, [this.topBar(), this.settingsPanel(), this.sectionBar(), banner?.el, this.scoreEl, this.infoBar(), this.kb.el]);
  }

  private sound(m: number, dur: number, vel: number, at = 0): void {
    if (this.oud) playOud(m, dur, vel, at);
    else playNote(m, dur, vel, at);
  }

  /** Accordeur par-dessus la partition : on garde sa place dans le morceau. */
  private openTuner(): void {
    this.stopListen();
    this.tuning = true;
    const t = createTuner(() => (this.kb as OudNeck).refresh());
    const close = openModal('Accorder le oud', t.el, [h('span', { class: 'spacer' }), h('button', { class: 'primary', onclick: () => close() }, 'Fermer')], () => {
      t.destroy();
      this.tuning = false;
      micInput.mute(400);
      this.enterStep(this.idx, false);
    });
    t.mount();
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
    this.sectionBtn = h('button', { title: 'Passage à travailler', onclick: () => this.onSectionBtn() }, 'Passage') as HTMLButtonElement;
    return h('header', { class: 'bar' }, [
      h('button', { class: 'icon', title: 'Bibliothèque', onclick: () => this.onBack() }, '←'),
      h('div', { class: 'title' }, this.piece.title),
      this.oud ? null : seg,
      this.listenBtn,
      this.sectionBtn,
      this.midiDot,
      h('button', { class: 'icon menu-btn', title: 'Menu', onclick: (e: Event) => { e.stopPropagation(); this.toggleMenu(); } }, '⋮')
    ]);
  }

  /**
   * Bandeau du passage.
   * Pendant le choix : consigne + OK / Annuler.
   * Sinon : Actif/Désactivé, début et fin (◀ ▶ = une note, toucher l'étiquette = choisir sur la partition),
   * mesures entières, S'arrête / Reprend, supprimer, fermer.
   */
  private sectionBar(): HTMLElement {
    this.sectionLabel = h('span', { class: 'section-label' });
    this.pickOkBtn = h('button', { class: 'primary', title: 'Garder cette fin', onclick: () => this.endPick(true) }, '✓ OK') as HTMLButtonElement;
    this.pickTools = h('div', { class: 'row-tools' }, [
      this.sectionLabel,
      this.pickOkBtn,
      h('button', { onclick: () => this.endPick(false) }, 'Annuler')
    ]);
    this.onBtn = h('button', { class: 'sec-on', title: 'Activer ou désactiver le passage', onclick: () => this.setSectionOn(!this.sectionOn) }) as HTMLButtonElement;
    const bound = (b: Bound) => {
      const lbl = h('button', { class: 'lbl', title: b === 'from' ? 'Toucher puis choisir le début sur la partition' : 'Toucher puis choisir la fin sur la partition', onclick: () => this.startPick(b) }) as HTMLButtonElement;
      if (b === 'from') this.fromLbl = lbl; else this.toLbl = lbl;
      return h('div', { class: 'sec-bound' }, [
        h('button', { title: 'Une note plus tôt', onclick: () => this.nudge(b, -1) }, '◀'),
        lbl,
        h('button', { title: 'Une note plus tard', onclick: () => this.nudge(b, 1) }, '▶')
      ]);
    };
    this.wholeBtn = h('button', { title: 'Élargir aux mesures entières', onclick: () => this.wholeMeasures() }, '⇔ Mesures') as HTMLButtonElement;
    this.stopBtn = h('button', { title: 'S’arrêter à la fin du passage', onclick: () => this.setSectionRepeat(false) }, '■ S’arrête') as HTMLButtonElement;
    this.repeatBtn = h('button', { title: 'Reprendre le passage au début', onclick: () => this.setSectionRepeat(true) }, '⟲ Reprend') as HTMLButtonElement;
    this.sectionTools = h('div', { class: 'row-tools' }, [
      this.onBtn,
      bound('from'),
      bound('to'),
      this.wholeBtn,
      h('div', { class: 'seg' }, [this.stopBtn, this.repeatBtn]),
      h('span', { class: 'spacer' }),
      h('button', { class: 'icon', title: 'Supprimer le passage', onclick: () => this.deleteSection() }, '🗑'),
      h('button', { class: 'icon', title: 'Fermer le bandeau (le passage reste)', onclick: () => { this.barOpen = false; this.renderSection(); } }, '✕')
    ]);
    this.sectionBarEl = h('div', { class: 'section-bar' }, [this.pickTools, this.sectionTools]);
    return this.sectionBarEl;
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
      this.oud ? action('🎚', 'Accorder le oud', () => this.openTuner()) : null,
      this.piece.hasOriginal ? action('📄', 'Voir la partition originale', () => this.showOriginal()) : null,
      action('←', 'Retour à la bibliothèque', () => this.onBack()),
      h('div', { class: 'menu-sep' }),
      h('label', {}, ["Vitesse d'écoute", select(this.speed, [[0.5, '50 %'], [0.75, '75 %'], [1, '100 %'], [1.25, '125 %']], v => {
        this.speed = Number(v); setPref('speed', this.speed);
      })]),
      this.oud ? null : h('label', {}, ['Son de l’appli', select(soundOut(), [['auto', 'Piano numérique s’il est branché'], ['device', 'Toujours cet appareil']], v => {
        setPref('soundOut', v);
      })]),
      this.kb instanceof Keyboard ? h('label', {}, ['Noms sur le clavier', select(this.kb.labels, [['c', 'Do seulement'], ['all', 'Toutes les notes'], ['none', 'Aucun']], v => {
        setPref('labels', v); (this.kb as Keyboard).setLabels(v as 'none' | 'c' | 'all'); this.enterStep(this.idx, false);
      })]) : null,
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
      // les morceaux déjà enregistrés peuvent contenir un caractère nul venu du MIDI
      await this.osmd.load(stripXmlInvalid(this.piece.xml), this.piece.title);
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
    if (this.oud) {
      this.unsub.push(
        micInput.onNoteOn(p => this.onNoteOn(p)),
        micInput.onNoteOff(p => this.kb.setHeld(p, false)),
        micInput.onState(s => {
          this.midiDot.classList.toggle('on', s === 'on');
          this.midiDot.title = micLabel(s);
        }),
        () => micInput.stop()
      );
      void micInput.start();
      void loadOud();
    } else {
      this.unsub.push(
        midiInput.onNoteOn(m => this.onNoteOn(m)),
        midiInput.onNoteOff(m => this.kb.setHeld(m, false)),
        midiInput.onStatus(s => {
          this.midiDot.classList.toggle('on', s.state === 'connected');
          this.midiDot.title = statusLabel(s);
        })
      );
    }
    window.addEventListener('resize', this.onResize);
    void this.keepAwake();
    this.piece.lastPlayedAt = Date.now();
    void savePiece(this.piece);
    this.loadSection();
    const a = this.active();
    if (a) this.partial = true;
    this.renderSection();
    this.enterStep(a ? a.from : 0, false);
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
      const anchors: Note[] = [];
      for (const ve of it.CurrentVoiceEntries) {
        if (ve.IsGrace) continue;
        for (const n of ve.Notes) {
          anchors.push(n);
          if (n.isRest() || !n.Pitch) continue;
          const tie = n.NoteTie;
          if (tie && tie.StartNote !== n) continue; // suite d'une liaison : ne se rejoue pas
          const wholes = tie ? tie.Notes.reduce((s, x) => s + x.Length.RealValue, 0) : n.Length.RealValue;
          // partition de oud : écrite une octave au-dessus du son réel
          notes.push({ midi: n.halfTone + 12 - (this.oud ? WRITTEN_OFFSET : 0), part: partOf(n), wholes, note: n });
        }
      }
      if (this.oud) {
        // le micro suit une note à la fois : la plus aiguë de la portée du haut (la mélodie)
        const top = notes.filter(x => x.part === 'R').reduce<StepNote | null>((b, x) => (!b || x.midi > b.midi ? x : b), null);
        for (const x of notes) x.part = x === top ? 'R' : 'acc';
      }
      const den = it.CurrentMeasure?.ActiveTimeSignature?.Denominator || 4;
      const beat = 1 + (it.CurrentRelativeInMeasureTimestamp?.RealValue ?? 0) * den;
      this.steps.push({ ts: it.CurrentEnrolledTimestamp.RealValue, measure: it.CurrentMeasureIndex, beat, notes, anchors });
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
    this.drawSectionMarks(); // un nouveau rendu efface le surlignage
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
    const sec = this.active();
    if (sec && fromAdvance && i > sec.to) {
      // sans note à jouer pour la main choisie, reprendre tournerait sans fin
      if (!this.sectionRepeat || !this.sectionHasNotes()) { this.finishSection(); return; }
      this.clearColors();
      this.resetRun();
      i = sec.from;
    }
    if (i >= this.steps.length) { this.finish(); return; }
    this.idx = i;
    this.moveCursor(i);
    const step = this.steps[i];
    this.expected = new Set(step.notes.filter(n => this.practiced(n.part)).map(n => n.midi));
    this.satisfied = new Set();
    if (this.oud) micInput.setTargets([...this.expected]);
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
    if (this.oud) return; // pas d'accompagnement : le micro l'entendrait comme une note jouée
    const spw = this.secPerWhole();
    for (const n of this.autoNotes) playNote(n.midi, n.wholes * spw, 70);
  }

  private firstStepOfMeasure(m: number): number {
    const i = this.steps.findIndex(s => s.measure >= m);
    return i < 0 ? 0 : i;
  }

  // ---------- jeu ----------

  private onNoteOn(m: number): void {
    if (this.tuning) return;
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
    if (this.oud) {
      const note = want.map(n => `${oudName(n.midi)} (${positionLabel(n.midi)})`).join(' ');
      this.infoEl.textContent = `Mesure ${step.measure + 1}/${this.measureCount}` + (note ? `  —  ${note}` : '');
      this.statsEl.textContent = this.wrong ? `${this.wrong} fausse${this.wrong > 1 ? 's' : ''} note${this.wrong > 1 ? 's' : ''}` : '';
      return;
    }
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
    this.resetRun();
    this.finished = false;
    const a = this.active();
    this.partial = !!a;
    this.enterStep(a ? a.from : 0, false);
  }

  private resetRun(): void {
    this.wrong = 0; this.hits = 0; this.startedAt = 0;
  }

  private finish(): void {
    this.finished = true;
    this.kb.setExpected(new Map());
    const secs = this.startedAt ? Math.round((performance.now() - this.startedAt) / 1000) : 0;
    const total = this.hits + this.wrong;
    const acc = total ? Math.round((this.hits / total) * 100) : 100;
    const best = this.piece.bestRun;
    const complete = !this.partial; // un morceau joué en partie ne compte ni comme record ni comme lecture
    const isBest = complete && (!best || this.wrong < best.wrong || (this.wrong === best.wrong && secs < best.seconds));
    if (complete) this.piece.playCount = (this.piece.playCount ?? 0) + 1;
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

  private measureGroup(gm: unknown): SVGGElement | undefined {
    return (gm as { getSVGGElement?: () => SVGGElement | undefined })?.getSVGGElement?.();
  }

  private measureAt(e: MouseEvent): number {
    const list = this.osmd.GraphicSheet?.MeasureList;
    if (!list) return -1;
    for (let m = 0; m < list.length; m++) {
      for (const gm of list[m] ?? []) {
        const g = this.measureGroup(gm);
        if (!g) continue;
        const r = g.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top - 10 && e.clientY <= r.bottom + 10) return m;
      }
    }
    return -1;
  }

  /** Groupes SVG des notes et silences dessinés à une position. */
  private stepGroups(i: number): SVGGElement[] {
    const out: SVGGElement[] = [];
    for (const n of this.steps[i]?.anchors ?? []) {
      try {
        const g = (this.osmd.EngravingRules.GNote(n) as unknown as { getSVGGElement?: () => SVGGElement })?.getSVGGElement?.();
        if (g) out.push(g);
      } catch { /* note non dessinée */ }
    }
    return out;
  }

  /** Bord gauche d'une position dans la partition (unités SVG), ou null si rien n'est dessiné. */
  private stepLeft(i: number): number | null {
    const xs = this.stepGroups(i).map(g => g.getBBox()).filter(b => b.width > 0).map(b => b.x);
    return xs.length ? Math.min(...xs) : null;
  }

  private stepRight(i: number): number | null {
    const xs = this.stepGroups(i).map(g => g.getBBox()).filter(b => b.width > 0).map(b => b.x + b.width);
    return xs.length ? Math.max(...xs) : null;
  }

  /** Position (note) touchée : la plus proche du doigt dans la mesure touchée. */
  private stepAt(e: MouseEvent): number {
    const m = this.measureAt(e);
    if (m < 0) return -1;
    let best = -1, bestD = Infinity;
    // reprises : une même mesure revient plusieurs fois ; pour la fin, on prend le passage après le début
    const after = this.picking === 'to' && this.section ? this.section.from : -1;
    for (let i = 0; i < this.steps.length; i++) {
      if (this.steps[i].measure !== m) continue;
      let d = Infinity;
      for (const g of this.stepGroups(i)) {
        const r = g.getBoundingClientRect();
        if (!r.width) continue;
        d = Math.min(d, e.clientX < r.left ? r.left - e.clientX : e.clientX > r.right ? e.clientX - r.right : 0);
      }
      if (d === Infinity) d = 1e6; // silence non dessiné : en dernier recours
      const better = d < bestD - 0.5 || (Math.abs(d - bestD) <= 0.5 && best < after && i >= after);
      if (better) { best = i; bestD = d; }
    }
    return best;
  }

  private onScoreClick(e: MouseEvent): void {
    if (!this.picking && this.listening) return;
    if (this.picking) {
      const i = this.stepAt(e);
      if (i >= 0) this.pickStep(i);
      return;
    }
    const m = this.measureAt(e);
    if (m < 0) return;
    const a = this.active();
    let target = this.firstStepOfMeasure(m);
    if (a) {
      // dans le passage : début de la mesure, ou début du passage s'il commence au milieu
      target = -1;
      for (let i = a.from; i <= a.to; i++) if (this.steps[i].measure === m) { target = i; break; }
      if (target < 0) { toast('Cette mesure est hors du passage'); return; }
    }
    this.goToStep(target);
  }

  private goToStep(i: number): void {
    this.closeOverlay();
    this.finished = false;
    if (i > 0) this.partial = true;
    this.enterStep(i, false);
    toast(this.posLabel(i, false));
  }

  // ---------- passage choisi ----------

  /** Passage pris en compte pour jouer et écouter (null : tout le morceau). */
  private active(): { from: number; to: number } | null {
    return this.sectionOn ? this.section : null;
  }

  private sectionKey(): string { return `passage.${this.piece.id}`; }

  private loadSection(): void {
    const v = pref<{ from: number; to: number; on: boolean } | null>(this.sectionKey(), null);
    const last = this.steps.length - 1;
    if (!v || !(v.from >= 0) || !(v.to >= v.from) || v.to > last) return;
    this.section = { from: v.from, to: v.to };
    this.sectionOn = v.on !== false;
  }

  private saveSection(): void {
    const s = this.section;
    setPref(this.sectionKey(), s ? { from: s.from, to: s.to, on: this.sectionOn } : null);
  }

  private isMeasureStart(i: number): boolean {
    return i <= 0 || this.steps[i - 1].measure !== this.steps[i].measure;
  }

  private isMeasureEnd(i: number): boolean {
    return i >= this.steps.length - 1 || this.steps[i + 1].measure !== this.steps[i].measure;
  }

  private measureEndOf(i: number): number {
    while (!this.isMeasureEnd(i)) i++;
    return i;
  }

  private measureStartOf(i: number): number {
    while (!this.isMeasureStart(i)) i--;
    return i;
  }

  /** « m.3 », « m.3 t2½ », « m.5 fin ». */
  private posLabel(i: number, end: boolean): string {
    const s = this.steps[i];
    if (!s) return '';
    const m = `m.${s.measure + 1}`;
    if (!end && this.isMeasureStart(i)) return m;
    if (end && this.isMeasureEnd(i)) return `${m} fin`;
    const whole = Math.floor(s.beat + 1e-6);
    const f = s.beat - whole;
    const fracs: [number, string][] = [[0, ''], [0.25, '¼'], [1 / 3, '⅓'], [0.5, '½'], [2 / 3, '⅔'], [0.75, '¾']];
    const hit = fracs.find(([v]) => Math.abs(f - v) < 0.02);
    return `${m} t${whole}${hit ? hit[1] : '+'}`;
  }

  private rangeLabel(s: { from: number; to: number }): string {
    return `${this.posLabel(s.from, false)} → ${this.posLabel(s.to, true)}`;
  }

  /** Bouton « Passage » : en créer un, sinon ouvrir / fermer le bandeau. */
  private onSectionBtn(): void {
    if (!this.section) { this.startPick('from', true); return; }
    if (this.picking) { this.endPick(false); return; }
    this.barOpen = !this.barOpen;
    this.renderSection();
  }

  private startPick(b: Bound, isNew = false): void {
    this.stopListen();
    this.pickBackup = this.section ? { ...this.section } : null;
    this.pickingNew = isNew;
    if (isNew) this.section = null;
    this.picking = b;
    this.barOpen = true;
    this.renderSection();
  }

  /** Fin du choix : OK garde ce qui est montré, Annuler revient à l'ancien passage. */
  private endPick(keep: boolean): void {
    this.picking = null;
    this.pickingNew = false;
    if (!keep) {
      this.section = this.pickBackup;
      this.pickBackup = null;
      if (!this.section) this.barOpen = false;
      this.renderSection();
      return;
    }
    this.pickBackup = null;
    this.sectionOn = true;
    this.sectionChanged();
  }

  private pickStep(i: number): void {
    if (this.pickingNew && this.picking === 'from') {
      // début choisi : fin provisoire à la fin de la mesure, on attend la vraie fin (ou OK)
      this.section = { from: i, to: this.measureEndOf(i) };
      this.picking = 'to';
      this.renderSection();
      return;
    }
    const s = this.section ?? { from: i, to: i };
    if (this.picking === 'from') s.from = i; else s.to = i;
    if (s.from > s.to) [s.from, s.to] = [s.to, s.from]; // touché à l'envers : on remet dans l'ordre
    this.section = s;
    this.endPick(true);
  }

  /** ◀ ▶ : décale une borne d'une position. */
  private nudge(b: Bound, d: number): void {
    const s = this.section;
    if (!s) return;
    if (b === 'from') s.from = Math.max(0, Math.min(s.to, s.from + d));
    else s.to = Math.max(s.from, Math.min(this.steps.length - 1, s.to + d));
    this.sectionOn = true;
    this.sectionChanged();
  }

  private wholeMeasures(): void {
    const s = this.section;
    if (!s) return;
    s.from = this.measureStartOf(s.from);
    s.to = this.measureEndOf(s.to);
    this.sectionChanged();
  }

  private setSectionOn(on: boolean): void {
    this.sectionOn = on;
    this.saveSection();
    this.stopListen();
    const s = this.section;
    if (on && s) {
      this.partial = true;
      // dans le passage, on reste où on est ; sinon on va à son début
      if (this.idx < s.from || this.idx > s.to || this.finished) this.restart();
    } else if (this.finished) {
      this.closeOverlay();
      this.finished = false;
    }
    this.renderSection();
    toast(on ? 'Passage activé' : 'Passage désactivé : tout le morceau');
  }

  private deleteSection(): void {
    this.stopListen();
    this.section = null;
    this.barOpen = false;
    this.saveSection();
    this.renderSection();
  }

  /** Après un changement du passage : enregistre et remet le curseur au début du passage. */
  private sectionChanged(): void {
    this.saveSection();
    this.stopListen();
    this.renderSection();
    if (this.active()) this.restart();
  }

  private setSectionRepeat(repeat: boolean): void {
    this.sectionRepeat = repeat;
    setPref('sectionRepeat', repeat);
    this.renderSection();
  }

  private sectionHasNotes(): boolean {
    const s = this.section;
    if (!s) return false;
    for (let i = s.from; i <= s.to; i++) if (this.steps[i]?.notes.some(n => this.practiced(n.part))) return true;
    return false;
  }

  private renderSection(): void {
    const s = this.section;
    const open = this.barOpen || !!this.picking;
    this.sectionBarEl.classList.toggle('open', open);
    this.sectionBtn.classList.toggle('on', !!s && this.sectionOn);
    this.sectionBtn.classList.toggle('dim', !!s && !this.sectionOn);
    if (s) {
      const a = this.steps[s.from].measure + 1, b = this.steps[s.to].measure + 1;
      const partial = !this.isMeasureStart(s.from) || !this.isMeasureEnd(s.to);
      this.sectionBtn.textContent = (a === b ? `${a}` : `${a}–${b}`) + (partial ? '*' : '');
      this.sectionBtn.title = `Passage ${this.rangeLabel(s)}${this.sectionOn ? '' : ' (désactivé)'}`;
    } else {
      this.sectionBtn.textContent = 'Passage';
      this.sectionBtn.title = 'Choisir un passage à travailler';
    }
    this.pickTools.style.display = this.picking ? '' : 'none';
    this.sectionTools.style.display = this.picking || !s ? 'none' : '';
    if (this.picking) {
      const isNewTo = this.pickingNew && this.picking === 'to' && s;
      this.sectionLabel.textContent = this.pickingNew
        ? (isNewTo ? `Début ${this.posLabel(s!.from, false)} — touchez la dernière note` : 'Touchez la première note du passage')
        : this.picking === 'from' ? 'Touchez la nouvelle première note' : 'Touchez la nouvelle dernière note';
      this.pickOkBtn.style.display = isNewTo ? '' : 'none';
    }
    if (s) {
      this.onBtn.textContent = this.sectionOn ? '● Actif' : '○ Désactivé';
      this.onBtn.classList.toggle('on', this.sectionOn);
      this.fromLbl.textContent = `Début ${this.posLabel(s.from, false)}`;
      this.toLbl.textContent = `Fin ${this.posLabel(s.to, true)}`;
      this.wholeBtn.disabled = this.isMeasureStart(s.from) && this.isMeasureEnd(s.to);
    }
    this.stopBtn.classList.toggle('on', !this.sectionRepeat);
    this.repeatBtn.classList.toggle('on', this.sectionRepeat);
    this.drawSectionMarks();
  }

  /**
   * Surligne le passage dans la partition, derrière les notes, une bande par ligne ;
   * un trait marque le début et la fin (au milieu d'une mesure si besoin).
   */
  private drawSectionMarks(): void {
    this.scoreEl.querySelectorAll('.section-mark, .section-edge').forEach(x => x.remove());
    const s = this.section;
    const list = this.osmd?.GraphicSheet?.MeasureList;
    if (!s || !list || !this.steps.length) return;
    const off = !this.sectionOn && !this.picking;
    if (off && !this.barOpen) return; // désactivé et bandeau fermé : partition nette
    const PAD = 3;
    type Band = { first: SVGGElement; l: number; t: number; r: number; b: number };
    const bands: Band[] = [];
    let startEdge: Band | null = null, endEdge: Band | null = null;
    let i = s.from;
    while (i <= s.to) {
      // suite de positions dans une même mesure
      const m = this.steps[i].measure;
      let j = i;
      while (j + 1 <= s.to && this.steps[j + 1].measure === m) j++;
      const groups = (list[m] ?? []).map(gm => this.measureGroup(gm)).filter((g): g is SVGGElement => !!g);
      if (groups.length) {
        const boxes = groups.map(g => g.getBBox());
        let l = Math.min(...boxes.map(x => x.x)), r = Math.max(...boxes.map(x => x.x + x.width));
        const t = Math.min(...boxes.map(x => x.y)), b = Math.max(...boxes.map(x => x.y + x.height));
        if (!this.isMeasureStart(i)) l = (this.stepLeft(i) ?? l + PAD) - PAD;
        if (!this.isMeasureEnd(j)) {
          const next = this.stepLeft(j + 1);
          const right = this.stepRight(j);
          r = next !== null ? next - PAD : right !== null ? right + PAD : r;
        }
        if (r < l + 2) r = l + 2;
        const seg: Band = { first: groups[0], l, t, r, b };
        if (i === s.from) startEdge = { ...seg };
        if (j === s.to) endEdge = { ...seg };
        const band = bands[bands.length - 1];
        if (band && band.first.ownerSVGElement === seg.first.ownerSVGElement && t < band.b && b > band.t && l >= band.r - 2) {
          band.l = Math.min(band.l, l); band.r = Math.max(band.r, r);
          band.t = Math.min(band.t, t); band.b = Math.max(band.b, b);
        } else {
          bands.push(seg);
        }
      }
      i = j + 1;
    }
    const add = (cls: string, first: SVGGElement, x: number, y: number, w: number, hgt: number) => {
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('class', cls + (off ? ' off' : ''));
      rect.setAttribute('x', String(x));
      rect.setAttribute('y', String(y));
      rect.setAttribute('width', String(Math.max(0, w)));
      rect.setAttribute('height', String(Math.max(0, hgt)));
      first.parentNode?.insertBefore(rect, first);
    };
    for (const x of bands) add('section-mark', x.first, x.l, x.t, x.r - x.l, x.b - x.t);
    const startBand = startEdge as Band | null, endBand = endEdge as Band | null;
    if (startBand) add('section-edge', startBand.first, startBand.l - 1.5, startBand.t - 4, 3, startBand.b - startBand.t + 8);
    if (endBand) add('section-edge', endBand.first, endBand.r - 1.5, endBand.t - 4, 3, endBand.b - endBand.t + 8);
  }

  /** Fin du passage en mode « S'arrête » : bilan du passage, sans toucher aux records du morceau. */
  private finishSection(): void {
    const s = this.section!;
    this.finished = true;
    this.kb.setExpected(new Map());
    const total = this.hits + this.wrong;
    const acc = total ? Math.round((this.hits / total) * 100) : 100;
    const hasNext = s.to + 1 < this.steps.length;
    this.overlay = h('div', { class: 'overlay' }, [
      h('div', { class: 'card done' }, [
        h('div', { class: 'big' }, this.wrong === 0 ? '🎉 Passage réussi !' : '👏 Passage terminé'),
        h('p', {}, this.rangeLabel(s)),
        h('p', {}, `${this.wrong} fausse${this.wrong > 1 ? 's' : ''} note${this.wrong > 1 ? 's' : ''} — précision ${acc} %.`),
        h('div', { class: 'row' }, [
          h('button', { class: 'primary', onclick: () => this.restart() }, 'Rejouer le passage'),
          hasNext ? h('button', { onclick: () => this.continueAfterSection() }, 'Continuer la suite') : null,
          h('button', { onclick: () => { this.sectionOn = false; this.saveSection(); this.renderSection(); this.restart(); } }, 'Tout le morceau')
        ])
      ])
    ]);
    this.el.appendChild(this.overlay);
  }

  /** Continue après le passage : le passage est désactivé (gardé), on joue la suite. */
  private continueAfterSection(): void {
    const next = this.section!.to + 1;
    this.sectionOn = false;
    this.saveSection();
    this.renderSection();
    this.closeOverlay();
    this.clearColors();
    this.resetRun();
    this.finished = false;
    this.partial = true;
    this.enterStep(next, false);
  }

  private setZoom(z: number): void {
    this.zoom = Math.min(2, Math.max(0.4, Math.round(z * 100) / 100));
    setPref('zoom', this.zoom);
    this.osmd.Zoom = this.zoom;
    this.osmd.render();
    this.refreshCursor();
    const first = this.active()?.from ?? 0;
    for (let i = first; i < this.idx; i++) this.colorStep(this.steps[i]);
  }

  // ---------- écoute ----------

  private async listen(): Promise<void> {
    unlockAudio();
    this.clearPending();
    this.closeOverlay();
    this.listening = true;
    this.listenBtn.textContent = '■';
    this.listenBtn.classList.add('on');
    if (!this.oud) await loadPiano(); // le vrai son de piano dès la première note
    if (!this.listening) return;
    let startIdx = this.finished ? 0 : this.idx;
    const s = this.active();
    if (s && (this.finished || startIdx < s.from || startIdx > s.to)) startIdx = s.from;
    this.finished = false;
    this.listenFrom(startIdx);
  }

  /** Joue à partir d'une position, jusqu'à la fin du passage ou du morceau. */
  private listenFrom(startIdx: number): void {
    const spw = this.secPerWhole() / this.speed;
    const base = this.steps[startIdx].ts;
    const t0 = now() + 0.15;
    const end = this.active()?.to ?? this.steps.length - 1; // dernière position jouée
    let next = startIdx;
    const tick = () => {
      const horizon = now() + 0.35;
      while (next <= end) {
        const s = this.steps[next];
        const at = t0 + (s.ts - base) * spw;
        if (at > horizon) break;
        for (const n of s.notes) this.sound(n.midi, n.wholes * spw, 75, at);
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
      if (next > end) {
        clearInterval(this.listenTimer);
        if (!this.listenEnd) {
          const last = this.steps[next - 1];
          const endAt = t0 + (last.ts - base) * spw + Math.max(0.25, ...last.notes.map(n => n.wholes)) * spw;
          this.listenEnd = window.setTimeout(() => {
            this.listenEnd = 0;
            const sec = this.active();
            if (sec && this.sectionRepeat) { this.listenFrom(sec.from); return; }
            if (sec) this.idx = sec.from; // prêt à rejouer le passage
            this.stopListen();
          }, Math.max(0, (endAt - now()) * 1000));
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
    if (this.oud) micInput.mute(600); // la dernière note résonne encore
    this.enterStep(Math.min(this.idx, this.steps.length - 1), false);
  }
}
