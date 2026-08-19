// Polyphonic subtractive synth — 2 oscillators, lowpass filter, ADSR.
// Constructed against any BaseAudioContext so the same code renders offline
// for WAV export.

export interface SynthPreset {
  osc1: OscillatorType;
  osc2: OscillatorType;
  detune: number;        // cents between oscillators
  sub: boolean;          // add a -1 octave sine underneath
  filterBase: number;    // Hz
  filterEnv: number;     // Hz added by the envelope
  attack: number;
  decay: number;
  sustain: number;       // 0..1
  release: number;
  gain: number;
}

export const PRESETS: Record<string, SynthPreset> = {
  warm: { osc1: 'sawtooth', osc2: 'sawtooth', detune: 9, sub: false, filterBase: 500, filterEnv: 2200, attack: 0.02, decay: 0.4, sustain: 0.7, release: 0.5, gain: 0.16 },
  pluck: { osc1: 'square', osc2: 'triangle', detune: 4, sub: false, filterBase: 300, filterEnv: 3800, attack: 0.002, decay: 0.18, sustain: 0.0, release: 0.15, gain: 0.2 },
  bass: { osc1: 'sawtooth', osc2: 'square', detune: 3, sub: true, filterBase: 80, filterEnv: 900, attack: 0.004, decay: 0.25, sustain: 0.4, release: 0.12, gain: 0.28 },
};

interface Voice {
  note: number;
  oscs: OscillatorNode[];
  filter: BiquadFilterNode;
  amp: GainNode;
  releasedAt: number | null;
}

export class PolySynth {
  private voices: Voice[] = [];
  preset: SynthPreset;
  /** Macro multipliers, live-controllable. */
  brightness = 1;   // scales filter env
  releaseScale = 1;

  constructor(
    private ctx: BaseAudioContext,
    private dest: AudioNode,
    preset: SynthPreset = PRESETS.warm,
    private maxVoices = 12,
  ) {
    this.preset = { ...preset };
  }

  noteOn(note: number, vel = 1, time = this.ctx.currentTime) {
    this.noteOff(note, time); // retrigger
    if (this.voices.length >= this.maxVoices) this.steal(time);

    const p = this.preset;
    const freq = midiToFreq(note);
    const amp = this.ctx.createGain();
    amp.gain.value = 0;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 1.1;

    const oscs: OscillatorNode[] = [];
    const mk = (type: OscillatorType, det: number, oct = 0) => {
      const o = this.ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq * Math.pow(2, oct);
      o.detune.value = det;
      o.connect(filter);
      o.start(time);
      oscs.push(o);
    };
    mk(p.osc1, -p.detune / 2);
    mk(p.osc2, p.detune / 2);
    if (p.sub) mk('sine', 0, -1);

    filter.connect(amp).connect(this.dest);

    // Filter envelope
    const fPeak = p.filterBase + p.filterEnv * this.brightness * (0.5 + 0.5 * vel);
    filter.frequency.setValueAtTime(p.filterBase, time);
    filter.frequency.linearRampToValueAtTime(Math.min(fPeak, 16000), time + Math.max(0.005, p.attack));
    filter.frequency.setTargetAtTime(p.filterBase + (fPeak - p.filterBase) * p.sustain, time + p.attack, Math.max(0.02, p.decay / 3));

    // Amp envelope
    const g = p.gain * (0.4 + 0.6 * vel);
    amp.gain.setValueAtTime(0, time);
    amp.gain.linearRampToValueAtTime(g, time + Math.max(0.002, p.attack));
    amp.gain.setTargetAtTime(g * p.sustain, time + p.attack, Math.max(0.02, p.decay / 3));

    this.voices.push({ note, oscs, filter, amp, releasedAt: null });
    // One-shot presets (sustain 0) self-release
    if (p.sustain === 0) this.noteOff(note, time + p.attack + p.decay);
  }

  noteOff(note: number, time = this.ctx.currentTime) {
    for (const v of this.voices) {
      if (v.note === note && v.releasedAt === null) this.releaseVoice(v, time);
    }
  }

  allOff(time = this.ctx.currentTime) {
    for (const v of this.voices) if (v.releasedAt === null) this.releaseVoice(v, time);
  }

  private releaseVoice(v: Voice, time: number) {
    const rel = Math.max(0.03, this.preset.release * this.releaseScale);
    v.releasedAt = time;
    v.amp.gain.cancelScheduledValues(time);
    v.amp.gain.setTargetAtTime(0, time, rel / 4);
    const stopAt = time + rel + 0.3;
    for (const o of v.oscs) o.stop(stopAt);
    setTimeoutSafe(this.ctx, stopAt, () => {
      v.amp.disconnect();
      this.voices = this.voices.filter((x) => x !== v);
    });
  }

  private steal(time: number) {
    const v = this.voices.shift();
    if (v && v.releasedAt === null) this.releaseVoice(v, time);
  }
}

export function midiToFreq(note: number): number {
  return 440 * Math.pow(2, (note - 69) / 12);
}

/** setTimeout keyed to audio time; in OfflineAudioContext cleanup is skipped (GC handles it). */
function setTimeoutSafe(ctx: BaseAudioContext, atTime: number, fn: () => void) {
  if (typeof window === 'undefined' || !(ctx instanceof AudioContext)) return;
  const ms = Math.max(0, (atTime - ctx.currentTime) * 1000 + 50);
  window.setTimeout(fn, ms);
}
