// Beat-mode sequencer: reads the 16-step grid from the store and schedules
// drums + a scale-locked bass track. Also owns live pad-recording quantize.
// The grid is one M8-style "phrase" — the model deliberately leaves room for
// chains/song mode later.

import type { Store } from '../state';
import { NUM_STEPS } from '../state';
import type { Clock } from './clock';
import { DrumKit } from '../audio/drums';
import { PolySynth, PRESETS } from '../audio/synth';
import { degreeToMidi } from '../theory/harmony';

export const BASS_TRACK = 7;

export class Sequencer {
  readonly kit: DrumKit;
  readonly bass: PolySynth;
  /** UI playhead position, -1 when stopped. */
  playhead = -1;

  constructor(
    private store: Store,
    private clock: Clock,
    ctx: AudioContext,
    dest: AudioNode,
  ) {
    this.kit = new DrumKit(ctx, dest);
    this.bass = new PolySynth(ctx, dest, PRESETS.bass, 4);
    clock.onStep((step, time, dur) => this.onStep(step, time, dur));
  }

  private onStep(globalStep: number, time: number, dur: number) {
    const s = this.store.state;
    const step = globalStep % NUM_STEPS;
    this.playhead = step;

    for (let tr = 0; tr < s.grid.length; tr++) {
      const cell = s.grid[tr][step];
      if (!cell.on) continue;
      const p = s.trackParams[tr];
      if (tr === BASS_TRACK) {
        const degree = s.bassSteps[step] >= 0 ? s.bassSteps[step] : 0;
        const note = degreeToMidi(s.keyRoot, s.scale, degree, 36) + p.pitch;
        this.bass.noteOn(note, cell.vel * p.volume, time);
        this.bass.noteOff(note, time + dur * (0.5 + p.decay));
      } else {
        this.kit.trigger(tr, time, cell.vel, p);
      }
    }
  }

  /** Finger-drumming a pad: always sounds; if transport runs + record armed, writes the grid. */
  padHit(track: number, vel: number, now: number) {
    const s = this.store.state;
    const p = s.trackParams[track];
    if (track === BASS_TRACK) {
      const note = degreeToMidi(s.keyRoot, s.scale, 0, 36) + p.pitch;
      this.bass.noteOn(note, vel * p.volume, now);
      this.bass.noteOff(note, now + 0.25);
    } else {
      this.kit.trigger(track, now, vel, p);
    }
    if (s.playing && s.recording) {
      const step = this.clock.quantizeNow();
      s.grid[track][step] = { on: true, vel };
      this.store.touch('grid');
    }
  }

  stopped() {
    this.playhead = -1;
    this.bass.allOff();
  }
}
