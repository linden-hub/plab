// TAPE mode — Chompi-inspired audio looper.
// Records the live bus (everything you play) and optionally the mic through an
// AudioWorklet that slices sample-accurately at bar-quantized punch times.
// Layers overdub with decay (old layers fade), varispeed incl. reverse, and
// keys can replay the loop repitched chromatically (Jammi-style).

export interface LoopLayer {
  buffer: AudioBuffer;
  gain: GainNode;
  level: number;        // authoritative gain value (AudioParam.value doesn't track ramps)
  phaseOffset: number;  // loop phase (sec) this buffer's first sample was recorded at
  source: AudioBufferSourceNode | null;
}

const WORKLET_SRC = `
class PlabRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.startT = -1; this.endT = -1; this.chunks = [];
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.cmd === 'arm') { this.startT = m.start; this.endT = m.end; this.chunks = []; }
      if (m.cmd === 'setEnd') { if (this.startT >= 0) this.endT = m.end; }
      if (m.cmd === 'cancel') { this.startT = -1; this.chunks = []; }
    };
  }
  process(inputs) {
    if (this.startT < 0) return true;
    const n = 128, sr = sampleRate;
    const t0 = currentTime, t1 = t0 + n / sr;
    if (t1 <= this.startT) return true;
    if (t0 >= this.endT) { this.flush(); return true; }
    const input = inputs[0];
    const l = (input && input[0]) ? input[0] : new Float32Array(n);
    const r = (input && input[1]) ? input[1] : l;
    const from = Math.max(0, Math.round((this.startT - t0) * sr));
    const to = Math.min(n, Math.round((this.endT - t0) * sr));
    if (to > from) this.chunks.push([l.slice(from, to), r.slice(from, to)]);
    if (t1 >= this.endT) this.flush();
    return true;
  }
  flush() {
    this.port.postMessage({ done: true, chunks: this.chunks, start: this.startT, end: this.endT });
    this.startT = -1; this.chunks = [];
  }
}
registerProcessor('plab-recorder', PlabRecorder);
`;

export class Looper {
  layers: LoopLayer[] = [];
  loopDur = 0;              // seconds at speed 1 (0 = no loop yet)
  speed = 1;                // -2..2, negative = reverse
  recState: 'idle' | 'armed' | 'recording' = 'idle';
  /** Called on state changes so the UI can re-render. */
  onChange: () => void = () => {};

  private node!: AudioWorkletNode;
  private micSource: MediaStreamAudioSourceNode | null = null;
  micEnabled = false;

  // Tape phase tracking: position (sec into loop) = phase0 + (t - phaseTime) * speed
  private phase0 = 0;
  private phaseTime = 0;

  private mixCache: AudioBuffer | null = null;

  /** Safety cap for an open-ended first recording. */
  static readonly MAX_RECORD_SEC = 120;

  constructor(
    private ctx: AudioContext,
    private recordTapIn: AudioNode,   // live instruments bus (tap)
    private loopOut: AudioNode,       // where loop playback goes (engine.loopIn)
  ) {}

