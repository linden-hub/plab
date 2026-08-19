// Standard MIDI File (format 1) writer — hand REAPER the pattern and the
// chord performance so its own instruments can play Playlab's ideas.

import type { AppState } from '../state';
import { NUM_STEPS } from '../state';
import { degreeToMidi } from '../theory/harmony';
import { BASS_TRACK } from '../sequencer/sequencer';
import type { PerfNote } from '../modes/chord';

const TPQ = 480; // ticks per quarter note

// General MIDI drum notes for our 7 drum tracks (channel 10)
const GM_DRUM = [36, 38, 42, 46, 39, 45, 37];

interface Ev { tick: number; bytes: number[] }

function vlq(n: number): number[] {
  const out = [n & 0x7f];
  n >>= 7;
  while (n > 0) { out.unshift((n & 0x7f) | 0x80); n >>= 7; }
  return out;
}

function trackBytes(events: Ev[], name: string): number[] {
  events.sort((a, b) => a.tick - b.tick);
  const data: number[] = [];
  // track name meta
  data.push(0x00, 0xff, 0x03, name.length, ...[...name].map((c) => c.charCodeAt(0)));
  let last = 0;
  for (const e of events) {
    data.push(...vlq(Math.max(0, e.tick - last)), ...e.bytes);
    last = e.tick;
  }
  data.push(0x00, 0xff, 0x2f, 0x00); // end of track
  return data;
}

function chunk(tag: string, body: number[]): number[] {
  const len = body.length;
  return [
    ...[...tag].map((c) => c.charCodeAt(0)),
    (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff,
    ...body,
  ];
}

export function exportMidi(state: AppState, perf: PerfNote[], patternBars = 1): Blob {
  const tracks: number[][] = [];

  // Tempo track
  const uspq = Math.round(60_000_000 / state.bpm);
  tracks.push(trackBytes([
    { tick: 0, bytes: [0xff, 0x51, 0x03, (uspq >> 16) & 0xff, (uspq >> 8) & 0xff, uspq & 0xff] },
    { tick: 0, bytes: [0xff, 0x58, 0x04, 4, 2, 24, 8] }, // 4/4
  ], 'PLAYLAB tempo'));

  // Drum + bass pattern from the grid (16 steps = 1 bar of 16ths)
  const drumEv: Ev[] = [];
  const bassEv: Ev[] = [];
  const ticksPerStep = TPQ / 4;
  for (let bar = 0; bar < patternBars; bar++) {
    for (let step = 0; step < NUM_STEPS; step++) {
      const tick = (bar * NUM_STEPS + step) * ticksPerStep;
      for (let tr = 0; tr < state.grid.length; tr++) {
        const cell = state.grid[tr][step];
        if (!cell.on) continue;
        const vel = Math.max(1, Math.min(127, Math.round(cell.vel * 110)));
        if (tr === BASS_TRACK) {
          const degree = state.bassSteps[step] >= 0 ? state.bassSteps[step] : 0;
          const note = degreeToMidi(state.keyRoot, state.scale, degree, 36) + state.trackParams[tr].pitch;
          bassEv.push({ tick, bytes: [0x91, note, vel] });
          bassEv.push({ tick: tick + ticksPerStep, bytes: [0x81, note, 0] });
        } else {
          const note = GM_DRUM[tr];
          drumEv.push({ tick, bytes: [0x99, note, vel] });
          drumEv.push({ tick: tick + Math.floor(ticksPerStep / 2), bytes: [0x89, note, 0] });
        }
      }
    }
  }
  if (drumEv.length) tracks.push(trackBytes(drumEv, 'PLAYLAB drums'));
  if (bassEv.length) tracks.push(trackBytes(bassEv, 'PLAYLAB bass'));

  // Chord performance (channel 1) + its bass layer (channel 2), beats → ticks
  if (perf.length) {
    const chordEv: Ev[] = [];
    for (const n of perf) {
      const startTick = Math.round(n.startBeat * TPQ);
      const endTick = Math.round((n.endBeat ?? n.startBeat + 1) * TPQ);
      const ch = n.channel === 1 ? 1 : 0;
      const vel = Math.max(1, Math.min(127, Math.round(n.vel * 110)));
      chordEv.push({ tick: startTick, bytes: [0x90 | ch, n.note, vel] });
      chordEv.push({ tick: Math.max(startTick + 1, endTick), bytes: [0x80 | ch, n.note, 0] });
    }
    tracks.push(trackBytes(chordEv, 'PLAYLAB chords'));
  }

  const header = chunk('MThd', [0, 1, 0, tracks.length, (TPQ >> 8) & 0xff, TPQ & 0xff]);
  const bytes = [...header, ...tracks.flatMap((t) => chunk('MTrk', t))];
  return new Blob([new Uint8Array(bytes)], { type: 'audio/midi' });
}
