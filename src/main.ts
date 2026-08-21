// PLAYLAB — boot + wiring. One harmonic brain, one clock, one global tape,
// four keyboards (what the 25 keys ARE): synth, chord, jammi, drums.

import './style.css';
import { Store, type AppState, type Keyboard, NUM_STEPS, TRACK_NAMES } from './state';
import { AudioEngine } from './audio/engine';
import { Clock } from './sequencer/clock';
import { Sequencer, BASS_TRACK } from './sequencer/sequencer';
import { ChordMode } from './modes/chord';
import { Looper } from './looper/looper';
import { JammiSampler } from './audio/jammi';
import { PolySynth, PRESETS } from './audio/synth';
import { MidiManager } from './midi/midi';
import { MINILAB3, padIndex, knobIndex, faderIndex, dawKnobIndex, dawFaderIndex, relDelta, VPOT_FIRST_CC, VPOT_LAST_CC, vpotDelta, padColorSysex, oledTextSysex } from './midi/minilab3';
import { SessionManager } from './persist/session';
import { encodeWav, download, renderPattern } from './export/wav';
import { exportMidi } from './export/midi';
import { snapToScale } from './theory/harmony';
import { UI } from './ui/ui';

const app = document.getElementById('app')!;

// K7 ARP speeds, slow → fast, in clock steps (16ths) per arp note.
const ARP_RATES = [8, 6, 4, 3, 2, 1];
const ARP_LABELS = ['1/2', '1/4·', '1/4', '8th·', '8th', '16th'];
const arpIndex = (rate: number) => Math.max(0, ARP_RATES.indexOf(rate));

// Browsers require a user gesture before audio — a friendly front door.
const overlay = document.createElement('div');
overlay.className = 'overlay';
overlay.innerHTML = `
  <h1>PLAY<em>LAB</em></h1>
  <p>a music &amp; sound-design playground for your MiniLab&nbsp;3.<br>
  four keyboards, chords you can't get wrong, and a tape that eats everything.</p>
`;
const startBtn = document.createElement('button');
startBtn.className = 'primary';
startBtn.textContent = 'press start';
overlay.appendChild(startBtn);
document.body.appendChild(overlay);

startBtn.onclick = () => boot().catch((e) => {
  console.error(e);
  alert('boot failed: ' + e);
});

