// Dictée : on joue (clavier MIDI, clavier à l'écran, micro ou fichier audio), les notes s'écrivent
// sur la portée et en texte. On les corrige comme dans un traitement de texte, on les écoute
// au son du piano ou du oud, puis on les enregistre dans la bibliothèque.

import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import { h, toast, openModal } from './ui';
import { midiInput, statusLabel } from './midiInput';
import { micInput, micBanner, micLabel, refHz } from './mic';
import { audioOut, playNote, stopAll, unlockAudio, soundOut } from './synth';
import { loadOud, playOud, OudNeck } from './oud';
import { Keyboard } from './keyboard';
import { detectPitch, hzToPitch, NoteTracker } from './pitch';
import { parsePcn, pcnToXml, normalizePcn } from './codification';
import { getPiece, savePiece, listPieces, newId, pref, setPref, getDomain, type Piece } from './storage';
import { keyLabel } from './theory';
import {
  eventsToPcn, pcnToEvents, eventsToText, textToEvents, quantize, noteName, durName,
  type DEvent, type DictMeta, type Instrument, type RawNote
} from './notation';

type Source = 'midi' | 'micro';
type Mode = 'pas' | 'temps';
interface Snapshot { events: DEvent[]; caret: number; sel: [number, number] | null }
interface Draft { pieceId: string | null; events: DEvent[]; meta: DictMeta }

const MIC_LATENCY = 170; // ms entre l'attaque d'une note et sa reconnaissance au micro
const CHORD_MS = 110; // touches enfoncées ensemble = un accord (saisie pas à pas)
const DURS: [number, string][] = [[4, 'Ronde'], [2, 'Blanche'], [1, 'Noire'], [0.5, 'Croche'], [0.25, 'Double']];
const TIMES: [number, number][] = [[4, 4], [3, 4], [2, 4], [6, 8]];
const COLOR_SEL = '#d9480f';
const COLOR_PLAY = '#1c9a5a';

let clipboard: DEvent[] = [];
const clone = (evs: DEvent[]) => evs.map(e => ({ pitches: [...e.pitches], dur: e.dur }));
const isDotted = (d: number) => [0.75, 1.5, 3, 6].some(x => Math.abs(x - d) < 1e-6);

// ---------- métronome (clic de bruit : le micro ne le prend pas pour une note) ----------

class Metronome {
  private timer = 0;
  private next = 0;
  private beat = 0;
  private noise: AudioBuffer | null = null;

  start(bpm: number, beats: number, at: number): void {
    this.stop();
    const { ctx } = audioOut();
    if (!this.noise) {
      this.noise = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.03), ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3);
    }
    this.next = at;
    this.beat = 0;
    const step = 60 / bpm;
    this.timer = window.setInterval(() => {
      while (this.next < ctx.currentTime + 0.15) {
        this.click(this.next, this.beat % beats === 0);
        this.next += step;
        this.beat++;
      }
    }, 25);
  }

  private click(t: number, accent: boolean): void {
    const { ctx, out } = audioOut();
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = accent ? 3200 : 2000;
    const g = ctx.createGain();
    g.gain.value = accent ? 1.6 : 1;
    src.connect(f).connect(g).connect(out);
    src.start(Math.max(t, ctx.currentTime));
  }

  stop(): void { clearInterval(this.timer); this.timer = 0; }
  get running(): boolean { return this.timer !== 0; }
}

// ---------- l'écran ----------

export interface DictationHandle { el: HTMLElement; mount(): Promise<void>; destroy(): void }

