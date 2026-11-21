// Conversion d'une liste de notes (temps en noires) en MusicXML piano à deux portées.
// Sert pour les fichiers MIDI, et plus tard pour l'audio transcrit.

export type Hand = 'R' | 'L';

export interface RawNote {
  midi: number;
  start: number; // en noires (temps)
  dur: number; // en noires
  hand?: Hand;
}

export interface ScoreMeta {
  title: string;
  beats?: number;
  beatType?: number;
  bpm?: number;
  fifths?: number; // armure : nb de dièses (>0) ou bémols (<0)
}

const DIV = 4; // divisions par noire : grille à la double croche
const SHARP_NAMES: [string, number][] = [
  ['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0], ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0]
];
const FLAT_NAMES: [string, number][] = [
  ['C', 0], ['D', -1], ['D', 0], ['E', -1], ['E', 0], ['F', 0], ['G', -1], ['G', 0], ['A', -1], ['A', 0], ['B', -1], ['B', 0]
];
// valeurs de note en doubles croches -> [type, pointée]
const VALUES: [number, string, boolean][] = [
  [16, 'whole', false], [12, 'half', true], [8, 'half', false], [6, 'quarter', true],
  [4, 'quarter', false], [3, 'eighth', true], [2, 'eighth', false], [1, '16th', false]
];

interface Ev { start: number; len: number; pitches: number[] | null }

function esc(s: string): string {
  return s.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]!));
}

/** Attribue une main à chaque note qui n'en a pas : sous le do central -> main gauche. */
export function splitHands(notes: RawNote[]): RawNote[] {
  return notes.map(n => (n.hand ? n : { ...n, hand: n.midi < 60 ? 'L' : 'R' }));
}

function buildEvents(notes: RawNote[]): Ev[] {
  // regroupe par attaque quantifiée, puis comble les trous avec des silences
  const byOnset = new Map<number, { pitches: Set<number>; end: number }>();
  for (const n of notes) {
    const s = Math.max(0, Math.round(n.start * DIV));
    let e = Math.round((n.start + n.dur) * DIV);
    if (e <= s) e = s + 1;
    const g = byOnset.get(s);
    if (g) { g.pitches.add(n.midi); g.end = Math.max(g.end, e); }
    else byOnset.set(s, { pitches: new Set([n.midi]), end: e });
  }
  const onsets = [...byOnset.keys()].sort((a, b) => a - b);
  const evs: Ev[] = [];
  let t = 0;
  onsets.forEach((s, i) => {
    const g = byOnset.get(s)!;
    if (s > t) evs.push({ start: t, len: s - t, pitches: null });
    const next = i + 1 < onsets.length ? onsets[i + 1] : Infinity;
    let end = Math.min(g.end, next);
    // jeu « humain » : une note un peu courte est prolongée jusqu'à la suivante (ou jusqu'au temps)
    const tolerance = Math.max(1, Math.round((end - s) * 0.25));
    if (next !== Infinity && next - end > 0 && next - end <= tolerance) end = next;
    else if (next === Infinity) {
      const beat = Math.ceil(end / DIV) * DIV;
      if (beat - end <= tolerance) end = beat;
    }
    evs.push({ start: s, len: end - s, pitches: [...g.pitches].sort((a, b) => a - b) });
    t = end;
  });
  return evs;
}

function decompose(len: number): [number, string, boolean][] {
  const out: [number, string, boolean][] = [];
  let rest = len;
  while (rest > 0) {
    const v = VALUES.find(([d]) => d <= rest)!;
    out.push(v);
    rest -= v[0];
  }
  return out;
}

