// Arturia MiniLab 3 — device map (factory Arturia mode defaults) + SysEx
// helpers for pad RGB and the OLED, per Arturia's manual and the
// community-reverse-engineered SysEx (Janiczek gist / Ableton remote script).

export const MINILAB3 = {
  keyChannel: 1,          // 25 keys, Note On/Off
  padChannel: 10,         // 8 pads, Bank A
  padNotes: [36, 37, 38, 39, 40, 41, 42, 43],       // Bank A: C1–G1
  padNotesB: [44, 45, 46, 47, 48, 49, 50, 51],      // Bank B (Shift+Pad2)
  knobCCs: [74, 71, 76, 77, 93, 18, 19, 16],        // encoders, absolute 0–127, ch 1
  faderCCs: [82, 83, 85, 17],                        // 4 faders, absolute, ch 1
  modCC: 1,               // mod strip (latching)
  sustainCC: 64,          // Hold button

  // DAW mode (Shift+Pad3): encoders turn relative (binary offset), different CCs.
  dawKnobCCs: [86, 87, 89, 90, 110, 111, 116, 117],
  dawFaderCCs: [14, 15, 30, 31],

  // Main encoder (big knob) — sends these in DAW mode; ch 1.
  mainTurnCC: 28,         // relative binary offset: 65.. = +, 63.. = −
  mainShiftTurnCC: 29,
  mainClickCC: 118,       // 127 press, 0 release
  mainShiftClickCC: 119,
  shiftCC: 27,            // Shift button state
} satisfies Record<string, number | number[]>;

export function padIndex(note: number): number {
  let i = MINILAB3.padNotes.indexOf(note);
  if (i >= 0) return i;
  i = MINILAB3.padNotesB.indexOf(note);
  return i; // -1 if not a pad
}

export function knobIndex(cc: number): number { return MINILAB3.knobCCs.indexOf(cc); }
export function faderIndex(cc: number): number { return MINILAB3.faderCCs.indexOf(cc); }
export function dawKnobIndex(cc: number): number { return MINILAB3.dawKnobCCs.indexOf(cc); }
export function dawFaderIndex(cc: number): number { return MINILAB3.dawFaderCCs.indexOf(cc); }

/** Relative binary-offset encoder value → signed delta (64 = no move). */
export function relDelta(value: number): number { return value - 64; }

// In DAW mode the 8 encoders speak Mackie on the MCU/HUI port: V-Pots,
// CC 16–23, relative two's-complement-ish (bit 6 set = counterclockwise).
export const VPOT_FIRST_CC = 16;
export const VPOT_LAST_CC = 23;

export function vpotDelta(value: number): number {
  const mag = value & 0x3f;
  return (value & 0x40) ? -mag : mag;
}

// ---- SysEx (all messages use the Arturia header F0 00 20 6B 7F 42 … F7) ----

const HDR = [0xf0, 0x00, 0x20, 0x6b, 0x7f, 0x42];

/**
 * Set a pad's RGB (persistent Bank-A slots 0x34–0x3B). r/g/b are 0–127.
 * Mode-context byte: 01 = Arturia mode (the device's factory default).
 */
export function padColorSysex(pad: number, r: number, g: number, b: number): number[] {
  const id = 0x34 + Math.max(0, Math.min(7, pad));
  return [...HDR, 0x02, 0x01, 0x16, id, r & 0x7f, g & 0x7f, b & 0x7f, 0xf7];
}

/** Two plain text lines on the OLED. */
export function oledTextSysex(line1: string, line2: string): number[] {
  const ascii = (s: string) => [...s.slice(0, 16)].map((c) => c.charCodeAt(0) & 0x7f);
  return [...HDR, 0x04, 0x02, 0x60, 0x01, ...ascii(line1), 0x00, 0x02, ...ascii(line2), 0xf7];
}