async function boot() {
  overlay.remove();

  const engine = new AudioEngine();
  await engine.resume();

  const store = new Store();
  const clock = new Clock(engine.ctx);
  const seq = new Sequencer(store, clock, engine.ctx, engine.sum);
  const chord = new ChordMode(store, clock, engine.ctx, engine.sum);
  const lead = new PolySynth(engine.ctx, engine.sum, PRESETS.warm, 10);
  const looper = new Looper(engine.ctx, engine.recordTap, engine.loopIn);
  await looper.init();
  const jammi = new JammiSampler(engine.ctx, engine.loopIn);
  const midi = new MidiManager();
  const session = new SessionManager(engine.ctx, looper, jammi);

  // ---- restore last session ----
  const saved = session.loadAutosaveState();
  if (saved) store.patch(saved);
  await session.loadAutosaveAudio();
  applyAudioParams(store.state);

  let selTrack = 0;
  const held = new Set<number>();
  let shiftHeld = false;         // MiniLab Shift button (CC 27, DAW mode)
  let jammiRecording = false;    // current take is destined for the JAMMI keys

  // Knob remapping (MIDI-learn): click a K-box, turn a knob to bind it.
  // Keyed by source port + CC; survives reloads.
  let knobRemap: Record<string, number> = {};
  try { knobRemap = JSON.parse(localStorage.getItem('plab.knobmap.v1') ?? '{}'); } catch { /* fresh */ }
  let learnTarget: number | null = null;

  looper.onJammiTake = (buf) => {
    jammi.setSample(buf, 'mic take');
    jammiRecording = false;
    ui.toast('take is on the JAMMI keys');
    ui.update();
    void session.autosaveAudio();
  };

  // ---- UI ----
  const ui = new UI({
    state: () => store.state,
    noteOn, noteOff,
    padHit: (i, vel) => padHit(i, vel),
    padRelease: (i) => padRelease(i),
    setKeyboard,
    togglePlay, toggleRec: () => store.patch({ recording: !store.state.recording }),
    patch: (p) => store.patch(p),
    toggleCell(track, step, shift) {
      if (track < 0) { store.touch('grid'); return; }
      const s = store.state;
      if (track === BASS_TRACK && shift) {
        s.bassSteps[step] = ((s.bassSteps[step] + 2) % 8) - 1; // -1,0..6 cycle
        s.grid[track][step].on = s.bassSteps[step] >= -1;
      } else {
        s.grid[track][step].on = !s.grid[track][step].on;
      }
      selTrack = track;
      store.touch('grid');
    },
    selectTrack: (i) => { selTrack = i; store.touch('grid'); },
    selectedTrack: () => selTrack,
    playhead: () => (store.state.playing ? seq.playhead : -1),
    tapeRecordStart: () => tapeRecordStart(),
    tapeRecordStop: () => { if (!jammiRecording) looper.stopRecord(); },
    tapeUndo: () => looper.popLayer(),
    tapeClear: () => looper.clear(),
    tapeInfo: () => ({
      layers: looper.layers.length,
      recState: looper.recState,
      speed: looper.speed,
      hasLoop: looper.loopDur > 0,
      loopSec: looper.loopDur,
    }),
    toggleMic() {
      if (looper.micEnabled) looper.disableMic();
      else looper.enableMic().then((ok) => { if (!ok) ui.toast('mic permission denied'); });
    },
    micOn: () => looper.micEnabled,
    jammiUseTape() {
      jammi.setSample(null, 'tape');
      ui.toast('JAMMI keys play the tape');
      ui.update();
    },
    jammiLoadFile(f) {
      jammi.loadFile(f).then((ok) => {
        ui.toast(ok ? `"${jammi.sourceName}" is on the JAMMI keys` : 'could not decode that file');
        ui.update();
        if (ok) void session.autosaveAudio();
      });
    },
    jammiRecordStart: () => jammiRecordStart(),
    jammiRecordStop: () => { if (jammiRecording) looper.stopRecord(); },
    jammiSource: () => jammi.sourceName,
    jammiRecording: () => jammiRecording,
    midiStatus: () => ({ connected: midi.connected, name: midi.deviceName }),
    exportLoopWav() {
      const mix = looper.mixdown();
      if (!mix) { ui.toast('no loops on the tape yet'); return; }
      download(encodeWav(mix), `playlab-tape-${stamp()}.wav`);
      ui.toast('tape.wav exported — drop it on a REAPER track');
    },
    async exportBeatWav() {
      ui.toast('rendering pattern…');
      const buf = await renderPattern(store.state, 2);
      download(encodeWav(buf), `playlab-beat-${stamp()}.wav`);
      ui.toast('beat.wav exported (2 bars, dry)');
    },
    exportMidiFile() {
      download(exportMidi(store.state, chord.perf, 1), `playlab-${stamp()}.mid`);
      ui.toast('MIDI exported — grid + chord performance');
    },
    saveSession() {
      const name = window.prompt('save session as:', 'jam-' + stamp());
      if (!name) return;
      session.saveSlot(name, store.state).then(() => ui.toast(`saved "${name}"`));
    },
    loadSession() {
      const slots = session.listSlots();
      if (!slots.length) { ui.toast('no saved sessions yet'); return; }
      const name = window.prompt(`load which session?\n${slots.join(', ')}`, slots[slots.length - 1]);
      if (!name) return;
      session.loadSlot(name).then((s) => {
        if (!s) { ui.toast(`no session named "${name}"`); return; }
        if (store.state.playing) togglePlay();
        store.patch(s);
        applyAudioParams(store.state);
        ui.toast(`loaded "${name}"`);
      });
    },
    knobLabels: () => knobReadout(store.state),
    learnKnob(i) {
      learnTarget = learnTarget === i ? null : i;
      ui.toast(learnTarget === null ? 'learn cancelled' : `turn a knob on the MiniLab to bind it to K${i + 1}`);
      ui.update();
    },
    learning: () => learnTarget,
    currentChordLabel: () => chord.current?.label ?? null,
    currentChordDegree: () => chord.current?.degree ?? null,
    heldNotes: () => held,
  }, app);

  // ---- store side effects ----
  store.subscribe((s, changed) => {
    if (changed.has('keyboard')) stepAccum.fill(0);
    if (changed.has('bpm')) clock.bpm = s.bpm;
    if (changed.has('swing')) clock.swing = s.swing;
    if (changed.has('vibe')) engine.setVibe(s.vibe);
    if (changed.has('delaySend')) engine.setDelaySend(s.delaySend);
    if (changed.has('reverbSend')) engine.setReverbSend(s.reverbSend);
    if (changed.has('masterVolume')) engine.setMasterVolume(s.masterVolume);
    if (changed.has('bpm')) engine.setDelayTime(60 / s.bpm * 0.75); // dotted 8th
    if (changed.has('tapeSpeed')) looper.setSpeed(s.tapeSpeed);
    if (changed.has('overdubDecay')) looper.decayAmount = s.overdubDecay;
    if (changed.has('loopVolume')) engine.setLoopVolume(s.loopVolume);
    if (changed.has('brightness') || changed.has('release')) chord.applyMacros();
    if (changed.has('synthPreset')) lead.preset = { ...PRESETS[s.synthPreset] };
    if (changed.has('keyboard')) syncHardware(s);
    session.scheduleAutosave(s);
    ui.update();
  });

  function applyAudioParams(s: AppState) {
    clock.bpm = s.bpm;
    clock.swing = s.swing;
    engine.setVibe(s.vibe);
    engine.setDelaySend(s.delaySend);
    engine.setReverbSend(s.reverbSend);
    engine.setMasterVolume(s.masterVolume);
    engine.setDelayTime(60 / s.bpm * 0.75);
    looper.decayAmount = s.overdubDecay;
    engine.setLoopVolume(s.loopVolume);
    lead.preset = { ...PRESETS[s.synthPreset] };
    chord.applyMacros();
  }

  // loop audio autosave when the layer count settles
  let lastLayerCount = looper.layers.length;
  looper.onChange = () => {
    ui.update();
    if (looper.recState === 'idle' && looper.layers.length !== lastLayerCount) {
      lastLayerCount = looper.layers.length;
      void session.autosaveAudio();
    }
  };

  // ---- transport ----
  function togglePlay() {
    const playing = !store.state.playing;
    if (playing) clock.start();
    else { clock.stop(); seq.stopped(); chord.clearPerf(); }
    store.patch({ playing });
  }

  // ---- global tape record (hold-to-record) ----
  function tapeRecordStart() {
    if (looper.recState !== 'idle') return;
    looper.decayAmount = store.state.overdubDecay;
    looper.record('tape');
  }

  function jammiRecordStart() {
    if (looper.recState !== 'idle') return;
    jammiRecording = true;
    looper.record('jammi');
    ui.update();
  }

  // ---- note routing: the keyboard decides what the 25 keys ARE ----
  function noteOn(note: number, vel: number) {
    if (held.has(note)) return;
    held.add(note);
    const s = store.state;
    const now = engine.now;
    switch (s.keyboard) {
      case 'synth': lead.noteOn(note, vel, now); break;
      case 'chord': chord.keyOn(note, vel, now); break;
      case 'jammi':
        if (!jammi.noteOn(note, vel, now, looper.mixdown())) ui.toast('nothing to play — record the tape or load a sample');
        break;
      case 'drums': {
        const n = snapToScale(note - 24, s.keyRoot, s.scale);
        seq.bass.noteOn(n, vel, now);
        break;
      }
    }
  }

  function noteOff(note: number) {
    if (!held.delete(note)) return;
    const s = store.state;
    const now = engine.now;
    switch (s.keyboard) {
      case 'synth': lead.noteOff(note, now); break;
      case 'chord': chord.keyOff(note, now); break;
      case 'jammi': jammi.noteOff(note, now); break;
      case 'drums': seq.bass.noteOff(snapToScale(note - 24, store.state.keyRoot, store.state.scale), now); break;
    }
  }

  // ---- pads: always the drum kit (record into the grid when armed) ----
  function padHit(i: number, vel: number) {
    ui.padFlash(i);
    seq.padHit(i, vel, engine.now);
  }

  function padRelease(_i: number) { /* drums are one-shots; nothing to release */ }

  // ---- keyboard switching + hardware feedback ----
  const KEYBOARDS: Keyboard[] = ['synth', 'chord', 'jammi', 'drums'];

  function setKeyboard(k: Keyboard) {
    const now = engine.now;
    chord.allOff(now);
    lead.allOff(now);
    jammi.allOff(now);
    held.clear();
    store.patch({ keyboard: k });
  }

  const KB_COLORS: Record<Keyboard, [number, number, number]> = {
    synth: [127, 90, 0],
    chord: [64, 32, 127],
    jammi: [0, 110, 90],
    drums: [127, 30, 8],
  };

  function syncHardware(s: AppState) {
    const [r, g, b] = KB_COLORS[s.keyboard];
    for (let i = 0; i < 8; i++) midi.sendSysex(padColorSysex(i, r, g, b));
    const line2: Record<Keyboard, string> = {
      synth: 'plain keys',
      chord: 'keys = chords',
      jammi: 'keys = sample',
      drums: 'pads = drums',
    };
    midi.sendSysex(oledTextSysex(`PLAYLAB ${s.keyboard.toUpperCase()}`, line2[s.keyboard]));
  }

  // ---- knob/fader mapping per keyboard ----
  // Each knob is a normalized get/set pair, so absolute encoders (Arturia
  // mode) and relative encoders (DAW mode) drive the same parameters.
  // `steps` marks quantized params: relative turns move one position per
  // detent instead of accumulating fractions that rounding would swallow.
  interface KnobDef { get(): number; set(v: number): void; steps?: number }

  function knobDefs(): KnobDef[] {
    const s = store.state;
    const P = (p: Partial<AppState>) => store.patch(p);
    const common: Record<string, KnobDef> = {
      vibe: { get: () => s.vibe, set: (v) => P({ vibe: v }) },
      delay: { get: () => s.delaySend, set: (v) => P({ delaySend: v }) },
      reverb: { get: () => s.reverbSend, set: (v) => P({ reverbSend: v }) },
      speed: { get: () => (s.tapeSpeed + 2) / 4, set: (v) => P({ tapeSpeed: Math.round((v * 4 - 2) * 20) / 20 }) },
      fade: { get: () => (s.overdubDecay - 0.3) / 0.7, set: (v) => P({ overdubDecay: 0.3 + v * 0.7 }) },
      loopVol: { get: () => s.loopVolume, set: (v) => P({ loopVolume: v }) },
      bright: { get: () => s.brightness, set: (v) => P({ brightness: v }) },
      release: { get: () => s.release, set: (v) => P({ release: v }) },
    };
    if (s.keyboard === 'chord') {
      return [
        { get: () => s.extension / 2, set: (v) => P({ extension: Math.round(v * 2) }), steps: 3 },
        { get: () => s.spread, set: (v) => P({ spread: v }) },
        { get: () => s.inversion / 3, set: (v) => P({ inversion: Math.round(v * 3) }), steps: 4 },
        { get: () => (s.chordOctave / 12 + 2) / 4, set: (v) => P({ chordOctave: (Math.round(v * 4) - 2) * 12 }), steps: 5 },
        common.bright,
        common.release,
        { get: () => arpIndex(s.arpRate) / (ARP_RATES.length - 1), set: (v) => P({ arpRate: ARP_RATES[Math.round(v * (ARP_RATES.length - 1))] }), steps: ARP_RATES.length },
        common.vibe,
      ];
    }
    if (s.keyboard === 'drums') {
      const tp = () => s.trackParams[selTrack];
      return [
        { get: () => (s.bpm - 60) / 120, set: (v) => P({ bpm: Math.round(60 + v * 120) }) },
        { get: () => s.swing, set: (v) => P({ swing: v }) },
        { get: () => tp().volume, set: (v) => { tp().volume = v; store.touch('grid'); } },
        { get: () => (tp().pitch + 12) / 24, set: (v) => { tp().pitch = Math.round(v * 24) - 12; store.touch('grid'); }, steps: 25 },
        { get: () => tp().decay, set: (v) => { tp().decay = v; store.touch('grid'); } },
        common.vibe,
        common.delay,
        common.reverb,
      ];
    }
    if (s.keyboard === 'jammi') {
      return [common.speed, common.fade, common.loopVol, common.vibe, common.delay, common.reverb,
        { get: () => s.masterVolume, set: (v) => P({ masterVolume: v }) }, common.bright];
    }
    // synth
    return [common.bright, common.release, common.vibe, common.delay, common.reverb,
      common.loopVol, common.speed, common.fade];
  }

  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  function onKnobAbs(i: number, value: number) { knobDefs()[i]?.set(value / 127); }

  // Relative tuning: ~0.6% per detent for continuous params (fast spins get a
  // capped speed bonus from the Mackie magnitude). Quantized params spread
  // their whole range over ~one full physical rotation: detents accumulate in
  // step units outside the param itself, because set() rounds to the nearest
  // position and would swallow sub-position fractions.
  const REL_STEP = 0.006;
  const DETENTS_PER_TURN = 48;
  const stepAccum = new Array<number>(8).fill(0);
  function onKnobRel(i: number, delta: number) {
    const d = knobDefs()[i];
    if (!d || delta === 0) return;
    ui.knobFlash(i);
    const capped = Math.sign(delta) * Math.min(4, Math.abs(delta));
    if (d.steps) {
      stepAccum[i] += capped * (d.steps - 1) / DETENTS_PER_TURN;
      const move = Math.trunc(stepAccum[i]);
      if (move !== 0) {
        stepAccum[i] -= move;
        const idx = Math.round(d.get() * (d.steps - 1)) + move;
        d.set(Math.max(0, Math.min(d.steps - 1, idx)) / (d.steps - 1));
      }
    } else {
      d.set(clamp01(d.get() + capped * REL_STEP));
    }
  }

  /** Route any encoder-ish CC through the remap table; true if consumed. */
  function routeKnobCC(source: string, cc: number, value: number, kind: 'abs' | 'rel', defaultSlot: number): boolean {
    const key = `${source}:${cc}`;
    if (learnTarget !== null) {
      knobRemap[key] = learnTarget;
      localStorage.setItem('plab.knobmap.v1', JSON.stringify(knobRemap));
      ui.toast(`bound that knob to K${learnTarget + 1}`);
      learnTarget = null;
      ui.update();
      return true;
    }
    const slot = knobRemap[key] ?? defaultSlot;
    if (kind === 'abs') onKnobAbs(slot, value);
    else onKnobRel(slot, source === 'mcu' ? vpotDelta(value) : relDelta(value));
    return true;
  }

  function applyFader(f: number, v: number) {
    if (f === 0) store.patch({ masterVolume: v });
    if (f === 1) store.patch({ delaySend: v });
    if (f === 2) store.patch({ reverbSend: v });
    if (f === 3) store.patch({ swing: v });
  }

  // ---- main encoder: hands-free navigation ----
  // The big knob sends CC 28/29 (turn) + 118/119 (click) with the device in
  // DAW mode (Shift+Pad3); in factory Arturia mode it only browses Analog Lab.
  function mainTurn(delta: number) {
    if (delta === 0) return;
    const next = KEYBOARDS[(KEYBOARDS.indexOf(store.state.keyboard) + (delta > 0 ? 1 : -1) + 4) % 4];
    setKeyboard(next);
  }
  function mainShiftTurn(delta: number) {
    if (delta === 0) return;
    const s = store.state;
    const d = delta > 0 ? 1 : -1;
    if (s.keyboard === 'chord' || s.keyboard === 'synth') {
      store.patch({ keyRoot: (s.keyRoot + d + 12) % 12 });
    } else if (s.keyboard === 'drums') {
      selTrack = Math.max(0, Math.min(7, selTrack + d));
      store.touch('grid');
      ui.toast(`track: ${TRACK_NAMES[selTrack]}`);
    } else {
      store.patch({ tapeSpeed: Math.max(-2, Math.min(2, Math.round((s.tapeSpeed + d * 0.05) * 20) / 20)) });
    }
  }

  function knobReadout(s: AppState): { label: string; value: string; norm: number }[] {
    const common = {
      vibe: { label: 'VIBE', value: pct(s.vibe), norm: s.vibe },
      delay: { label: 'DELAY', value: pct(s.delaySend), norm: s.delaySend },
      reverb: { label: 'REVERB', value: pct(s.reverbSend), norm: s.reverbSend },
      speed: { label: 'SPEED', value: '×' + s.tapeSpeed.toFixed(2), norm: (s.tapeSpeed + 2) / 4 },
      fade: { label: 'FADE', value: pct(s.overdubDecay), norm: (s.overdubDecay - 0.3) / 0.7 },
      loopVol: { label: 'LOOP VOL', value: pct(s.loopVolume), norm: s.loopVolume },
      bright: { label: 'BRIGHT', value: pct(s.brightness), norm: s.brightness },
      release: { label: 'RELEASE', value: pct(s.release), norm: s.release },
      master: { label: 'MASTER', value: pct(s.masterVolume), norm: s.masterVolume },
    };
    if (s.keyboard === 'chord') {
      return [
        { label: 'EXT', value: ['triad', '7th', '9th'][s.extension] ?? 'triad', norm: s.extension / 2 },
        { label: 'SPREAD', value: pct(s.spread), norm: s.spread },
        { label: 'INV', value: String(s.inversion), norm: s.inversion / 3 },
        { label: 'OCT', value: String(s.chordOctave / 12), norm: (s.chordOctave / 12 + 2) / 4 },
        common.bright,
        common.release,
        { label: 'ARP', value: ARP_LABELS[arpIndex(s.arpRate)], norm: arpIndex(s.arpRate) / (ARP_RATES.length - 1) },
        common.vibe,
      ];
    }
    if (s.keyboard === 'drums') {
      const p = s.trackParams[selTrack];
      const t = TRACK_NAMES[selTrack];
      return [
        { label: 'BPM', value: String(s.bpm), norm: (s.bpm - 60) / 120 },
        { label: 'SWING', value: pct(s.swing), norm: s.swing },
        { label: `${t} VOL`, value: pct(p.volume), norm: p.volume },
        { label: `${t} PITCH`, value: (p.pitch >= 0 ? '+' : '') + p.pitch, norm: (p.pitch + 12) / 24 },
        { label: `${t} DECAY`, value: pct(p.decay), norm: p.decay },
        common.vibe,
        common.delay,
        common.reverb,
      ];
    }
    if (s.keyboard === 'jammi') {
      return [common.speed, common.fade, common.loopVol, common.vibe, common.delay, common.reverb, common.master, common.bright];
    }
    return [common.bright, common.release, common.vibe, common.delay, common.reverb, common.loopVol, common.speed, common.fade];
  }

  // ---- MIDI wiring ----
  midi.onStatus(() => { ui.update(); syncHardware(store.state); });
  midi.onMessage((e) => {
    // MCU/HUI port: only the DAW-mode encoders (Mackie V-Pots) matter here.
    // Its note messages are Mackie button states, NOT piano keys — drop them.
    if (e.source === 'mcu') {
      if (e.type === 'cc' && e.a >= VPOT_FIRST_CC && e.a <= VPOT_LAST_CC) {
        routeKnobCC('mcu', e.a, e.b, 'rel', e.a - VPOT_FIRST_CC);
      } else if (e.type === 'cc') {
        console.debug('[plab] unmapped MCU CC', e.channel, e.a, e.b);
      }
      return;
    }
    if (e.type === 'noteon') {
      if (e.channel === MINILAB3.padChannel) {
        const i = padIndex(e.a);
        if (i >= 0) padHit(i, e.b / 127);
        return;
      }
      noteOn(e.a, e.b / 127);
    } else if (e.type === 'noteoff') {
      if (e.channel === MINILAB3.padChannel) {
        const i = padIndex(e.a);
        if (i >= 0) padRelease(i);
        return;
      }
      noteOff(e.a);
    } else if (e.type === 'cc') {
      // The device's HOLD button engages a hardware mode of its own — ignore it.
      if (e.a === MINILAB3.sustainCC) return;
      if (e.a === MINILAB3.shiftCC) { shiftHeld = e.b > 63; return; }
      const k = knobIndex(e.a);
      if (k >= 0) { routeKnobCC('main', e.a, e.b, 'abs', k); return; }
      const f = faderIndex(e.a);
      if (f >= 0) { applyFader(f, e.b / 127); return; }
      // DAW-mode surface (Shift+Pad3 on the device)
      const dk = dawKnobIndex(e.a);
      if (dk >= 0) { routeKnobCC('main', e.a, e.b, 'rel', dk); return; }
      const df = dawFaderIndex(e.a);
      if (df >= 0) { applyFader(df, e.b / 127); return; }
      // main encoder — CLICK-AND-HOLD records a loop (press starts, release
      // stops); Shift+click is play/stop.
      if (e.a === MINILAB3.mainTurnCC) { mainTurn(relDelta(e.b)); return; }
      if (e.a === MINILAB3.mainShiftTurnCC) { mainShiftTurn(relDelta(e.b)); return; }
      if (e.a === MINILAB3.mainClickCC) {
        if (e.b > 63) tapeRecordStart();
        else if (!jammiRecording) looper.stopRecord();
        return;
      }
      if (e.a === MINILAB3.mainShiftClickCC) { if (e.b > 63) togglePlay(); return; }
      if (e.a === MINILAB3.modCC) { store.patch({ vibe: e.b / 127 }); return; }
      console.debug('[plab] unmapped CC', e.source, e.channel, e.a, e.b);
    }
  });
  await midi.init();

  // ---- computer-keyboard fallback ----
  const KEYMAP: Record<string, number> = {
    a: 60, w: 61, s: 62, e: 63, d: 64, f: 65, t: 66, g: 67,
    y: 68, h: 69, u: 70, j: 71, k: 72, o: 73, l: 74, p: 75, ';': 76,
  };
  let kbOctave = 0;
  window.addEventListener('keydown', (ev) => {
    if (ev.repeat) return;
    if ((ev.target as HTMLElement)?.tagName === 'INPUT' || (ev.target as HTMLElement)?.tagName === 'SELECT') return;
    const key = ev.key.toLowerCase();
    if (ev.shiftKey) {
      if (key === 'r') { store.patch({ recording: !store.state.recording }); return; }
      if (key === 't') { tapeRecordStart(); return; } // hold ⇧T; keyup stops
    }
    if (key in KEYMAP && !ev.shiftKey) { noteOn(KEYMAP[key] + kbOctave * 12, 0.9); return; }
    if (key >= '1' && key <= '8') { padHit(Number(key) - 1, 1); return; }
    if (key === ' ') { ev.preventDefault(); togglePlay(); return; }
    if (key === 'z') { kbOctave = Math.max(-2, kbOctave - 1); ui.toast(`octave ${kbOctave}`); return; }
    if (key === 'x') { kbOctave = Math.min(2, kbOctave + 1); ui.toast(`octave ${kbOctave}`); return; }
    if (key === 'arrowright' || key === 'arrowleft') {
      const d = key === 'arrowright' ? 1 : -1;
      setKeyboard(KEYBOARDS[(KEYBOARDS.indexOf(store.state.keyboard) + d + 4) % 4]);
    }
  });
  window.addEventListener('keyup', (ev) => {
    const key = ev.key.toLowerCase();
    if (key === 't' && looper.recState === 'recording' && !jammiRecording) { looper.stopRecord(); return; }
    if (key in KEYMAP) noteOff(KEYMAP[key] + kbOctave * 12);
    if (key >= '1' && key <= '8') padRelease(Number(key) - 1);
  });

  ui.update();
  syncHardware(store.state);
}

function pct(v: number) { return Math.round(v * 100) + '%'; }
function stamp() {
  const d = new Date();
  return `${d.getMonth() + 1}${d.getDate()}-${d.getHours()}${String(d.getMinutes()).padStart(2, '0')}`;
}
