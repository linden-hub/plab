// PLAYLAB UI — minimalist monochrome chrome; color marks what's alive.
// The tape strip is always on screen; tabs switch which INSTRUMENT the keys
// are. One render() builds the DOM; update() + a rAF loop keep it honest.

import type { AppState, Keyboard, SynthPresetName } from '../state';
import { NUM_STEPS, NUM_TRACKS, TRACK_NAMES } from '../state';
import { NOTE_NAMES, SCALE_LIST, DEGREE_FUNCTION, keyToDegree } from '../theory/harmony';

export interface UIHooks {
  state(): AppState;
  noteOn(note: number, vel: number): void;
  noteOff(note: number): void;
  padHit(i: number, vel: number): void;
  padRelease(i: number): void;
  setKeyboard(k: Keyboard): void;
  togglePlay(): void;
  toggleRec(): void;
  patch(p: Partial<AppState>): void;
  toggleCell(track: number, step: number, shift: boolean): void;
  selectTrack(i: number): void;
  selectedTrack(): number;
  playhead(): number;
  // global tape (hold-to-record: start on press, stop on release)
  tapeRecordStart(): void;
  tapeRecordStop(): void;
  tapeUndo(): void;
  tapeClear(): void;
  tapeInfo(): { layers: number; recState: string; speed: number; hasLoop: boolean; loopSec: number };
  toggleMic(): void;
  micOn(): boolean;
  // jammi sample source
  jammiUseTape(): void;
  jammiLoadFile(f: File): void;
  jammiRecordStart(): void;
  jammiRecordStop(): void;
  jammiSource(): string;
  jammiRecording(): boolean;
  // header extras
  midiStatus(): { connected: boolean; name: string | null };
  exportLoopWav(): void;
  exportBeatWav(): void;
  exportMidiFile(): void;
  saveSession(): void;
  loadSession(): void;
  knobLabels(): { label: string; value: string; norm: number }[];
  learnKnob(i: number): void;
  learning(): number | null;
  currentChordLabel(): string | null;
  currentChordDegree(): number | null;
  heldNotes(): Set<number>;
}

// Mirror the MiniLab 3's 25 keys at their default octave: C3–C5 (48–72),
// 15 white keys including the top C.
const KB_LOW = 48;
const KB_KEYS = 25;

const KEYBOARDS: [Keyboard, string, string][] = [
  ['synth', 'SYNTH', 'plain keys'],
  ['chord', 'CHORD', 'harmony instrument'],
  ['jammi', 'JAMMI', 'sampler keys'],
  ['drums', 'DRUMS', 'kit + step grid'],
];

export class UI {
  private root: HTMLElement;
  private els: Record<string, HTMLElement> = {};
  private cells: HTMLElement[][] = [];
  private padEls: HTMLElement[] = [];
  private knobEls: { box: HTMLElement; val: HTMLElement; bar: HTMLElement; lab: HTMLElement }[] = [];
  private toastEl: HTMLElement;
  private toastTimer: number | null = null;

  constructor(private hooks: UIHooks, mount: HTMLElement) {
    this.root = mount;
    this.toastEl = el('div', 'toast');
    document.body.appendChild(this.toastEl);
    this.render();
    requestAnimationFrame(() => this.frame());
  }

