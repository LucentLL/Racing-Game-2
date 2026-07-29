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
 *
 * H1286: the starter and the shutdown are PER-FAMILY now — every recorded
 * engine family ships its own startup/engine_stop take, so a V8 cranks
 * like a V8, a rotary like a rotary, a bike like a bike. sampleEngine
 * registers each family's takes as it parses the manifest; the gameLoop
 * prefetches the active car's pair while the engine is off. The generic
 * i4 takes (the H1238 files) stay as the fallback for synth-voiced cars
 * and for a first-ever start whose fetch is still in flight — and since
 * crank lengths vary per family, playCarEntry now RETURNS the catch
 * delay instead of the caller reading fixed constants.
 */

import { audio } from './state';

/** Lazy so the audiolab node bundle can import this module — import.meta.env
 *  is a Vite global that does not exist under plain node (same pattern as
 *  sampleEngine's engineBase()). */
function foleyBase(): string {
  return `${import.meta.env.BASE_URL}audio/foley/`;
}

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
    fetch(foleyBase() + encodeURI(file))
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
export function playEngineShutdown(withCooldown = true, family?: string | null): void {
  const ctx = audio.audioCtx;
  if (!ctx) return;
  // H1286: this family's own shutdown take when resident, generic otherwise.
  const f = family ? famFoley[family] : undefined;
  if (f && f.state === 'ready' && f.stop) playFamilyBuf(f.stop, 0.55, 0);
  else playFoley('stop', 0.55);
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

// ---------------------------------------------------------------------------
// H1286: per-family ignition takes.
// ---------------------------------------------------------------------------

interface FamilyFoleyDef { start?: string; stop?: string; startS?: number }
interface FamilyFoley {
  def: FamilyFoleyDef;
  dir: string;
  state: 'idle' | 'loading' | 'ready' | 'failed';
  start: AudioBuffer | null;
  stop: AudioBuffer | null;
}

const famFoley: Record<string, FamilyFoley> = {};
/** Most-recently-prefetched first; decoded buffers beyond the cap are
 *  dropped (a start take is ~1.3s of stereo — small, but 33 families of
 *  them is pointless residency). */
const famLru: string[] = [];
const FOLEY_RESIDENT = 3;

/** sampleEngine calls this per manifest family at load. Registration only —
 *  nothing is fetched until the gameLoop prefetches the active car's pair. */
export function registerFamilyFoley(family: string, dir: string, def: FamilyFoleyDef): void {
  if (!def.start || !def.stop || famFoley[family]) return;
  famFoley[family] = { def, dir, state: 'idle', start: null, stop: null };
}

/** Fetch + decode a family's ignition pair. Idempotent and cheap to call
 *  every frame; the gameLoop fires it while the engine is OFF so the take
 *  is resident by the time the player hits START. */
export function prefetchFamilyFoley(family: string | null | undefined): void {
  if (!family) return;
  const f = famFoley[family];
  const ac = audio.audioCtx;
  if (!f || !ac || f.state === 'loading' || f.state === 'ready' || f.state === 'failed') return;
  f.state = 'loading';
  const at = famLru.indexOf(family);
  if (at >= 0) famLru.splice(at, 1);
  famLru.unshift(family);
  while (famLru.length > FOLEY_RESIDENT) {
    const victim = famLru.pop();
    const v = victim ? famFoley[victim] : undefined;
    if (v) { v.start = null; v.stop = null; v.state = 'idle'; }
  }
  let got = 0;
  const grab = (file: string, target: 'start' | 'stop'): void => {
    fetch(f.dir + encodeURI(file))
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((b) => ac.decodeAudioData(b))
      .then((d) => {
        f[target] = d;
        if (++got === 2) f.state = 'ready';
      })
      .catch((e) => {
        f.state = 'failed';
        console.warn(`[foley] ${family}/${file}:`, e);
      });
  };
  grab(f.def.start!, 'start');
  grab(f.def.stop!, 'stop');
}

/** When the engine flip should land inside a startup take: just before the
 *  take runs out, floored so a very short take still reads as a crank.
 *  The i4 reference take (1.27s) lands at 0.92s — within a frame of the
 *  hand-tuned H1238 value (0.95s), which is the calibration point. Pure so
 *  the probe can pin it. */
export function familyCatchDelayMs(startS: number, withDoors: boolean): number {
  const catchMs = Math.max(300, startS * 1000 - 350);
  return (withDoors ? 1000 : 0) + Math.round(catchMs);
}

function playFamilyBuf(buf: AudioBuffer, vol: number, delay: number): void {
  const ctx = audio.audioCtx;
  if (!ctx || !audio.sfxGain) return;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  g.gain.value = vol;
  src.connect(g);
  g.connect(audio.sfxGain);
  src.start(ctx.currentTime + delay);
}

/** Getting in and firing it up: door open, door thunk, starter, catch.
 *  `withDoors` is false when the player never left the car (an in-world
 *  restart after PARK) — just the starter then.
 *
 *  H1286: pass the car's recorded `family` to crank ITS starter; returns
 *  the milliseconds until the engine-on flip should land so the tach and
 *  the audio agree per take. Falls back to the generic i4 take (and the
 *  H1238 constants) when the family take isn't resident. */
export function playCarEntry(withDoors = true, family?: string | null): number {
  stopMufflerCooldown();
  if (withDoors) {
    playFoley('doorOpen', 0.5);
    playFoley('doorClose', 0.55, 0.55);
  }
  const crankAt = withDoors ? 1.0 : 0;
  const f = family ? famFoley[family] : undefined;
  if (f && f.state === 'ready' && f.start) {
    playFamilyBuf(f.start, 0.6, crankAt);
    return familyCatchDelayMs(f.def.startS ?? f.start.duration, withDoors);
  }
  playFoley('startup', 0.6, crankAt);
  return withDoors ? CAR_ENTRY_START_DELAY_MS : RESTART_START_DELAY_MS;
}

/** Door-only cue, for flows that just open or shut a door. */
export function playDoor(which: 'open' | 'close'): void {
  playFoley(which === 'open' ? 'doorOpen' : 'doorClose', 0.5);
}

/** H1286: test surface for tools/audiolab/foleycheck.mjs — install a family
 *  take as already-resident (no fetch), and read a family's load state. */
export const _foleyInternals = {
  installReady(family: string, startS: number): void {
    famFoley[family] = {
      def: { start: 'x.ogg', stop: 'y.ogg', startS },
      dir: '',
      state: 'ready',
      start: { duration: startS } as AudioBuffer,
      stop: { duration: 0.9 } as AudioBuffer,
    };
  },
  state(family: string): string {
    return famFoley[family]?.state ?? 'unregistered';
  },
};

/** How long after playCarEntry() the engine actually catches — the
 *  gameplay engine-on flip waits this long so the tach and the audio
 *  agree with the starter sound. The starter take is ~1.26s: with doors
 *  it is scheduled 1.0s in (door, thunk, crank), so the catch lands at
 *  1.9s — just before the crank finishes, which is how a real start
 *  sounds. Bare restart: crank at 0, catch at 0.95s. */
export const CAR_ENTRY_START_DELAY_MS = 1900;
export const RESTART_START_DELAY_MS = 950;
