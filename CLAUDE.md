# PLAYLAB — notes for Claude

A browser music workstation prototype (Vite + TS + Web MIDI + Web Audio, no deps) for the
Arturia MiniLab 3, fusing Dirtywave M8 (sequencer), Nopia (harmony), CHOMPI (looper).
Design thesis: approachable, fun, "state of play", aimed at video-game sound design.

- `npm run dev` → Chrome only (Web MIDI). Audio starts behind a click ("press start").
- Typecheck: `npx tsc --noEmit`. No test framework; pure-logic smoke tests can run via
  `npx esbuild <script> --bundle --format=esm --platform=node` + node.
- Keep engine code UI-agnostic: instruments/drums take `BaseAudioContext` so they also render
  in `OfflineAudioContext` (WAV export) — don't reach for `window`/`AudioContext` inside them.
- One store (`src/state.ts`), UI re-renders via `store.subscribe` + a rAF loop for playheads.
- MiniLab 3 facts (verified from Arturia manual + reverse-engineered SysEx): keys ch1; pads
  ch10 notes 36–43 (bank A); encoders CC 74,71,76,77,93,18,19,16 absolute; faders CC
  82,83,85,17; mod strip CC1. SysEx pad RGB / OLED formats live in `src/midi/minilab3.ts` —
  do NOT send the DAW-mode handshake (it flips encoders to relative CCs and breaks mapping).
- Looper punch-in/out is sample-accurate inside the AudioWorklet (it slices by `currentTime`);
  don't move that logic to the main thread.
- `AudioParam.value` does not track `setTargetAtTime` ramps — loop layers keep an
  authoritative `level` number; preserve that pattern.
- Sessions: state JSON in localStorage, loop audio Float32 in IndexedDB (`src/persist/`).
- Long-term direction: grow BEAT's phrase model into M8-style chains/song; port engine to a
  portable hardware form factor.
