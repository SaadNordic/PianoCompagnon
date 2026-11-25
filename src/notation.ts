// Dictée de notes : modèle du « texte musical » et conversions, sans dépendance à l'écran.
// Une dictée est une suite d'événements joués l'un après l'autre (comme les mots d'un texte) :
// une note, un accord ou un silence, chacun avec sa durée en noires.
// Les hauteurs sont le son réel en MIDI décimal (63,5 = Mi½♭) ; la partition du oud est écrite une octave au-dessus.

import { PCN_HEADER, parsePcn } from './codification';

export interface DEvent { pitches: number[]; dur: number } // pitches vide = silence
export type Instrument = 'piano' | 'oud';
export interface DictMeta { title: string; beats: number; beatType: number; fifths: number; bpm: number; instrument: Instrument }

export const OUD_WRITTEN = 12;
export const MIN_DUR = 0.25; // grille à la double croche (celle de la partition affichée)

const fmt = (x: number) => String(+x.toFixed(4));
const snapDur = (d: number) => Math.max(MIN_DUR, Math.round(d / MIN_DUR) * MIN_DUR);

// ---------- noms ----------

const FR = ['Do', 'Do♯', 'Ré', 'Mi♭', 'Mi', 'Fa', 'Fa♯', 'Sol', 'La♭', 'La', 'Si♭', 'Si'];
const FR_SHARP = ['Do', 'Do♯', 'Ré', 'Ré♯', 'Mi', 'Fa', 'Fa♯', 'Sol', 'Sol♯', 'La', 'La♯', 'Si'];
const FR_FLAT = ['Do', 'Ré♭', 'Ré', 'Mi♭', 'Mi', 'Fa', 'Sol♭', 'Sol', 'La♭', 'La', 'Si♭', 'Si'];
const FR_Q: Record<number, string> = {
  1: 'Do½♯', 3: 'Ré½♭', 5: 'Ré½♯', 7: 'Mi½♭', 9: 'Fa½♭', 11: 'Fa½♯', 13: 'Sol½♭', 15: 'Sol½♯', 17: 'La½♭', 19: 'La½♯', 21: 'Si½♭', 23: 'Do½♭'
};

/** Nom français avec octave (convention française : do central = Do3), quarts de ton compris. */
export function noteName(p: number, inst: Instrument, fifths = 0): string {
  const q = Math.round(p * 2);
  const idx = ((q % 24) + 24) % 24;
  if (idx % 2) {
    const base = idx === 23 ? q + 1 : q; // Do½♭ appartient à l'octave du Do au-dessus
    return FR_Q[idx] + String(Math.floor(base / 24) - 2);
  }
  const m = q / 2;
  const table = inst === 'oud' ? FR : fifths < 0 ? FR_FLAT : FR_SHARP;
  return table[((m % 12) + 12) % 12] + String(Math.floor(m / 12) - 2);
}

export function eventName(e: DEvent, inst: Instrument, fifths = 0): string {
  if (!e.pitches.length) return 'Silence';
  return [...e.pitches].sort((a, b) => a - b).map(p => noteName(p, inst, fifths)).join(' + ');
}

const DUR_NAMES: Record<string, string> = {
  4: 'ronde', 3: 'blanche pointée', 2: 'blanche', 1.5: 'noire pointée', 1: 'noire', 0.75: 'croche pointée', 0.5: 'croche', 0.25: 'double croche'
};
export function durName(d: number): string {
  return DUR_NAMES[fmt(d)] ?? `${fmt(d).replace('.', ',')} temps`;
}

// ---------- codification PCN ----------

