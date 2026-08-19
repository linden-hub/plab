// PLAYLAB UI — minimalist monochrome chrome; color marks what's alive.
// One render() builds the DOM; update() + a rAF loop keep it honest.

import type { AppState, Mode } from '../state';
import { NUM_STEPS, NUM_TRACKS, TRACK_NAMES } from '../state';
import { NOTE_NAMES, SCALE_LIST } from '../theory/harmony';

export interface UIHooks {
  state(): AppState;
  noteOn(note: number, vel: number): void;
  noteOff(note: number): void;
  padHit(i: number, vel: number): void;
  setMode(m: Mode): void;
  togglePlay(): void;
  toggleRec(): void;
  patch(p: Partial<AppState>): void;
  toggleCell(track: number, step: number, shift: boolean): void;
  selectTrack(i: number): void;
  selectedTrack(): number;
  playhead(): number;
  // tape
  tapeRecord(): void;
  tapeUndo(): void;
  tapeClear(): void;
  tapeInfo(): { layers: number; recState: string; speed: number; hasLoop: boolean };
  toggleMic(): void;
  micOn(): boolean;
  // header extras
  midiStatus(): { connected: boolean; name: string | null };
  exportLoopWav(): void;
  exportBeatWav(): void;
  exportMidiFile(): void;
  saveSession(): void;
  loadSession(): void;
  knobLabels(): { label: string; value: string; norm: number }[];
  currentChordLabel(): string | null;
  heldNotes(): Set<number>;
}

const KB_LOW = 60; // C4
const KB_KEYS = 24;

export class UI {
  private root: HTMLElement;
  private els: Record<string, HTMLElement> = {};
  private cells: HTMLElement[][] = [];
  private keyEls = new Map<number, HTMLElement>();
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
    this.els.play = play; this.els.rec = rec;
    const bpmWrap = el('div', 'bpm');
    const bpmIn = document.createElement('input');
    bpmIn.type = 'range'; bpmIn.min = '60'; bpmIn.max = '180'; bpmIn.step = '1';
    bpmIn.oninput = () => h.patch({ bpm: Number(bpmIn.value) });
    const bpmLab = el('span');
    this.els.bpmLab = bpmLab;
    (this.els.bpmIn as unknown as HTMLInputElement) = bpmIn as unknown as HTMLElement & HTMLInputElement;
    bpmWrap.append(bpmLab, bpmIn);
    transport.append(bpmWrap, play, rec,
      button('WAV·LOOP', () => h.exportLoopWav()),
      button('WAV·BEAT', () => h.exportBeatWav()),
      button('MIDI', () => h.exportMidiFile()),
      button('SAVE', () => h.saveSession()),
      button('LOAD', () => h.loadSession()),
    );
    header.append(logo, midiPill, transport);

    // ---- tabs ----
    const tabs = el('div', 'tabs');
    const tabDefs: [Mode, string, string][] = [
      ['chord', 'CHORD', 'harmony instrument'],
      ['beat', 'BEAT', 'step sequencer'],
      ['tape', 'TAPE', 'looper'],
    ];
    for (const [m, name, sub] of tabDefs) {
      const b = button('', () => h.setMode(m));
      b.innerHTML = `${name}<span class="sub">${sub}</span>`;
      b.dataset.mode = m;
      tabs.appendChild(b);
    }
    this.els.tabs = tabs;

    // ---- chord panel ----
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

    chordPanel.append(chordNow, keyRow, this.buildKeyboard());
    this.els.chordPanel = chordPanel;

    // ---- beat panel ----
    const beatPanel = el('div', 'panel');
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
    const swingIn = document.createElement('input');
    swingIn.type = 'range'; swingIn.min = '0'; swingIn.max = '1'; swingIn.step = '0.01';
    swingIn.oninput = () => h.patch({ swing: Number(swingIn.value) });
    this.els.swingIn = swingIn as unknown as HTMLElement;
    beatRow.append(ctl('SWING', swingIn), el('span', 'spacer'),
      button('CLEAR GRID', () => {
        const g = h.state().grid;
        for (const row of g) for (const c of row) c.on = false;
        h.patch({}); h.toggleCell(-1, -1, false); // trigger redraw path
      }));
    const pads = el('div', 'pads');
    for (let i = 0; i < 8; i++) {
      const b = button(TRACK_NAMES[i], () => h.padHit(i, 1));
      pads.appendChild(b);
      this.padEls.push(b);
    }
    beatPanel.append(grid, beatRow, pads);
    this.els.beatPanel = beatPanel;

    // ---- tape panel ----
    const tapePanel = el('div', 'panel');
    const reels = el('div', 'reels');
    const reelL = this.buildReel(); const reelR = this.buildReel();
    const tapeStatus = el('div', 'tape-status');
    this.els.tapeStatus = tapeStatus;
    const layerBox = el('div', 'layers');
    this.els.layerBox = layerBox;
    reels.append(reelL, tapeStatus, el('span', 'spacer'), layerBox, reelR);

