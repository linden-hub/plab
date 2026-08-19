// WAV export for the DAW handoff (REAPER): 16-bit PCM stereo.
// Loops export bar-exact so they tile cleanly as loop items.

import type { AppState } from '../state';
import { NUM_STEPS } from '../state';
import { DrumKit } from '../audio/drums';
import { PolySynth, PRESETS } from '../audio/synth';
import { degreeToMidi } from '../theory/harmony';
import { BASS_TRACK } from '../sequencer/sequencer';

export function encodeWav(buffer: AudioBuffer): Blob {
  const numCh = Math.min(2, buffer.numberOfChannels);
  const sr = buffer.sampleRate;
  const len = buffer.length;
  const bytesPerSample = 2;
  const dataSize = len * numCh * bytesPerSample;
  const ab = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(ab);

  const wstr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  wstr(0, 'RIFF');
  dv.setUint32(4, 36 + dataSize, true);
  wstr(8, 'WAVE');
  wstr(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);            // PCM
  dv.setUint16(22, numCh, true);
  dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * numCh * bytesPerSample, true);
  dv.setUint16(32, numCh * bytesPerSample, true);
  dv.setUint16(34, 16, true);
  wstr(36, 'data');
  dv.setUint32(40, dataSize, true);

  const chans = Array.from({ length: numCh }, (_, i) => buffer.getChannelData(i));
  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      const x = Math.max(-1, Math.min(1, chans[ch][i]));
      dv.setInt16(off, x < 0 ? x * 0x8000 : x * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Render the current step pattern offline (dry — FX are a performance thing;
 * dry stems sit better in a DAW) for `bars` bars at the session tempo.
 */
export async function renderPattern(state: AppState, bars = 2, sampleRate = 48000): Promise<AudioBuffer> {
  const stepDur = 60 / state.bpm / 4;
  const totalDur = stepDur * NUM_STEPS * bars;
  const ctx = new OfflineAudioContext(2, Math.ceil(totalDur * sampleRate), sampleRate);
  const master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(ctx.destination);

  const kit = new DrumKit(ctx, master);
  const bass = new PolySynth(ctx, master, PRESETS.bass, 4);

  for (let bar = 0; bar < bars; bar++) {
    for (let step = 0; step < NUM_STEPS; step++) {
      let t = (bar * NUM_STEPS + step) * stepDur;
      if (step % 2 === 1) t += state.swing * stepDur * 0.45;
      for (let tr = 0; tr < state.grid.length; tr++) {
        const cell = state.grid[tr][step];
        if (!cell.on) continue;
        const p = state.trackParams[tr];
        if (tr === BASS_TRACK) {
          const degree = state.bassSteps[step] >= 0 ? state.bassSteps[step] : 0;
          const note = degreeToMidi(state.keyRoot, state.scale, degree, 36) + p.pitch;
          bass.noteOn(note, cell.vel * p.volume, t);
          bass.noteOff(note, t + stepDur * (0.5 + p.decay));
        } else {
          kit.trigger(tr, t, cell.vel, p);
        }
      }
    }
  }
  return ctx.startRendering();
}
