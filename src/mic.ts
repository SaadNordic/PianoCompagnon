// Écoute au micro : pour le oud, c'est l'équivalent de l'entrée MIDI du piano.
// Le micro n'est ouvert que sur les écrans qui en ont besoin, et coupé dès que l'appli passe en arrière-plan.

import { audioOut } from './synth';
import { pref, setPref } from './storage';
import { detectPitch, hzToPitch, NoteTracker } from './pitch';
import { h } from './ui';

export type MicState = 'off' | 'asking' | 'on' | 'denied' | 'unsupported';
export interface MicFrame { pitch: number | null; rms: number }

const TOLERANCE = 0.35; // 35 cents : assez large pour un instrument sans frettes, moins qu'un quart de ton + marge

let ref = pref<number>('oud.ref', 440);
/** Fréquence du La de référence. */
export const refHz = () => ref;
export function setRefHz(hz: number): void { ref = hz; setPref('oud.ref', hz); }

export function micLabel(s: MicState): string {
  switch (s) {
    case 'on': return 'Micro à l’écoute';
    case 'asking': return 'Autorisation du micro…';
    case 'denied': return 'Micro refusé : autorisez-le dans les réglages du téléphone';
    case 'unsupported': return 'Micro non disponible sur cet appareil';
    default: return 'Micro prêt';
  }
}

class MicInput {
  state: MicState = 'off';
  private users = 0;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private buf: Float32Array<ArrayBuffer> | null = null;
  private timer = 0;
  private opening = false;
  private mutedUntil = 0;
  private targets: number[] = [];
  private onListeners = new Set<(p: number) => void>();
  private offListeners = new Set<(p: number) => void>();
  private frameListeners = new Set<(f: MicFrame) => void>();
  private stateListeners = new Set<(s: MicState) => void>();
  private shown = new Map<number, number>(); // hauteur brute -> note annoncée
  private tracker = new NoteTracker(
    p => { const s = this.snap(p); this.shown.set(p, s); this.onListeners.forEach(f => f(s)); },
    p => { const s = this.shown.get(p) ?? this.snap(p); this.shown.delete(p); this.offListeners.forEach(f => f(s)); }
  );

  constructor() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.close();
      else if (this.users > 0) void this.open();
    });
  }

  /** Un écran commence à écouter. */
  start(): Promise<void> { this.users++; return this.open(); }

  /** Un écran cesse d'écouter ; le micro se coupe quand plus personne n'en a besoin. */
  stop(): void {
    this.users = Math.max(0, this.users - 1);
    if (!this.users) { this.close(); this.targets = []; }
  }

  /** Nouvelle tentative après un refus. */
  retry(): Promise<void> { return this.open(); }

  private async open(): Promise<void> {
    if (this.stream || this.opening) return;
    if (!navigator.mediaDevices?.getUserMedia) { this.setState('unsupported'); return; }
    this.opening = true;
    this.setState('asking');
    let stream: MediaStream;
    try {
      // sans traitement du téléphone : il déformerait le son d'un instrument
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 }
      });
    } catch {
      this.opening = false;
      this.setState('denied');
      return;
    }
    this.opening = false;
    if (!this.users || document.visibilityState === 'hidden') {
      stream.getTracks().forEach(t => t.stop());
      this.setState('off');
      return;
    }
    const { ctx } = audioOut();
    this.stream = stream;
    this.source = ctx.createMediaStreamSource(stream);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 4096;
    this.source.connect(this.analyser); // jamais relié aux haut-parleurs
    this.buf = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));
    this.tracker.reset();
    this.timer = window.setInterval(() => this.tick(), 50);
    this.setState('on');
  }

  private close(): void {
    clearInterval(this.timer);
    this.tracker.reset();
    this.source?.disconnect();
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.source = null;
    this.analyser = null;
    if (this.state === 'on' || this.state === 'asking') this.setState('off');
  }

  private tick(): void {
    if (!this.analyser || !this.buf) return;
    const { ctx } = audioOut(); // relance le contexte audio s'il a été suspendu
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
    const rms = Math.sqrt(sum / this.buf.length);
    const d = rms >= 0.002 ? detectPitch(this.buf, ctx.sampleRate) : null;
    const pitch = d && d.clarity >= 0.85 ? hzToPitch(d.freq, ref) : null;
    const muted = performance.now() < this.mutedUntil; // l'appli joue : elle ne doit pas s'écouter
    this.frameListeners.forEach(f => f({ pitch: muted ? null : pitch, rms }));
    if (muted) { this.tracker.reset(); return; }
    this.tracker.feed(pitch, rms, performance.now());
  }

  /** Notes attendues : un son assez proche (même à l'octave) compte pour la note attendue. */
  setTargets(list: number[]): void { this.targets = list; }

  private snap(p: number): number {
    let best: number | null = null;
    let bestD = TOLERANCE;
    for (const t of this.targets) {
      for (const oct of [-12, 0, 12]) {
        const d = Math.abs(p - (t + oct));
        if (d <= bestD) { bestD = d; best = t; }
      }
    }
    return best ?? Math.round(p * 2) / 2;
  }

  /** N'écoute plus pendant un instant (l'appli joue elle-même : elle ne doit pas s'entendre). */
  mute(ms: number): void {
    this.mutedUntil = Math.max(this.mutedUntil, performance.now() + ms);
  }

  /** Note jouée au doigt sur le manche affiché. */
  press(p: number): void {
    const s = this.snap(p);
    this.onListeners.forEach(f => f(s));
    setTimeout(() => this.offListeners.forEach(f => f(s)), 250);
  }

  onNoteOn(f: (p: number) => void): () => void { this.onListeners.add(f); return () => this.onListeners.delete(f); }
  onNoteOff(f: (p: number) => void): () => void { this.offListeners.add(f); return () => this.offListeners.delete(f); }
  onFrame(f: (x: MicFrame) => void): () => void { this.frameListeners.add(f); return () => this.frameListeners.delete(f); }
  onState(f: (s: MicState) => void): () => void { this.stateListeners.add(f); f(this.state); return () => this.stateListeners.delete(f); }

  private setState(s: MicState): void {
    this.state = s;
    this.stateListeners.forEach(f => f(s));
  }
}

export const micInput = new MicInput();

/** Bandeau affiché seulement si le micro est refusé ou absent, avec un bouton pour réessayer. */
export function micBanner(): { el: HTMLElement; destroy: () => void } {
  const text = h('span', {});
  const retry = h('button', { onclick: () => void micInput.retry() }, 'Réessayer');
  const el = h('div', { class: 'mic-warn', style: 'display:none' }, [text, retry]);
  const destroy = micInput.onState(s => {
    const bad = s === 'denied' || s === 'unsupported';
    el.style.display = bad ? '' : 'none';
    retry.style.display = s === 'denied' ? '' : 'none';
    text.textContent = micLabel(s);
  });
  return { el, destroy };
}
