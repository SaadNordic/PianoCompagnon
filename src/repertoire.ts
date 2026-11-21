// Répertoire de départ (œuvres du domaine public), codé au format PCN.

import { PCN_HEADER, parsePcn, pcnToXml } from './codification';
import { ns, pref, setPref, getPiece, storePiece, removePieceLocal } from './storage';

export interface RepertoireItem { id: string; title: string; composer: string; difficulty: number; tags: string[]; code: string }

const pcn = (title: string, composer: string, time: string, key: number, tempo: number, measures: string[]) =>
  [PCN_HEADER, `TITLE: ${title}`, `COMPOSER: ${composer}`, `TIME: ${time}`, `KEY: ${key}`, `TEMPO: ${tempo}`,
    ...measures.map((m, i) => `M${i + 1} | ${m}`)].join('\n') + '\n';

// ---------- Beethoven : Lettre à Élise (partie A, reprise développée) ----------
const eliseA = [
  'RH: E5:0.25 D#5:0.25 E5:0.25 B4:0.25 D5:0.25 C5:0.25 | LH: r:1.5',
  'RH: A4:0.5 r:0.25 C4:0.25 E4:0.25 A4:0.25 | LH: A2:0.25 E3:0.25 A3:0.25 r:0.75',
  'RH: B4:0.5 r:0.25 E4:0.25 G#4:0.25 B4:0.25 | LH: E2:0.25 E3:0.25 G#3:0.25 r:0.75',
  'RH: C5:0.5 r:0.25 E4:0.25 E5:0.25 D#5:0.25 | LH: A2:0.25 E3:0.25 A3:0.25 r:0.75',
  'RH: E5:0.25 D#5:0.25 E5:0.25 B4:0.25 D5:0.25 C5:0.25 | LH: r:1.5',
  'RH: A4:0.5 r:0.25 C4:0.25 E4:0.25 A4:0.25 | LH: A2:0.25 E3:0.25 A3:0.25 r:0.75',
  'RH: B4:0.5 r:0.25 E4:0.25 C5:0.25 B4:0.25 | LH: E2:0.25 E3:0.25 G#3:0.25 r:0.75'
];
const elise = pcn('Lettre à Élise (partie A)', 'Beethoven', '3/8', 0, 66, [
  'RH: r:1 E5:0.25 D#5:0.25 | LH: r:1.5',
  ...eliseA,
  'RH: A4:0.5 r:0.5 E5:0.25 D#5:0.25 | LH: A2:0.25 E3:0.25 A3:0.25 r:0.75',
  ...eliseA,
  'RH: A4:1.5 | LH: A2:0.25 E3:0.25 A3:0.25 r:0.75'
]);

// ---------- Bach : Prélude en do majeur BWV 846 (mesures 1 à 19 + accord final) ----------
const preludeChords = [
  'C3 E3 G3 C4 E4', 'C3 D3 A3 D4 F4', 'B2 D3 G3 D4 F4', 'C3 E3 G3 C4 E4', 'C3 E3 A3 E4 A4',
  'C3 D3 F#3 A3 D4', 'B2 D3 G3 D4 G4', 'B2 C3 E3 G3 C4', 'A2 C3 E3 G3 C4', 'D2 A2 D3 F#3 C4',
  'G2 B2 D3 G3 B3', 'G2 Bb2 E3 G3 C#4', 'F2 A2 D3 A3 D4', 'F2 Ab2 D3 F3 B3', 'E2 G2 C3 G3 C4',
  'E2 F2 A2 C3 F3', 'D2 F2 A2 C3 F3', 'G1 D2 G2 B2 F3', 'C2 E2 G2 C3 E3'
];
const prelude = pcn('Prélude en do majeur (BWV 846, début)', 'J. S. Bach', '4/4', 0, 66, [
  ...preludeChords.map(c => {
    const [n1, n2, n3, n4, n5] = c.split(' ');
    const half = `r:0.5 ${n3}:0.25 ${n4}:0.25 ${n5}:0.25 ${n3}:0.25 ${n4}:0.25 ${n5}:0.25`;
    return `RH: ${half} ${half} | LH: ${n1}:2 ${n1}:2 & r:0.25 ${n2}:1.75 r:0.25 ${n2}:1.75`;
  }),
  'RH: G3+C4+E4:4 | LH: C2+C3:4'
]);