  async init() {
    const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
    await this.ctx.audioWorklet.addModule(url);
    this.node = new AudioWorkletNode(this.ctx, 'plab-recorder', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    this.recordTapIn.connect(this.node);
    this.node.port.onmessage = (e) => {
      if (e.data.done) this.commit(e.data.chunks as [Float32Array, Float32Array][], e.data.start, e.data.end);
    };
  }

  async enableMic(): Promise<boolean> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      this.micSource = this.ctx.createMediaStreamSource(stream);
      this.micSource.connect(this.node); // record-only, never monitored (no feedback)
      this.micEnabled = true;
      this.onChange();
      return true;
    } catch {
      return false;
    }
  }

  disableMic() {
    this.micSource?.disconnect();
    this.micSource?.mediaStream.getTracks().forEach((t) => t.stop());
    this.micSource = null;
    this.micEnabled = false;
    this.onChange();
  }

  /**
   * Chompi-style free-form recording: starts NOW, no bar grid.
   * - No loop yet: open-ended — stopRecord() (or the safety cap) sets the
   *   length, and that exact span becomes the loop, playing immediately.
   * - Loop exists: overdub punches in immediately, auto-stops after one loop
   *   length (stopRecord() earlier leaves a shorter, silence-padded layer).
   */
  record() {
    if (this.recState !== 'idle') return;
    const start = this.ctx.currentTime + 0.03;
    const end = this.loopDur === 0
      ? start + Looper.MAX_RECORD_SEC
      : start + this.loopDur;
    this.node.port.postMessage({ cmd: 'arm', start, end });
    this.recState = 'recording';
    this.onChange();
  }

  /** Punch out — the worklet slices sample-accurately at this moment. */
  stopRecord() {
    if (this.recState !== 'recording') return;
    this.node.port.postMessage({ cmd: 'setEnd', end: this.ctx.currentTime });
  }

  cancelRecord() {
    this.node.port.postMessage({ cmd: 'cancel' });
    this.recState = 'idle';
    this.onChange();
  }

  private commit(chunks: [Float32Array, Float32Array][], startT: number, endT: number) {
    const total = chunks.reduce((n, c) => n + c[0].length, 0);
    const isFirst = this.loopDur === 0;
    const sr = this.ctx.sampleRate;
    // Accidental taps make useless sub-150ms loops — discard them.
    if (total < 512 || (isFirst && total < sr * 0.15)) {
      this.recState = 'idle';
      this.onChange();
      return;
    }
    // Overdubs are padded with silence to exactly one loop so every layer tiles.
    const len = isFirst ? total : Math.round(this.loopDur * sr);
    const buf = this.ctx.createBuffer(2, len, sr);
    const L = buf.getChannelData(0), R = buf.getChannelData(1);
    let off = 0;
    for (const [l, r] of chunks) {
      const n = Math.min(l.length, len - off);
      if (n <= 0) break;
      L.set(l.subarray(0, n), off);
      R.set(r.subarray(0, n), off);
      off += n;
    }

    let phaseOffset = 0;
    if (isFirst) {
      this.loopDur = buf.duration;
      this.phase0 = 0;          // loop phase 0 = the moment recording started
      this.phaseTime = endT;    // ...which comes around again right at punch-out
    } else {
      phaseOffset = this.phaseAt(startT);
    }

    // Overdub decay: every existing layer steps back as a new one lands.
    const decay = this.decayAmount;
    for (const layer of this.layers) {
      layer.level *= decay;
      layer.gain.gain.setTargetAtTime(layer.level, this.ctx.currentTime, 0.05);
    }

    const gain = this.ctx.createGain();
    gain.connect(this.loopOut);
    const layer: LoopLayer = { buffer: buf, gain, level: 1, phaseOffset, source: null };
    this.layers.push(layer);
    this.startLayer(layer, Math.max(this.ctx.currentTime + 0.02, endT));

    this.mixCache = null;
    this.recState = 'idle';
    this.onChange();
  }

  decayAmount = 0.85;

  private startLayer(layer: LoopLayer, at: number) {
    layer.source?.stop();
    const src = this.ctx.createBufferSource();
    src.buffer = this.speed < 0 ? reversed(this.ctx, layer.buffer) : layer.buffer;
    src.loop = true;
    src.playbackRate.value = Math.max(0.05, Math.abs(this.speed));
    const dur = layer.buffer.duration;
    // position inside THIS buffer = loop phase minus where this layer punched in
    let offset = (((this.phaseAt(at) - layer.phaseOffset) % dur) + dur) % dur;
    if (this.speed < 0) offset = dur - offset;
    src.connect(layer.gain);
    src.start(at, Math.max(0, Math.min(offset, dur - 0.001)));
    layer.source = src;
  }

  private phaseAt(t: number): number {
    if (this.loopDur === 0) return 0;
    const raw = this.phase0 + (t - this.phaseTime) * this.speed;
    return ((raw % this.loopDur) + this.loopDur) % this.loopDur;
  }

  nextLoopBoundary(): number {
    const now = this.ctx.currentTime + 0.05;
    if (this.loopDur === 0) return now;
    const sp = Math.abs(this.speed) < 0.05 ? 1 : Math.abs(this.speed);
    const remaining = this.speed >= 0
      ? (this.loopDur - this.phaseAt(now)) / sp
      : this.phaseAt(now) / sp;
    return now + remaining;
  }

  setSpeed(v: number) {
    if (Math.abs(v) < 0.05) v = v < 0 ? -0.05 : 0.05;
    const t = this.ctx.currentTime + 0.03;
    this.phase0 = this.phaseAt(t);
    this.phaseTime = t;
    this.speed = v;
    for (const layer of this.layers) this.startLayer(layer, t);
    this.onChange();
  }

  /** Undo: drop the most recent layer. */
  popLayer() {
    const l = this.layers.pop();
    if (!l) return;
    l.source?.stop();
    l.gain.disconnect();
    if (this.layers.length === 0) this.loopDur = 0;
    this.mixCache = null;
    this.onChange();
  }

  clear() {
    for (const layer of this.layers) { layer.source?.stop(); layer.gain.disconnect(); }
    this.layers = [];
    this.loopDur = 0;
    this.mixCache = null;
    this.recState = 'idle';
    this.onChange();
  }

  /** Flattened loop (all layers × current gains) — for Jammi keys + WAV export. */
  mixdown(): AudioBuffer | null {
    if (this.layers.length === 0) return null;
    if (this.mixCache) return this.mixCache;
    const len = Math.round(this.loopDur * this.ctx.sampleRate);
    const out = this.ctx.createBuffer(2, len, this.ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const o = out.getChannelData(ch);
      for (const layer of this.layers) {
        const g = layer.level;
        const d = layer.buffer.getChannelData(Math.min(ch, layer.buffer.numberOfChannels - 1));
        const shift = Math.round(layer.phaseOffset * this.ctx.sampleRate);
        const n = Math.min(len, d.length);
        for (let i = 0; i < n; i++) o[(i + shift) % len] += d[i] * g;
      }
    }
    this.mixCache = out;
    return out;
  }

  /** Jammi: play the loop repitched from a key (C4 = original pitch). */
  playPitched(note: number, vel: number, at: number): AudioBufferSourceNode | null {
    const mix = this.mixdown();
    if (!mix) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = mix;
    src.playbackRate.value = Math.pow(2, (note - 60) / 12);
    const g = this.ctx.createGain();
    g.gain.value = 0.9 * vel;
    src.connect(g).connect(this.loopOut);
    src.start(at);
    return src;
  }

  /** Restore layers from a saved session. */
  restore(buffers: AudioBuffer[], gains: number[], phaseOffsets: number[], loopDur: number) {
    this.clear();
    if (!buffers.length) return;
    this.loopDur = loopDur;
    this.phase0 = 0;
    this.phaseTime = this.ctx.currentTime + 0.1;
    for (let i = 0; i < buffers.length; i++) {
      const gain = this.ctx.createGain();
      gain.gain.value = gains[i] ?? 1;
      gain.connect(this.loopOut);
      const layer: LoopLayer = {
        buffer: buffers[i],
        gain,
        level: gains[i] ?? 1,
        phaseOffset: phaseOffsets[i] ?? 0,
        source: null,
      };
      this.layers.push(layer);
      this.startLayer(layer, this.phaseTime);
    }
    this.onChange();
  }
}

function reversed(ctx: BaseAudioContext, buf: AudioBuffer): AudioBuffer {
  const out = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const s = buf.getChannelData(ch);
    const d = out.getChannelData(ch);
    for (let i = 0; i < s.length; i++) d[i] = s[s.length - 1 - i];
  }
  return out;
}
