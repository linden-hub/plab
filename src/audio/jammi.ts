// JAMMI keyboard — Chompi-style sampler keys.
// One sample spread chromatically across the keyboard via varispeed
// (C4 = original pitch). The sample is either the live tape mixdown, a loaded
// WAV, or a take recorded straight off the mic/bus into the keys.

interface Voice { src: AudioBufferSourceNode; gain: GainNode }

export class JammiSampler {
  /** Explicit sample (loaded WAV or mic take). null = fall back to the tape mixdown. */
  sample: AudioBuffer | null = null;
  sourceName = 'tape'; // what the UI shows: 'tape' | file name | 'mic take'

  private voices = new Map<number, Voice>();

  constructor(private ctx: AudioContext, private dest: AudioNode) {}

  setSample(buf: AudioBuffer | null, name: string) {
    this.sample = buf;
    this.sourceName = name;
  }

  async loadFile(file: File): Promise<boolean> {
    try {
      const buf = await this.ctx.decodeAudioData(await file.arrayBuffer());
      this.setSample(buf, file.name.replace(/\.[^.]+$/, ''));
      return true;
    } catch {
      return false;
    }
  }

  noteOn(note: number, vel: number, at: number, fallback: AudioBuffer | null) {
    const buf = this.sample ?? fallback;
    if (!buf) return false;
    this.noteOff(note, at);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = Math.pow(2, (note - 60) / 12);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.9 * vel, at + 0.005);
    src.connect(gain).connect(this.dest);
    src.start(at);
    src.onended = () => { if (this.voices.get(note)?.src === src) this.voices.delete(note); };
    this.voices.set(note, { src, gain });
    return true;
  }

  noteOff(note: number, at: number) {
    const v = this.voices.get(note);
    if (!v) return;
    this.voices.delete(note);
    v.gain.gain.setTargetAtTime(0, at, 0.04);
    v.src.stop(at + 0.25);
  }

  allOff(at: number) {
    for (const note of [...this.voices.keys()]) this.noteOff(note, at);
  }
}
