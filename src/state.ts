// Central app state — a single serializable object + subscribe/patch store.
// Everything here is what a session save captures (audio buffers live in IndexedDB).

import type { ScaleName } from './theory/harmony';

export type Mode = 'chord' | 'beat' | 'tape';

export interface Step { on: boolean; vel: number }

export const NUM_TRACKS = 8;
export const NUM_STEPS = 16;

export const TRACK_NAMES = ['KICK', 'SNARE', 'HAT', 'OPEN', 'CLAP', 'TOM', 'PERC', 'BASS'] as const;

export interface TrackParams {
  volume: number;   // 0..1
  pitch: number;    // -12..+12 semitones
  decay: number;    // 0..1
}

export interface AppState {
  mode: Mode;

  // Harmonic brain (shared by all modes)
  keyRoot: number;          // 0..11
  scale: ScaleName;

  // Transport
  bpm: number;
  swing: number;            // 0..1
  playing: boolean;
  recording: boolean;       // live-record pads into the grid

  // Chord mode
  extension: number;        // 0..2 — Nopia extensions dial
  spread: number;           // 0..1
  inversion: number;        // 0..3
  chordOctave: number;      // semitone offset, multiples of 12
  brightness: number;       // 0..1 filter macro
  release: number;          // 0..1
  bassOn: boolean;
  arpOn: boolean;
  arpRate: number;          // steps per 16th: 1 = 16ths, 2 = 8ths...

  // Beat mode
  grid: Step[][];           // [track][step]
  bassSteps: number[];      // scale degree per step (-1 = inherit root)
  trackParams: TrackParams[];

  // Tape mode
  tapeBars: number;         // 1|2|4|8
  tapeSpeed: number;        // -2..2 (negative = reverse)
  overdubDecay: number;     // 0..1 — how much old layers fade per overdub
  jammi: boolean;           // true = keys repitch the loop; false = keys play chords over it

  // Master FX
  vibe: number;
  delaySend: number;
  reverbSend: number;
  masterVolume: number;
}

export function defaultState(): AppState {
  return {
    mode: 'chord',
    keyRoot: 0,
    scale: 'major',
    bpm: 100,
    swing: 0,
    playing: false,
    recording: false,
    extension: 0,
    spread: 0.2,
    inversion: 0,
    chordOctave: 0,
    brightness: 0.6,
    release: 0.4,
    bassOn: true,
    arpOn: false,
    arpRate: 1,
    grid: Array.from({ length: NUM_TRACKS }, () =>
      Array.from({ length: NUM_STEPS }, () => ({ on: false, vel: 1 })),
    ),
    bassSteps: Array.from({ length: NUM_STEPS }, () => -1),
    trackParams: Array.from({ length: NUM_TRACKS }, () => ({ volume: 0.8, pitch: 0, decay: 0.5 })),
    tapeBars: 2,
    tapeSpeed: 1,
    overdubDecay: 0.85,
    jammi: false,
    vibe: 0.15,
    delaySend: 0.1,
    reverbSend: 0.15,
    masterVolume: 0.85,
  };
}

type Listener = (s: AppState, changed: Set<keyof AppState>) => void;

export class Store {
  state: AppState;
  private listeners: Listener[] = [];

  constructor(initial?: Partial<AppState>) {
    this.state = { ...defaultState(), ...initial };
  }

  patch(p: Partial<AppState>) {
    const changed = new Set<keyof AppState>();
    for (const k of Object.keys(p) as (keyof AppState)[]) {
      if (this.state[k] !== p[k]) changed.add(k);
    }
    Object.assign(this.state, p);
    if (changed.size) this.emit(changed);
  }

  /** For mutations inside nested arrays (grid, trackParams) — notify manually. */
  touch(...keys: (keyof AppState)[]) {
    this.emit(new Set(keys));
  }

  private emit(changed: Set<keyof AppState>) {
    for (const l of this.listeners) l(this.state, changed);
  }

  subscribe(fn: Listener) {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter((f) => f !== fn); };
  }
}
