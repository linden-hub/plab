// TAPE mode — free-form layered looper.
// Every recording is its OWN loop: hold to record, release to close the take,
// and it immediately loops at exactly its own length, on top of every other
// layer. Layers of different lengths drift against each other on purpose
// (Frippertronics). Recording is sliced sample-accurately in an AudioWorklet.

export interface LoopLayer {
  buffer: AudioBuffer;
  gain: GainNode;
  level: number;      // authoritative gain value (AudioParam.value doesn't track ramps)
  source: AudioBufferSourceNode | null;
  // playback position tracking (pos = seconds into the *playing* buffer):
  phase0: number;
  phaseTime: number;
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
  speed = 1;                // -2..2, negative = reverse
  recState: 'idle' | 'recording' = 'idle';
  decayAmount = 0.85;       // older layers fade as new ones land
  /** Called on state changes so the UI can re-render. */
  onChange: () => void = () => {};

  private node!: AudioWorkletNode;
  private micSource: MediaStreamAudioSourceNode | null = null;
  micEnabled = false;
  private mixCache: AudioBuffer | null = null;

  /** Safety cap for a held recording. */
  static readonly MAX_RECORD_SEC = 120;
  static readonly MIN_TAKE_SEC = 0.15;

  constructor(
    private ctx: AudioContext,
    private recordTapIn: AudioNode,   // live instruments bus (tap)
    private loopOut: AudioNode,       // where loop playback goes (engine.loopIn)
  ) {}

  /** Longest layer, for display/export framing. 0 = empty tape. */
  get loopDur(): number {
    return this.layers.reduce((m, l) => Math.max(m, l.buffer.duration), 0);
  }

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
      if (e.data.done) this.commit(e.data.chunks as [Float32Array, Float32Array][], e.data.end);
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

  /** Hold-to-record: starts NOW, runs until stopRecord() (or the safety cap). */
  record() {
    if (this.recState !== 'idle') return;
    const start = this.ctx.currentTime + 0.03;
    this.node.port.postMessage({ cmd: 'arm', start, end: start + Looper.MAX_RECORD_SEC });
    this.recState = 'recording';
    this.onChange();
  }

  /** Release — the worklet slices sample-accurately at this moment. */
  stopRecord() {
    if (this.recState !== 'recording') return;
    this.node.port.postMessage({ cmd: 'setEnd', end: this.ctx.currentTime });
  }

  cancelRecord() {
    this.node.port.postMessage({ cmd: 'cancel' });
    this.recState = 'idle';
    this.onChange();
  }

  private commit(chunks: [Float32Array, Float32Array][], endT: number) {
    const total = chunks.reduce((n, c) => n + c[0].length, 0);
    const sr = this.ctx.sampleRate;
    // Accidental taps make useless sub-150ms loops — discard them.
    if (total < sr * Looper.MIN_TAKE_SEC) {
      this.recState = 'idle';
      this.onChange();
      return;
    }

    const buf = this.ctx.createBuffer(2, total, sr);
    const L = buf.getChannelData(0), R = buf.getChannelData(1);
    let off = 0;
    for (const [l, r] of chunks) { L.set(l, off); R.set(r, off); off += l.length; }

    // Frippertronics fade: every existing layer steps back as a new one lands.
    for (const layer of this.layers) {
      layer.level *= this.decayAmount;
      layer.gain.gain.setTargetAtTime(layer.level, this.ctx.currentTime, 0.05);
    }

    const gain = this.ctx.createGain();
    gain.connect(this.loopOut);
    const layer: LoopLayer = { buffer: buf, gain, level: 1, source: null, phase0: 0, phaseTime: endT };
    this.layers.push(layer);
    // the take starts looping the instant it closed, phase-continuous with itself
    this.startLayer(layer, Math.max(this.ctx.currentTime + 0.02, endT), 0);

    this.mixCache = null;
    this.recState = 'idle';
    this.onChange();
  }

  /** (Re)start a layer's looping source at position `pos` (sec into the playing buffer). */
  private startLayer(layer: LoopLayer, at: number, pos: number) {
    layer.source?.stop();
    const src = this.ctx.createBufferSource();
    src.buffer = this.speed < 0 ? reversed(this.ctx, layer.buffer) : layer.buffer;
    src.loop = true;
    src.playbackRate.value = Math.max(0.05, Math.abs(this.speed));
    src.connect(layer.gain);
    const dur = layer.buffer.duration;
    src.start(at, Math.max(0, Math.min(pos, dur - 0.001)));
    layer.source = src;
    layer.phase0 = pos;
    layer.phaseTime = at;
  }

  /** Position (sec) inside the layer's currently playing buffer. */
  private layerPos(layer: LoopLayer, t: number): number {
    const dur = layer.buffer.duration;
    const raw = layer.phase0 + (t - layer.phaseTime) * Math.max(0.05, Math.abs(this.speed));
    return ((raw % dur) + dur) % dur;
  }

  setSpeed(v: number) {
    if (Math.abs(v) < 0.05) v = v < 0 ? -0.05 : 0.05;
    const flip = (v < 0) !== (this.speed < 0);
    const t = this.ctx.currentTime + 0.03;
    for (const layer of this.layers) {
      const pos = this.layerPos(layer, t);
      layer.phase0 = pos;
      layer.phaseTime = t;
      if (flip || !layer.source) {
        this.speed = v; // startLayer reads direction from this
        this.startLayer(layer, t, layer.buffer.duration - pos);
      } else {
        layer.source.playbackRate.setValueAtTime(Math.max(0.05, Math.abs(v)), t);
      }
    }
    this.speed = v;
    this.onChange();
  }

  /** Undo: drop the most recent layer. */
  popLayer() {
    const l = this.layers.pop();
    if (!l) return;
    l.source?.stop();
    l.gain.disconnect();
    this.mixCache = null;
    this.onChange();
  }

  clear() {
    for (const layer of this.layers) { layer.source?.stop(); layer.gain.disconnect(); }
    this.layers = [];
    this.mixCache = null;
    this.recState = 'idle';
    this.onChange();
  }

  /**
   * Flattened tape (for Jammi keys + WAV export): as long as the longest
   * layer, with shorter layers tiled across it — one honest pass of the pool.
   */
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
        for (let i = 0; i < len; i++) o[i] += d[i % d.length] * g;
      }
    }
    this.mixCache = out;
    return out;
  }

  /** Jammi: play the flattened tape repitched from a key (C4 = original pitch). */
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

  /** Restore layers from a saved session — each spins up as its own loop. */
  restore(buffers: AudioBuffer[], gains: number[]) {
    this.clear();
    const t = this.ctx.currentTime + 0.1;
    for (let i = 0; i < buffers.length; i++) {
      const gain = this.ctx.createGain();
      gain.gain.value = gains[i] ?? 1;
      gain.connect(this.loopOut);
      const layer: LoopLayer = { buffer: buffers[i], gain, level: gains[i] ?? 1, source: null, phase0: 0, phaseTime: t };
      this.layers.push(layer);
      this.startLayer(layer, t, 0);
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
