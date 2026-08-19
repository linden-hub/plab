// Web MIDI manager: request access (SysEx if granted), find the MiniLab 3,
// parse messages into simple events, survive hot-plugging.

export interface MidiEvent {
  type: 'noteon' | 'noteoff' | 'cc' | 'pitchbend';
  channel: number;   // 1-based
  a: number;         // note or cc number
  b: number;         // velocity or value (0..127); pitchbend: 0..16383 in a
}

export type MidiListener = (e: MidiEvent) => void;
export type StatusListener = (connected: boolean, name: string | null, sysex: boolean) => void;

export class MidiManager {
  private access: MIDIAccess | null = null;
  private input: MIDIInput | null = null;
  private output: MIDIOutput | null = null;
  private listeners: MidiListener[] = [];
  private statusListeners: StatusListener[] = [];
  sysexOk = false;

  get deviceName(): string | null { return this.input?.name ?? null; }
  get connected(): boolean { return this.input !== null; }

  onMessage(fn: MidiListener) { this.listeners.push(fn); }
  onStatus(fn: StatusListener) { this.statusListeners.push(fn); }

  async init() {
    if (!('requestMIDIAccess' in navigator)) {
      this.emitStatus();
      return;
    }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: true });
      this.sysexOk = true;
    } catch {
      try {
        this.access = await navigator.requestMIDIAccess();
      } catch {
        this.emitStatus();
        return;
      }
    }
    this.access.onstatechange = () => this.bind();
    this.bind();
  }

  /** Prefer the MiniLab 3 main port; fall back to any input. */
  private bind() {
    if (!this.access) return;
    const inputs = [...this.access.inputs.values()];
    const outputs = [...this.access.outputs.values()];
    const isMain = (n: string | null) => !!n && /minilab.?3/i.test(n) && /midi/i.test(n) && !/(mcu|hui|alv|din)/i.test(n);
    const isMinilab = (n: string | null) => !!n && /minilab.?3/i.test(n) && !/(mcu|hui|alv|din)/i.test(n);

    const next =
      inputs.find((i) => isMain(i.name)) ??
      inputs.find((i) => isMinilab(i.name)) ??
      inputs[0] ??
      null;

    if (next !== this.input) {
      if (this.input) this.input.onmidimessage = null;
      this.input = next;
      if (this.input) this.input.onmidimessage = (e) => this.parse(e);
    }
    this.output =
      outputs.find((o) => isMain(o.name)) ??
      outputs.find((o) => isMinilab(o.name)) ??
      null;
    this.emitStatus();
  }

  private parse(e: MIDIMessageEvent) {
    const d = e.data;
    if (!d || d.length < 2) return;
    const status = d[0] & 0xf0;
    const channel = (d[0] & 0x0f) + 1;
    switch (status) {
      case 0x90:
        if (d[2] > 0) this.emit({ type: 'noteon', channel, a: d[1], b: d[2] });
        else this.emit({ type: 'noteoff', channel, a: d[1], b: 0 });
        break;
      case 0x80:
        this.emit({ type: 'noteoff', channel, a: d[1], b: d[2] });
        break;
      case 0xb0:
        this.emit({ type: 'cc', channel, a: d[1], b: d[2] });
        break;
      case 0xe0:
        this.emit({ type: 'pitchbend', channel, a: d[1] | (d[2] << 7), b: 0 });
        break;
    }
  }

  sendSysex(bytes: number[]) {
    if (!this.output || !this.sysexOk) return;
    try { this.output.send(bytes); } catch { /* not fatal — LEDs are a bonus */ }
  }

  private emit(e: MidiEvent) { for (const l of this.listeners) l(e); }
  private emitStatus() {
    for (const l of this.statusListeners) l(this.connected, this.deviceName, this.sysexOk);
  }
}
