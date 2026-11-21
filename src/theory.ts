// Un peu de solfège : orthographe des notes, accords, gammes (noms français).

export const STEP_LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
export const STEP_PC = [0, 2, 4, 5, 7, 9, 11];
export const FR_STEPS = ['Do', 'Ré', 'Mi', 'Fa', 'Sol', 'La', 'Si'];

/** Note orthographiée : degré (0 = do … 6 = si) et altération (-1 bémol, +1 dièse). */
export interface Sp { step: number; alter: number }

export const accSymbol = (a: number) => (a === 1 ? '♯' : a === -1 ? '♭' : a === 2 ? '𝄪' : a === -2 ? '𝄫' : '');
export const spName = (s: Sp) => FR_STEPS[s.step] + accSymbol(s.alter);
export const spPc = (s: Sp) => (((STEP_PC[s.step] + s.alter) % 12) + 12) % 12;

/** Orthographie une suite d'intervalles à partir d'une fondamentale. */
export function spell(root: Sp, degreeSteps: number[], semitones: number[]): Sp[] {
  return degreeSteps.map((d, i) => {
    const step = (root.step + d) % 7;
    let alter = ((spPc(root) + semitones[i] - STEP_PC[step]) % 12 + 12) % 12;
    if (alter > 6) alter -= 12;
    return { step, alter };
  });
}

export function parseSp(name: string): Sp {
  const base = name.replace(/[♯♭#b]$/, '');
  const step = FR_STEPS.indexOf(base);
  const alter = /[♯#]$/.test(name) ? 1 : /[♭b]$/.test(name) && base !== name ? -1 : 0;
  return { step, alter };
}

// ---------- accords ----------

export interface ChordType { id: string; label: string; symbol: string; steps: number[]; semis: number[] }

export const CHORDS: Record<string, ChordType> = {
  maj: { id: 'maj', label: 'majeur', symbol: '', steps: [0, 2, 4], semis: [0, 4, 7] },
  min: { id: 'min', label: 'mineur', symbol: 'm', steps: [0, 2, 4], semis: [0, 3, 7] },
  dim: { id: 'dim', label: 'diminué', symbol: 'dim', steps: [0, 2, 4], semis: [0, 3, 6] },
  aug: { id: 'aug', label: 'augmenté', symbol: '+', steps: [0, 2, 4], semis: [0, 4, 8] },
  sus2: { id: 'sus2', label: 'sus2', symbol: 'sus2', steps: [0, 1, 4], semis: [0, 2, 7] },
  sus4: { id: 'sus4', label: 'sus4', symbol: 'sus4', steps: [0, 3, 4], semis: [0, 5, 7] },
  dom7: { id: 'dom7', label: 'septième', symbol: '7', steps: [0, 2, 4, 6], semis: [0, 4, 7, 10] },
  maj7: { id: 'maj7', label: 'septième majeure', symbol: '7M', steps: [0, 2, 4, 6], semis: [0, 4, 7, 11] },
  min7: { id: 'min7', label: 'mineur septième', symbol: 'm7', steps: [0, 2, 4, 6], semis: [0, 3, 7, 10] }
};

// ---------- gammes ----------

export interface ScaleType { id: string; label: string; semis: number[] }
export const SCALES: Record<string, ScaleType> = {
  major: { id: 'major', label: 'majeur', semis: [0, 2, 4, 5, 7, 9, 11, 12] },
  harm: { id: 'harm', label: 'mineur harmonique', semis: [0, 2, 3, 5, 7, 8, 11, 12] }
};

export function scaleNotes(root: Sp, type: ScaleType): Sp[] {
  return spell(root, [0, 1, 2, 3, 4, 5, 6, 0], type.semis.map(s => s % 12));
}

export const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

/** MusicXML d'une seule mesure (note isolée ou accord) pour l'afficher avec OSMD. */
export function miniScoreXml(notes: { sp: Sp; octave: number }[], clef: 'G' | 'F'): string {
  const body = notes.map((n, i) => {
    const acc = n.sp.alter === 1 ? 'sharp' : n.sp.alter === -1 ? 'flat' : '';
    return `<note>${i ? '<chord/>' : ''}<pitch><step>${STEP_LETTERS[n.sp.step]}</step>` +
      `${n.sp.alter ? `<alter>${n.sp.alter}</alter>` : ''}<octave>${n.octave}</octave></pitch>` +
      `<duration>4</duration><type>whole</type>${acc ? `<accidental>${acc}</accidental>` : ''}</note>`;
  }).join('');
  const clefXml = clef === 'G' ? '<sign>G</sign><line>2</line>' : '<sign>F</sign><line>4</line>';
  return `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0">` +
    `<part-list><score-part id="P1"><part-name></part-name></score-part></part-list><part id="P1"><measure number="1">` +
    `<attributes><divisions>1</divisions><key><fifths>0</fifths></key><time print-object="no"><beats>4</beats><beat-type>4</beat-type></time>` +
    `<clef>${clefXml}</clef></attributes>${body}</measure></part></score-partwise>`;
}

/** MIDI d'une note orthographiée à une octave (notation internationale : do central = octave 4). */
export const spMidi = (sp: Sp, octave: number) => (octave + 1) * 12 + STEP_PC[sp.step] + sp.alter;
