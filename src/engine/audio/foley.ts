/**
 * H1238: car foley one-shots — ignition, doors, and the hot-muffler
 * cooldown tail, from the user's purchased packs (Skril i4 startup /
 * engine_stop; Car Essential Sounds doors + Other/Hot_muffler_sfx).
 *
 * Follows the sfx.ts one-shot contract: fetch + decodeAudioData once at
 * init, then each play creates a throwaway BufferSource → gain →
 * sfxGain. Missing files degrade to silence, never throw.
 *
 * The sequences are the audible half of the park/ignition loop:
 *   PARK      → engine_stop, then the muffler ticks as it cools
 *   GET IN    → door_open · door_close · starter cranks · idle catches
 */

import { audio } from './state';

const FOLEY_BASE = `${import.meta.env.BASE_URL}audio/foley/`;

const FILES = {
  startup: 'engine_startup.wav',
  stop: 'engine_stop.wav',
  doorOpen: 'door_open.wav',
  doorClose: 'door_close.wav',
  muffler: 'hot_muffler.wav',
} as const;

type FoleyKey = keyof typeof FILES;

const buffers: Partial<Record<FoleyKey, AudioBuffer>> = {};
let loaded = false;

/** Live muffler-cooldown voice, so a re-park (or a restart) can cut it. */
let mufflerGain: GainNode | null = null;
let mufflerSrc: AudioBufferSourceNode | null = null;

export function loadFoley(ac: AudioContext): void {
  if (loaded) return;
  loaded = true;
  for (const [key, file] of Object.entries(FILES) as Array<[FoleyKey, string]>) {
    fetch(FOLEY_BASE + encodeURI(file))
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((b) => ac.decodeAudioData(b))
      .then((d) => { buffers[key] = d; })
      .catch((e) => console.warn(`[foley] ${file}:`, e));
  }
}

/** Fire a one-shot. `delay` in seconds lets callers script a sequence
 *  on the audio clock instead of with setTimeout drift. */
function playFoley(key: FoleyKey, vol = 0.6, delay = 0): AudioBufferSourceNode | null {
  const ctx = audio.audioCtx;
  const buf = buffers[key];
  if (!ctx || !audio.sfxGain || !buf) return null;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  g.gain.value = vol;
  src.connect(g);
  g.connect(audio.sfxGain);
  src.start(ctx.currentTime + delay);
  return src;
}

/** Engine shutdown: the stop take, then the exhaust ticking as it cools.
 *  The muffler recording is long and quiet on purpose — it should read as
 *  a detail you notice while standing next to a car you just parked.
 *  `withCooldown` false skips the tail (garage entry, where the player is
 *  immediately inside a menu and 20s of ticking under it is just noise). */
export function playEngineShutdown(withCooldown = true): void {
  const ctx = audio.audioCtx;
  if (!ctx) return;
  playFoley('stop', 0.55);
  stopMufflerCooldown();
  if (!withCooldown) return;
  const buf = buffers.muffler;
  if (!buf || !audio.sfxGain) return;
  mufflerSrc = ctx.createBufferSource();
  mufflerSrc.buffer = buf;
  mufflerGain = ctx.createGain();
  // Fade in behind the shutdown, then decay away over the recording —
  // hot metal contracts fastest right after shutoff.
  mufflerGain.gain.setValueAtTime(0.0001, ctx.currentTime);
  mufflerGain.gain.linearRampToValueAtTime(0.34, ctx.currentTime + 1.2);
  // tau 3s, not 12 — the recording is ~10s long, so a 12s decay was still
  // at 56% of peak when the buffer simply ran out (an audible chop). This
  // lands near-silent by the time the take ends.
  mufflerGain.gain.setTargetAtTime(0.02, ctx.currentTime + 1.2, 3);
  mufflerSrc.connect(mufflerGain);
  mufflerGain.connect(audio.sfxGain);
  mufflerSrc.start(ctx.currentTime + 0.35);
}

export function stopMufflerCooldown(): void {
  const ctx = audio.audioCtx;
  if (mufflerGain && ctx) {
    try {
      mufflerGain.gain.cancelScheduledValues(ctx.currentTime);
      mufflerGain.gain.setTargetAtTime(0, ctx.currentTime, 0.15);
    } catch { /* node in a bad state */ }
  }
  if (mufflerSrc) {
    const s = mufflerSrc;
    setTimeout(() => { try { s.stop(); } catch { /* already stopped */ } }, 600);
  }
  mufflerSrc = null;
  mufflerGain = null;
}

/** Getting in and firing it up: door open, door thunk, starter, catch.
 *  `withDoors` is false when the player never left the car (an in-world
 *  restart after PARK) — just the starter then. */
export function playCarEntry(withDoors = true): void {
  stopMufflerCooldown();
  if (withDoors) {
    playFoley('doorOpen', 0.5);
    playFoley('doorClose', 0.55, 0.55);
    playFoley('startup', 0.6, 1.0);
  } else {
    playFoley('startup', 0.6);
  }
}

/** Door-only cue, for flows that just open or shut a door. */
export function playDoor(which: 'open' | 'close'): void {
  playFoley(which === 'open' ? 'doorOpen' : 'doorClose', 0.5);
}

/** How long after playCarEntry() the engine actually catches — the
 *  gameplay engine-on flip waits this long so the tach and the audio
 *  agree with the starter sound. The starter take is ~1.26s: with doors
 *  it is scheduled 1.0s in (door, thunk, crank), so the catch lands at
 *  1.9s — just before the crank finishes, which is how a real start
 *  sounds. Bare restart: crank at 0, catch at 0.95s. */
export const CAR_ENTRY_START_DELAY_MS = 1900;
export const RESTART_START_DELAY_MS = 950;
