// Master audio graph. Everything audible flows through: sum → tape (vibe) →
// delay → reverb → soft limiter → speakers. The looper taps the sum bus so
// loops capture the full processed performance.

export class AudioEngine {
  readonly ctx: AudioContext;
  readonly sum: GainNode;          // all live instruments connect here
  readonly recordTap: GainNode;    // looper records from here (live sum, pre-FX)
  readonly loopIn: GainNode;       // loop playback enters here (heard, FX'd, but NOT re-recorded)

  private delay: DelayNode;
  private delayFeedback: GainNode;
  private delaySend: GainNode;
  private reverbSend: GainNode;
  private convolver: ConvolverNode;

  // "vibe" — tape character: pitch wobble + gentle lowpass + saturation
  private wowDelay: DelayNode;
  private wowLfo: OscillatorNode;
  private wowDepth: GainNode;
  private vibeFilter: BiquadFilterNode;
  private saturator: WaveShaperNode;
  private vibeAmount = 0;

  private master: DynamicsCompressorNode;
  private masterGain: GainNode;

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    const c = this.ctx;

    this.sum = c.createGain();
    this.recordTap = c.createGain();
    this.sum.connect(this.recordTap);
    this.loopIn = c.createGain();

    // Tape stage
    this.wowDelay = c.createDelay(0.05);
    this.wowDelay.delayTime.value = 0.006;
    this.wowLfo = c.createOscillator();
    this.wowLfo.frequency.value = 1.7; // wow-ish rate
    this.wowDepth = c.createGain();
    this.wowDepth.gain.value = 0;
    this.wowLfo.connect(this.wowDepth).connect(this.wowDelay.delayTime);
    this.wowLfo.start();

    this.vibeFilter = c.createBiquadFilter();
    this.vibeFilter.type = 'lowpass';
    this.vibeFilter.frequency.value = 18000;
    this.saturator = c.createWaveShaper();
    this.saturator.curve = makeSaturationCurve(0);
    this.saturator.oversample = '2x';

    this.sum.connect(this.wowDelay).connect(this.vibeFilter).connect(this.saturator);
    this.loopIn.connect(this.wowDelay);

    // Delay send
    this.delay = c.createDelay(2);
    this.delay.delayTime.value = 0.375;
    this.delayFeedback = c.createGain();
    this.delayFeedback.gain.value = 0.35;
    this.delaySend = c.createGain();
    this.delaySend.gain.value = 0.0;
    const delayTone = c.createBiquadFilter();
    delayTone.type = 'lowpass';
    delayTone.frequency.value = 4000;
    this.saturator.connect(this.delaySend).connect(this.delay);
    this.delay.connect(delayTone).connect(this.delayFeedback).connect(this.delay);

    // Reverb send
    this.convolver = c.createConvolver();
    this.convolver.buffer = makeImpulse(c, 2.2, 2.5);
    this.reverbSend = c.createGain();
    this.reverbSend.gain.value = 0.12;
    this.saturator.connect(this.reverbSend).connect(this.convolver);

    // Master
    this.master = c.createDynamicsCompressor();
    this.master.threshold.value = -12;
    this.master.ratio.value = 4;
    this.masterGain = c.createGain();
    this.masterGain.gain.value = 0.85;

    this.saturator.connect(this.master);
    delayTone.connect(this.master);
    this.convolver.connect(this.master);
    this.master.connect(this.masterGain).connect(c.destination);
  }

  get now(): number {
    return this.ctx.currentTime;
  }

  async resume() {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  /** 0..1 — one knob that takes the sound from clean to warbly cassette. */
  setVibe(v: number) {
    this.vibeAmount = v;
    this.wowDepth.gain.setTargetAtTime(v * 0.0035, this.now, 0.05);
    this.wowLfo.frequency.setTargetAtTime(0.8 + v * 5.0, this.now, 0.1);
    this.vibeFilter.frequency.setTargetAtTime(18000 - v * 14500, this.now, 0.05);
    this.saturator.curve = makeSaturationCurve(v * 0.7);
  }

  getVibe() { return this.vibeAmount; }

  setDelaySend(v: number) { this.delaySend.gain.setTargetAtTime(v * 0.8, this.now, 0.03); }
  setDelayTime(seconds: number) { this.delay.delayTime.setTargetAtTime(Math.max(0.02, seconds), this.now, 0.1); }
  setReverbSend(v: number) { this.reverbSend.gain.setTargetAtTime(v * 0.9, this.now, 0.03); }
  setMasterVolume(v: number) { this.masterGain.gain.setTargetAtTime(v, this.now, 0.03); }
}

function makeSaturationCurve(amount: number) {
  const n = 1024;
  const curve = new Float32Array(n);
  const k = 1 + amount * 12;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  return curve;
}

/** Simple exponential-decay noise impulse response for the reverb. */
function makeImpulse(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}
