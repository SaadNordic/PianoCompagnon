// Détection de hauteur (algorithme YIN) et repérage des notes jouées, sans dépendance au navigateur.
// Les hauteurs sont exprimées en « MIDI décimal » : 69 = La 440, 63,5 = Mi demi-bémol.

export interface Detected { freq: number; clarity: number }

export const hzToPitch = (hz: number, ref = 440) => 69 + 12 * Math.log2(hz / ref);
export const pitchToHz = (p: number, ref = 440) => ref * Math.pow(2, (p - 69) / 12);

/** Fréquence fondamentale d'une fenêtre de son, ou null si le son n'est pas périodique. */
export function detectPitch(input: Float32Array, sampleRate: number, minHz = 50, maxHz = 1500): Detected | null {
  // on divise la fréquence d'échantillonnage par 2 : quatre fois moins de calcul, précision suffisante
  const ds = sampleRate > 32000 ? 2 : 1;
  const n = Math.floor(input.length / ds);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = ds === 2 ? (input[2 * i] + input[2 * i + 1]) / 2 : input[i];
  const sr = sampleRate / ds;
  const tauMin = Math.max(2, Math.floor(sr / maxHz));
  const tauMax = Math.min(Math.ceil(sr / minHz), Math.floor(n / 2));
  const w = n - tauMax;
  if (tauMax <= tauMin || w <= 0) return null;

  // différence cumulée normalisée
  const d = new Float32Array(tauMax + 2);
  d[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax + 1 && tau + w <= n; tau++) {
    let sum = 0;
    for (let i = 0; i < w; i++) { const v = x[i] - x[i + tau]; sum += v * v; }
    running += sum;
    d[tau] = running > 0 ? (sum * tau) / running : 1;
  }

  // premier creux sous le seuil : c'est la période (évite de prendre une harmonique)
  const THRESHOLD = 0.15;
  let best = -1;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (d[tau] < THRESHOLD) {
      while (tau + 1 <= tauMax && d[tau + 1] < d[tau]) tau++;
      best = tau;
      break;
    }
  }
  if (best < 0) return null;

  // interpolation autour du creux, pour une précision au cent près
  const a = d[best - 1], b = d[best], c = d[best + 1];
  const denom = a - 2 * b + c;
  const shift = denom > 0 ? Math.max(-1, Math.min(1, (a - c) / (2 * denom))) : 0;
  return { freq: sr / (best + shift), clarity: 1 - b };
}

const MIN_RMS = 0.004; // en dessous : silence
const STABLE_FRAMES = 3; // images concordantes avant de valider une note
const HOLD_MS = 150; // après une note, délai avant de pouvoir détecter une nouvelle attaque
const ATTACK_RATIO = 1.45; // remontée du volume qui signale une corde repincée

const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
/** Écart entre deux hauteurs, sans tenir compte de l'octave. */
const pcDistance = (a: number, b: number) => Math.abs((((a - b + 6) % 12) + 12) % 12 - 6);

/**
 * Transforme le flux de hauteurs en notes : une corde pincée donne UNE note, même si elle résonne longtemps ;
 * la même note repincée en redonne une (remontée du volume) ; un glissé vers une autre note aussi.
 */
export class NoteTracker {
  private armed = true;
  private candidate: number[] = [];
  private current: number | null = null;
  private noise = 0.002;
  private trough = Infinity;
  private holdUntil = 0;

  constructor(private on: (p: number) => void, private off: (p: number) => void) {}

  reset(): void {
    this.release();
    this.armed = true;
    this.candidate = [];
    this.trough = Infinity;
    this.holdUntil = 0;
  }

  private release(): void {
    if (this.current !== null) this.off(this.current);
    this.current = null;
  }

  feed(pitch: number | null, rms: number, t: number): void {
    if (pitch === null) this.noise += (Math.min(rms, 0.03) - this.noise) * 0.03;
    const gate = Math.max(MIN_RMS, this.noise * 3);
    if (rms < gate * 0.7) {
      this.release();
      this.armed = true;
      this.candidate = [];
      this.trough = Infinity;
      return;
    }
    if (this.current !== null) {
      if (t < this.holdUntil) this.trough = rms;
      else {
        this.trough = Math.min(this.trough, rms);
        if (!this.armed && rms > this.trough * ATTACK_RATIO) {
          this.armed = true;
          this.candidate = [];
          this.trough = rms;
          this.holdUntil = t + HOLD_MS;
        }
      }
    }
    if (pitch === null || rms < gate) { this.candidate = []; return; }
    // une erreur d'octave sur une note qui résonne n'est pas une nouvelle note
    const moved = this.current !== null && pcDistance(pitch, this.current) > 0.6;
    if (!this.armed && !moved) { this.candidate = []; return; }
    if (this.candidate.length && Math.abs(pitch - median(this.candidate)) > 0.35) this.candidate = [];
    this.candidate.push(pitch);
    if (this.candidate.length < STABLE_FRAMES) return;
    const note = median(this.candidate);
    this.release();
    this.current = note;
    this.armed = false;
    this.candidate = [];
    this.trough = rms;
    this.holdUntil = t + HOLD_MS;
    this.on(note);
  }
}
