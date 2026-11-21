// Entrée MIDI (Web MIDI API). Fonctionne dans Chrome Android avec un câble USB OTG.

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

  async start(): Promise<void> {
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

  private bind(): void {
    if (!this.access) return;
    const names: string[] = [];
    this.access.inputs.forEach(input => {
      if (input.state !== 'connected') return;
      names.push(input.name || 'Appareil MIDI');
      input.onmidimessage = ev => this.handle(ev.data);
    });
    this.setStatus(names.length ? { state: 'connected', names } : { state: 'none' });
  }

  private handle(data: Uint8Array | null): void {
    if (!data || data.length < 3) return;
    const cmd = data[0] & 0xf0;
    const note = data[1];
    const vel = data[2];
    if (cmd === 0x90 && vel > 0) this.noteOn(note, vel);
    else if (cmd === 0x80 || (cmd === 0x90 && vel === 0)) this.noteOff(note);
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
    case 'unsupported': return 'MIDI non disponible dans ce navigateur (utilisez Chrome)';
    case 'denied': return 'Accès MIDI refusé';
    case 'none': return 'Aucun piano branché';
    case 'connected': return s.names.join(', ');
  }
}