    const tapeRow = el('div', 'row');
    const recBtn = button('● RECORD', () => h.tapeRecord());
    this.els.tapeRec = recBtn;
    const barsSel = document.createElement('select');
    for (const b of [1, 2, 4, 8]) barsSel.append(new Option(`${b} bar${b > 1 ? 's' : ''}`, String(b)));
    barsSel.onchange = () => h.patch({ tapeBars: Number(barsSel.value) });
    this.els.barsSel = barsSel as unknown as HTMLElement;
    const speedIn = document.createElement('input');
    speedIn.type = 'range'; speedIn.min = '-2'; speedIn.max = '2'; speedIn.step = '0.05';
    speedIn.oninput = () => h.patch({ tapeSpeed: Number(speedIn.value) });
    this.els.speedIn = speedIn as unknown as HTMLElement;
    const decayIn = document.createElement('input');
    decayIn.type = 'range'; decayIn.min = '0.3'; decayIn.max = '1'; decayIn.step = '0.01';
    decayIn.oninput = () => h.patch({ overdubDecay: Number(decayIn.value) });
    this.els.decayIn = decayIn as unknown as HTMLElement;
    const micBtn = button('MIC', () => h.toggleMic());
    this.els.micBtn = micBtn;
    tapeRow.append(recBtn, ctl('LENGTH', barsSel), ctl('SPEED', speedIn), ctl('OVERDUB DECAY', decayIn),
      micBtn, el('span', 'spacer'),
      button('UNDO', () => h.tapeUndo()),
      button('CLEAR', () => h.tapeClear()));
    const tapeHint = el('div', 'row');
    tapeHint.innerHTML = `<span style="color:var(--dim);font-size:11px">keys replay the loop repitched (C4 = original) · recording captures everything you play, in any mode</span>`;
    tapePanel.append(reels, tapeRow, tapeHint, this.buildKeyboard());
    this.els.tapePanel = tapePanel;

    // ---- hardware mirror ----
    const hw = el('div', 'hw');
    for (let i = 0; i < 8; i++) {
      const box = el('div', 'k');
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
      `MiniLab 3: keys play · pads drum (BEAT) / pick scale (CHORD) / drive tape (TAPE) · 8 knobs = the panel above · faders: volume, delay, reverb, swing<br>` +
      `no controller? <kbd>A</kbd>–<kbd>;</kbd> piano · <kbd>W E T Y U</kbd> black keys · <kbd>1</kbd>–<kbd>8</kbd> pads · <kbd>space</kbd> play · <kbd>⇧R</kbd> record · <kbd>←</kbd><kbd>→</kbd> mode · <kbd>Z</kbd>/<kbd>X</kbd> octave · shift-click a BASS cell to cycle its scale degree`;

    this.root.append(header, tabs, chordPanel, beatPanel, tapePanel, hw, footer);
    this.update();
  }

