// CHORD mode — the Nopia-inspired harmony instrument.
// One harmonic brain: key + scale + played degree → chord data that drives
// the chord synth, the auto-bass, and the clock-synced arp. Also captures a
// performance log (in beats) for Standard MIDI File export to the DAW.

import type { Store } from '../state';
import type { Clock } from '../sequencer/clock';
import { PolySynth, PRESETS } from '../audio/synth';
import { buildChord, keyToDegree, type ChordSpec } from '../theory/harmony';

export interface PerfNote { note: number; vel: number; startBeat: number; endBeat: number | null; channel: number }

export class ChordMode {
  readonly chords: PolySynth;
  readonly bassSynth: PolySynth;
  readonly arpSynth: PolySynth;

  /** Currently sounding chord per held source key (MIDI note that triggered it). */
  private held = new Map<number, ChordSpec>();
  current: ChordSpec | null = null;

  private arpIndex = 0;

  /** Chord performance log for MIDI export (beats relative to transport start). */
  perf: PerfNote[] = [];
  private perfOpen = new Map<string, PerfNote>();

  // Free-running arp scheduler for when the transport is stopped — the arp
  // must not depend on the step grid being in use.
  private arpNextTime = 0;
  private freeStep = 0;

  constructor(
    private store: Store,
    private clock: Clock,
    private ctx: AudioContext,
    dest: AudioNode,
  ) {
    this.chords = new PolySynth(ctx, dest, PRESETS.warm, 16);
    this.bassSynth = new PolySynth(ctx, dest, PRESETS.bass, 2);
    this.arpSynth = new PolySynth(ctx, dest, PRESETS.pluck, 4);
    clock.onStep((step, time) => this.onStep(step, time));
    window.setInterval(() => this.freeTick(), 25);
  }

  /** Lookahead arp scheduling while the transport clock is NOT running. */
  private freeTick() {
    if (this.clock.running) { this.arpNextTime = 0; return; }
    const s = this.store.state;
    if (!s.arpOn || this.held.size === 0) { this.arpNextTime = 0; return; }
    const now = this.ctx.currentTime;
    if (this.arpNextTime === 0 || this.arpNextTime < now - 0.2) {
      this.arpNextTime = now + 0.02;
      this.freeStep = 0;
    }
    while (this.arpNextTime < now + 0.12) {
      this.scheduleArp(this.freeStep++, this.arpNextTime);
      this.arpNextTime += this.clock.stepDur;
    }
  }

  keyOn(midiNote: number, vel: number, now: number) {
    const s = this.store.state;
    const { degree, extraExtension, octave } = keyToDegree(midiNote);
    const spec = buildChord(s.keyRoot, s.scale, degree, {
      extension: Math.min(2, s.extension + (extraExtension ? 1 : 0)),
      spread: s.spread,
      inversion: s.inversion,
      octave: s.chordOctave + octave * 12,
    });
    this.held.set(midiNote, spec);
    this.current = spec;
    this.applyMacros();

    for (const n of spec.notes) {
      this.chords.noteOn(n, vel, now);
      this.logOn(n, vel, 0);
    }
    if (s.bassOn) {
      this.bassSynth.noteOn(spec.bass, Math.min(1, vel + 0.1), now);
      this.logOn(spec.bass, vel, 1);
    }
  }

  keyOff(midiNote: number, now: number) {
    const spec = this.held.get(midiNote);
    if (!spec) return;
    this.held.delete(midiNote);
    for (const n of spec.notes) {
      this.chords.noteOff(n, now);
      this.logOff(n, 0);
    }
    this.bassSynth.noteOff(spec.bass, now);
    this.logOff(spec.bass, 1);
    if (this.held.size === 0) this.arpIndex = 0;
    else this.current = [...this.held.values()].pop()!;
  }

  allOff(now: number) {
    this.held.clear();
    this.chords.allOff(now);
    this.bassSynth.allOff(now);
    this.arpSynth.allOff(now);
    for (const [key] of this.perfOpen) this.logOff(Number(key.split(':')[0]), Number(key.split(':')[1]));
  }

  private onStep(step: number, time: number) {
    this.scheduleArp(step, time);
  }

  private scheduleArp(step: number, time: number) {
    const s = this.store.state;
    if (!s.arpOn || this.held.size === 0) return;
    if (step % Math.max(1, Math.round(s.arpRate)) !== 0) return;
    const spec = this.current;
    if (!spec) return;
    const note = spec.notes[this.arpIndex % spec.notes.length] + 12;
    this.arpIndex++;
    this.arpSynth.noteOn(note, 0.8, time);
    this.arpSynth.noteOff(note, time + this.clock.stepDur * 0.8);
  }

  applyMacros() {
    const s = this.store.state;
    this.chords.brightness = 0.25 + s.brightness * 1.5;
    this.chords.releaseScale = 0.3 + s.release * 3;
    this.arpSynth.brightness = 0.25 + s.brightness * 1.5;
  }

  // --- performance capture (beats, only while transport runs) ---

  private nowBeats(): number | null {
    if (!this.clock.running) return null;
    return this.clock.currentStep / 4;
  }

  private logOn(note: number, vel: number, channel: number) {
    const b = this.nowBeats();
    if (b === null) return;
    const rec: PerfNote = { note, vel, startBeat: b, endBeat: null, channel };
    this.perf.push(rec);
    this.perfOpen.set(`${note}:${channel}`, rec);
  }

  private logOff(note: number, channel: number) {
    const key = `${note}:${channel}`;
    const rec = this.perfOpen.get(key);
    if (rec) {
      const b = this.nowBeats();
      rec.endBeat = b ?? rec.startBeat + 1;
      this.perfOpen.delete(key);
    }
  }

  clearPerf() { this.perf = []; this.perfOpen.clear(); }
}
