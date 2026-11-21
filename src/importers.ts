import { Midi } from '@tonejs/midi';
import { unzipSync, strFromU8 } from 'fflate';
import { notesToMusicXml, type RawNote, type Hand } from './musicxml';

export interface Imported { title: string; xml: string; source: 'musicxml' | 'midi' }

export class ImportError extends Error {}

const KEY_FIFTHS: Record<string, number> = {
  Cb: -7, Gb: -6, Db: -5, Ab: -4, Eb: -3, Bb: -2, F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, 'F#': 6, 'C#': 7
};

function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim() || 'Sans titre';
}

function titleFromXml(xml: string, fallback: string): string {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const t = doc.querySelector('work-title')?.textContent?.trim()
    || doc.querySelector('movement-title')?.textContent?.trim()
    || doc.querySelector('credit-words')?.textContent?.trim();
  return t || fallback;
}

function checkXml(xml: string): void {
  if (!/<score-(partwise|timewise)/.test(xml)) {
    throw new ImportError("Ce fichier XML n'est pas une partition MusicXML.");
  }
}

function fromMxl(buf: Uint8Array): string {
  const files = unzipSync(buf);
  const container = files['META-INF/container.xml'];
  let path: string | undefined;
  if (container) {
    const m = strFromU8(container).match(/full-path="([^"]+)"/);
    path = m?.[1];
  }
  if (!path || !files[path]) {
    path = Object.keys(files).find(f => !f.startsWith('META-INF') && /\.(xml|musicxml)$/i.test(f));
  }
  if (!path) throw new ImportError('Archive MXL sans partition à l\'intérieur.');
  return strFromU8(files[path]);
}

function fromMidi(buf: Uint8Array, title: string): string {
  const midi = new Midi(buf);
  const ppq = midi.header.ppq;
  const tracks = midi.tracks.filter(t => t.notes.length > 0 && t.channel !== 9); // canal 10 = batterie
  if (!tracks.length) throw new ImportError('Ce fichier MIDI ne contient aucune note.');
  // deux pistes -> main droite = la plus aiguë ; sinon répartition par hauteur
  let handOf: (ti: number) => Hand | undefined = () => undefined;
  if (tracks.length === 2) {
    const avg = tracks.map(t => t.notes.reduce((s, n) => s + n.midi, 0) / t.notes.length);
    const right = avg[0] >= avg[1] ? 0 : 1;
    handOf = ti => (ti === right ? 'R' : 'L');
  }
  const notes: RawNote[] = [];
  tracks.forEach((t, ti) => t.notes.forEach(n => notes.push({
    midi: n.midi, start: n.ticks / ppq, dur: n.durationTicks / ppq, hand: handOf(ti)
  })));
  const ts = midi.header.timeSignatures[0]?.timeSignature ?? [4, 4];
  const key = midi.header.keySignatures[0];
  const fifths = key ? (KEY_FIFTHS[key.key] ?? 0) - (key.scale === 'minor' ? 3 : 0) : 0;
  const bpm = midi.header.tempos[0]?.bpm ?? 100;
  const name = midi.header.name?.trim() || title;
  return notesToMusicXml(notes, { title: name, beats: ts[0], beatType: ts[1], bpm, fifths: Math.max(-7, Math.min(7, fifths)) });
}

export async function importFile(file: File): Promise<Imported> {
  const name = file.name.toLowerCase();
  const title = baseName(file.name);
  const buf = new Uint8Array(await file.arrayBuffer());
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b; // "PK"
  const isMidi = buf[0] === 0x4d && buf[1] === 0x54 && buf[2] === 0x68 && buf[3] === 0x64; // "MThd"

  if (isMidi || /\.midi?$/.test(name)) {
    return { title, xml: fromMidi(buf, title), source: 'midi' };
  }
  if (isZip || name.endsWith('.mxl')) {
    const xml = fromMxl(buf);
    checkXml(xml);
    return { title: titleFromXml(xml, title), xml, source: 'musicxml' };
  }
  if (/\.(xml|musicxml)$/.test(name) || buf[0] === 0x3c || (buf[0] === 0xef && buf[3] === 0x3c)) {
    const xml = new TextDecoder().decode(buf);
    checkXml(xml);
    return { title: titleFromXml(xml, title), xml, source: 'musicxml' };
  }
  if (name.endsWith('.pdf') || file.type.startsWith('image/') || file.type.startsWith('audio/')) {
    throw new ImportError('PDF, photo et audio arrivent dans la prochaine version. Pour l\'instant : MusicXML (.xml, .musicxml, .mxl) ou MIDI (.mid).');
  }
  throw new ImportError('Format non reconnu. Formats acceptés : MusicXML (.xml, .musicxml, .mxl) et MIDI (.mid).');
}
