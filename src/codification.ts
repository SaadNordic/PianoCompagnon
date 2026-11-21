// Codification maison des partitions : format PCN (Piano Compagnon Notation), version 1.
// C'est le texte stocké dans la base ; l'appli en tire le MusicXML pour afficher, suivre et écouter.
//
//   PIANO-COMPAGNON 1
//   TITLE: Ode à la joie
//   COMPOSER: Beethoven
//   TIME: 4/4
//   KEY: 0            (dièses > 0, bémols < 0)
//   TEMPO: 90         (noires par minute)
//   M1 | RH: E4:1 E4:1 F4:1 G4:1 | LH: C3+G3:4
//   M2 | RH: G4:1 F4:1 E4:1 D4:1~ | LH: G2+D3:4
//
// Événement = hauteurs:durée. Hauteur : C4 (do central), F#3, Bb5 ; accord : C4+E4+G4 ; silence : r.
// Durée en noires : 4 ronde, 2 blanche, 1 noire, 0.5 croche, 0.25 double, 1.5 noire pointée, 1/3 triolet.
// ~ en fin d'événement = lié à la note suivante. Plusieurs voix d'une même main séparées par &.

import { notesToMusicXml, type RawNote, type Hand } from './musicxml';

export const PCN_HEADER = 'PIANO-COMPAGNON 1';

export const PCN_HELP = `Une ligne par mesure :  M3 | RH: <main droite> | LH: <main gauche>
Événement = hauteurs:durée, séparés par des espaces.
  Hauteur : C4 = do central (Do3), D4 ré, E4 mi, F4 fa, G4 sol, A4 la, B4 si ; # dièse, b bémol (F#4, Bb3).
  Accord : C4+E4+G4      Silence : r
  Durée en noires : 4 ronde · 2 blanche · 1 noire · 0.5 croche · 0.25 double · 1.5 noire pointée · 1/3 triolet
  ~ à la fin = lié à la note suivante (ex. C5:2~)
  Deux voix dans une main : séparées par &  (ex. RH: E5:1 D5:1 C5:2 & C4+E4:4)
En-tête : TITLE, COMPOSER, TIME (ex. 3/4), KEY (dièses > 0, bémols < 0), TEMPO (noires/min).`;

export interface PcnMeta { title: string; composer?: string; beats: number; beatType: number; fifths: number; bpm: number }
export interface PcnParsed { notes: RawNote[]; meta: PcnMeta; measures: number; problems: string[] }

const PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function parsePitch(s: string): number | null {
  const m = s.match(/^([A-Ga-g])(##|#|bb|b|n)?(-?\d)$/);
  if (!m) return null;
  const alter = { '##': 2, '#': 1, bb: -2, b: -1, n: 0 }[m[2] ?? 'n'] ?? 0;
  return (Number(m[3]) + 1) * 12 + PC[m[1].toUpperCase()] + alter;
}

function parseDur(s: string): number {
  if (s.includes('/')) {
    const [a, b] = s.split('/').map(Number);
    return b ? a / b : NaN;
  }
  return Number(s.replace(',', '.'));
}

/** Le texte ressemble-t-il à une codification PCN ? */
export function looksLikePcn(text: string): boolean {
  return text.trimStart().startsWith('PIANO-COMPAGNON') || /^M\d+\s*\|\s*(RH|LH)\s*:/im.test(text);
}

export function parsePcn(text: string): PcnParsed {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const header = (k: string) => lines.find(l => l.toUpperCase().startsWith(k + ':'))?.slice(k.length + 1).trim() ?? '';
  const [beats, beatType] = (header('TIME').match(/(\d+)\s*\/\s*(\d+)/)?.slice(1).map(Number) ?? [4, 4]) as [number, number];
  const fifths = Math.max(-7, Math.min(7, parseInt(header('KEY'), 10) || 0));
  const bpm = Math.min(240, Math.max(30, parseInt(header('TEMPO'), 10) || 90));
  const measureLen = (beats * 4) / beatType;
  const notes: RawNote[] = [];
  const problems: string[] = [];
  let measures = 0;
  // liaisons en attente, par main et par voix : hauteur -> note à prolonger
  const ties = new Map<string, Map<number, RawNote>>();

  for (const line of lines) {
    const lm = line.match(/^M(\d+)\s*\|/i);
    if (!lm) continue;
    const start = measures * measureLen;
    measures++;
    for (const part of line.split('|').slice(1)) {
      const hm = part.trim().match(/^(RH|LH)\s*:\s*(.*)$/i);
      if (!hm) continue;
      const hand: Hand = hm[1].toUpperCase() === 'RH' ? 'R' : 'L';
      hm[2].split('&').forEach((voice, vi) => {
        const key = `${hand}${vi}`;
        const pending = ties.get(key) ?? new Map<number, RawNote>();
        let t = start;
        for (const tok of voice.trim().split(/\s+/).filter(Boolean)) {
          const em = tok.match(/^([^:]+):([^~]+)(~?)$/);
          const dur = em ? parseDur(em[2]) : NaN;
          if (!em || !(dur > 0)) { problems.push(`mesure ${lm[1]} : « ${tok} »`); continue; }
          const tied = em[3] === '~';
          const next = new Map<number, RawNote>();
          if (em[1].toLowerCase() !== 'r') {
            for (const ps of em[1].split('+')) {
              const midi = parsePitch(ps);
              if (midi === null) { problems.push(`mesure ${lm[1]} : note « ${ps} »`); continue; }
              const prev = pending.get(midi);
              let n: RawNote;
              if (prev && Math.abs(prev.start + prev.dur - t) < 0.01) { prev.dur += dur; n = prev; }
              else { n = { midi, start: t, dur, hand, voice: vi }; notes.push(n); }
              if (tied) next.set(midi, n);
            }
          }
          pending.clear();
          next.forEach((v, k) => pending.set(k, v));
          t += dur;
        }
        const total = t - start;
        if (Math.abs(total - measureLen) > 0.05) {
          problems.push(`mesure ${lm[1]}, ${hand === 'R' ? 'main droite' : 'main gauche'} : ${+total.toFixed(2)} temps au lieu de ${measureLen}`);
        }
        ties.set(key, pending);
      });
    }
  }
  return { notes, meta: { title: header('TITLE'), composer: header('COMPOSER') || undefined, beats, beatType, fifths, bpm }, measures, problems };
}

/** Codification -> MusicXML (pour l'affichage). */
export function pcnToXml(parsed: PcnParsed, fallbackTitle: string): string {
  return notesToMusicXml(parsed.notes, { ...parsed.meta, title: parsed.meta.title || fallbackTitle, exact: true });
}

/** Met le texte au propre : en-tête de format, titre et compositeur à jour. */
export function normalizePcn(text: string, title?: string, composer?: string): string {
  let lines = text.replace(/\r/g, '').split('\n').map(l => l.trimEnd());
  lines = lines.filter(l => !l.trim().startsWith('PIANO-COMPAGNON'));
  const setHeader = (k: string, v: string | undefined) => {
    if (v === undefined) return;
    const i = lines.findIndex(l => l.toUpperCase().startsWith(k + ':'));
    if (i >= 0) lines[i] = `${k}: ${v}`;
    else lines.unshift(`${k}: ${v}`);
  };
  setHeader('COMPOSER', composer ?? '');
  setHeader('TITLE', title);
  while (lines.length && !lines[0].trim()) lines.shift();
  return [PCN_HEADER, ...lines].join('\n').trim() + '\n';
}
