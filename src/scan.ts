// Reconnaissance de partitions (PDF, photos) avec Claude.
// Claude renvoie une transcription compacte mesure par mesure ; l'appli la convertit
// en MusicXML avec le même convertisseur que pour les fichiers MIDI.

import Anthropic from '@anthropic-ai/sdk';
import { notesToMusicXml, type RawNote, type Hand } from './musicxml';
import { pref, setPref } from './storage';

export const getApiKey = () => pref<string>('apiKey', '');
export const setApiKey = (k: string) => setPref('apiKey', k.trim());

export const isScanFile = (f: File) =>
  f.type === 'application/pdf' || /\.pdf$/i.test(f.name) ||
  f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name);

export class ScanError extends Error {}

export interface ScanResult {
  title: string;
  composer?: string;
  xml: string;
  measures: number;
  warning?: string;
}

export interface ScanProgress { phase: 'prepare' | 'reading' | 'writing'; measures: number }

const SYSTEM = `You transcribe piano sheet music (PDF pages or photos) into a compact text format.
Read every page in order and transcribe ALL measures, both hands, as faithfully as possible.

Output ONLY the transcription, no commentary, no markdown fence. Format:

TITLE: <title, or empty>
COMPOSER: <composer, or empty>
TIME: <beats>/<beat-type>   (e.g. 4/4, 3/4, 6/8)
KEY: <number of sharps as positive integer, flats as negative; 0 for C major / A minor>
TEMPO: <quarter-note BPM; estimate from the tempo marking if no number, default 90>
M1 | RH: <events> | LH: <events>
M2 | RH: <events> | LH: <events>
...

Events are separated by spaces. Each event is <pitches>:<duration>
- pitches: one note like C4, F#3, Bb5, E##4, Dbb3 (scientific pitch: middle C = C4), a chord joined with + like C4+E4+G4, or r for a rest.
- Always write the actual sounding accidental of each note, taking the key signature and earlier accidentals in the measure into account (e.g. in G major write F#4, not F4).
- duration in quarter notes: 4 whole, 3 dotted half, 2 half, 1.5 dotted quarter, 1 quarter, 0.75 dotted eighth, 0.5 eighth, 0.25 sixteenth; triplets as fractions like 1/3 or 2/3.
- append ~ to an event whose notes are tied to the same notes in the next event (also across the bar line).
- If one hand plays several simultaneous voices, separate the voices with & (each voice starts at the beginning of the measure and should fill it), e.g. RH: E5:1 D5:1 C5:2 & C4+E4:4
- Each hand's events (each voice) must add up to the measure length; fill with rests where needed. For a pickup (anacrusis) measure, start it with a rest so that it has the full length.
- Expand repeat signs and first/second endings into the order in which they are played; do not write repeat marks.
- Ignore lyrics, fingerings, dynamics and pedal marks. Grace notes are omitted.
- If a page is hard to read, give your best reading rather than skipping measures.`;

// ---------- préparation des fichiers ----------

function fileToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Réduit une photo (2400 px maximum) et la convertit en JPEG. */
async function imageToJpeg(file: File): Promise<string> {
  let bmp: ImageBitmap;
  try { bmp = await createImageBitmap(file); } catch {
    throw new ScanError(`Impossible de lire l'image « ${file.name} » (format non pris en charge ?).`);
  }
  const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  const blob = await new Promise<Blob>((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('jpeg'))), 'image/jpeg', 0.88));
  return fileToBase64(blob);
}

async function toBlocks(files: File[]): Promise<Anthropic.Beta.BetaContentBlockParam[]> {
  const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const f of files) {
    if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
      if (f.size > 30 * 1024 * 1024) throw new ScanError(`Le PDF « ${f.name} » dépasse 30 Mo.`);
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: await fileToBase64(f) } });
    } else {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await imageToJpeg(f) } });
    }
  }
  return blocks;
}

// ---------- lecture de la transcription ----------

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

