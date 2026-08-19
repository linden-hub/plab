// Synthesized drum kit — no sample assets, everything sculpted from
// oscillators and noise. Works against any BaseAudioContext so patterns can
// render offline for WAV export.

export interface DrumParams {
  volume: number;  // 0..1
  pitch: number;   // semitone offset
  decay: number;   // 0..1 scales the tail
}

const DEFAULTS: DrumParams = { volume: 0.8, pitch: 0, decay: 0.5 };

export class DrumKit {
  private noiseBuf: AudioBuffer;

  constructor(private ctx: BaseAudioContext, private dest: AudioNode) {
    // 1s of white noise, reused by every noise-based voice
    const len = ctx.sampleRate;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  /** Trigger track index 0..6 (7 = bass handled by PolySynth elsewhere). */
  trigger(track: number, time: number, vel = 1, p: DrumParams = DEFAULTS) {
    switch (track) {
      case 0: return this.kick(time, vel, p);
      case 1: return this.snare(time, vel, p);
      case 2: return this.hat(time, vel, p, false);
      case 3: return this.hat(time, vel, p, true);
      case 4: return this.clap(time, vel, p);
      case 5: return this.tom(time, vel, p);
      case 6: return this.perc(time, vel, p);
    }
  }

  private out(time: number, gain: number): GainNode {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, time);
    g.connect(this.dest);
    return g;
  }

  private noiseSource(time: number, dur: number): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = true;
    s.start(time);
    s.stop(time + dur + 0.05);
    return s;
  }

  private kick(time: number, vel: number, p: DrumParams) {
    const semi = Math.pow(2, p.pitch / 12);
    const dur = 0.15 + p.decay * 0.4;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(160 * semi, time);
    o.frequency.exponentialRampToValueAtTime(48 * semi, time + 0.08);
    const g = this.out(time, 0);
    g.gain.setValueAtTime(0.9 * vel * p.volume, time + 0.002);
    g.gain.exponentialRampToValueAtTime(0.001, time + dur);
    // click transient
    const click = this.noiseSource(time, 0.02);
    const cg = this.out(time, 0.25 * vel * p.volume);
    cg.gain.exponentialRampToValueAtTime(0.001, time + 0.02);
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 1200;
    click.connect(hp).connect(cg);
    o.connect(g);
    o.start(time); o.stop(time + dur + 0.1);
  }

  private snare(time: number, vel: number, p: DrumParams) {
    const dur = 0.08 + p.decay * 0.25;
    const noise = this.noiseSource(time, dur);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1800 * Math.pow(2, p.pitch / 12); bp.Q.value = 0.8;
    const ng = this.out(time, 0.7 * vel * p.volume);
    ng.gain.exponentialRampToValueAtTime(0.001, time + dur);
    noise.connect(bp).connect(ng);
    // body
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(220 * Math.pow(2, p.pitch / 12), time);
    o.frequency.exponentialRampToValueAtTime(150, time + 0.06);
    const og = this.out(time, 0.4 * vel * p.volume);
    og.gain.exponentialRampToValueAtTime(0.001, time + 0.1);
    o.connect(og); o.start(time); o.stop(time + 0.15);
  }

  private hat(time: number, vel: number, p: DrumParams, open: boolean) {
    const dur = open ? 0.18 + p.decay * 0.5 : 0.02 + p.decay * 0.08;
    const noise = this.noiseSource(time, dur);
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 7000 * Math.pow(2, p.pitch / 12);
    const g = this.out(time, (open ? 0.4 : 0.35) * vel * p.volume);
    g.gain.exponentialRampToValueAtTime(0.001, time + dur);
    noise.connect(hp).connect(g);
  }

  private clap(time: number, vel: number, p: DrumParams) {
    const dur = 0.1 + p.decay * 0.3;
    for (let i = 0; i < 3; i++) {
      const t = time + i * 0.012;
      const noise = this.noiseSource(t, 0.03);
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 1100 * Math.pow(2, p.pitch / 12); bp.Q.value = 1.5;
      const g = this.out(t, 0.5 * vel * p.volume);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
      noise.connect(bp).connect(g);
    }
    // tail
    const tail = this.noiseSource(time + 0.036, dur);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1100 * Math.pow(2, p.pitch / 12); bp.Q.value = 1.2;
    const tg = this.out(time + 0.036, 0.45 * vel * p.volume);
    tg.gain.exponentialRampToValueAtTime(0.001, time + 0.036 + dur);
    tail.connect(bp).connect(tg);
  }

  private tom(time: number, vel: number, p: DrumParams) {
    const dur = 0.15 + p.decay * 0.4;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    const f = 110 * Math.pow(2, p.pitch / 12);
    o.frequency.setValueAtTime(f * 1.5, time);
    o.frequency.exponentialRampToValueAtTime(f, time + 0.1);
    const g = this.out(time, 0.7 * vel * p.volume);
    g.gain.exponentialRampToValueAtTime(0.001, time + dur);
    o.connect(g); o.start(time); o.stop(time + dur + 0.1);
  }

  /** Zap/blip — a video-game-flavored percussive synth hit. */
  private perc(time: number, vel: number, p: DrumParams) {
    const dur = 0.06 + p.decay * 0.2;
    const o = this.ctx.createOscillator();
    o.type = 'square';
    const f = 880 * Math.pow(2, p.pitch / 12);
    o.frequency.setValueAtTime(f, time);
    o.frequency.exponentialRampToValueAtTime(f / 4, time + dur);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 4000;
    const g = this.out(time, 0.3 * vel * p.volume);
    g.gain.exponentialRampToValueAtTime(0.001, time + dur);
    o.connect(lp).connect(g); o.start(time); o.stop(time + dur + 0.05);
  }
}
