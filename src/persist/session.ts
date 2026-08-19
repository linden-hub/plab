// Session persistence: pick up exactly where you left off.
// - App state (grid, params, key, bpm…) → localStorage JSON, debounced autosave
// - Loop audio layers → IndexedDB as raw Float32 channel data
// - Named slots snapshot both.

import type { AppState } from '../state';
import { defaultState } from '../state';
import type { Looper } from '../looper/looper';
import type { JammiSampler } from '../audio/jammi';

const LS_KEY = 'plab.autosave.v1';
const LS_SLOTS = 'plab.slots.v1';
const DB_NAME = 'plab';
const DB_STORE = 'audio';

interface StoredLayer {
  sampleRate: number;
  length: number;
  gain: number;
  phaseOffset?: number;
  ch0: ArrayBuffer;
  ch1: ArrayBuffer;
}

interface AudioSnapshot {
  loopDur: number;
  layers: StoredLayer[];
  jammi?: StoredLayer;
  jammiName?: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function idbPut(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(value, key);
    tx.oncomplete = () => { db.close(); res(); };
    tx.onerror = () => { db.close(); rej(tx.error); };
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).get(key);
    req.onsuccess = () => { db.close(); res(req.result as T | undefined); };
    req.onerror = () => { db.close(); rej(req.error); };
  });
}

function storeBuffer(buf: AudioBuffer, gain = 1): StoredLayer {
  return {
    sampleRate: buf.sampleRate,
    length: buf.length,
    gain,
    ch0: buf.getChannelData(0).slice().buffer,
    ch1: buf.getChannelData(Math.min(1, buf.numberOfChannels - 1)).slice().buffer,
  };
}

function loadBuffer(ctx: AudioContext, sl: StoredLayer): AudioBuffer {
  const buf = ctx.createBuffer(2, sl.length, sl.sampleRate);
  buf.getChannelData(0).set(new Float32Array(sl.ch0));
  buf.getChannelData(1).set(new Float32Array(sl.ch1));
  return buf;
}

function snapshotAudio(looper: Looper, jammi: JammiSampler): AudioSnapshot {
  return {
    loopDur: looper.loopDur,
    layers: looper.layers.map((l) => storeBuffer(l.buffer, l.level)),
    jammi: jammi.sample ? storeBuffer(jammi.sample) : undefined,
    jammiName: jammi.sample ? jammi.sourceName : undefined,
  };
}

function restoreAudio(ctx: AudioContext, looper: Looper, jammi: JammiSampler, snap: AudioSnapshot | undefined) {
  if (!snap) return;
  if (snap.layers.length) {
    looper.restore(snap.layers.map((sl) => loadBuffer(ctx, sl)), snap.layers.map((l) => l.gain));
  }
  if (snap.jammi) jammi.setSample(loadBuffer(ctx, snap.jammi), snap.jammiName ?? 'sample');
}

/** Serializable subset of state (transport flags reset on load). */
function serializable(s: AppState): Partial<AppState> {
  const { playing, recording, ...rest } = s;
  return rest;
}

export class SessionManager {
  private saveTimer: number | null = null;

  constructor(
    private ctx: AudioContext,
    private looper: Looper,
    private jammi: JammiSampler,
  ) {}

  loadAutosaveState(): Partial<AppState> | null {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      return { ...defaultState(), ...JSON.parse(raw), playing: false, recording: false };
    } catch {
      return null;
    }
  }

  async loadAutosaveAudio() {
    try {
      restoreAudio(this.ctx, this.looper, this.jammi, await idbGet<AudioSnapshot>('autosave'));
    } catch (e) {
      console.warn('loop restore failed', e);
    }
  }

  /** Debounced — call on every state change. */
  scheduleAutosave(state: AppState) {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      localStorage.setItem(LS_KEY, JSON.stringify(serializable(state)));
    }, 400);
  }

  /** Loop audio changed — persist it (called on looper.onChange when idle). */
  async autosaveAudio() {
    try {
      await idbPut('autosave', snapshotAudio(this.looper, this.jammi));
    } catch (e) {
      console.warn('loop autosave failed', e);
    }
  }

  listSlots(): string[] {
    try { return JSON.parse(localStorage.getItem(LS_SLOTS) ?? '[]'); } catch { return []; }
  }

  async saveSlot(name: string, state: AppState) {
    const slots = new Set(this.listSlots());
    slots.add(name);
    localStorage.setItem(LS_SLOTS, JSON.stringify([...slots]));
    localStorage.setItem(`plab.slot.${name}`, JSON.stringify(serializable(state)));
    await idbPut(`slot:${name}`, snapshotAudio(this.looper, this.jammi));
  }

  async loadSlot(name: string): Promise<Partial<AppState> | null> {
    const raw = localStorage.getItem(`plab.slot.${name}`);
    if (!raw) return null;
    restoreAudio(this.ctx, this.looper, this.jammi, await idbGet<AudioSnapshot>(`slot:${name}`));
    return { ...defaultState(), ...JSON.parse(raw), playing: false, recording: false };
  }
}