  toast(msg: string) {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    if (this.toastTimer) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), 2200);
  }

  private render() {
    const h = this.hooks;
    this.root.innerHTML = '';

    // ---- header ----
    const header = el('header');
    const logo = el('div', 'logo');
    logo.innerHTML = 'PLAY<em>LAB</em>';
    const midiPill = el('span', 'pill');
    this.els.midiPill = midiPill;
    const transport = el('div', 'transport');
    const play = button('▶ PLAY', () => h.togglePlay());
    const rec = button('● REC', () => h.toggleRec());
    rec.title = 'arm the step grid: pads write into it while playing';
    this.els.play = play; this.els.rec = rec;
    const bpmWrap = el('div', 'bpm');
    const bpmIn = document.createElement('input');
    bpmIn.type = 'range'; bpmIn.min = '60'; bpmIn.max = '180'; bpmIn.step = '1';
    bpmIn.oninput = () => h.patch({ bpm: Number(bpmIn.value) });
    const bpmLab = el('span');
    this.els.bpmLab = bpmLab;
    this.els.bpmIn = bpmIn as unknown as HTMLElement;
    bpmWrap.append(bpmLab, bpmIn);
    transport.append(bpmWrap, play, rec,
      button('WAV·TAPE', () => h.exportLoopWav()),
      button('WAV·BEAT', () => h.exportBeatWav()),
      button('MIDI', () => h.exportMidiFile()),
      button('SAVE', () => h.saveSession()),
      button('LOAD', () => h.loadSession()),
    );
    header.append(logo, midiPill, transport);

    // ---- global tape strip (always visible) ----
    const tape = el('div', 'tapebar');
    const recBtn = button('● HOLD TO RECORD', () => {});
    recBtn.title = 'hold (or hold the MiniLab HOLD button) while you play, release to drop the loop';
    hold(recBtn, () => h.tapeRecordStart(), () => h.tapeRecordStop());
    this.els.tapeRec = recBtn;
    const tapeStatus = el('span', 'tape-status');
    this.els.tapeStatus = tapeStatus;
    const layerBox = el('span', 'layers');
    this.els.layerBox = layerBox;

    const speedIn = slider(-2, 2, 0.05, (v) => h.patch({ tapeSpeed: v }));
    this.els.speedIn = speedIn as unknown as HTMLElement;
    const decayIn = slider(0.3, 1, 0.01, (v) => h.patch({ overdubDecay: v }));
    this.els.decayIn = decayIn as unknown as HTMLElement;
    const loopVolIn = slider(0, 1, 0.01, (v) => h.patch({ loopVolume: v }));
    this.els.loopVolIn = loopVolIn as unknown as HTMLElement;
    const micBtn = button('MIC', () => h.toggleMic());
    micBtn.title = 'record the microphone into loops too';
    this.els.micBtn = micBtn;

    tape.append(recBtn, tapeStatus, layerBox, el('span', 'spacer'),
      ctl('SPEED', speedIn), ctl('FADE', decayIn), ctl('LOOP VOL', loopVolIn),
      micBtn, button('UNDO', () => h.tapeUndo()), button('CLEAR', () => h.tapeClear()));

    // ---- keyboard tabs ----
    const tabs = el('div', 'tabs');
    for (const [k, name, sub] of KEYBOARDS) {
      const b = button('', () => h.setKeyboard(k));
      b.innerHTML = `${name}<span class="sub">${sub}</span>`;
      b.dataset.kb = k;
      tabs.appendChild(b);
    }
    this.els.tabs = tabs;

    // ---- SYNTH panel ----
    const synthPanel = el('div', 'panel');
    const presetRow = el('div', 'row');
    for (const p of ['warm', 'pluck', 'bass'] as SynthPresetName[]) {
      const b = button(p.toUpperCase(), () => h.patch({ synthPreset: p }));
      b.dataset.preset = p;
      presetRow.appendChild(b);
    }
    this.els.presetRow = presetRow;
    synthPanel.append(presetRow, this.buildKeyboard());
    this.els.synthPanel = synthPanel;

    // ---- CHORD panel ----
    const chordPanel = el('div', 'panel');
    const chordNow = el('div', 'chord-now empty');
    chordNow.textContent = 'play a key…';
    this.els.chordNow = chordNow;
    const keyRow = el('div', 'row');
    const chips = el('div', 'keychips');
    NOTE_NAMES.forEach((n, i) => {
      const b = button(n, () => h.patch({ keyRoot: i }));
      b.dataset.root = String(i);
      chips.appendChild(b);
    });
    this.els.chips = chips;
    const scaleSel = document.createElement('select');
    for (const s of SCALE_LIST) scaleSel.append(new Option(s, s));
    scaleSel.onchange = () => h.patch({ scale: scaleSel.value as AppState['scale'] });
    this.els.scaleSel = scaleSel as unknown as HTMLElement;
    const bassT = button('BASS', () => h.patch({ bassOn: !h.state().bassOn }));
    const arpT = button('ARP', () => h.patch({ arpOn: !h.state().arpOn }));
    this.els.bassT = bassT; this.els.arpT = arpT;
    keyRow.append(chips, scaleSel, el('span', 'spacer'), bassT, arpT);
    const fnLegend = el('div', 'fn-legend');
    fnLegend.innerHTML =
      `<span data-fn="home">HOME · I III VI</span>` +
      `<span data-fn="away">AWAY · II IV</span>` +
      `<span data-fn="pull">PULL · V VII</span>` +
      `<span class="fn-hint">same color = swappable · pull wants to land home</span>`;
    chordPanel.append(chordNow, keyRow, fnLegend, this.buildKeyboard());
    this.els.chordPanel = chordPanel;

    // ---- JAMMI panel ----
    const jammiPanel = el('div', 'panel');
    const srcRow = el('div', 'row');
    const srcLabel = el('span', 'jammi-src');
    this.els.jammiSrc = srcLabel;
    const useTape = button('USE TAPE', () => h.jammiUseTape());
    this.els.useTape = useTape;
    const fileIn = document.createElement('input');
    fileIn.type = 'file';
    fileIn.accept = 'audio/*';
    fileIn.style.display = 'none';
    fileIn.onchange = () => { if (fileIn.files?.[0]) h.jammiLoadFile(fileIn.files[0]); fileIn.value = ''; };
    const loadBtn = button('LOAD WAV', () => fileIn.click());
    const jamRec = button('● HOLD TO SAMPLE', () => {});
    jamRec.title = 'hold while you play or speak (enable MIC for the microphone) — release puts the take on the keys';
    hold(jamRec, () => h.jammiRecordStart(), () => h.jammiRecordStop());
    this.els.jamRec = jamRec;
    srcRow.append(srcLabel, el('span', 'spacer'), useTape, loadBtn, fileIn, jamRec);
    const jammiHint = el('div', 'row');
    jammiHint.innerHTML = `<span style="color:var(--dim);font-size:11px">keys replay the sample repitched chromatically · C4 = original pitch · with no sample loaded, keys play the tape itself</span>`;
    jammiPanel.append(srcRow, jammiHint, this.buildKeyboard());
    this.els.jammiPanel = jammiPanel;

    // ---- DRUMS panel ----
    const drumsPanel = el('div', 'panel');
    const grid = el('div', 'grid');
    this.cells = [];
    for (let tr = 0; tr < NUM_TRACKS; tr++) {
      const tn = el('div', 'tname');
      tn.textContent = TRACK_NAMES[tr];
      tn.onclick = () => h.selectTrack(tr);
      tn.dataset.track = String(tr);
      grid.appendChild(tn);
      const row: HTMLElement[] = [];
      for (let st = 0; st < NUM_STEPS; st++) {
        const c = el('div', 'cell' + (st % 4 === 0 ? ' q' : ''));
        c.onclick = (ev) => h.toggleCell(tr, st, (ev as MouseEvent).shiftKey);
        grid.appendChild(c);
        row.push(c);
      }
      this.cells.push(row);
    }
    const beatRow = el('div', 'row');
    const swingIn = slider(0, 1, 0.01, (v) => h.patch({ swing: v }));
    this.els.swingIn = swingIn as unknown as HTMLElement;
    beatRow.append(ctl('SWING', swingIn), el('span', 'spacer'),
      button('CLEAR GRID', () => {
        const g = h.state().grid;
        for (const row of g) for (const c of row) c.on = false;
        h.toggleCell(-1, -1, false);
      }));
    const pads = el('div', 'pads');
    for (let i = 0; i < 8; i++) {
      const b = button(TRACK_NAMES[i], () => {});
      b.addEventListener('pointerdown', (ev) => { ev.preventDefault(); h.padHit(i, 1); });
      b.addEventListener('pointerup', () => h.padRelease(i));
      b.addEventListener('pointerleave', () => h.padRelease(i));
      pads.appendChild(b);
      this.padEls.push(b);
    }
    drumsPanel.append(grid, beatRow, pads);
    this.els.drumsPanel = drumsPanel;

    // ---- hardware mirror ----
    const hw = el('div', 'hw');
    for (let i = 0; i < 8; i++) {
      const box = el('div', 'k');
      box.title = 'click, then turn a knob on the MiniLab to bind it here';
      box.onclick = () => h.learnKnob(i);
      const lab = el('span'); lab.textContent = `K${i + 1}`;
      const val = el('b');
      const bar = el('div', 'bar');
      const fill = el('i');
      bar.appendChild(fill);
      box.append(lab, val, bar);
      hw.appendChild(box);
      this.knobEls.push({ box, val, bar: fill, lab });
    }

    const footer = el('footer');
    footer.innerHTML =
      `MiniLab 3 (DAW mode, ⇧+Pad3): big knob — <b>press &amp; hold the click = record a loop</b> (release stops) · turn = switch keyboard · ⇧+click = play/stop · ⇧+turn = key root / track / tape speed<br>` +
      `pads always finger-drum (and write into the grid when ● REC is armed) · 8 knobs = the strip above · faders: master, delay, reverb, swing · mod strip: vibe<br>` +
      `knob mapping wrong? click a K-box, then turn the knob you want bound there — it sticks<br>` +
      `no controller? <kbd>A</kbd>–<kbd>;</kbd> piano · <kbd>W E T Y U</kbd> black keys · <kbd>1</kbd>–<kbd>8</kbd> pads · <kbd>space</kbd> play · hold <kbd>⇧T</kbd> record loop · <kbd>⇧R</kbd> rec-arm · <kbd>←</kbd><kbd>→</kbd> keyboard · <kbd>Z</kbd>/<kbd>X</kbd> octave · shift-click a BASS cell to cycle its degree`;

    this.root.append(header, tape, tabs, synthPanel, chordPanel, jammiPanel, drumsPanel, hw, footer);
    this.update();
  }

  private buildKeyboard(): HTMLElement {
    const kb = el('div', 'kb');
    const whiteCount = 15;
    let whiteIdx = 0;
    const DEG = ['I', '', 'II', '', 'III', 'IV', '', 'V', '', 'VI', '', 'VII'];
    for (let i = 0; i < KB_KEYS; i++) {
      const note = KB_LOW + i;
      const pc = note % 12;
      const isBlack = [1, 3, 6, 8, 10].includes(pc);
      const key = el('div', isBlack ? 'black' : 'white');
      if (!isBlack) {
        key.style.left = `${(whiteIdx / whiteCount) * 100}%`;
        key.style.width = `${100 / whiteCount}%`;
        const d = el('div', 'deg');
        d.textContent = DEG[pc];
        key.appendChild(d);
        whiteIdx++;
      } else {
        key.style.left = `${((whiteIdx - 0.32) / whiteCount) * 100}%`;
        key.style.width = `${(100 / whiteCount) * 0.62}%`;
      }
      const down = (ev: Event) => { ev.preventDefault(); this.hooks.noteOn(note, 0.9); };
      const up = () => this.hooks.noteOff(note);
      key.addEventListener('pointerdown', down);
      key.addEventListener('pointerup', up);
      key.addEventListener('pointerleave', up);
      key.dataset.note = String(note);
      key.dataset.fn = DEGREE_FUNCTION[keyToDegree(note).degree];
      kb.appendChild(key);
    }
    return kb;
  }

  padFlash(i: number) {
    const b = this.padEls[i];
    if (!b) return;
    b.classList.add('hit');
    window.setTimeout(() => b.classList.remove('hit'), 120);
  }

  /** Flash the K-box a physical knob just drove, so mappings are visible. */
  knobFlash(i: number) {
    const k = this.knobEls[i];
    if (!k) return;
    k.box.classList.add('hit');
    window.setTimeout(() => k.box.classList.remove('hit'), 180);
    this.update();
  }

  /** Cheap full refresh of stateful chrome — called on store changes. */
  update() {
    const h = this.hooks;
    const s = h.state();

    document.body.dataset.kb = s.keyboard;

    // header
    const { connected, name } = h.midiStatus();
    this.els.midiPill.textContent = connected ? `● ${name}` : '○ no MIDI — keyboard fallback on';
    this.els.midiPill.className = 'pill' + (connected ? ' on' : '');
    this.els.play.textContent = s.playing ? '■ STOP' : '▶ PLAY';
    this.els.play.className = s.playing ? 'lit' : '';
    this.els.rec.className = s.recording ? 'rec-lit' : '';
    this.els.bpmLab.textContent = `${s.bpm} BPM`;
    (this.els.bpmIn as unknown as HTMLInputElement).value = String(s.bpm);

    // tape strip
    const t = h.tapeInfo();
    const tapeRecording = t.recState === 'recording' && !h.jammiRecording();
    this.els.tapeRec.className = tapeRecording ? 'rec-lit' : '';
    this.els.tapeRec.textContent = tapeRecording ? '● RECORDING…' : t.hasLoop ? '● HOLD TO LAYER' : '● HOLD TO RECORD';
    (this.els.speedIn as unknown as HTMLInputElement).value = String(s.tapeSpeed);
    (this.els.decayIn as unknown as HTMLInputElement).value = String(s.overdubDecay);
    (this.els.loopVolIn as unknown as HTMLInputElement).value = String(s.loopVolume);
    this.els.micBtn.className = h.micOn() ? 'lit' : '';
    this.els.layerBox.innerHTML = '';
    for (let i = 0; i < t.layers; i++) this.els.layerBox.appendChild(el('i', 'layer-chip'));

    // tabs + panels
    for (const b of this.els.tabs.children) {
      (b as HTMLElement).classList.toggle('active', (b as HTMLElement).dataset.kb === s.keyboard);
    }
    this.els.synthPanel.style.display = s.keyboard === 'synth' ? '' : 'none';
    this.els.chordPanel.style.display = s.keyboard === 'chord' ? '' : 'none';
    this.els.jammiPanel.style.display = s.keyboard === 'jammi' ? '' : 'none';
    this.els.drumsPanel.style.display = s.keyboard === 'drums' ? '' : 'none';

    // synth chrome
    for (const b of this.els.presetRow.children) {
      (b as HTMLElement).className = (b as HTMLElement).dataset.preset === s.synthPreset ? 'lit' : '';
    }

    // chord chrome
    for (const b of this.els.chips.children) {
      (b as HTMLElement).classList.toggle('active', Number((b as HTMLElement).dataset.root) === s.keyRoot);
    }
    (this.els.scaleSel as unknown as HTMLSelectElement).value = s.scale;
    this.els.bassT.className = s.bassOn ? 'lit' : '';
    this.els.arpT.className = s.arpOn ? 'lit' : '';

    // jammi chrome
    this.els.jammiSrc.textContent = `sample: ${h.jammiSource()}`;
    this.els.jamRec.className = h.jammiRecording() ? 'rec-lit' : '';
    this.els.jamRec.textContent = h.jammiRecording() ? '● SAMPLING…' : '● HOLD TO SAMPLE';

    // drums chrome
    (this.els.swingIn as unknown as HTMLInputElement).value = String(s.swing);
    for (let tr = 0; tr < NUM_TRACKS; tr++) {
      for (let st = 0; st < NUM_STEPS; st++) {
        this.cells[tr][st].classList.toggle('on', s.grid[tr][st].on);
      }
    }
    const tnames = this.els.drumsPanel.querySelectorAll('.tname');
    tnames.forEach((tn) => tn.classList.toggle('sel', Number((tn as HTMLElement).dataset.track) === h.selectedTrack()));

    // knob mirror
    const knobs = h.knobLabels();
    const learning = h.learning();
    knobs.forEach((k, i) => {
      const K = this.knobEls[i];
      K.lab.textContent = `K${i + 1} ${k.label}`;
      K.val.textContent = learning === i ? 'turn a knob…' : k.value;
      K.bar.style.width = `${Math.round(k.norm * 100)}%`;
      K.box.classList.toggle('learn', learning === i);
    });
  }

  /** rAF loop for the fast-moving things: playhead, held keys, tape status, chord name. */
  private frame() {
    const h = this.hooks;
    const s = h.state();

    if (s.keyboard === 'drums') {
      const ph = h.playhead();
      for (let tr = 0; tr < NUM_TRACKS; tr++) {
        for (let st = 0; st < NUM_STEPS; st++) {
          this.cells[tr][st].classList.toggle('playing', st === ph && ph >= 0);
        }
      }
    }

    if (s.keyboard === 'chord') {
      const label = h.currentChordLabel();
      const held = h.heldNotes().size > 0;
      if (held && label) {
        const [nm, roman] = label.split('·');
        this.els.chordNow.innerHTML = `${nm.trim()} <span class="roman">${(roman ?? '').trim()}</span>`;
        this.els.chordNow.classList.remove('empty');
        const deg = h.currentChordDegree();
        if (deg !== null) this.els.chordNow.dataset.fn = DEGREE_FUNCTION[deg];
      } else {
        this.els.chordNow.textContent = 'play a key…';
        this.els.chordNow.classList.add('empty');
        delete this.els.chordNow.dataset.fn;
      }
    }

    // held keys on the visible keyboard
    const held = h.heldNotes();
    document.querySelectorAll<HTMLElement>('.kb [data-note]').forEach((k) => {
      k.classList.toggle('held', held.has(Number(k.dataset.note)));
    });

    // tape strip status
    const st = h.tapeInfo();
    this.els.tapeStatus.textContent =
      st.recState === 'recording' ? (h.jammiRecording() ? 'sampling into JAMMI keys…' : 'recording… release to drop the loop')
      : st.hasLoop ? `${st.layers} loop${st.layers === 1 ? '' : 's'} · longest ${st.loopSec.toFixed(1)}s · ×${st.speed.toFixed(2)}`
      : 'empty tape — hold record and play';
    this.els.tapeStatus.classList.toggle('rec', st.recState === 'recording');

    requestAnimationFrame(() => this.frame());
  }
}

function el(tag: string, cls?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function button(label: string, onClick: () => void): HTMLElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.onclick = onClick;
  return b;
}

function slider(min: number, max: number, step: number, oninput: (v: number) => void): HTMLInputElement {
  const s = document.createElement('input');
  s.type = 'range';
  s.min = String(min); s.max = String(max); s.step = String(step);
  s.oninput = () => oninput(Number(s.value));
  return s;
}

function hold(btn: HTMLElement, start: () => void, stop: () => void) {
  btn.addEventListener('pointerdown', (ev) => { ev.preventDefault(); start(); });
  btn.addEventListener('pointerup', stop);
  btn.addEventListener('pointerleave', stop);
}

function ctl(label: string, input: HTMLElement): HTMLElement {
  const l = document.createElement('label');
  l.className = 'ctl';
  const b = document.createElement('b');
  b.textContent = label;
  l.append(b, input);
  return l;
}