export function createDictation(pieceId: string | null, onBack: () => void): DictationHandle {
  let piece: Piece | null = null;
  let events: DEvent[] = [];
  let caret = 0;
  let sel: [number, number] | null = null;
  let meta: DictMeta = {
    title: '', beats: 4, beatType: 4, fifths: 0, bpm: pref('dictee.bpm', 80),
    instrument: getDomain() === 'oud' ? 'oud' : 'piano'
  };
  let dirty = false;
  let undo: string[] = [];
  let redo: string[] = [];
  let src: Source = pref<Source>('dictee.src.' + meta.instrument, meta.instrument === 'oud' ? 'micro' : 'midi');
  let mode: Mode = pref<Mode>('dictee.mode', 'pas');
  let armed = false;
  let metroOn = pref('dictee.metro', true);
  let grid = pref('dictee.grid', 0.5);
  let sound: Instrument = meta.instrument;
  let curDur = pref('dictee.dur', 1);
  let dotted = false;
  let extend = false;
  let showKb = pref('dictee.kb', true);
  let micOn = false;
  let lastStep: { idx: number; t: number } | null = null;
  let rec: { raw: RawNote[]; origin: number | null } | null = null;
  let playing: { timer: number; idx: number; to: number; next: number; timers: number[] } | null = null;
  let playIdx = -1;
  let unsub: (() => void)[] = [];
  const metro = new Metronome();

  // ---------- éléments ----------
  const titleInput = h('input', { class: 'dt-title', placeholder: 'Titre de la dictée', oninput: () => { meta.title = titleInput.value; dirty = true; saveDraft(); } }) as HTMLInputElement;
  const playBtn = h('button', { class: 'icon', title: 'Écouter (espace)', onclick: () => togglePlay() }, '▶');
  const saveBtn = h('button', { class: 'primary', title: 'Enregistrer dans la bibliothèque', onclick: () => void save() }, '💾 Enregistrer');
  const scoreEl = h('div', { class: 'dt-score' });
  const scoreHost = h('div', { class: 'dt-score-host' });
  const emptyEl = h('div', { class: 'dt-empty' });
  scoreEl.append(emptyEl, scoreHost);
  const textEl = h('div', { class: 'dt-text', tabindex: '0' });
  const heardEl = h('span', { class: 'dt-heard' }, '—');
  const statusEl = h('span', { class: 'dt-status' });
  const countEl = h('span', { class: 'dt-count' });
  const banner = micBanner();
  const kbHost = h('div', { class: 'dt-kb' });
  const audioInput = h('input', { type: 'file', accept: 'audio/*,.wav,.mp3,.m4a,.ogg,.webm', style: 'display:none' }) as HTMLInputElement;

  const seg = (items: [string, string][], get: () => string, set: (v: string) => void) => {
    const el = h('div', { class: 'seg' });
    const paint = () => el.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === get()));
    el.append(...items.map(([v, label]) => {
      const b = h('button', { onclick: () => { set(v); paint(); } }, label);
      b.dataset.v = v;
      return b;
    }));
    paint();
    return { el, paint };
  };

  const recBtn = h('button', { class: 'dt-rec', onclick: () => toggleArmed() });
  const srcSeg = seg([['midi', '🎹 Clavier'], ['micro', '🎤 Micro']], () => src, v => setSource(v as Source));
  const modeSeg = seg([['pas', 'Pas à pas'], ['temps', 'Temps réel']], () => mode, v => setMode(v as Mode));
  const instSeg = seg([['piano', '🎹 Piano'], ['oud', 'Oud']], () => meta.instrument, v => setInstrument(v as Instrument));
  const soundSeg = seg([['piano', '🔊 Piano'], ['oud', '🔊 Oud']], () => sound, v => { sound = v as Instrument; if (sound === 'oud') void loadOud(); });
  const metroBtn = h('button', { title: 'Métronome pendant l\'enregistrement en temps réel', onclick: () => {
    metroOn = !metroOn; setPref('dictee.metro', metroOn); paintTools();
  } }, '🥁 Métronome');
  const bpmEl = h('span', { class: 'dt-bpm' });
  const bump = (d: number) => { meta.bpm = Math.max(30, Math.min(220, meta.bpm + d)); setPref('dictee.bpm', meta.bpm); dirty = true; paintTools(); scheduleRender(); };
  const tempoBox = h('div', { class: 'dt-tempo' }, [
    h('button', { class: 'icon', onclick: () => bump(-5) }, '−'), bpmEl, h('button', { class: 'icon', onclick: () => bump(5) }, '+')
  ]);
  const gridSel = h('select', { title: 'Précision du rythme', onchange: () => { grid = Number(gridSel.value); setPref('dictee.grid', grid); } }, [
    h('option', { value: '0.5' }, 'Rythme : croches'), h('option', { value: '0.25' }, 'Rythme : doubles croches')
  ]) as HTMLSelectElement;
  gridSel.value = String(grid);
  const timeSel = h('select', { title: 'Mesure', onchange: () => {
    const [b, t] = timeSel.value.split('/').map(Number);
    snapshot(); meta.beats = b; meta.beatType = t; changed();
  } }, TIMES.map(([b, t]) => h('option', { value: `${b}/${t}` }, `${b}/${t}`))) as HTMLSelectElement;
  const keySel = h('select', { title: 'Armure', onchange: () => { snapshot(); meta.fifths = Number(keySel.value); changed(); } },
    Array.from({ length: 15 }, (_, i) => i - 7).map(f => h('option', { value: String(f) }, f ? keyLabel(f) : 'Armure : aucune'))) as HTMLSelectElement;

  const durBtns = DURS.map(([d, label]) => {
    const b = h('button', { title: `${label} (touche ${DURS.findIndex(x => x[0] === d) + 1})`, onclick: () => setDur(d) }, label);
    b.dataset.d = String(d);
    return b;
  });
  const dotBtn = h('button', { title: 'Pointée (touche .)', onclick: () => toggleDot() }, '· Pointée');
  const extendBtn = h('button', { title: 'Étendre la sélection : touchez la dernière note du passage', onclick: () => { extend = !extend; paintTools(); } }, '⇔ Étendre');
  const quarterBtns = [
    h('button', { title: 'Un quart de ton plus bas', onclick: () => transpose(-0.5) }, '−¼ ton'),
    h('button', { title: 'Un quart de ton plus haut', onclick: () => transpose(0.5) }, '+¼ ton')
  ];
  const kbBtn = h('button', { title: 'Afficher le clavier ou le manche à l\'écran', onclick: () => { showKb = !showKb; setPref('dictee.kb', showKb); paintKb(); paintTools(); } }, '⌨ À l\'écran');

  const captureRow = h('div', { class: 'filters dt-row' }, [
    recBtn, srcSeg.el, modeSeg.el, metroBtn, tempoBox, gridSel,
    h('button', { title: 'Transcrire un enregistrement (une note à la fois)', onclick: () => audioInput.click() }, '📁 Fichier audio'),
    timeSel, keySel, instSeg.el, soundSeg.el
  ]);
  const editRow = h('div', { class: 'filters dt-row' }, [
    h('button', { class: 'icon', title: 'Annuler (Ctrl+Z)', onclick: () => doUndo() }, '↶'),
    h('button', { class: 'icon', title: 'Rétablir (Ctrl+Y)', onclick: () => doRedo() }, '↷'),
    h('button', { class: 'icon', title: 'Curseur à gauche', onclick: () => moveCaret(-1) }, '◀'),
    h('button', { class: 'icon', title: 'Curseur à droite', onclick: () => moveCaret(1) }, '▶'),
    extendBtn,
    ...durBtns, dotBtn,
    h('button', { title: 'Silence (touche 0)', onclick: () => rest() }, '𝄽 Silence'),
    h('button', { title: 'Réunir les notes sélectionnées en un accord', onclick: () => makeChord() }, 'Accord'),
    h('button', { title: 'Un demi-ton plus bas', onclick: () => transpose(-1) }, '♭'),
    h('button', { title: 'Un demi-ton plus haut', onclick: () => transpose(1) }, '♯'),
    ...quarterBtns,
    h('button', { title: 'Une octave plus bas', onclick: () => transpose(-12) }, '8ve ↓'),
    h('button', { title: 'Une octave plus haut', onclick: () => transpose(12) }, '8ve ↑'),
    h('button', { class: 'danger', title: 'Supprimer (Retour arrière)', onclick: () => remove() }, '⌫ Supprimer'),
    h('button', { title: 'Copier (Ctrl+C)', onclick: () => copy(false) }, 'Copier'),
    h('button', { title: 'Couper (Ctrl+X)', onclick: () => copy(true) }, 'Couper'),
    h('button', { title: 'Coller (Ctrl+V)', onclick: () => paste() }, 'Coller'),
    h('button', { title: 'Tout sélectionner (Ctrl+A)', onclick: () => selectAll() }, 'Tout'),
    h('button', { title: 'Écrire ou corriger les notes au clavier, comme un texte', onclick: () => openTextEditor() }, '✎ Texte'),
    kbBtn,
    h('button', { title: 'Commencer une nouvelle dictée', onclick: () => void newDoc() }, '🗋 Nouveau'),
    h('button', { title: 'Aide', onclick: () => openHelp() }, '❓')
  ]);

  const el = h('div', { class: 'trainer dictation' }, [
    h('header', { class: 'bar' }, [
      h('button', { class: 'icon', title: 'Retour', onclick: () => void leave() }, '←'),
      h('span', { class: 'dt-label' }, '✍'),
      titleInput,
      playBtn,
      saveBtn
    ]),
    banner.el,
    captureRow,
    editRow,
    h('div', { class: 'dt-main' }, [scoreEl, textEl]),
    h('div', { class: 'infobar' }, [h('span', {}, 'Entendu :'), heardEl, statusEl, countEl]),
    kbHost,
    audioInput
  ]);

  // ---------- OSMD ----------
  let osmd: OpenSheetMusicDisplay | null = null;
  let graphics: { ev: number; g: SVGGElement }[] = [];
  let colored: Element[] = [];
  let renderTimer = 0;
  let renderSeq = 0;

  const displayEvents = (): { evs: DEvent[]; ghostFrom: number; ghostTo: number } => {
    if (!rec) return { evs: events, ghostFrom: -1, ghostTo: -1 };
    const q = quantize(rec.raw, recOpts()).events;
    return { evs: [...events.slice(0, caret), ...q, ...events.slice(caret)], ghostFrom: caret, ghostTo: caret + q.length };
  };

  const scheduleRender = (delay = 180) => {
    clearTimeout(renderTimer);
    renderTimer = window.setTimeout(() => void renderScore(), delay);
  };

  const renderScore = async () => {
    const { evs } = displayEvents();
    const seq = ++renderSeq;
    if (!evs.length) {
      scoreHost.style.display = 'none';
      emptyEl.style.display = '';
      emptyEl.textContent = armed ? 'Jouez : les notes s\'écrivent ici.' : 'Touchez « ● Écrire » puis jouez : les notes s\'écrivent ici, sur la portée et en texte.';
      graphics = [];
      return;
    }
    emptyEl.style.display = 'none';
    scoreHost.style.display = '';
    if (!osmd) {
      osmd = new OpenSheetMusicDisplay(scoreHost, {
        backend: 'svg', autoResize: true, drawTitle: false, drawComposer: false, drawCredits: false, drawPartNames: false,
        autoBeam: true, pageBackgroundColor: '#fffdf8'
      });
      osmd.EngravingRules.PageTopMargin = 1;
      osmd.EngravingRules.PageBottomMargin = 1;
    }
    try {
      const xml = pcnToXml(parsePcn(eventsToPcn(evs, meta)), meta.title || 'Dictée');
      await osmd.load(xml);
      if (seq !== renderSeq) return;
      osmd.Zoom = scoreEl.clientWidth < 600 ? 0.75 : 0.9;
      osmd.render();
      collectGraphics(evs);
      paintScoreMarks();
    } catch (e) {
      emptyEl.style.display = '';
      emptyEl.textContent = `Affichage impossible : ${(e as Error).message}`;
    }
  };

  const collectGraphics = (evs: DEvent[]) => {
    graphics = [];
    colored = [];
    if (!osmd) return;
    const starts: number[] = [];
    let t = 0;
    for (const e of evs) { starts.push(t); t += e.dur; }
    const evAt = (q: number) => {
      let lo = 0, hi = starts.length - 1, best = 0;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (starts[mid] <= q + 1e-6) { best = mid; lo = mid + 1; } else hi = mid - 1; }
      return best;
    };
    try {
      const cursor = osmd.cursor;
      cursor.reset();
      const it = cursor.Iterator;
      let guard = 0;
      while (!it.EndReached && guard++ < 50000) {
        const q = it.CurrentEnrolledTimestamp.RealValue * 4;
        for (const ve of it.CurrentVoiceEntries) {
          for (const n of ve.Notes) {
            const g = (osmd.EngravingRules.GNote(n) as unknown as { getSVGGElement?: () => SVGGElement })?.getSVGGElement?.();
            if (g && q < t - 1e-6) graphics.push({ ev: evAt(q), g });
          }
        }
        cursor.next();
      }
      cursor.reset();
      cursor.hide();
    } catch { /* sans repérage, la portée reste affichée */ }
  };

  const paintScoreMarks = () => {
    colored.forEach(p => { p.removeAttribute('fill'); p.removeAttribute('stroke'); });
    colored = [];
    const { ghostFrom, ghostTo } = displayEvents();
    let first: SVGGElement | null = null;
    for (const { ev, g } of graphics) {
      const color = ev === playIdx ? COLOR_PLAY
        : (sel && ev >= sel[0] && ev < sel[1]) || (ev >= ghostFrom && ev < ghostTo) ? COLOR_SEL : null;
      if (!color) continue;
      first ??= g;
      g.querySelectorAll('path, rect').forEach(p => { p.setAttribute('fill', color); p.setAttribute('stroke', color); colored.push(p); });
    }
    first?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  scoreEl.addEventListener('click', e => {
    if (rec || !graphics.length) return;
    let best: { ev: number; d: number } | null = null;
    for (const { ev, g } of graphics) {
      const r = g.getBoundingClientRect();
      if (e.clientY < r.top - 50 || e.clientY > r.bottom + 50) continue;
      const d = Math.abs(e.clientX - (r.left + r.right) / 2);
      if (d < 40 && (!best || d < best.d)) best = { ev, d };
    }
    if (best) tapEvent(best.ev, e.shiftKey);
  });

  // ---------- texte ----------
  const renderText = () => {
    const { evs, ghostFrom, ghostTo } = displayEvents();
    const L = (meta.beats * 4) / meta.beatType;
    const nodes: HTMLElement[] = [];
    const caretEl = h('span', { class: 'dt-caret' + (armed ? ' armed' : '') });
    let t = 0;
    let measure = -1;
    let caretNode: HTMLElement | null = null;
    evs.forEach((ev, i) => {
      const m = Math.floor(t / L + 1e-6);
      if (m !== measure) { nodes.push(h('span', { class: 'dt-bar' }, String(m + 1))); measure = m; }
      const ghost = i >= ghostFrom && i < ghostTo;
      const realIdx = ghostFrom >= 0 && i >= ghostTo ? i - (ghostTo - ghostFrom) : i;
      if (!sel && !ghost && realIdx === caret && i === (ghostFrom >= 0 && caret >= ghostFrom ? caret + (ghostTo - ghostFrom) : caret)) nodes.push(caretNode = caretEl);
      const cls = ['dt-tok', ev.pitches.length ? '' : 'rest', ghost ? 'ghost' : '',
        !ghost && sel && realIdx >= sel[0] && realIdx < sel[1] ? 'sel' : '', !ghost && realIdx === playIdx ? 'playing' : ''].filter(Boolean).join(' ');
      nodes.push(h('button', { class: cls, onclick: (e: MouseEvent) => { e.stopPropagation(); if (!ghost) tapEvent(realIdx, e.shiftKey); } }, [
        h('span', { class: 'n' }, ev.pitches.length ? [...ev.pitches].sort((a, b) => a - b).map(p => noteName(p, meta.instrument, meta.fifths)).join('+') : '𝄽'),
        h('span', { class: 'd' }, durName(ev.dur))
      ]));
      t += ev.dur;
    });
    if (!sel && !caretNode) nodes.push(caretNode = caretEl);
    if (!evs.length) nodes.push(h('span', { class: 'meta dt-hint' }, 'Le texte des notes apparaîtra ici. Touchez une note pour la sélectionner, la modifier ou la supprimer.'));
    textEl.replaceChildren(...nodes);
    (caretNode ?? textEl.querySelector('.dt-tok.sel, .dt-tok.playing'))?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const total = events.reduce((s, e) => s + e.dur, 0);
    const notes = events.filter(e => e.pitches.length).length;
    countEl.textContent = `${notes} note${notes > 1 ? 's' : ''} · ${Math.max(events.length ? 1 : 0, Math.ceil(total / L - 1e-6))} mesure${total > L ? 's' : ''}`;
  };

  textEl.addEventListener('click', e => {
    if (e.target === textEl) { sel = null; caret = events.length; refreshSelection(); }
  });

  const refreshSelection = () => { renderText(); paintScoreMarks(); paintTools(); };
  const changed = () => { dirty = true; renderText(); scheduleRender(); paintTools(); saveDraft(); };

  // ---------- outils ----------
  const effDur = () => (dotted && curDur > 0.25 ? curDur * 1.5 : curDur);

  const paintTools = () => {
    recBtn.textContent = mode === 'pas' ? (armed ? '⏸ Pause' : '● Écrire') : (rec ? '■ Arrêter' : '● Enregistrer');
    recBtn.classList.toggle('on', armed);
    recBtn.title = mode === 'pas' ? 'Chaque note jouée s\'écrit avec la durée choisie' : 'Jouez librement : le rythme est relevé à l\'arrêt';
    srcSeg.paint(); modeSeg.paint(); instSeg.paint(); soundSeg.paint();
    metroBtn.classList.toggle('on', metroOn);
    metroBtn.style.display = mode === 'temps' ? '' : 'none';
    gridSel.style.display = mode === 'temps' ? '' : 'none';
    bpmEl.textContent = `♩ = ${meta.bpm}`;
    timeSel.value = `${meta.beats}/${meta.beatType}`;
    keySel.value = String(meta.fifths);
    const selDur = sel && sel[1] - sel[0] >= 1 ? events[sel[0]]?.dur : null;
    const shownDur = selDur ?? effDur();
    const baseDur = isDotted(shownDur) ? shownDur / 1.5 : shownDur;
    durBtns.forEach(b => b.classList.toggle('on', Math.abs(Number(b.dataset.d) - baseDur) < 1e-6));
    dotBtn.classList.toggle('on', selDur !== null ? isDotted(selDur) : dotted);
    extendBtn.classList.toggle('on', extend);
    quarterBtns.forEach(b => { b.style.display = meta.instrument === 'oud' ? '' : 'none'; });
    kbBtn.classList.toggle('on', showKb);
    playBtn.textContent = playing ? '■' : '▶';
    saveBtn.classList.toggle('primary', dirty || !piece);
    paintStatus();
  };

  const paintStatus = () => {
    if (rec) { statusEl.textContent = rec.origin && performance.now() < rec.origin ? '⏱ Décompte…' : `● Enregistrement (${rec.raw.length} notes)`; return; }
    const input = src === 'micro' ? micLabel(micInput.state) : midiInput.status.state === 'connected' ? `🎹 ${statusLabel(midiInput.status)}` : 'Aucun clavier MIDI : jouez sur l\'écran';
    statusEl.textContent = (armed ? '● ' : '') + input;
  };

  const paintKb = () => {
    kbHost.replaceChildren();
    kbHost.style.display = showKb ? '' : 'none';
    if (!showKb) return;
    if (meta.instrument === 'oud') {
      const neck = new OudNeck(p => { unlockAudio(); playOud(p, 0.9); input(p, false); });
      kbHost.append(neck.el);
    } else {
      const kb = new Keyboard(m => { unlockAudio(); playNote(m, 0.9, 85); kbHeld.add(m); input(m, false, [...kbHeld].some(x => x !== m)); }, m => { kbHeld.delete(m); release(m, false); });
      kb.setRange(36, 84);
      kbHost.append(kb.el);
    }
  };
  const kbHeld = new Set<number>();

  // ---------- historique ----------
  const state = (): string => JSON.stringify({ events, caret, sel } satisfies Snapshot);
  const restore = (s: string) => { const x = JSON.parse(s) as Snapshot; events = x.events; caret = x.caret; sel = x.sel; };
  const snapshot = () => { undo.push(state()); if (undo.length > 300) undo.shift(); redo = []; };
  const doUndo = () => { const s = undo.pop(); if (!s) { toast('Rien à annuler'); return; } redo.push(state()); restore(s); changed(); };
  const doRedo = () => { const s = redo.pop(); if (!s) { toast('Rien à rétablir'); return; } undo.push(state()); restore(s); changed(); };

  // ---------- sélection ----------
  const tapEvent = (i: number, shift = false) => {
    if (playing) stopPlay();
    if ((extend || shift) && (sel || events.length)) {
      if (sel) sel = i >= sel[0] ? [sel[0], i + 1] : [i, sel[1]];
      else sel = i >= caret ? [caret, i + 1] : [i, caret];
      caret = sel[1];
      extend = false;
    } else if (sel && sel[0] === i && sel[1] === i + 1) {
      sel = null; caret = i + 1;
    } else {
      sel = [i, i + 1]; caret = i + 1;
      preview(events[i]);
    }
    lastStep = null;
    refreshSelection();
  };

  const moveCaret = (d: number, shift = false) => {
    if (shift) {
      const anchor = sel ? (caret === sel[1] ? sel[0] : sel[1]) : caret;
      const to = Math.max(0, Math.min(events.length, caret + d));
      caret = to;
      sel = anchor === to ? null : [Math.min(anchor, to), Math.max(anchor, to)];
    } else {
      caret = sel ? (d < 0 ? sel[0] : sel[1]) : Math.max(0, Math.min(events.length, caret + d));
      sel = null;
    }
    lastStep = null;
    refreshSelection();
  };

  const selectAll = () => { if (!events.length) return; sel = [0, events.length]; caret = events.length; refreshSelection(); };
  /** Ce sur quoi porte une modification : la sélection, sinon la note juste avant le curseur. */
  const targets = (): [number, number] | null => sel ?? (caret > 0 ? [caret - 1, caret] : null);

  // ---------- modifications ----------
  const setDur = (d: number) => {
    curDur = d;
    setPref('dictee.dur', d);
    if (d === 0.25) dotted = false;
    if (sel) {
      snapshot();
      for (let i = sel[0]; i < sel[1]; i++) events[i].dur = dotted && d > 0.25 ? d * 1.5 : d;
      changed();
    } else paintTools();
  };

  const toggleDot = () => {
    if (sel) {
      snapshot();
      const on = !isDotted(events[sel[0]].dur);
      for (let i = sel[0]; i < sel[1]; i++) {
        const e = events[i];
        if (on && !isDotted(e.dur) && e.dur > 0.25) e.dur *= 1.5;
        else if (!on && isDotted(e.dur)) e.dur /= 1.5;
      }
      dotted = on;
      changed();
      return;
    }
    dotted = !dotted && curDur > 0.25;
    paintTools();
  };

  const rest = () => {
    snapshot();
    if (sel) for (let i = sel[0]; i < sel[1]; i++) events[i].pitches = [];
    else { events.splice(caret, 0, { pitches: [], dur: effDur() }); caret++; }
    lastStep = null;
    changed();
  };

  const makeChord = () => {
    if (!sel || sel[1] - sel[0] < 2) { toast('Sélectionnez plusieurs notes (⇔ Étendre) pour en faire un accord', 3000); return; }
    snapshot();
    const group = events.slice(sel[0], sel[1]);
    const chord: DEvent = { pitches: [...new Set(group.flatMap(e => e.pitches))].sort((a, b) => a - b), dur: group[0].dur };
    events.splice(sel[0], group.length, chord);
    sel = [sel[0], sel[0] + 1];
    caret = sel[1];
    changed();
    preview(chord);
  };

  const transpose = (d: number) => {
    const r = targets();
    if (!r) { toast('Sélectionnez d\'abord une note'); return; }
    snapshot();
    for (let i = r[0]; i < r[1]; i++) events[i].pitches = events[i].pitches.map(p => Math.max(21, Math.min(108, p + d))).sort((a, b) => a - b);
    changed();
    if (r[1] - r[0] === 1) preview(events[r[0]]);
  };

  const remove = () => {
    if (sel) { snapshot(); events.splice(sel[0], sel[1] - sel[0]); caret = sel[0]; sel = null; }
    else if (caret > 0) { snapshot(); events.splice(caret - 1, 1); caret--; }
    else return;
    lastStep = null;
    changed();
  };

  const copy = (cut: boolean) => {
    if (!sel) { toast('Sélectionnez d\'abord des notes'); return; }
    clipboard = clone(events.slice(sel[0], sel[1]));
    toast(`${clipboard.length} élément${clipboard.length > 1 ? 's' : ''} ${cut ? 'coupé' : 'copié'}${clipboard.length > 1 ? 's' : ''}`);
    if (cut) remove();
  };

  const paste = () => {
    if (!clipboard.length) { toast('Rien à coller'); return; }
    snapshot();
    const items = clone(clipboard);
    if (sel) { events.splice(sel[0], sel[1] - sel[0], ...items); caret = sel[0] + items.length; sel = null; }
    else { events.splice(caret, 0, ...items); caret += items.length; }
    changed();
  };

  const nNotes = () => events.filter(e => e.pitches.length).length;
  /** Question claire avant de perdre des notes : enregistrer, ignorer, ou revenir à l’édition. */
  const askSave = (title: string, text: string, discardLabel: string): Promise<'save' | 'discard' | 'cancel'> => new Promise(resolve => {
    let answer: 'save' | 'discard' | 'cancel' = 'cancel';
    const pick = (a: typeof answer) => { answer = a; close(); };
    const body = h('div', { class: 'form' }, [
      h('h3', {}, title),
      h('p', {}, text),
      h('p', { class: 'meta' }, `${nNotes()} note${nNotes() > 1 ? 's' : ''}${piece ? ` · « ${piece.title} »` : ' · pas encore enregistrée'}`)
    ]);
    const close = openModal('Modifications non enregistrées', body, [
      h('button', { onclick: () => pick('cancel') }, '↩ Annuler, retour à l’édition'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'danger', onclick: () => pick('discard') }, discardLabel),
      h('button', { class: 'primary', onclick: () => pick('save') }, '💾 Oui, enregistrer')
    ], () => resolve(answer));
  });

  const newDoc = async () => {
    if (events.length && dirty) {
      const r = await askSave('Enregistrer avant de commencer une nouvelle dictée ?',
        'Les notes écrites n’ont pas été enregistrées.', 'Non, ignorer');
      if (r === 'cancel') return;
      if (r === 'save' && !(await save())) return;
    }
    stopPlay(); stopRec();
    piece = null;
    events = []; caret = 0; sel = null; undo = []; redo = [];
    meta = { ...meta, title: '' };
    titleInput.value = '';
    dirty = false;
    setPref('dictee.draft', null);
    history.replaceState(null, '', '#/dictee');
    changed();
    dirty = false;
    paintTools();
  };

  // ---------- saisie ----------
  const norm = (p: number) => (meta.instrument === 'oud' ? Math.round(p * 2) / 2 : Math.round(p));

  /** chordable : une autre touche est encore enfoncée (accord possible) */
  const input = (raw: number, fromMic: boolean, chordable = false) => {
    const p = norm(raw);
    heardEl.textContent = noteName(p, meta.instrument, meta.fifths);
    if (playing || !armed) return;
    if (mode === 'temps') {
      if (!rec) return;
      rec.raw.push({ p, on: performance.now() - (fromMic ? MIC_LATENCY : 0), off: null });
      renderText();
      scheduleRender(350);
      paintStatus();
      return;
    }
    const now = performance.now();
    if (chordable && lastStep && now - lastStep.t < CHORD_MS && events[lastStep.idx]) {
      const e = events[lastStep.idx];
      if (!e.pitches.includes(p)) e.pitches = [...e.pitches, p].sort((a, b) => a - b);
      changed();
      return;
    }
    snapshot();
    if (sel) {
      // une note sélectionnée est remplacée par celle jouée (sa durée est gardée), puis on passe à la suivante
      const i = sel[0];
      events[i].pitches = [p];
      lastStep = { idx: i, t: now };
      if (i + 1 < events.length) { sel = [i + 1, i + 2]; caret = i + 2; } else { sel = null; caret = events.length; }
    } else {
      events.splice(caret, 0, { pitches: [p], dur: effDur() });
      lastStep = { idx: caret, t: now };
      caret++;
    }
    changed();
  };

  const release = (raw: number, fromMic: boolean) => {
    if (!rec) return;
    const p = norm(raw);
    for (let i = rec.raw.length - 1; i >= 0; i--) {
      const n = rec.raw[i];
      if (n.p === p && n.off === null) { n.off = performance.now() - (fromMic ? MIC_LATENCY : 0); break; }
    }
  };

  const setSource = (s: Source) => {
    src = s;
    setPref('dictee.src.' + meta.instrument, s);
    if (s === 'micro' && !micOn) { micOn = true; void micInput.start(); }
    if (s !== 'micro' && micOn) { micOn = false; micInput.stop(); }
    paintTools();
  };

  const setMode = (m: Mode) => {
    if (rec) stopRec();
    armed = false;
    mode = m;
    setPref('dictee.mode', m);
    renderText();
    paintTools();
  };

  const setInstrument = (i: Instrument) => {
    if (i === meta.instrument) return;
    snapshot();
    meta.instrument = i;
    sound = i;
    if (i === 'piano') events.forEach(e => { e.pitches = [...new Set(e.pitches.map(Math.round))]; });
    else void loadOud();
    setSource(pref<Source>('dictee.src.' + i, i === 'oud' ? 'micro' : 'midi'));
    paintKb();
    changed();
  };

  const recOpts = () => ({
    bpm: metroOn ? meta.bpm : null, origin: metroOn ? rec?.origin ?? undefined : undefined,
    grid, restMin: src === 'micro' ? 1 : 0.5
  });

  const toggleArmed = () => {
    unlockAudio();
    if (playing) stopPlay();
    if (mode === 'pas') { armed = !armed; lastStep = null; renderText(); scheduleRender(0); paintTools(); return; }
    if (rec) stopRec(); else startRec();
  };

  const startRec = () => {
    armed = true;
    rec = { raw: [], origin: null };
    if (metroOn) {
      const { ctx } = audioOut();
      const beat = 60 / meta.bpm;
      const at = ctx.currentTime + 0.15;
      metro.start(meta.bpm, meta.beats, at);
      // le premier temps après une mesure de décompte (son réellement entendu : on ajoute la latence de sortie)
      const lat = (ctx.outputLatency || ctx.baseLatency || 0) * 1000;
      rec.origin = performance.now() + (0.15 + beat * meta.beats) * 1000 + lat;
      const tick = window.setInterval(() => { if (!rec) clearInterval(tick); else paintStatus(); }, 250);
    }
    paintTools();
    renderText();
  };

  const stopRec = () => {
    metro.stop();
    if (!rec) { armed = false; return; }
    const r = rec;
    rec = null;
    armed = false;
    // notes encore tenues : elles finissent maintenant
    const now = performance.now();
    r.raw.forEach(n => { n.off ??= now; });
    if (r.raw.length) {
      const q = quantize(r.raw, { bpm: metroOn ? meta.bpm : null, origin: metroOn ? r.origin ?? undefined : undefined, grid, restMin: src === 'micro' ? 1 : 0.5 });
      snapshot();
      if (!metroOn) { meta.bpm = q.bpm; toast(`Tempo estimé : ♩ = ${q.bpm}`, 2500); }
      events.splice(caret, 0, ...q.events);
      caret += q.events.length;
      sel = null;
      changed();
    } else { renderText(); scheduleRender(0); paintTools(); }
  };

  // ---------- écoute ----------
  const toPiano = () => soundOut() === 'auto' && midiInput.canPlay;
  const sing = (p: number, sec: number, when = 0, vel = 85) => {
    if (sound === 'oud') playOud(p, sec, vel, when);
    else {
      playNote(toPiano() ? Math.round(p) : p, sec * 0.95, vel, when);
      micInput.mute(sec * 1000 + 500 + Math.max(0, (when - audioOut().ctx.currentTime) * 1000));
    }
  };
  const preview = (e: DEvent | undefined) => { if (e?.pitches.length) { unlockAudio(); e.pitches.forEach(p => sing(p, 0.6)); } };

  const togglePlay = () => { if (playing) stopPlay(); else startPlay(); };

  const startPlay = () => {
    if (!events.length) { toast('Rien à écouter'); return; }
    unlockAudio();
    if (rec) stopRec();
    if (sound === 'oud') void loadOud();
    const from = sel ? sel[0] : caret < events.length ? caret : 0;
    const to = sel && sel[1] - sel[0] > 1 ? sel[1] : events.length;
    const { ctx } = audioOut();
    const p = { timer: 0, idx: from, to, next: ctx.currentTime + 0.12, timers: [] as number[] };
    playing = p;
    const spb = 60 / meta.bpm;
    p.timer = window.setInterval(() => {
      while (p.idx < p.to && p.next < ctx.currentTime + 0.3) {
        const i = p.idx;
        const e = events[i];
        const sec = e.dur * spb;
        e.pitches.forEach(x => sing(x, sec, p.next));
        p.timers.push(window.setTimeout(() => { playIdx = i; renderText(); paintScoreMarks(); }, Math.max(0, (p.next - ctx.currentTime) * 1000)));
        p.next += sec;
        p.idx++;
      }
      if (p.idx >= p.to && ctx.currentTime > p.next) stopPlay();
    }, 40);
    paintTools();
  };

  const stopPlay = () => {
    if (!playing) return;
    clearInterval(playing.timer);
    playing.timers.forEach(t => clearTimeout(t));
    playing = null;
    playIdx = -1;
    stopAll();
    renderText();
    paintScoreMarks();
    paintTools();
  };

  // ---------- fichier audio ----------
  audioInput.addEventListener('change', () => {
    const f = audioInput.files?.[0];
    audioInput.value = '';
    if (f) void transcribeFile(f);
  });

  const transcribeFile = async (file: File) => {
    let cancelled = false;
    const status = h('div', { class: 'scan-status' }, 'Lecture du fichier…');
    const body = h('div', { class: 'scan-body' }, [
      h('div', { class: 'scan-spinner' }), status,
      h('p', { class: 'meta' }, file.name),
      h('p', { class: 'meta' }, 'Les notes sont relevées une à une : un enregistrement d\'une seule mélodie (oud, voix, piano joué note par note) donne le meilleur résultat.')
    ]);
    const close = openModal('Transcription d\'un enregistrement', body, [h('span', { class: 'spacer' }), h('button', { onclick: () => close() }, 'Annuler')], () => { cancelled = true; });
    try {
      const { ctx } = audioOut();
      const buf = await ctx.decodeAudioData(await file.arrayBuffer());
      if (buf.duration > 600) throw new Error('Enregistrement trop long (10 minutes au plus).');
      const sr = buf.sampleRate;
      const mono = new Float32Array(buf.length);
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < d.length; i++) mono[i] += d[i] / buf.numberOfChannels;
      }
      const raw: RawNote[] = [];
      const open = new Map<number, RawNote>();
      let t = 0;
      const tracker = new NoteTracker(
        p => { const n: RawNote = { p: norm(p), on: t, off: null }; raw.push(n); open.set(p, n); },
        p => { const n = open.get(p); if (n) { n.off = t; open.delete(p); } }
      );
      const win = 4096;
      const hop = Math.round(sr * 0.05);
      const frames = Math.max(0, Math.floor((mono.length - win) / hop));
      for (let f = 0; f < frames; f++) {
        if (cancelled) return;
        const frame = mono.subarray(f * hop, f * hop + win);
        let sum = 0;
        for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
        const rms = Math.sqrt(sum / frame.length);
        const d = rms >= 0.002 ? detectPitch(frame, sr) : null;
        t = (f * hop / sr) * 1000;
        tracker.feed(d && d.clarity >= 0.85 ? hzToPitch(d.freq, refHz()) : null, rms, t);
        if (f % 150 === 0) {
          status.textContent = `Écoute : ${Math.round((f / frames) * 100)} % · ${raw.length} notes`;
          await new Promise(r => setTimeout(r, 0));
        }
      }
      tracker.reset();
      if (cancelled) return;
      if (!raw.length) throw new Error('Aucune note reconnue dans cet enregistrement.');
      const q = quantize(raw, { bpm: null, grid, restMin: 1 });
      snapshot();
      meta.bpm = q.bpm;
      events.splice(caret, 0, ...q.events);
      caret += q.events.length;
      sel = null;
      if (!titleInput.value.trim()) { titleInput.value = file.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' '); meta.title = titleInput.value; }
      changed();
      close();
      toast(`${q.events.filter(e => e.pitches.length).length} notes relevées · ♩ = ${q.bpm}. Vérifiez à l'écoute.`, 4000);
    } catch (e) {
      if (cancelled) return;
      status.textContent = (e as Error).message.includes('decode') || (e as Error).name === 'EncodingError'
        ? 'Format audio non reconnu par ce téléphone.' : (e as Error).message;
      status.classList.add('bad');
      body.querySelector('.scan-spinner')?.remove();
    }
  };

  // ---------- texte complet ----------
  const openTextEditor = () => {
    stopPlay();
    const area = h('textarea', { class: 'pcn', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off' }) as HTMLTextAreaElement;
    area.value = eventsToText(events, meta);
    const msg = h('div', { class: 'meta' });
    const check = () => {
      const r = textToEvents(area.value);
      msg.className = 'meta ' + (r.problems.length ? 'bad' : 'ok');
      msg.textContent = r.problems.length ? `À corriger : ${r.problems.slice(0, 5).join(' ; ')}${r.problems.length > 5 ? '…' : ''}` : `${r.events.length} éléments, tout est lisible.`;
      return r;
    };
    area.addEventListener('input', () => check());
    check();
    const body = h('div', { class: 'pcn-tab' }, [
      h('p', { class: 'meta' }, 'Une note = nom + octave : durée. Ex. « Do3:1 Ré3:0.5 Mi3:0.5 | Sol3+Si3:2 -:1 ». Les barres | ne servent qu\'à la lecture.'),
      area, msg,
      h('details', { class: 'pcn-help' }, [h('summary', {}, 'Comment écrire'), h('pre', {}, `Notes : Do Ré Mi Fa Sol La Si + octave (Do3 = do central).
Altérations : Do#3 ou Do♯3 (dièse), Sib3 ou Si♭3 (bémol).
Quarts de ton (oud) : Mi½♭3 ou Mid3 (demi-bémol), Fa½♯3 ou Faq3 (demi-dièse).
Accord : Do3+Mi3+Sol3     Silence : -
Durée en noires : 4 ronde · 2 blanche · 1 noire · 0.5 croche · 0.25 double · 1.5 noire pointée
La notation anglaise est aussi acceptée : C4:1 Bb3:0.5`)])
    ]);
    const close = openModal('Les notes en texte', body, [
      h('button', { onclick: async () => { try { await navigator.clipboard.writeText(area.value); toast('Texte copié'); } catch { toast('Copie impossible'); } } }, 'Copier le texte'),
      h('span', { class: 'spacer' }),
      h('button', { onclick: () => close() }, 'Annuler'),
      h('button', { class: 'primary', onclick: () => {
        const r = check();
        if (r.problems.length) { toast('Corrigez les éléments signalés', 3000); return; }
        snapshot();
        events = r.events;
        caret = events.length;
        sel = null;
        changed();
        close();
      } }, 'Appliquer')
    ], undefined, false);
    setTimeout(() => area.focus(), 50);
  };

  const openHelp = () => {
    const body = h('div', { class: 'help-body', html: `
      <p><b>Écrire :</b> touchez <b>● Écrire</b> puis jouez. <b>Clavier</b> = piano numérique branché en USB (ou le clavier à l'écran) ; <b>Micro</b> = le téléphone écoute l'instrument (une note à la fois).</p>
      <p><b>Pas à pas :</b> chaque note jouée s'écrit avec la durée choisie (Noire, Croche…). Plusieurs touches ensemble = un accord. <b>Temps réel :</b> jouez librement, avec ou sans métronome ; à l'arrêt, le rythme est relevé et écrit.</p>
      <p><b>Corriger :</b> touchez une note (sur la portée ou dans le texte) pour la sélectionner. Changez sa durée, montez-la (♯, 8ve ↑), supprimez-la (⌫), ou rejouez la bonne note : elle remplace la note sélectionnée. <b>⇔ Étendre</b> puis une autre note sélectionne un passage, à copier, couper, coller ou réunir en accord. ↶ annule.</p>
      <p><b>Le curseur</b> (trait orange) indique où s'insère la prochaine note, comme dans un texte : ◀ ▶ pour le déplacer.</p>
      <p><b>✎ Texte :</b> toutes les notes en texte (« Do3:1 Ré3:0.5… ») : on peut les écrire ou les corriger au clavier.</p>
      <p><b>Écouter :</b> ▶ joue depuis le curseur ou la sélection, au son du piano ou du oud (🔊).</p>
      <p><b>📁 Fichier audio :</b> transcrit un enregistrement (mélodie seule de préférence).</p>
      <p><b>💾 Enregistrer :</b> la dictée rejoint « Mes partitions » (catégorie Dictées) : elle se joue ensuite comme les autres partitions. Pour la reprendre ici : fiche de la partition, « ✍ Modifier les notes ».</p>
      <p><b>Au clavier d'ordinateur :</b> flèches (Maj pour sélectionner), Retour arrière, Ctrl+Z / Ctrl+Y, Ctrl+C / X / V, 1 à 5 pour les durées, « . » pointée, 0 silence, espace pour écouter.</p>` });
    const close = openModal('Aide — Dictée', body, [h('span', { class: 'spacer' }), h('button', { class: 'primary', onclick: () => close() }, 'Fermer')]);
  };

  // ---------- enregistrement ----------
  const defaultTitle = () => `Dictée du ${new Date().toLocaleDateString('fr-FR')} ${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;

  /** Fiche à remplir à l'enregistrement : titre, artiste d'origine, catégorie… */
  const save = (): Promise<boolean> => new Promise(resolve => {
    if (rec) stopRec();
    if (!events.length) { toast('Rien à enregistrer : jouez d’abord quelques notes.'); resolve(false); return; }
    let done = false;
    const field = (label: string, input: HTMLElement) => h('label', { class: 'field' }, [h('span', {}, label), input]);
    const title = h('input', { value: titleInput.value.trim() || piece?.title || '', placeholder: defaultTitle() }) as HTMLInputElement;
    const composer = h('input', { value: piece?.composer ?? '', placeholder: 'ex. Fairouz, Chopin, moi-même…', list: 'dl-dt-composers' }) as HTMLInputElement;
    const category = h('input', { value: piece?.category ?? 'Dictées', placeholder: 'ex. Dictées, Variété, Exercices…', list: 'dl-dt-categories' }) as HTMLInputElement;
    const tags = h('input', { value: (piece?.tags ?? []).join(', '), placeholder: 'ex. refrain, maqam rast, à travailler' }) as HTMLInputElement;
    const stars = (n: number) => '★'.repeat(n) + '☆'.repeat(5 - n);
    const difficulty = h('select', {}, [0, 1, 2, 3, 4, 5].map(n => {
      const o = h('option', { value: String(n) }, n ? `${stars(n)}  (${n}/5)` : 'Non précisée') as HTMLOptionElement;
      if ((piece?.difficulty ?? 0) === n) o.selected = true;
      return o;
    })) as HTMLSelectElement;
    const note = h('textarea', { rows: 3, placeholder: 'Où, quand, avec qui… doigtés, passages à revoir' }) as HTMLTextAreaElement;
    note.value = piece?.note ?? '';
    const dlCats = h('datalist', { id: 'dl-dt-categories' });
    const dlComp = h('datalist', { id: 'dl-dt-composers' });
    void listPieces().then(all => {
      const uniq = (v: (string | undefined)[]) => [...new Set(v.filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b, 'fr'));
      dlCats.replaceChildren(...uniq(['Dictées', ...all.map(x => x.category)]).map(c => h('option', { value: c })));
      dlComp.replaceChildren(...uniq(all.map(x => x.composer)).map(c => h('option', { value: c })));
    });
    const body = h('div', { class: 'form' }, [
      field('Titre', title),
      field('Artiste / compositeur d’origine', composer),
      field('Catégorie', category),
      field('Étiquettes (séparées par des virgules)', tags),
      field('Difficulté', difficulty),
      field('Note personnelle', note),
      dlCats, dlComp,
      h('p', { class: 'meta' }, `${events.filter(e => e.pitches.length).length} notes · ${meta.instrument === 'oud' ? 'Oud' : 'Piano'} · ${meta.beats}/${meta.beatType} · ♩ = ${meta.bpm}. La dictée rejoint « Mes partitions » et se joue comme les autres.`)
    ]);
    const confirmSave = async () => {
      const t = title.value.trim() || defaultTitle();
      const comp = composer.value.trim() || undefined;
      titleInput.value = t;
      meta.title = t;
      const code = normalizePcn(eventsToPcn(events, meta), t, comp);
      const xml = pcnToXml(parsePcn(code), t);
      piece ??= { id: newId(), title: t, xml, code, source: 'dictee', addedAt: Date.now() };
      Object.assign(piece, {
        title: t, code, xml, composer: comp,
        category: category.value.trim() || undefined,
        tags: tags.value.split(',').map(x => x.trim()).filter(Boolean),
        difficulty: Number(difficulty.value) || undefined,
        note: note.value.trim() || undefined,
        instrument: meta.instrument === 'oud' ? 'oud' : undefined
      });
      await savePiece(piece);
      dirty = false;
      setPref('dictee.draft', null);
      history.replaceState(null, '', `#/dictee/${encodeURIComponent(piece.id)}`);
      paintTools();
      toast(`« ${t} » enregistrée dans Mes partitions${meta.instrument === 'oud' ? ' (Oud)' : ''}`, 2600);
      done = true;
      close();
      resolve(true);
    };
    const close = openModal(piece ? 'Enregistrer la dictée' : 'Nouvelle partition — enregistrer', body, [
      h('span', { class: 'spacer' }),
      h('button', { onclick: () => close() }, 'Annuler'),
      h('button', { class: 'primary', onclick: () => void confirmSave() }, '💾 Enregistrer')
    ], () => { if (!done) resolve(false); });
    setTimeout(() => title.focus(), 50);
  });

  const saveDraft = () => {
    if (!dirty) return;
    setPref('dictee.draft', { pieceId: piece?.id ?? null, events, meta } satisfies Draft);
  };

  const leave = async () => {
    if (dirty && events.length) {
      const r = await askSave('Enregistrer la dictée avant de quitter ?',
        piece ? 'Les dernières modifications n’ont pas été enregistrées.' : 'Ces notes n’ont pas encore été enregistrées dans la bibliothèque.',
        piece ? 'Non, ignorer les modifications' : 'Non, ignorer');
      if (r === 'cancel') return;
      if (r === 'save' && !(await save())) return;
      if (r === 'discard') setPref('dictee.draft', null);
    }
    onBack();
  };

  // ---------- raccourcis clavier ----------
  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest('input, textarea, select, .modal-overlay') || document.querySelector('.modal-overlay')) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    let used = true;
    if (mod && k === 'z') { if (e.shiftKey) doRedo(); else doUndo(); }
    else if (mod && k === 'y') doRedo();
    else if (mod && k === 'c') copy(false);
    else if (mod && k === 'x') copy(true);
    else if (mod && k === 'v') paste();
    else if (mod && k === 'a') selectAll();
    else if (mod && k === 's') void save();
    else if (mod) used = false;
    else if (e.key === 'ArrowLeft') moveCaret(-1, e.shiftKey);
    else if (e.key === 'ArrowRight') moveCaret(1, e.shiftKey);
    else if (e.key === 'Home') { caret = 0; sel = null; refreshSelection(); }
    else if (e.key === 'End') { caret = events.length; sel = null; refreshSelection(); }
    else if (e.key === 'Backspace') remove();
    else if (e.key === 'Delete') { if (!sel && caret < events.length) { sel = [caret, caret + 1]; } remove(); }
    else if (e.key === ' ') togglePlay();
    else if (/^[1-5]$/.test(e.key)) setDur(DURS[Number(e.key) - 1][0]);
    else if (e.key === '.') toggleDot();
    else if (e.key === '0') rest();
    else if (e.key === 'ArrowUp') transpose(e.shiftKey ? 12 : 1);
    else if (e.key === 'ArrowDown') transpose(e.shiftKey ? -12 : -1);
    else used = false;
    if (used) e.preventDefault();
  };

  // ---------- cycle de vie ----------
  return {
    el,
    async mount() {
      if (pieceId) {
        piece = (await getPiece(pieceId)) ?? null;
        if (piece?.code) {
          const r = pcnToEvents(piece.code);
          events = r.events;
          meta = { ...r.meta, title: piece.title, instrument: piece.instrument === 'oud' ? 'oud' : 'piano' };
        } else if (piece) { toast('Cette partition n\'a pas de codification : impossible de la reprendre ici.', 4000); piece = null; }
      }
      const draft = pref<Draft | null>('dictee.draft', null);
      if (draft && draft.pieceId === (piece?.id ?? null) && draft.events?.length) {
        events = draft.events;
        meta = { ...meta, ...draft.meta };
        dirty = true;
        toast('Brouillon non enregistré repris', 2500);
      }
      caret = events.length;
      sound = meta.instrument;
      titleInput.value = meta.title;
      src = pref<Source>('dictee.src.' + meta.instrument, meta.instrument === 'oud' ? 'micro' : 'midi');
      unsub.push(
        midiInput.onNoteOn(m => { if (src === 'midi' && !kbHeld.has(m)) input(m, false, [...midiInput.held].some(x => x !== m)); }),
        midiInput.onNoteOff(m => { if (src === 'midi' && !kbHeld.has(m)) release(m, false); }),
        midiInput.onStatus(() => paintStatus()),
        micInput.onNoteOn(p => { if (src === 'micro') input(p, true); }),
        micInput.onNoteOff(p => { if (src === 'micro') release(p, true); }),
        micInput.onState(() => paintStatus())
      );
      document.addEventListener('keydown', onKey);
      if (src === 'micro') { micOn = true; void micInput.start(); }
      if (meta.instrument === 'oud') void loadOud();
      paintKb();
      paintTools();
      renderText();
      await renderScore();
    },
    destroy() {
      stopPlay();
      metro.stop();
      rec = null;
      clearTimeout(renderTimer);
      unsub.forEach(f => f());
      unsub = [];
      banner.destroy();
      document.removeEventListener('keydown', onKey);
      if (micOn) { micOn = false; micInput.stop(); }
      osmd?.clear();
    }
  };
}