  private buildKeyboard(): HTMLElement {
    const kb = el('div', 'kb');
    const whiteCount = 14;
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
      // multiple keyboards exist (chord + tape panels); register the visible one last wins is fine
      this.keyEls.set(note * 1000 + Math.random(), key);
      key.dataset.note = String(note);
      kb.appendChild(key);
    }
    return kb;
  }

  private buildReel(): HTMLElement {
    const r = el('div', 'reel');
    const s = el('div', 'spoke');
    r.appendChild(s);
    return r;
  }

  padFlash(i: number) {
    const b = this.padEls[i];
    if (!b) return;
    b.classList.add('hit');
    window.setTimeout(() => b.classList.remove('hit'), 120);
  }

  /** Cheap full refresh of stateful chrome — called on store changes. */
  update() {
    const h = this.hooks;
    const s = h.state();

    document.body.dataset.mode = s.mode;

    // header
    const { connected, name } = h.midiStatus();
    this.els.midiPill.textContent = connected ? `● ${name}` : '○ no MIDI — keyboard fallback on';
    this.els.midiPill.className = 'pill' + (connected ? ' on' : '');
    this.els.play.textContent = s.playing ? '■ STOP' : '▶ PLAY';
    this.els.play.className = s.playing ? 'lit' : '';
    this.els.rec.className = s.recording ? 'rec-lit' : '';
    this.els.bpmLab.textContent = `${s.bpm} BPM`;
    (this.els.bpmIn as unknown as HTMLInputElement).value = String(s.bpm);

    // tabs + panels
    for (const b of this.els.tabs.children) {
      (b as HTMLElement).classList.toggle('active', (b as HTMLElement).dataset.mode === s.mode);
    }
    this.els.chordPanel.style.display = s.mode === 'chord' ? '' : 'none';
    this.els.beatPanel.style.display = s.mode === 'beat' ? '' : 'none';
    this.els.tapePanel.style.display = s.mode === 'tape' ? '' : 'none';

    // chord chrome
    for (const b of this.els.chips.children) {
      (b as HTMLElement).classList.toggle('active', Number((b as HTMLElement).dataset.root) === s.keyRoot);
    }
    (this.els.scaleSel as unknown as HTMLSelectElement).value = s.scale;
    this.els.bassT.className = s.bassOn ? 'lit' : '';
    this.els.arpT.className = s.arpOn ? 'lit' : '';

    // beat chrome
    (this.els.swingIn as unknown as HTMLInputElement).value = String(s.swing);
    for (let tr = 0; tr < NUM_TRACKS; tr++) {
      for (let st = 0; st < NUM_STEPS; st++) {
        this.cells[tr][st].classList.toggle('on', s.grid[tr][st].on);
      }
    }
    const tnames = this.els.beatPanel.querySelectorAll('.tname');
    tnames.forEach((t) => t.classList.toggle('sel', Number((t as HTMLElement).dataset.track) === h.selectedTrack()));

    // tape chrome
    (this.els.barsSel as unknown as HTMLSelectElement).value = String(s.tapeBars);
    (this.els.speedIn as unknown as HTMLInputElement).value = String(s.tapeSpeed);
    (this.els.decayIn as unknown as HTMLInputElement).value = String(s.overdubDecay);
    this.els.micBtn.className = h.micOn() ? 'lit' : '';
    const t = h.tapeInfo();
    this.els.tapeRec.className = t.recState === 'recording' ? 'rec-lit' : t.recState === 'armed' ? 'lit' : '';
    this.els.tapeRec.textContent = t.recState === 'recording' ? '● RECORDING' : t.recState === 'armed' ? '● ARMED…' : t.hasLoop ? '● OVERDUB' : '● RECORD';
    this.els.layerBox.innerHTML = '';
    for (let i = 0; i < t.layers; i++) this.els.layerBox.appendChild(el('div', 'layer-chip'));

    // knob mirror
    const knobs = h.knobLabels();
    knobs.forEach((k, i) => {
      const K = this.knobEls[i];
      K.lab.textContent = `K${i + 1} ${k.label}`;
      K.val.textContent = k.value;
      K.bar.style.width = `${Math.round(k.norm * 100)}%`;
    });
  }

  /** rAF loop for the fast-moving things: playhead, held keys, reels, chord name. */
  private frame() {
    const h = this.hooks;
    const s = h.state();

    if (s.mode === 'beat') {
      const ph = h.playhead();
      for (let tr = 0; tr < NUM_TRACKS; tr++) {
        for (let st = 0; st < NUM_STEPS; st++) {
          this.cells[tr][st].classList.toggle('playing', st === ph && ph >= 0);
        }
      }
    }

    if (s.mode === 'chord') {
      const label = h.currentChordLabel();
      const held = h.heldNotes().size > 0;
      if (held && label) {
        const [nm, roman] = label.split('·');
        this.els.chordNow.innerHTML = `${nm.trim()} <span class="roman">${(roman ?? '').trim()}</span>`;
        this.els.chordNow.classList.remove('empty');
      } else {
        this.els.chordNow.textContent = 'play a key…';
        this.els.chordNow.classList.add('empty');
      }
    }

    // held keys on every visible keyboard
    const held = h.heldNotes();
    document.querySelectorAll<HTMLElement>('.kb [data-note]').forEach((k) => {
      k.classList.toggle('held', held.has(Number(k.dataset.note)));
    });

    // reels spin with tape speed
    if (s.mode === 'tape') {
      const t = h.tapeInfo();
      const angle = (performance.now() / 1000) * t.speed * 120;
      document.querySelectorAll<HTMLElement>('.reel .spoke').forEach((sp) => {
        sp.style.transform = `rotate(${t.hasLoop ? angle : 0}deg)`;
      });
      const st = h.tapeInfo();
      this.els.tapeStatus.textContent =
        st.recState === 'recording' ? 'recording…'
        : st.recState === 'armed' ? 'waiting for the bar…'
        : st.hasLoop ? `${st.layers} layer${st.layers === 1 ? '' : 's'} · ×${st.speed.toFixed(2)}`
        : 'empty tape';
      this.els.tapeStatus.className = 'tape-status' + (st.recState === 'recording' ? ' rec' : '');
    }

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

function ctl(label: string, input: HTMLElement): HTMLElement {
  const l = document.createElement('label');
  l.className = 'ctl';
  const b = document.createElement('b');
  b.textContent = label;
  l.append(b, input);
  return l;
}
