# PLAYLAB — notes for Claude

A browser music workstation prototype (Vite + TS + Web MIDI + Web Audio, zero runtime deps)
for the Arturia MiniLab 3, fusing Dirtywave M8 (step sequencer), Nopia (harmony), CHOMPI
(looper/sampler). Design thesis: approachable, fun, "state of play", aimed at video-game
sound design. Long-term: port to a portable hardware unit. Repo: github.com/linden-hub/plab.

## Architecture (current — post keyboards-restructure)

- **Global tape looper** (always on, `src/looper/looper.ts`): hold-to-record — every take is
  its OWN independent loop at exactly its own length; layers drift freely (no bar grid, no
  auto-stop, no shared loop length). Frippertronics fade on each new take, varispeed incl.
  reverse. Recording sliced sample-accurately in an AudioWorklet (`arm`/`setEnd` messages);
  takes <150ms discarded; 120s cap. Records `engine.recordTap` (live bus) + optional mic;
  loop playback re-enters FX via `engine.loopIn` so it's never re-recorded.
- **Four keyboards** (what the 25 keys ARE, `state.keyboard`): `synth` (plain keys,
  warm/pluck/bass presets), `chord` (Nopia degree-based harmony, `src/modes/chord.ts`),
  `jammi` (sampler keys, `src/audio/jammi.ts` — plays tape mixdown, loaded WAV, or mic take),
  `drums` (step grid, `src/sequencer/`). Pads ALWAYS finger-drum; transport only matters for
  the step grid. The arp free-runs its own scheduler when the transport is stopped.
- One store (`src/state.ts`), UI re-renders via `store.subscribe` + a rAF loop for playheads.
- Sessions: state JSON in localStorage, tape layers + jammi sample as Float32 in IndexedDB
  (`src/persist/session.ts`); autosave on change, named slots, resumes on boot.
- Exports (`src/export/`): tape mixdown WAV (longest layer, shorter tiled), offline-rendered
  pattern WAV, SMF with grid + chord performance — all for REAPER handoff.

## MiniLab 3 (user runs it in DAW mode — Shift+Pad3)

- Verified facts: keys ch1 (C3–C5 default, screen keyboard mirrors 25 keys); pads ch10 notes
  36–43; Arturia-mode knobs CC 74,71,76,77,93,18,19,16 absolute; faders 82,83,85,17.
- **DAW mode splits ports**: the 8 encoders speak Mackie V-Pots (CC 16–23, relative, bit 6 =
  CCW) on the **MCU/HUI port** — `MidiManager` listens on ALL device ports and tags source;
  MCU note messages are Mackie buttons, never piano keys. DAW faders CC 14,15,30,31.
- **Big knob** (DAW mode, ch1): turn CC28 = switch keyboard; **click CC118 held =
  record-loop (press starts, release stops)**; shift+click CC119 = play/stop; shift+turn
  CC29 = key root / track / tape speed. Shift state = CC27. The device's HOLD button (CC64)
  engages a hardware mode — the app must IGNORE it.
- Do NOT send the DAW-mode SysEx handshake (flips encoder CCs). Pad RGB / OLED SysEx formats
  in `src/midi/minilab3.ts`.
- Knob MIDI-learn: click a K-box then turn a knob; bindings in localStorage `plab.knobmap.v1`.
- Relative knob tuning: 0.6%/detent, magnitude cap 4 (`REL_STEP` in main.ts — user is
  sensitive to this feel); quantized params (`steps` on KnobDef) move one position per detent.

## Conventions & gotchas

- `npm run dev` → Chrome only; audio starts behind "press start". Typecheck `npx tsc
  --noEmit`. No test framework; pure-logic smoke tests via
  `npx esbuild <script> --bundle --format=esm --platform=node` + node.
- Keep instruments/drums against `BaseAudioContext` so OfflineAudioContext rendering works.
- `AudioParam.value` doesn't track ramps — loop layers keep an authoritative `level` number.
- Hold-to-record gesture everywhere (pointerdown/up, pad note-on/off, knob click 127/0).
- Old autosaves may contain retired keys (`mode`, `jammi`, `tapeBars`) — merged over
  defaults, harmless.
- Commit + push to origin main after each verified change set (user expects this).
