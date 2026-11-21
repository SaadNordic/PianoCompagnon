// Petit son de piano synthétisé (Web Audio) : sert à écouter la partition
// et à jouer les parties que l'élève ne joue pas. Aucun fichier à télécharger.

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

function ac(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 0.5;
    const comp = ctx.createDynamicsCompressor();
    master.connect(comp).connect(ctx.destination);
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

export function setVolume(v: number): void {
  ac();
  master!.gain.value = v;
}

/** Joue une note. `when` en secondes dans le temps du contexte audio (0 = maintenant). */
export function playNote(midi: number, durationSec = 0.8, velocity = 80, when = 0): void {
  const c = ac();
  const t0 = Math.max(c.currentTime, when || c.currentTime);
  const freq = 440 * Math.pow(2, (midi - 69) / 12);
  const v = (velocity / 127) * 0.35;
  const out = c.createGain();
  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(Math.min(12000, freq * 8), t0);
  filter.frequency.exponentialRampToValueAtTime(Math.max(400, freq * 2), t0 + 1.2);
  out.connect(filter).connect(master!);

  // attaque rapide, décroissance naturelle, relâchement à la fin
  const decay = Math.max(0.6, 3.2 - (midi - 40) * 0.035);
  const end = t0 + Math.min(durationSec, decay) + 0.25;
  out.gain.setValueAtTime(0.0001, t0);
  out.gain.exponentialRampToValueAtTime(v, t0 + 0.005);
  out.gain.exponentialRampToValueAtTime(v * 0.35, t0 + 0.25);
  out.gain.setTargetAtTime(0.0001, t0 + 0.25, decay / 3);
  out.gain.setTargetAtTime(0.0001, end - 0.25, 0.06);

  const partials: [number, number, OscillatorType][] = [[1, 1, 'triangle'], [2, 0.35, 'sine'], [3, 0.12, 'sine'], [4, 0.05, 'sine']];
  for (const [mult, amp, type] of partials) {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.value = freq * mult;
    o.detune.value = (Math.random() - 0.5) * 4;
    g.gain.value = amp;
    o.connect(g).connect(out);
    o.start(t0);
    o.stop(end + 0.1);
  }
}

export function now(): number {
  return ac().currentTime;
}

/** À appeler sur un geste de l'utilisateur pour débloquer le son sur mobile. */
export function unlockAudio(): void {
  ac();
}
