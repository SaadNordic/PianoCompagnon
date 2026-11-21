// Son de piano : échantillons du Salamander Grand Piano (Yamaha C5, CC BY 3.0) intégrés à l'appli
// (public/piano/, une note sur trois demi-tons, les autres sont transposées).
// Tant que les échantillons ne sont pas chargés, un petit son synthétique sert de secours.

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

function ac(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: 'interactive' });
    master = ctx.createGain();
    master.gain.value = 0.8;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 3;
    master.connect(comp).connect(ctx.destination);
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

export function setVolume(v: number): void {
  ac();
  master!.gain.value = v;
}

// ---------- échantillons ----------

const NAMES = ['C', 'Cs', 'D', 'Ds', 'E', 'F', 'Fs', 'G', 'Gs', 'A', 'As', 'B'];
const SAMPLE_MIDIS: number[] = [];
for (let m = 21; m <= 108; m++) if ([0, 3, 6, 9].includes(m % 12)) SAMPLE_MIDIS.push(m); // C, D#, F#, A
const buffers = new Map<number, AudioBuffer>();
let loading: Promise<void> | null = null;

function sampleUrl(midi: number): string {
  return `${import.meta.env.BASE_URL}piano/${NAMES[midi % 12]}${Math.floor(midi / 12) - 1}.mp3`;
}

/** Charge les échantillons (une seule fois). */
export function loadPiano(): Promise<void> {
  if (!loading) {
    const c = ac();
    loading = Promise.all(SAMPLE_MIDIS.map(async m => {
      try {
        const data = await fetch(sampleUrl(m)).then(r => r.arrayBuffer());
        buffers.set(m, await c.decodeAudioData(data));
      } catch { /* note manquante : la plus proche servira */ }
    })).then(() => undefined);
  }
  return loading;
}

function nearestSample(midi: number): number | null {
  let best: number | null = null;
  for (const m of buffers.keys()) if (best === null || Math.abs(m - midi) < Math.abs(best - midi)) best = m;
  return best;
}

const active = new Set<{ stop: (t: number) => void }>();

/** Joue une note. `when` en secondes dans le temps du contexte audio (0 = maintenant). */
export function playNote(midi: number, durationSec = 0.8, velocity = 80, when = 0): void {
  const c = ac();
  const t0 = Math.max(c.currentTime, when || c.currentTime);
  const s = nearestSample(midi);
  if (s === null) { void loadPiano(); synthNote(c, midi, durationSec, velocity, t0); return; }
  const src = c.createBufferSource();
  src.buffer = buffers.get(s)!;
  src.playbackRate.value = Math.pow(2, (midi - s) / 12);
  const g = c.createGain();
  const level = Math.pow(Math.max(1, velocity) / 127, 1.6) * 1.1;
  g.gain.setValueAtTime(level, t0);
  // relâchement de la touche : extinction douce (comme l'étouffoir)
  const end = t0 + Math.max(0.12, durationSec);
  g.gain.setTargetAtTime(0, end, 0.18);
  src.connect(g).connect(master!);
  src.start(t0);
  src.stop(end + 1.5);
  const handle = { stop: (t: number) => { try { g.gain.cancelScheduledValues(t); g.gain.setTargetAtTime(0, t, 0.05); src.stop(t + 0.3); } catch { /* déjà arrêtée */ } } };
  active.add(handle);
  src.onended = () => active.delete(handle);
}

/** Coupe immédiatement tout ce qui joue (fin d'une écoute). */
export function stopAll(): void {
  if (!ctx) return;
  const t = ctx.currentTime;
  active.forEach(h => h.stop(t));
  active.clear();
}

/** Son de secours, le temps que les échantillons arrivent. */
function synthNote(c: AudioContext, midi: number, durationSec: number, velocity: number, t0: number): void {
  const freq = 440 * Math.pow(2, (midi - 69) / 12);
  const v = (velocity / 127) * 0.3;
  const out = c.createGain();
  out.connect(master!);
  const end = t0 + Math.min(durationSec, 2) + 0.25;
  out.gain.setValueAtTime(0.0001, t0);
  out.gain.exponentialRampToValueAtTime(v, t0 + 0.005);
  out.gain.setTargetAtTime(0.0001, t0 + 0.1, 0.5);
  out.gain.setTargetAtTime(0.0001, end - 0.25, 0.06);
  for (const [mult, amp] of [[1, 1], [2, 0.3], [3, 0.1]] as [number, number][]) {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'sine';
    o.frequency.value = freq * mult;
    g.gain.value = amp;
    o.connect(g).connect(out);
    o.start(t0);
    o.stop(end + 0.1);
  }
}

export function now(): number {
  return ac().currentTime;
}

/** À appeler sur un geste de l'utilisateur : débloque le son sur mobile et charge le piano. */
export function unlockAudio(): void {
  ac();
  void loadPiano();
}
