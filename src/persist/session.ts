// Session persistence: pick up exactly where you left off.
// - App state (grid, params, key, bpm…) → localStorage JSON, debounced autosave
// - Loop audio layers → IndexedDB as raw Float32 channel data
// - Named slots snapshot both.

import type { AppState } from '../state';
import { defaultState } from '../state';
import type { Looper } from '../looper/looper';

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

function snapshotAudio(looper: Looper): AudioSnapshot {
  return {
    loopDur: looper.loopDur,
    layers: looper.layers.map((l) => ({
      sampleRate: l.buffer.sampleRate,
      length: l.buffer.length,
      gain: l.level,
      ch0: l.buffer.getChannelData(0).slice().buffer,
      ch1: l.buffer.getChannelData(Math.min(1, l.buffer.numberOfChannels - 1)).slice().buffer,
    })),
  };
}

function restoreAudio(ctx: AudioContext, looper: Looper, snap: AudioSnapshot | undefined) {
  if (!snap || !snap.layers.length) return;
  const buffers = snap.layers.map((sl) => {
    const buf = ctx.createBuffer(2, sl.length, sl.sampleRate);
    buf.getChannelData(0).set(new Float32Array(sl.ch0));
    buf.getChannelData(1).set(new Float32Array(sl.ch1));
    return buf;
  });
  looper.restore(buffers, snap.layers.map((l) => l.gain));
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
      restoreAudio(this.ctx, this.looper, await idbGet<AudioSnapshot>('autosave'));
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
      await idbPut('autosave', snapshotAudio(this.looper));
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
    await idbPut(`slot:${name}`, snapshotAudio(this.looper));
  }

  async loadSlot(name: string): Promise<Partial<AppState> | null> {
    const raw = localStorage.getItem(`plab.slot.${name}`);
    if (!raw) return null;
    restoreAudio(this.ctx, this.looper, await idbGet<AudioSnapshot>(`slot:${name}`));
    return { ...defaultState(), ...JSON.parse(raw), playing: false, recording: false };
  }
}