const LETTERS: Record<number, [string, number]> = { 0: ['C', 0], 2: ['D', 0], 4: ['E', 0], 5: ['F', 0], 7: ['G', 0], 9: ['A', 0], 11: ['B', 0] };
const SHARP_TOK: Record<number, [string, number]> = { 1: ['C', 1], 3: ['D', 1], 6: ['F', 1], 8: ['G', 1], 10: ['A', 1] };
const FLAT_TOK: Record<number, [string, number]> = { 1: ['D', -1], 3: ['E', -1], 6: ['G', -1], 8: ['A', -1], 10: ['B', -1] };
const OUD_TOK: Record<number, [string, number]> = { 1: ['C', 1], 3: ['E', -1], 6: ['F', 1], 8: ['A', -1], 10: ['B', -1] };
const Q_TOK: Record<number, [string, number]> = {
  1: ['C', 0.5], 3: ['D', -0.5], 5: ['D', 0.5], 7: ['E', -0.5], 9: ['F', -0.5], 11: ['F', 0.5],
  13: ['G', -0.5], 15: ['G', 0.5], 17: ['A', -0.5], 19: ['A', 0.5], 21: ['B', -0.5], 23: ['C', -0.5]
};
const ALT_TOK: Record<string, string> = { 1: '#', '-1': 'b', 0.5: 'q', '-0.5': 'd', 0: '' };

/** Hauteur écrite -> élément de codification (C4, F#3, Ed4…). */
export function pcnPitch(p: number, inst: Instrument, fifths = 0): string {
  const q = Math.round(p * 2);
  const idx = ((q % 24) + 24) % 24;
  let entry: [string, number];
  if (idx % 2) entry = Q_TOK[idx];
  else {
    const pc = idx / 2;
    entry = LETTERS[pc] ?? (inst === 'oud' ? OUD_TOK : fifths < 0 ? FLAT_TOK : SHARP_TOK)[pc];
  }
  const base = Math.round(q / 2 - entry[1]); // note naturelle de référence
  return `${entry[0]}${ALT_TOK[String(entry[1])]}${Math.floor(base / 12) - 1}`;
}

/** Dictée -> codification PCN (ce qui est enregistré dans la bibliothèque). */
export function eventsToPcn(events: DEvent[], meta: DictMeta): string {
  const oud = meta.instrument === 'oud';
  const L = (meta.beats * 4) / meta.beatType;
  const hands: ('RH' | 'LH')[] = oud ? ['RH'] : ['RH', 'LH'];
  const measures: Record<string, string[]>[] = [];
  const bar = (i: number) => (measures[i] ??= { RH: [], LH: [] });
  const push = (m: number, hand: string, tok: string, len: number) => {
    const list = bar(m)[hand];
    const last = list[list.length - 1];
    if (tok === 'r' && last?.startsWith('r:')) list[list.length - 1] = `r:${fmt(Number(last.slice(2)) + len)}`;
    else list.push(tok === 'r' ? `r:${fmt(len)}` : tok);
  };
  let t = 0;
  for (const ev of events) {
    let pos = t;
    const end = t + ev.dur;
    while (pos < end - 1e-6) {
      const m = Math.floor(pos / L + 1e-6);
      const segEnd = Math.min(end, (m + 1) * L);
      const len = segEnd - pos;
      const tied = segEnd < end - 1e-6;
      for (const hand of hands) {
        const ps = ev.pitches.filter(p => oud || (hand === 'RH' ? p >= 60 : p < 60)).sort((a, b) => a - b);
        if (!ps.length) push(m, hand, 'r', len);
        else push(m, hand, `${ps.map(p => pcnPitch(oud ? p + OUD_WRITTEN : p, meta.instrument, meta.fifths)).join('+')}:${fmt(len)}${tied ? '~' : ''}`, len);
      }
      pos = segEnd;
    }
    t = end;
  }
  const count = Math.max(1, Math.ceil(t / L - 1e-6));
  const used = t - (count - 1) * L;
  if (!events.length) bar(0);
  else if (used < L - 1e-6) for (const hand of hands) push(count - 1, hand, 'r', L - used);
  const lines = Array.from({ length: count }, (_, i) => {
    const b = bar(i);
    if (!b.RH.length) b.RH.push(`r:${fmt(L)}`);
    if (!b.LH.length) b.LH.push(`r:${fmt(L)}`);
    return `M${i + 1} | RH: ${b.RH.join(' ')}` + (oud ? '' : ` | LH: ${b.LH.join(' ')}`);
  });
  return [
    PCN_HEADER, `TITLE: ${meta.title}`, ...(oud ? ['INSTRUMENT: oud'] : []),
    `TIME: ${meta.beats}/${meta.beatType}`, `KEY: ${meta.fifths}`, `TEMPO: ${Math.round(meta.bpm)}`, ...lines
  ].join('\n') + '\n';
}