// ---------- Bach / Petzold : Menuet en sol (Petit livre d'Anna Magdalena) ----------
const menuet = pcn('Menuet en sol (Anna Magdalena)', 'J. S. Bach / C. Petzold', '3/4', 1, 120, [
  'RH: D5:1 G4:0.5 A4:0.5 B4:0.5 C5:0.5 | LH: G3:2 A3:1',
  'RH: D5:1 G4:1 G4:1 | LH: B3:3',
  'RH: E5:1 C5:0.5 D5:0.5 E5:0.5 F#5:0.5 | LH: C4:3',
  'RH: G5:1 G4:1 G4:1 | LH: B3:3',
  'RH: C5:1 D5:0.5 C5:0.5 B4:0.5 A4:0.5 | LH: A3:3',
  'RH: B4:1 C5:0.5 B4:0.5 A4:0.5 G4:0.5 | LH: G3:3',
  'RH: F#4:1 G4:0.5 A4:0.5 B4:0.5 G4:0.5 | LH: D4:1 B3:1 G3:1',
  'RH: A4:3 | LH: D4:1 D3:0.5 C4:0.5 B3:0.5 A3:0.5',
  'RH: D5:1 G4:0.5 A4:0.5 B4:0.5 C5:0.5 | LH: B3:2 A3:1',
  'RH: D5:1 G4:1 G4:1 | LH: G3:1 B3:1 G3:1',
  'RH: E5:1 C5:0.5 D5:0.5 E5:0.5 F#5:0.5 | LH: C4:3',
  'RH: G5:1 G4:1 G4:1 | LH: B3:1 C4:0.5 B3:0.5 A3:0.5 G3:0.5',
  'RH: C5:1 D5:0.5 C5:0.5 B4:0.5 A4:0.5 | LH: A3:2 F#3:1',
  'RH: B4:1 C5:0.5 B4:0.5 A4:0.5 G4:0.5 | LH: G3:2 B3:1',
  'RH: A4:1 B4:0.5 A4:0.5 G4:0.5 F#4:0.5 | LH: C4:1 D4:1 D3:1',
  'RH: G4:3 | LH: G3:2 G2:1'
]);

// ---------- Beethoven : Ode à la joie (deux mains) ----------
const ode = pcn('Ode à la joie', 'Beethoven', '4/4', 0, 90, [
  'RH: E4:1 E4:1 F4:1 G4:1 | LH: C3+G3:4',
  'RH: G4:1 F4:1 E4:1 D4:1 | LH: G2+D3:4',
  'RH: C4:1 C4:1 D4:1 E4:1 | LH: C3+G3:4',
  'RH: E4:1.5 D4:0.5 D4:2 | LH: G2+D3:4',
  'RH: E4:1 E4:1 F4:1 G4:1 | LH: C3+G3:4',
  'RH: G4:1 F4:1 E4:1 D4:1 | LH: G2+D3:4',
  'RH: C4:1 C4:1 D4:1 E4:1 | LH: C3+G3:4',
  'RH: D4:1.5 C4:0.5 C4:2 | LH: G2+D3:2 C3+G3:2'
]);

export const REPERTOIRE: RepertoireItem[] = [
  { id: 'rep-ode', title: 'Ode à la joie', composer: 'Beethoven', difficulty: 1, tags: ['débutant'], code: ode },
  { id: 'rep-menuet-sol', title: 'Menuet en sol (Anna Magdalena)', composer: 'J. S. Bach / C. Petzold', difficulty: 2, tags: ['baroque'], code: menuet },
  { id: 'rep-elise', title: 'Lettre à Élise (partie A)', composer: 'Beethoven', difficulty: 3, tags: ['romantique'], code: elise },
  { id: 'rep-prelude-do', title: 'Prélude en do majeur (BWV 846, début)', composer: 'J. S. Bach', difficulty: 3, tags: ['baroque', 'arpèges'], code: prelude }
];

/** Ajoute le répertoire de départ dans l'espace courant (une fois par espace, sans synchroniser). */
export async function seedRepertoire(): Promise<void> {
  const flag = `seeded.rep1.${ns()}`;
  if (pref(flag, false) || (ns() === 'local' && pref('seeded.rep1', false))) return;
  if (ns() === 'local') await removePieceLocal('demo-ode'); // ancien morceau d'exemple
  let t = Date.now();
  for (const r of REPERTOIRE) {
    if (await getPiece(r.id)) continue;
    await storePiece({
      id: r.id, title: r.title, composer: r.composer, difficulty: r.difficulty, tags: r.tags, category: 'Classique',
      code: r.code, xml: pcnToXml(parsePcn(r.code), r.title), source: 'pcn', addedAt: t--, updatedAt: 0
    });
  }
  setPref(flag, true);
}
