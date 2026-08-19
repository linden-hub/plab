# PLAYLAB

An early software prototype of a playful music & sound-design workstation for video-game
audio, driven by an **Arturia MiniLab 3**. The architecture: a **global tape looper** that is
always listening, and **four keyboards** — what the 25 keys *are* at any moment:

- **SYNTH** — plain chromatic keys with selectable presets (warm / pluck / bass).
- **CHORD** — a [Nopia](https://nopia.io/)-inspired harmony instrument: keys play *scale
  degrees*, so wrong notes are structurally impossible. Extensions dial (triad → 7th → 9th),
  voicing spread, inversions, auto-bass, clock-synced arp.
- **JAMMI** — [CHOMPI](https://www.chompiclub.com/)-inspired sampler keys: one sample spread
  chromatically (C4 = original). The sample is the tape itself, a loaded WAV, or a take
  recorded straight off the mic into the keys.
- **DRUMS** — a [Dirtywave M8](https://dirtywave.com/)-inspired step sequencer: 8 tracks × 16
  steps, finger-drum the pads and live-record, swing, per-track pitch/decay/volume. The bass
  track auto-snaps to the current key.

**The tape** ([CHOMPI](https://www.chompiclub.com/) LOOPI-inspired) sits above all of it:
hold record while you play *anything*, release, and that exact take loops at its own length,
layered over every other take, drifting freely (no bar grid, Frippertronics fade, varispeed
incl. reverse). Pads always finger-drum regardless of keyboard.

One harmonic brain (key + scale) drives every keyboard. One **vibe** macro moves the whole
output from clean to warbly cassette (wow/flutter + saturation + lowpass).

## Run it

```bash
npm install
npm run dev
```

Open the printed URL in **Chrome** (Web MIDI required), click **press start** (browsers need a
gesture before audio), and plug in the MiniLab 3 — it's auto-detected, hot-plug safe.

No controller? Full computer-keyboard fallback: `A`–`;` piano (`W E T Y U` black keys),
`1`–`8` pads, `space` play, hold `⇧T` record loop, `⇧R` record-arm, `←`/`→` switch keyboards,
`Z`/`X` octave.

## MiniLab 3 mapping (put the device in DAW mode: Shift+Pad3)

- **HOLD button = the record-loop button.** Hold it while you play — on any keyboard —
  release, and the take loops. **Shift+HOLD = undo the last loop.**
- **Big knob**: turn = switch keyboard · click = play/stop · Shift+turn = key root (SYNTH,
  CHORD) / selected track (DRUMS) / tape speed (JAMMI) · Shift+click = rec-arm the grid.
- **Pads 1–8**: always the drum kit; they write into the step grid when ● REC is armed.
- **Faders 1–4**: master · delay · reverb · swing. **Mod strip**: vibe.
- **Knobs 1–8** per keyboard:
  - SYNTH: bright · release · vibe · delay · reverb · loop vol · tape speed · fade
  - CHORD: ext · spread · inv · oct · bright · release · arp · vibe
  - JAMMI: tape speed · fade · loop vol · vibe · delay · reverb · master · bright
  - DRUMS: bpm · swing · track vol · track pitch · track decay · vibe · delay · reverb

Both device modes work (Arturia-mode absolute CCs and DAW-mode relative/Mackie encoders are
handled), but the big knob and Shift only speak in DAW mode. If a knob lands on the wrong
function, click a K-box on screen and turn the knob to rebind it. If the browser grants
SysEx, keyboard switches recolor the pads and write to the OLED.

## Sessions & DAW handoff (REAPER)

- **Autosave**: everything (grid, params, key, loop audio) persists locally; reload the tab
  and you're exactly where you left off. `SAVE`/`LOAD` manage named slots.
- **WAV·LOOP** — the tape loop, cut exactly at its own length, tiles cleanly as a REAPER loop item.
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