/** Codification -> dictée (pour reprendre une dictée enregistrée). */
export function pcnToEvents(code: string): { events: DEvent[]; meta: DictMeta } {
  const parsed = parsePcn(code);
  const oud = parsed.meta.instrument === 'oud';
  const groups = new Map<number, { pitches: Set<number>; dur: number }>();
  for (const n of parsed.notes) {
    const k = Math.round(n.start * 1000) / 1000;
    const g = groups.get(k) ?? { pitches: new Set<number>(), dur: 0 };
    g.pitches.add(oud ? n.midi - OUD_WRITTEN : n.midi);
    g.dur = Math.max(g.dur, n.dur);
    groups.set(k, g);
  }
  const starts = [...groups.keys()].sort((a, b) => a - b);
  const events: DEvent[] = [];
  let t = 0;
  starts.forEach((s, i) => {
    if (s - t > 0.01) events.push({ pitches: [], dur: snapDur(s - t) });
    const g = groups.get(s)!;
    const next = starts[i + 1];
    const dur = next !== undefined ? Math.min(g.dur, next - s) : g.dur;
    events.push({ pitches: [...g.pitches].sort((a, b) => a - b), dur: snapDur(dur) });
    t = s + dur;
  });
  const m = parsed.meta;
  return { events, meta: { title: m.title, beats: m.beats, beatType: m.beatType, fifths: m.fifths, bpm: m.bpm, instrument: oud ? 'oud' : 'piano' } };
}

// ---------- texte modifiable ----------

/** Texte lisible : « Do3:1 Ré3:0.5 | Mi½♭3:2 … », une barre entre les mesures. */
export function eventsToText(events: DEvent[], meta: DictMeta): string {
  const L = (meta.beats * 4) / meta.beatType;
  const out: string[] = [];
  let t = 0;
  let measure = 0;
  for (const ev of events) {
    const m = Math.floor(t / L + 1e-6);
    if (m > measure) { out.push(m % 4 === 0 ? '|\n' : '|'); measure = m; }
    const name = ev.pitches.length ? [...ev.pitches].sort((a, b) => a - b).map(p => noteName(p, meta.instrument, meta.fifths)).join('+') : '-';
    out.push(`${name}:${fmt(ev.dur)}`);
    t += ev.dur;
  }
  return out.join(' ').replace(/\n /g, '\n');
}

const FR_PC: Record<string, number> = { do: 0, ré: 2, re: 2, mi: 4, fa: 5, sol: 7, la: 9, si: 11 };
const EN_PC: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const ALTER: Record<string, number> = { '♯': 1, '#': 1, '♭': -1, b: -1, '½♯': 0.5, '½#': 0.5, q: 0.5, '½♭': -0.5, '½b': -0.5, d: -0.5, '': 0 };

