// Web MIDI manager: request access (SysEx if granted), find the MiniLab 3,
// parse messages into simple events, survive hot-plugging.

export type PortKind = 'main' | 'mcu' | 'other';

export interface MidiEvent {
  type: 'noteon' | 'noteoff' | 'cc' | 'pitchbend';
  channel: number;   // 1-based
  a: number;         // note or cc number
  b: number;         // velocity or value (0..127); pitchbend: 0..16383 in a
  source: PortKind;  // which device port it arrived on (DAW mode splits controls across ports)
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

  /**
   * Listen on ALL device inputs. In DAW mode the MiniLab 3 splits its surface
   * across ports: keys/pads/faders/main-encoder on the main MIDI port, but the
   * 8 encoders speak Mackie (V-Pots) on the MCU/HUI port — so one port is not
   * enough. Each message is tagged with its source port.
   */
  private bind() {
    if (!this.access) return;
    const inputs = [...this.access.inputs.values()];
    const outputs = [...this.access.outputs.values()];
    const kind = (n: string | null): PortKind => {
      if (!!n && /(mcu|hui)/i.test(n)) return 'mcu';
      if (!!n && /minilab.?3/i.test(n) && /midi/i.test(n) && !/(alv|din)/i.test(n)) return 'main';
      return 'other';
    };
    const isMinilab = (n: string | null) => !!n && /minilab.?3/i.test(n);

    for (const inp of inputs) {
      // DIN THRU echoes external gear — skip it; ALV is Analog Lab private chatter
      if (isMinilab(inp.name) && /(alv|din)/i.test(inp.name ?? '')) { inp.onmidimessage = null; continue; }
      inp.onmidimessage = (e) => this.parse(e, kind(inp.name));
    }

    this.input =
      inputs.find((i) => kind(i.name) === 'main') ??
      inputs.find((i) => isMinilab(i.name) && !/(alv|din)/i.test(i.name ?? '')) ??
      inputs[0] ??
      null;

    this.output =
      outputs.find((o) => kind(o.name) === 'main') ??
      outputs.find((o) => isMinilab(o.name) && !/(alv|din)/i.test(o.name ?? '')) ??
      null;
    this.emitStatus();
  }

  private parse(e: MIDIMessageEvent, source: PortKind) {
    const d = e.data;
    if (!d || d.length < 2) return;
    const status = d[0] & 0xf0;
    const channel = (d[0] & 0x0f) + 1;
    switch (status) {
      case 0x90:
        if (d[2] > 0) this.emit({ type: 'noteon', channel, a: d[1], b: d[2], source });
        else this.emit({ type: 'noteoff', channel, a: d[1], b: 0, source });
        break;
      case 0x80:
        this.emit({ type: 'noteoff', channel, a: d[1], b: d[2], source });
        break;
      case 0xb0:
        this.emit({ type: 'cc', channel, a: d[1], b: d[2], source });
        break;
      case 0xe0:
        this.emit({ type: 'pitchbend', channel, a: d[1] | (d[2] << 7), b: 0, source });
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
