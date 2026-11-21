// Entrée MIDI. Dans l'APK : module natif Android (android.media.midi).
// Dans un navigateur : Web MIDI API (Chrome).
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

interface NativeMidi {
  getDevices(): Promise<{ supported: boolean; names: string[]; canPlay?: boolean }>;
  send(o: { data: number[] }): Promise<void>;
  addListener(ev: 'message', f: (d: { data: number[] }) => void): Promise<PluginListenerHandle>;
  addListener(ev: 'devices', f: (d: { names: string[]; canPlay?: boolean }) => void): Promise<PluginListenerHandle>;
}
const nativeMidi = registerPlugin<NativeMidi>('Midi');

type NoteHandler = (midi: number, velocity: number) => void;

export type MidiStatus =
  | { state: 'unsupported' }
  | { state: 'denied'; message: string }
  | { state: 'none' }
  | { state: 'connected'; names: string[] };

class MidiInput {
  private access: MIDIAccess | null = null;
  private onListeners = new Set<NoteHandler>();
  private offListeners = new Set<(midi: number) => void>();
  private statusListeners = new Set<(s: MidiStatus) => void>();
  status: MidiStatus = { state: 'none' };
  readonly held = new Set<number>();
  /** Vrai si un piano peut recevoir des notes (sortie MIDI). */
  canPlay = false;

  async start(): Promise<void> {
    if (Capacitor.isNativePlatform()) {
      await nativeMidi.addListener('message', d => this.handle(d.data));
      await nativeMidi.addListener('devices', d => { this.canPlay = !!d.canPlay; this.setNames(d.names); });
      const r = await nativeMidi.getDevices();
      this.canPlay = !!r.canPlay;
      if (!r.supported) this.setStatus({ state: 'unsupported' });
      else this.setNames(r.names);
      return;
    }
    if (!('requestMIDIAccess' in navigator)) {
      this.setStatus({ state: 'unsupported' });
      return;
    }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
      this.access.onstatechange = () => this.bind();
      this.bind();
    } catch (e) {
      this.setStatus({ state: 'denied', message: String((e as Error)?.message ?? e) });
    }
  }

  private setNames(names: string[]): void {
    this.setStatus(names.length ? { state: 'connected', names } : { state: 'none' });
  }

  private bind(): void {
    if (!this.access) return;
    this.canPlay = [...this.access.outputs.values()].some(o => o.state === 'connected');
    const names: string[] = [];
    this.access.inputs.forEach(input => {
      if (input.state !== 'connected') return;
      names.push(input.name || 'Appareil MIDI');
      input.onmidimessage = ev => this.handle(ev.data);
    });
    this.setStatus(names.length ? { state: 'connected', names } : { state: 'none' });
  }

  private running = 0;

  /** Décode un flux d'octets MIDI (plusieurs messages possibles, « running status »). */
  private handle(data: ArrayLike<number> | null): void {
    if (!data) return;
    let i = 0;
    while (i < data.length) {
      const b = data[i];
      if (b >= 0xf8) { i++; continue; } // horloge, active sensing…
      if (b === 0xf0) { while (i < data.length && data[i] !== 0xf7) i++; i++; continue; } // sysex
      if (b >= 0xf0) { this.running = 0; i++; continue; }
      if (b >= 0x80) { this.running = b; i++; } else if (!this.running) { i++; continue; }
      const cmd = this.running & 0xf0;
      const len = cmd === 0xc0 || cmd === 0xd0 ? 1 : 2;
      if (i + len > data.length) break;
      const note = data[i];
      const vel = len === 2 ? data[i + 1] : 0;
      i += len;
      if (cmd === 0x90 && vel > 0) this.noteOn(note, vel);
      else if (cmd === 0x80 || (cmd === 0x90 && vel === 0)) this.noteOff(note);
    }
  }

  /** Envoie des octets MIDI au piano (pour qu'il joue avec son vrai son). */
  send(data: number[]): void {
    if (!this.canPlay) return;
    if (Capacitor.isNativePlatform()) { void nativeMidi.send({ data }).catch(() => { /* piano débranché */ }); return; }
    this.access?.outputs.forEach(o => { try { o.send(data); } catch { /* ignoré */ } });
  }

  /** Aussi appelé par le clavier à l'écran. */
  noteOn(note: number, vel = 90): void {
    this.held.add(note);
    this.onListeners.forEach(f => f(note, vel));
  }
  noteOff(note: number): void {
    this.held.delete(note);
    this.offListeners.forEach(f => f(note));
  }

  onNoteOn(f: NoteHandler): () => void { this.onListeners.add(f); return () => this.onListeners.delete(f); }
  onNoteOff(f: (midi: number) => void): () => void { this.offListeners.add(f); return () => this.offListeners.delete(f); }
  onStatus(f: (s: MidiStatus) => void): () => void { this.statusListeners.add(f); f(this.status); return () => this.statusListeners.delete(f); }

  private setStatus(s: MidiStatus): void {
    this.status = s;
    this.statusListeners.forEach(f => f(s));
  }
}

export const midiInput = new MidiInput();

export function statusLabel(s: MidiStatus): string {
  switch (s.state) {
    case 'unsupported': return Capacitor.isNativePlatform() ? 'MIDI non pris en charge par cet appareil' : 'MIDI non disponible dans ce navigateur (utilisez Chrome)';
    case 'denied': return 'Accès MIDI refusé';
    case 'none': return 'Aucun piano branché';
    case 'connected': return s.names.join(', ');
  }
}
