// Répertoire de départ du oud : petites études originales, une par maqam (aucune œuvre sous droits).
// Écrites comme une partition de oud, une octave au-dessus du son réel. Ed = Mi½♭, Bd = Si½♭.

import { PCN_HEADER, parsePcn, pcnToXml } from './codification';
import { ns, pref, setPref, getPiece, storePiece } from './storage';

interface Etude { id: string; maqam: string; difficulty: number; tempo: number; measures: string[] }

const ETUDES: Etude[] = [
  { id: 'oud-rast', maqam: 'Rast', difficulty: 1, tempo: 72, measures: [
    'C4:1 D4:1 Ed4:1 F4:1', 'G4:2 F4:1 Ed4:1', 'D4:1 Ed4:0.5 F4:0.5 G4:2', 'A4:1 G4:1 F4:1 Ed4:1',
    'G4:1 A4:1 Bd4:1 C5:1', 'Bd4:1 A4:1 G4:2', 'F4:1 Ed4:1 D4:1 Ed4:1', 'D4:2 C4:2'
  ] },
  { id: 'oud-bayati', maqam: 'Bayati', difficulty: 1, tempo: 72, measures: [
    'D4:1 Ed4:1 F4:1 G4:1', 'A4:2 G4:1 F4:1', 'Ed4:1 F4:0.5 G4:0.5 F4:1 Ed4:1', 'D4:2 Ed4:1 F4:1',
    'G4:1 A4:1 Bb4:1 C5:1', 'D5:2 C5:1 Bb4:1', 'A4:1 G4:1 F4:1 Ed4:1', 'D4:4'
  ] },
  { id: 'oud-nahawand', maqam: 'Nahawand', difficulty: 1, tempo: 76, measures: [
    'C4:1 D4:1 Eb4:1 F4:1', 'G4:2 Eb4:1 D4:1', 'C4:1 Eb4:1 G4:1 Ab4:1', 'G4:1 F4:1 Eb4:2',
    'F4:1 G4:1 Ab4:1 B4:1', 'C5:2 B4:1 Ab4:1', 'G4:1 F4:1 Eb4:1 D4:1', 'C4:4'
  ] },
  { id: 'oud-kurd', maqam: 'Kurd', difficulty: 2, tempo: 76, measures: [
    'D4:1 Eb4:1 F4:1 G4:1', 'F4:1 Eb4:1 D4:2', 'F4:1 G4:1 A4:2', 'Bb4:1 A4:1 G4:1 F4:1',
    'A4:1 Bb4:1 C5:1 D5:1', 'C5:1 Bb4:1 A4:1 G4:1', 'F4:1 G4:0.5 F4:0.5 Eb4:2', 'D4:4'
  ] },
  { id: 'oud-hijaz', maqam: 'Hijaz', difficulty: 2, tempo: 72, measures: [
    'D4:1 Eb4:1 F#4:2', 'G4:1 F#4:1 Eb4:1 D4:1', 'D4:0.5 Eb4:0.5 F#4:1 G4:1 A4:1', 'Bb4:1 A4:1 G4:1 F#4:1',
    'A4:1 Bb4:1 C5:1 D5:1', 'C5:1 Bb4:1 A4:2', 'G4:1 F#4:1 Eb4:1 F#4:1', 'D4:4'
  ] },
  { id: 'oud-saba', maqam: 'Saba', difficulty: 3, tempo: 66, measures: [
    'D4:1 Ed4:1 F4:1 Gb4:1', 'F4:1 Ed4:1 D4:2', 'Ed4:1 F4:1 Gb4:2', 'A4:1 Gb4:1 F4:1 Ed4:1',
    'F4:1 Gb4:1 A4:1 Bb4:1', 'A4:1 Gb4:1 F4:2', 'Ed4:1 F4:0.5 Ed4:0.5 D4:2', 'D4:4'
  ] }
];

const AUTHOR = 'My Music Inst';

const code = (e: Etude, title: string) => [
  PCN_HEADER, `TITLE: ${title}`, `COMPOSER: ${AUTHOR}`, 'INSTRUMENT: oud', 'TIME: 4/4', 'KEY: 0', `TEMPO: ${e.tempo}`,
  ...e.measures.map((m, i) => `M${i + 1} | RH: ${m}`)
].join('\n') + '\n';

/** Études déjà installées et jamais modifiées : remplace l'ancien nom de l'appli (sans synchroniser). */
async function renameOudAuthor(): Promise<void> {
  const flag = `renamed.oud1.${ns()}`;
  if (pref(flag, false)) return;
  for (const e of ETUDES) {
    const p = await getPiece(e.id);
    if (p && !p.updatedAt && p.composer === 'Piano Compagnon') {
      await storePiece({ ...p, composer: AUTHOR, code: p.code?.replace('COMPOSER: Piano Compagnon', `COMPOSER: ${AUTHOR}`) });
    }
  }
  setPref(flag, true);
}

/** Ajoute les études dans l'espace courant (une fois par espace, sans synchroniser). */
export async function seedOud(): Promise<void> {
  await renameOudAuthor();
  const flag = `seeded.oud1.${ns()}`;
  if (pref(flag, false)) return;
  let t = Date.now();
  for (const e of ETUDES) {
    if (await getPiece(e.id)) continue;
    const title = `Étude en maqam ${e.maqam}`;
    const pcn = code(e, title);
    await storePiece({
      id: e.id, title, composer: AUTHOR, difficulty: e.difficulty, tags: [e.maqam.toLowerCase()], category: 'Études',
      instrument: 'oud', code: pcn, xml: pcnToXml(parsePcn(pcn), title), source: 'pcn', addedAt: t--, updatedAt: 0
    });
  }
  setPref(flag, true);
}