export function parseTranscription(text: string): { notes: RawNote[]; meta: { title: string; composer?: string; beats: number; beatType: number; fifths: number; bpm: number }; measures: number; problems: number } {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const header = (k: string) => lines.find(l => l.toUpperCase().startsWith(k + ':'))?.slice(k.length + 1).trim() ?? '';
  const [beats, beatType] = (header('TIME').match(/(\d+)\s*\/\s*(\d+)/)?.slice(1).map(Number) ?? [4, 4]) as [number, number];
  const fifths = Math.max(-7, Math.min(7, parseInt(header('KEY'), 10) || 0));
  const bpm = Math.min(240, Math.max(30, parseInt(header('TEMPO'), 10) || 90));
  const measureLen = (beats * 4) / beatType;
  const notes: RawNote[] = [];
  let measures = 0;
  let problems = 0;
  // liaisons en attente : par main et par voix, hauteur -> note à prolonger
  const ties = new Map<string, Map<number, RawNote>>();

  for (const line of lines) {
    if (!/^M\d+\s*\|/i.test(line)) continue;
    const start = measures * measureLen;
    measures++;
    for (const part of line.split('|').slice(1)) {
      const hm = part.trim().match(/^(RH|LH)\s*:\s*(.*)$/i);
      if (!hm) continue;
      const hand: Hand = hm[1].toUpperCase() === 'RH' ? 'R' : 'L';
      hm[2].split('&').forEach((voice, vi) => {
        const key = `${hand}${vi}`;
        const pending = ties.get(key) ?? new Map<number, RawNote>();
        const next = new Map<number, RawNote>();
        let t = start;
        for (const tok of voice.trim().split(/\s+/).filter(Boolean)) {
          const em = tok.match(/^([^:]+):([^~]+)(~?)$/);
          const dur = em ? parseDur(em[2]) : NaN;
          if (!em || !(dur > 0)) { problems++; continue; }
          const tied = em[3] === '~';
          if (em[1].toLowerCase() !== 'r') {
            for (const ps of em[1].split('+')) {
              const midi = parsePitch(ps);
              if (midi === null) { problems++; continue; }
              const prev = pending.get(midi);
              let n: RawNote;
              if (prev && Math.abs(prev.start + prev.dur - t) < 0.01) { prev.dur += dur; n = prev; }
              else { n = { midi, start: t, dur, hand }; notes.push(n); }
              if (tied) next.set(midi, n);
            }
          }
          pending.clear();
          if (tied) next.forEach((v, k) => pending.set(k, v));
          next.clear();
          t += dur;
        }
        ties.set(key, pending);
      });
    }
  }
  return { notes, meta: { title: header('TITLE'), composer: header('COMPOSER') || undefined, beats, beatType, fifths, bpm }, measures, problems };
}

// ---------- appel à Claude ----------

export async function scanScore(files: File[], fallbackTitle: string, onProgress: (p: ScanProgress) => void, signal: AbortSignal): Promise<ScanResult> {
  const apiKey = getApiKey();
  if (!apiKey) throw new ScanError('Aucune clé API Claude enregistrée.');
  onProgress({ phase: 'prepare', measures: 0 });
  const blocks = await toBlocks(files);
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  let text = '';
  let msg: Anthropic.Beta.BetaMessage;
  try {
    const stream = client.beta.messages.stream({
      model: 'claude-opus-5-5',
      max_tokens: 64000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default', // si le modèle refuse, l'API réessaie avec le modèle de secours
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      system: SYSTEM,
      messages: [{ role: 'user', content: [...blocks, { type: 'text', text: 'Transcribe this piano score.' }] }]
    }, { signal });
    onProgress({ phase: 'reading', measures: 0 });
    stream.on('text', delta => {
      text += delta;
      onProgress({ phase: 'writing', measures: (text.match(/^M\d+\s*\|/gim) ?? []).length });
    });
    msg = await stream.finalMessage();
  } catch (e) {
    if (e instanceof Anthropic.APIUserAbortError) throw new ScanError('Lecture annulée.');
    if (e instanceof Anthropic.AuthenticationError) throw new ScanError('Clé API refusée : vérifiez-la dans les réglages.');
    if (e instanceof Anthropic.PermissionDeniedError) throw new ScanError('Accès refusé par l\'API (crédit ou droits du compte).');
    if (e instanceof Anthropic.RateLimitError) throw new ScanError('Trop de demandes en même temps : réessayez dans une minute.');
    if (e instanceof Anthropic.BadRequestError) throw new ScanError(`Demande refusée : ${e.message}`);
    if (e instanceof Anthropic.APIConnectionError) throw new ScanError('Pas de connexion à Internet.');
    if (e instanceof Anthropic.APIError) throw new ScanError(`Erreur du service (${e.status}) : réessayez plus tard.`);
    throw e;
  }
  if (msg.stop_reason === 'refusal') throw new ScanError('Claude a refusé de lire ce document.');
  const finalText = msg.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map(b => b.text).join('');
  const parsed = parseTranscription(finalText || text);
  if (!parsed.measures || !parsed.notes.length) {
    throw new ScanError('Aucune mesure reconnue. La photo est-elle nette et bien cadrée ?');
  }
  const title = parsed.meta.title || fallbackTitle;
  const xml = notesToMusicXml(parsed.notes, { ...parsed.meta, title });
  const warnings: string[] = [];
  if (msg.stop_reason === 'max_tokens') warnings.push('La partition est très longue : la fin n\'a pas pu être transcrite.');
  if (parsed.problems) warnings.push(`${parsed.problems} élément${parsed.problems > 1 ? 's' : ''} illisible${parsed.problems > 1 ? 's' : ''} ignoré${parsed.problems > 1 ? 's' : ''}.`);
  return { title, composer: parsed.meta.composer, xml, measures: parsed.measures, warning: warnings.join(' ') || undefined };
}
