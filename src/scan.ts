// Reconnaissance de partitions (PDF, photos) avec Claude.
// Claude renvoie une transcription compacte mesure par mesure ; l'appli la convertit
// en MusicXML avec le même convertisseur que pour les fichiers MIDI.

import Anthropic from '@anthropic-ai/sdk';
import { parsePcn, pcnToXml, normalizePcn } from './codification';
import { pref, setPref, getSession } from './storage';
import { api, ApiError } from './api';

export const getApiKey = () => pref<string>('apiKey', '');
export const setApiKey = (k: string) => setPref('apiKey', k.trim());

export const isScanFile = (f: File) =>
  f.type === 'application/pdf' || /\.pdf$/i.test(f.name) ||
  f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name);

export class ScanError extends Error {}

export interface ScanResult {
  title: string;
  composer?: string;
  code: string; // codification PCN
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

// ---------- appel à Claude ----------

/** Lecture par le serveur (clé Claude ND/NT gardée côté serveur) : envoi, puis suivi de l'avancement. */
async function scanViaServer(blocks: Anthropic.Beta.BetaContentBlockParam[], onProgress: (p: ScanProgress) => void, signal: AbortSignal): Promise<{ text: string; truncated: boolean }> {
  const files = blocks.map((b, i) => {
    const src = (b as { source: { media_type: string; data: string } }).source;
    return { name: `page${i + 1}`, type: src.media_type, data: src.data };
  });
  let job: string;
  try {
    job = (await api<{ job: string }>('POST', '/api/scan', { files }, 120000)).job;
  } catch (e) {
    throw new ScanError(e instanceof ApiError ? e.message : String(e));
  }
  onProgress({ phase: 'reading', measures: 0 });
  for (;;) {
    await new Promise(r => setTimeout(r, 2500));
    if (signal.aborted) throw new ScanError('Lecture annulée.');
    let st: { state: string; measures: number; error?: string; text?: string; truncated?: boolean };
    try {
      st = await api('GET', `/api/scan/${job}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) continue; // coupure passagère : on réessaie
      throw new ScanError(e instanceof ApiError ? e.message : String(e));
    }
    if (st.state === 'error') throw new ScanError(st.error || 'Erreur de lecture.');
    if (st.state === 'done') return { text: st.text ?? '', truncated: !!st.truncated };
    onProgress({ phase: st.measures ? 'writing' : 'reading', measures: st.measures });
  }
}

export async function scanScore(files: File[], fallbackTitle: string, onProgress: (p: ScanProgress) => void, signal: AbortSignal): Promise<ScanResult> {
  const apiKey = getApiKey();
  if (!getSession() && !apiKey) throw new ScanError('Connectez-vous à votre compte (VPN activé) pour lire une partition.');
  onProgress({ phase: 'prepare', measures: 0 });
  const blocks = await toBlocks(files);
  if (getSession()) {
    const r = await scanViaServer(blocks, onProgress, signal);
    return finish(r.text, r.truncated, fallbackTitle);
  }
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
  return finish(finalText || text, msg.stop_reason === 'max_tokens', fallbackTitle);
}

function finish(rawText: string, truncated: boolean, fallbackTitle: string): ScanResult {
  const parsed = parsePcn(rawText);
  if (!parsed.measures || !parsed.notes.length) {
    throw new ScanError('Aucune mesure reconnue. La photo est-elle nette et bien cadrée ?');
  }
  const title = parsed.meta.title || fallbackTitle;
  const xml = pcnToXml(parsed, title);
  const code = normalizePcn(rawText, title, parsed.meta.composer);
  const warnings: string[] = [];
  if (truncated) warnings.push("La partition est très longue : la fin n'a pas pu être transcrite.");
  if (parsed.problems.length) warnings.push(`À vérifier : ${parsed.problems.slice(0, 5).join(' ; ')}${parsed.problems.length > 5 ? '…' : ''}`);
  return { title, composer: parsed.meta.composer, code, xml, measures: parsed.measures, warning: warnings.join(' ') || undefined };
}
