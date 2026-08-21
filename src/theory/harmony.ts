// Harmony engine — Nopia-inspired: play by scale degree, not by note name.
// Every chord decision (quality, extensions, voicing) is derived from a key
// center + scale, so the player can't land outside the harmony.

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export type ScaleName = 'major' | 'minor' | 'dorian' | 'mixolydian' | 'lydian' | 'phrygian';

export const SCALES: Record<ScaleName, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
};

export const SCALE_LIST = Object.keys(SCALES) as ScaleName[];

export interface ChordSpec {
  degree: number;        // 0..6
  rootMidi: number;      // MIDI note of chord root
  notes: number[];       // voiced chord notes (MIDI)
  bass: number;          // suggested bass note (MIDI)
  label: string;         // e.g. "Dm7 (ii)"
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

// Functional-harmony families: chords in the same family substitute for each
// other, so the keyboard color-codes them as one group. HOME rests (tonic:
// I III VI), AWAY steps out (subdominant: II IV), PULL leans back toward home
// (dominant: V VII).
export type ChordFunction = 'home' | 'away' | 'pull';
export const DEGREE_FUNCTION: ChordFunction[] = ['home', 'away', 'home', 'away', 'pull', 'home', 'pull'];

export interface VoicingOptions {
  extension: number;     // 0 = triad, 1 = add diatonic 7th, 2 = add 7th + 9th (Nopia extensions dial)
  spread: number;        // 0..1 — 0 = close voicing, 1 = wide open voicing
  inversion: number;     // 0..3
  octave: number;        // base offset in semitones (multiples of 12)
}

/** Build a diatonic chord on a scale degree, voiced per options. */
export function buildChord(
  keyRoot: number,          // 0..11 pitch class of the key
  scale: ScaleName,
  degree: number,           // 0..6
  opts: VoicingOptions,
): ChordSpec {
  const iv = SCALES[scale];
  const deg = ((degree % 7) + 7) % 7;

  // Pitch (relative to keyRoot octave 0) of the d-th scale tone.
  const tone = (d: number) => {
    const oct = Math.floor(d / 7);
    return iv[((d % 7) + 7) % 7] + oct * 12;
  };

  // Stack diatonic thirds above the degree: 1-3-5, then 7, then 9.
  const ext = Math.max(0, Math.min(2, Math.round(opts.extension)));
  const stackSize = 3 + ext;
  let pitches: number[] = [];
  for (let i = 0; i < stackSize; i++) pitches.push(tone(deg + i * 2));

  // Inversion: rotate lowest note(s) up an octave.
  const inv = ((opts.inversion % stackSize) + stackSize) % stackSize;
  for (let i = 0; i < inv; i++) {
    const low = pitches.shift()!;
    pitches.push(low + 12);
  }

  // Spread: progressively open the voicing — drop-2, then lift the top note.
  if (opts.spread > 0.33 && pitches.length >= 3) {
    pitches[pitches.length - 2] -= 12;
  }
  if (opts.spread > 0.75) {
    pitches[pitches.length - 1] += 12;
  }
  pitches.sort((a, b) => a - b);

  const base = 60 + keyRoot + opts.octave; // key root near C4
  const rootMidi = base + tone(deg);
  const notes = pitches.map((p) => base + p);
  const bass = rootMidi - 12;

  // Label: root name + quality from the actual intervals.
  const third = mod12(tone(deg + 2) - tone(deg));
  const fifth = mod12(tone(deg + 4) - tone(deg));
  const seventh = ext >= 1 ? mod12(tone(deg + 6) - tone(deg)) : null;
  let quality = third === 3 ? 'm' : '';
  if (fifth === 6) quality = 'dim';
  let extLabel = '';
  if (ext === 1) extLabel = seventh === 11 ? 'maj7' : '7';
  if (ext === 2) extLabel = seventh === 11 ? 'maj9' : '9';
  if (quality === 'dim' && seventh === 10) { quality = 'm'; extLabel = ext === 2 ? '9b5' : '7b5'; }

  const rootName = NOTE_NAMES[mod12(keyRoot + iv[deg])];
  const roman = third === 3 || fifth === 6 ? ROMAN[deg].toLowerCase() : ROMAN[deg];
  return { degree: deg, rootMidi, notes, bass, label: `${rootName}${quality}${extLabel} · ${roman}${fifth === 6 ? '°' : ''}` };
}

function mod12(n: number) { return ((n % 12) + 12) % 12; }

/**
 * Map a played MIDI key to a scale degree, Nopia-style:
 * white keys C..B choose degrees I..VII; black keys play the same degree as
 * the white key below with one extra extension level (a taste of the dial).
 */
export function keyToDegree(midiNote: number): { degree: number; extraExtension: boolean; octave: number } {
  const pc = midiNote % 12;
  const octave = Math.floor(midiNote / 12) - 5; // relative to the C4 octave
  const WHITE: Record<number, number> = { 0: 0, 2: 1, 4: 2, 5: 3, 7: 4, 9: 5, 11: 6 };
  if (pc in WHITE) return { degree: WHITE[pc], extraExtension: false, octave };
  const below: Record<number, number> = { 1: 0, 3: 1, 6: 3, 8: 4, 10: 5 };
  return { degree: below[pc], extraExtension: true, octave };
}

/** Quantize any MIDI note to the nearest note in the key/scale (for bass/lead layers). */
export function snapToScale(midiNote: number, keyRoot: number, scale: ScaleName): number {
  const iv = SCALES[scale];
  const pc = mod12(midiNote - keyRoot);
  let best = iv[0];
  let bestDist = 99;
  for (const s of iv) {
    const d = Math.min(Math.abs(pc - s), 12 - Math.abs(pc - s));
    if (d < bestDist) { bestDist = d; best = s; }
  }
  let delta = best - pc;
  if (delta > 6) delta -= 12;
  if (delta < -6) delta += 12;
  return midiNote + delta;
}

/** The n-th scale tone (degree, 0-based) as a MIDI note near a reference. */
export function degreeToMidi(keyRoot: number, scale: ScaleName, degree: number, baseOctaveMidi = 48): number {
  const iv = SCALES[scale];
  const oct = Math.floor(degree / 7);
  return baseOctaveMidi + keyRoot + iv[((degree % 7) + 7) % 7] + oct * 12;
}