export function notesToMusicXml(input: RawNote[], meta: ScoreMeta): string {
  const beats = meta.beats ?? 4;
  const beatType = meta.beatType ?? 4;
  const fifths = meta.fifths ?? 0;
  const names = fifths < 0 ? FLAT_NAMES : SHARP_NAMES;
  const L = Math.round((beats * 4 * DIV) / beatType); // longueur de mesure en doubles croches
  const notes = splitHands(input);
  const staffEvents: Record<Hand, Ev[]> = {
    R: buildEvents(notes.filter(n => n.hand === 'R')),
    L: buildEvents(notes.filter(n => n.hand === 'L'))
  };
  const lastEnd = Math.max(1, ...Object.values(staffEvents).flat().map(e => e.start + e.len));
  const nMeasures = Math.ceil(lastEnd / L);
  const total = nMeasures * L;
  for (const h of ['R', 'L'] as Hand[]) {
    const evs = staffEvents[h];
    const end = evs.length ? evs[evs.length - 1].start + evs[evs.length - 1].len : 0;
    if (end < total) evs.push({ start: end, len: total - end, pitches: null });
  }

  // découpe aux barres de mesure -> XML par mesure et par portée
  const out: string[][][] = Array.from({ length: nMeasures }, () => [[], []]);
  (['R', 'L'] as Hand[]).forEach((h, si) => {
    const staff = si + 1;
    const voice = si === 0 ? 1 : 5;
    for (const ev of staffEvents[h]) {
      let pos = ev.start;
      const evEnd = ev.start + ev.len;
      while (pos < evEnd) {
        const m = Math.floor(pos / L);
        const segEnd = Math.min(evEnd, (m + 1) * L);
        const pieces = decompose(segEnd - pos);
        pieces.forEach(([d, type, dot]) => {
          const tieStop = ev.pitches !== null && (pos > ev.start);
          const tieStart = ev.pitches !== null && (pos + d < evEnd);
          if (ev.pitches === null) {
            const whole = d === L && pieces.length === 1;
            out[m][si].push(
              `<note><rest${whole ? ' measure="yes"' : ''}/><duration>${d}</duration><voice>${voice}</voice>` +
              (whole ? '' : `<type>${type}</type>${dot ? '<dot/>' : ''}`) + `<staff>${staff}</staff></note>`
            );
          } else {
            ev.pitches.forEach((p, ci) => {
              const [step, alter] = names[p % 12];
              const octave = Math.floor(p / 12) - 1;
              const ties = (tieStop ? '<tie type="stop"/>' : '') + (tieStart ? '<tie type="start"/>' : '');
              const tied = (tieStop ? '<tied type="stop"/>' : '') + (tieStart ? '<tied type="start"/>' : '');
              out[m][si].push(
                `<note>${ci > 0 ? '<chord/>' : ''}<pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ''}<octave>${octave}</octave></pitch>` +
                `<duration>${d}</duration>${ties}<voice>${voice}</voice><type>${type}</type>${dot ? '<dot/>' : ''}` +
                `<staff>${staff}</staff>${tied ? `<notations>${tied}</notations>` : ''}</note>`
              );
            });
          }
          pos += d;
        });
      }
    }
  });

  const measures = out.map((staves, i) => {
    let attrs = '';
    if (i === 0) {
      attrs = `<attributes><divisions>${DIV}</divisions><key><fifths>${fifths}</fifths></key>` +
        `<time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time><staves>2</staves>` +
        `<clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>`;
      if (meta.bpm) {
        attrs += `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit>` +
          `<per-minute>${Math.round(meta.bpm)}</per-minute></metronome></direction-type><sound tempo="${Math.round(meta.bpm)}"/></direction>`;
      }
    }
    return `<measure number="${i + 1}">${attrs}${staves[0].join('')}<backup><duration>${L}</duration></backup>${staves[1].join('')}</measure>`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0"><work><work-title>${esc(meta.title)}</work-title></work>
<part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
<part id="P1">${measures.join('\n')}</part></score-partwise>`;
}

/** Morceau d'exemple : l'Ode à la joie (Beethoven, domaine public), deux mains. */
export function demoPiece(): string {
  const E4 = 64, F4 = 65, G4 = 67, D4 = 62, C4 = 60;
  const melody: [number, number][] = [
    [E4, 1], [E4, 1], [F4, 1], [G4, 1], [G4, 1], [F4, 1], [E4, 1], [D4, 1],
    [C4, 1], [C4, 1], [D4, 1], [E4, 1], [E4, 1.5], [D4, 0.5], [D4, 2],
    [E4, 1], [E4, 1], [F4, 1], [G4, 1], [G4, 1], [F4, 1], [E4, 1], [D4, 1],
    [C4, 1], [C4, 1], [D4, 1], [E4, 1], [D4, 1.5], [C4, 0.5], [C4, 2]
  ];
  const notes: RawNote[] = [];
  let t = 0;
  for (const [m, d] of melody) { notes.push({ midi: m, start: t, dur: d, hand: 'R' }); t += d; }
  const bass: [number, number][][] = [[[48, 55]], [[43, 50]], [[48, 55]], [[43, 50]], [[48, 55]], [[43, 50]], [[48, 55]]];
  bass.forEach((chords, i) => chords[0].forEach(p => notes.push({ midi: p, start: i * 4, dur: 4, hand: 'L' })));
  [43, 50].forEach(p => notes.push({ midi: p, start: 28, dur: 2, hand: 'L' }));
  [48, 55].forEach(p => notes.push({ midi: p, start: 30, dur: 2, hand: 'L' }));
  return notesToMusicXml(notes, { title: 'Ode à la joie (exemple)', bpm: 90 });
}