/** Une hauteur écrite en français (Do3, Mi½♭3, Sol#2) ou en codification (C4, Bb3, Ed4). */
export function parseNoteName(s: string): number | null {
  const t = s.trim().toLowerCase();
  const fr = t.match(/^(do|ré|re|mi|fa|sol|la|si)(½♯|½#|½♭|½b|♯|#|♭|b|d|q)?(-?\d)$/);
  if (fr) return (Number(fr[3]) + 2) * 12 + FR_PC[fr[1]] + ALTER[fr[2] ?? ''];
  const en = t.match(/^([a-g])(#|b|d|q)?(-?\d)$/);
  if (en) return (Number(en[3]) + 1) * 12 + EN_PC[en[1]] + ALTER[en[2] ?? ''];
  return null;
}

function parseDuration(s: string): number {
  const t = s.trim().replace(',', '.');
  if (t.includes('/')) { const [a, b] = t.split('/').map(Number); return b ? a / b : NaN; }
  return Number(t);
}

/** Texte -> dictée ; les éléments illisibles sont signalés. */
export function textToEvents(text: string): { events: DEvent[]; problems: string[] } {
  const events: DEvent[] = [];
  const problems: string[] = [];
  for (const tok of text.split(/[\s|]+/).filter(Boolean)) {
    const [names, durStr] = tok.split(':');
    const dur = durStr === undefined ? 1 : parseDuration(durStr);
    if (!(dur > 0) || Math.abs(dur / MIN_DUR - Math.round(dur / MIN_DUR)) > 1e-6) { problems.push(`« ${tok} » : durée`); continue; }
    if (/^(-|—|r|s|silence|pause)$/i.test(names)) { events.push({ pitches: [], dur }); continue; }
    const pitches = names.split('+').map(parseNoteName);
    if (pitches.some(p => p === null)) { problems.push(`« ${tok} » : note`); continue; }
    events.push({ pitches: [...new Set(pitches as number[])].sort((a, b) => a - b), dur });
  }
  return { events, problems };
}

// ---------- rythme d'un enregistrement ----------

export interface RawNote { p: number; on: number; off: number | null } // temps en ms

export interface QuantizeOpts {
  bpm: number | null; // null : tempo estimé d'après le jeu
  origin?: number; // temps du premier temps (métronome), en ms
  grid: number; // 0.5 (croches) ou 0.25 (doubles croches)
  restMin: number; // silence plus court que cela (en noires) : la note est prolongée
  chordMs?: number;
}

/** Transforme des notes jouées librement en durées écrites. */
export function quantize(raw: RawNote[], o: QuantizeOpts): { events: DEvent[]; bpm: number } {
  if (!raw.length) return { events: [], bpm: o.bpm ?? 80 };
  const chordMs = o.chordMs ?? 70;
  const sorted = [...raw].sort((a, b) => a.on - b.on);
  const groups: { t: number; pitches: number[]; off: number }[] = [];
  for (const n of sorted) {
    const g = groups[groups.length - 1];
    const off = n.off ?? n.on + 400;
    if (g && n.on - g.t <= chordMs) { if (!g.pitches.includes(n.p)) g.pitches.push(n.p); g.off = Math.max(g.off, off); }
    else groups.push({ t: n.on, pitches: [n.p], off });
  }
  let bpm = o.bpm;
  if (!bpm) {
    // tempo estimé : l'écart le plus courant entre deux attaques devient la noire (ou la croche si très rapide)
    const iois = groups.slice(1).map((g, i) => g.t - groups[i].t).filter(x => x > 80).sort((a, b) => a - b);
    let beat = iois.length ? iois[Math.floor(iois.length / 2)] : 750;
    while (beat < 330) beat *= 2;
    while (beat > 1500) beat /= 2;
    bpm = Math.round(60000 / beat);
  }
  const beatMs = 60000 / bpm;
  const origin = o.origin ?? groups[0].t;
  const pos = (t: number) => Math.round((t - origin) / beatMs / o.grid) * o.grid;
  const starts = groups.map(g => pos(g.t));
  const events: DEvent[] = [];
  // deux attaques tombées au même endroit de la grille : un accord
  const merged: { s: number; pitches: number[]; off: number; t: number }[] = [];
  groups.forEach((g, i) => {
    const last = merged[merged.length - 1];
    if (last && starts[i] <= last.s) { g.pitches.forEach(p => { if (!last.pitches.includes(p)) last.pitches.push(p); }); last.off = Math.max(last.off, g.off); }
    else merged.push({ s: starts[i], pitches: [...g.pitches], off: g.off, t: g.t });
  });
  merged.forEach((g, i) => {
    const held = Math.max(o.grid, Math.round((g.off - g.t) / beatMs / o.grid) * o.grid);
    const next = merged[i + 1];
    const span = next ? next.s - g.s : held;
    let dur = span;
    if (next) {
      // silence : d'après l'écart réel jusqu'à la note suivante, arrondi vers le bas (on lâche souvent la touche un peu tôt)
      const gap = (next.t - g.off) / beatMs;
      const restLen = Math.floor(gap / o.grid + 0.25) * o.grid;
      if (gap >= o.restMin * 0.8 && restLen >= o.restMin && restLen < span) dur = span - restLen;
    }
    events.push({ pitches: g.pitches.sort((a, b) => a - b), dur: snapDur(dur) });
    if (dur < span) events.push({ pitches: [], dur: snapDur(span - dur) });
  });
  return { events, bpm };
}
