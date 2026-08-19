# PLAYLAB

An early software prototype of a playful music & sound-design workstation for video-game
audio — three instruments fused into one, driven by an **Arturia MiniLab 3**:

- **CHORD** — a [Nopia](https://nopia.io/)-inspired harmony instrument: keys play *scale
  degrees*, so wrong notes are structurally impossible. Extensions dial (triad → 7th → 9th),
  voicing spread, inversions, auto-bass, clock-synced arp.
- **BEAT** — a [Dirtywave M8](https://dirtywave.com/)-inspired step sequencer: 8 tracks × 16
  steps, finger-drum the pads and live-record, swing, per-track pitch/decay/volume. The bass
  track auto-snaps to the current key.
- **TAPE** — a [CHOMPI](https://www.chompiclub.com/)-inspired looper: records the master bus
  (everything you play, in any mode) or the mic, bar-quantized, unlimited overdubs with decay
  (Frippertronics), varispeed incl. reverse, and keys replay the loop repitched chromatically.

One harmonic brain (key + scale) drives all three modes. One **vibe** macro moves the whole
output from clean to warbly cassette (wow/flutter + saturation + lowpass).

## Run it

```bash
npm install
npm run dev
```

Open the printed URL in **Chrome** (Web MIDI required), click **press start** (browsers need a
gesture before audio), and plug in the MiniLab 3 — it's auto-detected, hot-plug safe.

No controller? Full computer-keyboard fallback: `A`–`;` piano (`W E T Y U` black keys),
`1`–`8` pads, `space` play, `⇧R` record-arm, `←`/`→` switch modes, `Z`/`X` octave.

## MiniLab 3 mapping (factory Arturia mode)

| Control | CHORD | BEAT | TAPE |
|---|---|---|---|
| Keys | diatonic chords by degree (black key = +1 extension) | scale-locked bass, live | chords over the loop (JAMMI: repitch the loop, C4 = original) |
| Pads 1–8 | 1–6 scale · 7 bass · 8 arp | finger-drum the 8 tracks (records when armed) | 1 record/overdub · 2 undo · 3 reverse · 4 speed reset |
| Knobs 1–8 | ext · spread · inv · oct · bright · release · arp · vibe | bpm · swing · vol · pitch · decay · vibe · delay · reverb | speed · decay · bars · vibe · delay · reverb · master · bright |
| Faders 1–4 | master · delay · reverb · swing (all modes) | | |
| Mod strip | vibe (all modes) | | |

**Recording works from any mode**: the header's **● TAPE** button (or `⇧T`) punches the loop
in wherever you are — jam in CHORD or BEAT, record, then export WAV·LOOP.

**Hands-free navigation with the big knob** — put the device in DAW mode (Shift+Pad3):
turn = switch mode, click = play/stop, Shift+turn = key root (CHORD) / track (BEAT) / tape
speed (TAPE), Shift+click = record arm. In DAW mode the 8 encoders and 4 faders keep working
(relative CCs are handled); in factory Arturia mode the big knob only browses Analog Lab and
sends nothing, so use DAW mode if you want it.

If the browser grants SysEx, mode switches recolor the pads and write to the OLED.

## Sessions & DAW handoff (REAPER)

- **Autosave**: everything (grid, params, key, loop audio) persists locally; reload the tab
  and you're exactly where you left off. `SAVE`/`LOAD` manage named slots.
- **WAV·LOOP** — the tape loop, bar-exact, tiles cleanly as a REAPER loop item.
- **WAV·BEAT** — the pattern rendered offline (2 bars, dry).
- **MIDI** — a .mid with tempo, the drum/bass grid, and your chord performance (recorded
  while the transport runs in CHORD mode), ready to drive REAPER's own instruments.

## Architecture

Vite + TypeScript, Web MIDI + Web Audio, zero runtime dependencies. Engine code is
UI-agnostic (instruments take any `BaseAudioContext`) for a later native/embedded port.

```
src/theory/     scales, diatonic chords, voicing (the harmonic brain)
src/audio/      master FX graph (vibe/delay/reverb), polysynth, drum synthesis
src/sequencer/  lookahead clock (swing), 16-step phrase sequencer
src/modes/      chord-mode instrument (chords + bass + arp + perf capture)
src/looper/     AudioWorklet tape looper (sample-accurate punch, layers)
src/midi/       Web MIDI manager + MiniLab 3 map (CCs, notes, SysEx)
src/persist/    localStorage + IndexedDB sessions
src/export/     WAV encoder, offline pattern render, SMF writer
src/ui/         monochrome UI, color = what's alive
```
