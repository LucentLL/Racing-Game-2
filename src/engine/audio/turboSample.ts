/**
 * H1254: RECORDED turbo voice — the user's Skril Studio "Turbo Sounds" pack.
 *
 * H1222 built the turbo out of oscillators and filtered noise, and it took
 * two rounds of rework (H1225 "disturbing electric whine", H1230) to stop it
 * sounding synthetic. This replaces it with the real recordings, the same way
 * H1237 replaced the synth engine voice with the recorded i4 family.
 *
 * The pack ships 10 turbo KITS — 10 genuinely different turbochargers, from a
 * deep big-single to a small screamer. Each kit is:
 *
 *   loop_N.wav      spool loop, plays while the throttle is down
 *   maxLoop_N.wav   the same turbo held against the rev limiter
 *   long_shot_*     6 blow-off releases from high revs
 *   short_shot_*    6 blow-off releases from part revs
 *
 * PLAYBACK IS THE VENDOR'S OWN CONTRACT, ported from the TurboCharger.cs
 * controller and the TurboCharger_N prefabs shipped in the pack:
 *
 *   - the spool loop plays ONLY while the throttle is down; its gain is
 *     loopVol(rpmNorm) x masterVolume x loopVolume x load and its playback
 *     rate is loopPitch(rpmNorm) — so the turbo tracks CRANK SPEED, not a
 *     boost model (the pack was recorded that way; see the note below)
 *   - near the limiter the maxLoop replaces the spool loop
 *   - releasing the throttle fires exactly ONE shot — long above
 *     longShotThreshold of the rev range, short below, chosen at random from
 *     that kit's six — at shotVol(rpmNorm) x masterVolume
 *
 * The curves are Unity AnimationCurves read straight off the prefabs and
 * carried in the manifest as [time, value, inSlope, outSlope] keys; evalCurve
 * below is Unity's cubic Hermite with clamped ends (PreInfinity = 2).
 *
 * TWO DELIBERATE ADAPTATIONS, both carrying forward behaviour H1222/H1223
 * already shipped rather than inventing anything new:
 *
 *   1. Analog throttle. Unity hands the controller a BOOL pedal; this game has
 *      a real 0..1 axis, so "pressing" is hysteretic (down above GAS_ON, up
 *      below GAS_OFF, the H1222 blow-off thresholds) and the loop gain rises
 *      on a slower time constant than it falls. That asymmetry IS spool lag —
 *      it replaces the fiBoostStep proxy rather than stacking on it.
 *   2. Power stage. The upgrade ladder is a turbo-kit fiction, so a staged car
 *      gets a slightly bigger-sounding turbo: a touch louder and pitched down
 *      up to 12% at stage 4. Same axis fiWhineFreq/fiWhineGain drove on the
 *      synth voice, applied to a recording instead.
 *
 * Only the kit a car actually uses is fetched (~2-4MB), never all 33MB.
 * Everything degrades to silence — if the manifest or the clips don't load,
 * turboSampleReady stays false and forcedInduction keeps the synth whistle.
 */

import { audio } from './state';

const BASE = `${import.meta.env.BASE_URL}audio/turbo/`;

/** Unity AnimationCurve key: [time, value, inSlope, outSlope]. */
export type CurveKey = [number, number, number, number];

/** Throttle hysteresis standing in for Unity's bool `gasPedalPressing`, used
 *  to arm and fire the blow-off. These are the H1222 thresholds, so a release
 *  still fires exactly where the synthetic valve used to, and pedal chatter
 *  around one threshold can't machine-gun the valve. */
const GAS_ON = 0.45;
const GAS_OFF = 0.2;
/** Spool lag: the loop opens up slowly and collapses fast (a closed throttle
 *  kills drive pressure almost immediately). Seconds, as setTargetAtTime taus. */
const SPOOL_UP_TAU = 0.13;
const SPOOL_DOWN_TAU = 0.045;
/** Width of the crossfade into the rev-limiter loop, in rpmNorm. A hard swap
 *  at the threshold clicks. */
const LIMITER_BLEND = 0.03;

/**
 * Evaluate a Unity AnimationCurve at `x`. Cubic Hermite between keys, clamped
 * to the end values outside the key range — the pack's curves all carry
 * PreInfinity/PostInfinity = 2 (ClampForever).
 *
 * Exported for headless verification; the sound itself is ear-tested.
 */
export function evalCurve(keys: CurveKey[], x: number): number {
  if (!keys || keys.length === 0) return 0;
  if (keys.length === 1 || x <= keys[0][0]) return keys[0][1];
  const last = keys[keys.length - 1];
  if (x >= last[0]) return last[1];
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1][0] <= x) i++;
  const [t0, v0, , outSlope] = keys[i];
  const [t1, v1, inSlope] = keys[i + 1];
  const span = t1 - t0;
  if (span <= 0) return v0;
  const t = (x - t0) / span;
  const m0 = outSlope * span;
  const m1 = inSlope * span;
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * v0
    + (t3 - 2 * t2 + t) * m0
    + (-2 * t3 + 3 * t2) * v1
    + (t3 - t2) * m1;
}

interface KitDef {
  loop: string;
  maxLoop: string;
  long: string[];
  short: string[];
}

interface TurboManifest {
  masterVolume?: number;
  loopVolume?: number;
  longShotThreshold?: number;
  limiterAt?: number;
  curves?: { loopVol?: CurveKey[]; loopPitch?: CurveKey[]; shotVol?: CurveKey[] };
  kits?: Record<string, KitDef>;
}

interface Kit {
  def: KitDef;
  loop: AudioBuffer | null;
  maxLoop: AudioBuffer | null;
  long: AudioBuffer[];
  short: AudioBuffer[];
  /** Fetches still in flight — a kit only goes live once loading settles, so
   *  the voice never starts on a half-decoded set. */
  pending: number;
  requested: boolean;
}

/** Manifest defaults mirror the shipped TurboCharger_N prefabs, so a missing
 *  or partial manifest still plays the way the pack was authored. */
const cfg = {
  masterVolume: 0.5,
  loopVolume: 0.8,
  longShotThreshold: 0.8,
  limiterAt: 0.97,
  loopVol: [[0.4, 0, 1.0909665, 1.0909665], [1, 0.35270923, -0.028526865, -0.028526865]] as CurveKey[],
  loopPitch: [[0, 0.5, 1, 1], [1, 1.5, 1, 1]] as CurveKey[],
  shotVol: [[0.5, 0, 2.45083, 2.45083], [0.9005, 1, 0.39042124, 0.39042124], [1, 1, 0, 0]] as CurveKey[],
};

const kits: Record<string, Kit> = {};
let manifestTried = false;
let ctxRef: AudioContext | null = null;

/** Fetch + decode one clip into the kit, counting it in/out of `pending`. */
function loadClip(ac: AudioContext, kit: Kit, file: string, sink: (b: AudioBuffer) => void): void {
  kit.pending++;
  fetch(BASE + encodeURI(file))
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
    .then((b) => ac.decodeAudioData(b))
    .then((d) => { sink(d); })
    .catch((e) => console.warn(`[turboSample] ${file}:`, e))
    .finally(() => { kit.pending--; });
}

/** Read the manifest (JSON only — no audio). Called once from audio init;
 *  the clips themselves wait until a car actually needs a kit. */
export function loadTurboManifest(ac: AudioContext): void {
  if (manifestTried) return;
  manifestTried = true;
  ctxRef = ac;
  fetch(BASE + 'manifest.json')
    .then((r) => (r.ok ? r.json() : null))
    .then((m: TurboManifest | null) => {
      if (!m?.kits) return;
      cfg.masterVolume = m.masterVolume ?? cfg.masterVolume;
      cfg.loopVolume = m.loopVolume ?? cfg.loopVolume;
      cfg.longShotThreshold = m.longShotThreshold ?? cfg.longShotThreshold;
      cfg.limiterAt = m.limiterAt ?? cfg.limiterAt;
      cfg.loopVol = m.curves?.loopVol ?? cfg.loopVol;
      cfg.loopPitch = m.curves?.loopPitch ?? cfg.loopPitch;
      cfg.shotVol = m.curves?.shotVol ?? cfg.shotVol;
      for (const [name, def] of Object.entries(m.kits)) {
        kits[name] = {
          def, loop: null, maxLoop: null, long: [], short: [], pending: 0, requested: false,
        };
      }
    })
    .catch(() => { /* no manifest — the synth whistle carries every turbo */ });
}

/** Start fetching a kit's 14 clips, once. No-op if the manifest hasn't landed
 *  yet; the next frame that asks for the kit will start it. */
export function requestTurboKit(name: string): void {
  const kit = kits[name];
  const ac = ctxRef ?? audio.audioCtx;
  if (!kit || kit.requested || !ac) return;
  kit.requested = true;
  loadClip(ac, kit, kit.def.loop, (b) => { kit.loop = b; });
  loadClip(ac, kit, kit.def.maxLoop, (b) => { kit.maxLoop = b; });
  for (const f of kit.def.long ?? []) loadClip(ac, kit, f, (b) => { kit.long.push(b); });
  for (const f of kit.def.short ?? []) loadClip(ac, kit, f, (b) => { kit.short.push(b); });
}

/** True once this kit has settled with the clips it needs to speak. A shot
 *  that 404s just shortens the random pool; a missing loop keeps the kit
 *  silent and hands the turbo back to the synth. */
export function turboSampleReady(name: string): boolean {
  const kit = kits[name];
  return !!kit && kit.requested && kit.pending === 0
    && !!kit.loop && !!kit.maxLoop && kit.long.length > 0 && kit.short.length > 0;
}

interface Loop { src: AudioBufferSourceNode; gain: GainNode }

const play = {
  kit: '',
  master: null as GainNode | null,
  spool: null as Loop | null,
  limiter: null as Loop | null,
  /** Vendor `oneShotController`: armed by holding throttle, spent on release,
   *  so pedal chatter can't machine-gun the valve. */
  armed: false,
  gasDown: false,
  /** Live blow-off, so re-applying throttle can cut it (vendor: oneShot.Stop). */
  shotGain: null as GainNode | null,
  shotSrc: null as AudioBufferSourceNode | null,
  lastLong: -1,
  lastShort: -1,
  prevLoopGain: 0,
  /** H1255: audio-clock time of the last shot, so a manual lift-and-shift
   *  fires ONE flutter rather than the release valve and the shift stacking
   *  on top of each other. */
  lastShotAt: -1,
};

function startLoop(buf: AudioBuffer): Loop | null {
  const ctx = audio.audioCtx;
  if (!ctx || !play.master) return null;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  src.connect(gain);
  gain.connect(play.master);
  src.start();
  return { src, gain };
}

function stopLoop(l: Loop | null, t: number): void {
  if (!l) return;
  l.gain.gain.cancelScheduledValues(t);
  l.gain.gain.setTargetAtTime(0, t, 0.05);
  const s = l.src;
  setTimeout(() => { try { s.stop(); } catch { /* already stopped */ } }, 250);
}

/** Random clip from a pool, never the one that just played. */
function pick(pool: AudioBuffer[], last: number): number {
  if (pool.length <= 1) return 0;
  let i = Math.floor(Math.random() * pool.length);
  if (i === last) i = (i + 1) % pool.length;
  return i;
}

/**
 * Fire one blow-off.
 *
 * `long` false forces the short pool — H1255 uses that for the flick of
 * pressure a gearshift releases, which is a different event from a driver
 * lifting off and is what the pack's two shot categories are FOR.
 * `volMul` trims that shorter event under a full lift.
 */
function fireShot(
  kit: Kit, rpmNorm: number, stage: number, long: boolean, volMul = 1,
): void {
  const ctx = audio.audioCtx;
  if (!ctx || !play.master) return;
  const vol = evalCurve(cfg.shotVol, rpmNorm) * cfg.masterVolume
    * (1 + 0.12 * stage) * volMul;
  if (vol <= 0.001) return;   // vendor curve is flat 0 below half revs
  const pool = long ? kit.long : kit.short;
  if (pool.length === 0) return;
  const idx = pick(pool, long ? play.lastLong : play.lastShort);
  if (long) play.lastLong = idx; else play.lastShort = idx;
  cutShot();
  const src = ctx.createBufferSource();
  src.buffer = pool[idx];
  // Bigger turbo = lower-pitched dump, matching the loop's stage offset.
  src.playbackRate.value = 1 - 0.03 * stage;
  const g = ctx.createGain();
  g.gain.value = Math.min(1, vol);
  src.connect(g);
  g.connect(play.master);
  src.start();
  play.shotSrc = src;
  play.shotGain = g;
  play.lastShotAt = ctx.currentTime;
}

/** Vendor `oneShot.Stop()` — kill an in-flight psshh (throttle re-applied,
 *  or a race restart). Faded rather than hard-stopped so it doesn't click. */
function cutShot(): void {
  const ctx = audio.audioCtx;
  if (play.shotGain && ctx) {
    try {
      play.shotGain.gain.cancelScheduledValues(ctx.currentTime);
      play.shotGain.gain.setTargetAtTime(0, ctx.currentTime, 0.02);
    } catch { /* node in a bad state */ }
  }
  if (play.shotSrc) {
    const s = play.shotSrc;
    setTimeout(() => { try { s.stop(); } catch { /* already stopped */ } }, 120);
  }
  play.shotSrc = null;
  play.shotGain = null;
}

/**
 * Per-frame update. Returns true when the recording is carrying the turbo,
 * which is forcedInduction's signal to hold the synthetic whistle silent.
 *
 * `kitName` is the car's assigned kit (engineVoice.turboKit); `eligible` is
 * the existing fiTurboEligible verdict; `load` is the analog throttle.
 */
export function updateTurboSample(
  kitName: string,
  eligible: boolean,
  rpmNorm: number,
  load: number,
  stage: number,
): boolean {
  const ctx = audio.audioCtx;
  if (!ctx || !audio.sfxGain) return false;
  if (!eligible || !kitName) {
    if (play.kit) stopTurboSample();
    return false;
  }
  if (!turboSampleReady(kitName)) {
    requestTurboKit(kitName);
    if (play.kit) stopTurboSample();
    return false;
  }
  const kit = kits[kitName];
  const t = ctx.currentTime;

  if (!play.master) {
    play.master = ctx.createGain();
    play.master.gain.value = 1;
    play.master.connect(audio.sfxGain);
  }
  if (play.kit !== kitName) {
    stopLoop(play.spool, t);
    stopLoop(play.limiter, t);
    play.spool = kit.loop ? startLoop(kit.loop) : null;
    play.limiter = kit.maxLoop ? startLoop(kit.maxLoop) : null;
    play.kit = kitName;
    play.prevLoopGain = 0;
  }
  play.master.gain.setTargetAtTime(1, t, 0.05);

  const r = Math.max(0, Math.min(1, rpmNorm));
  const gas = Math.max(0, Math.min(1, load));

  // Hysteretic stand-in for the vendor's bool pedal.
  if (gas >= GAS_ON) play.gasDown = true;
  else if (gas <= GAS_OFF) play.gasDown = false;

  if (play.gasDown) {
    play.armed = true;
    cutShot();
  } else if (play.armed) {
    play.armed = false;
    fireShot(kit, r, stage, r > cfg.longShotThreshold);
  }

  // Spool loop. The vendor hard-stops it on release, but its `engineLoad`
  // factor already fades the loop out as the pedal comes up — so the analog
  // throttle multiplies directly instead of going through the GAS_ON/GAS_OFF
  // gate. Routing the loop through that gate too would leave a dead zone
  // where a part-throttle cruise below 45% made no turbo noise at all.
  const target = evalCurve(cfg.loopVol, r)
    * cfg.masterVolume * cfg.loopVolume * gas * (1 + 0.15 * stage);
  // Asymmetric: slow to build charge, quick to lose it.
  const tau = target > play.prevLoopGain ? SPOOL_UP_TAU : SPOOL_DOWN_TAU;
  play.prevLoopGain = target;

  // Crossfade into the rev-limiter take instead of swapping at a threshold.
  const limMix = Math.max(0, Math.min(1,
    (r - (cfg.limiterAt - LIMITER_BLEND)) / LIMITER_BLEND));
  // Stage pitches the whole turbo down — a bigger compressor spins slower.
  const rate = evalCurve(cfg.loopPitch, r) * (1 - 0.03 * stage);

  if (play.spool) {
    play.spool.gain.gain.setTargetAtTime(target * (1 - limMix), t, tau);
    play.spool.src.playbackRate.setTargetAtTime(Math.max(0.25, rate), t, 0.04);
  }
  if (play.limiter) {
    play.limiter.gain.gain.setTargetAtTime(target * limMix, t, tau);
    play.limiter.src.playbackRate.setTargetAtTime(Math.max(0.25, rate), t, 0.04);
  }
  return true;
}

export function isTurboSampleActive(): boolean {
  return !!play.kit;
}

/** Minimum gap between shots. A manual lift-and-shift trips the release valve
 *  and the gearchange within a few frames of each other; without this they
 *  stack into a double psshh. */
const SHIFT_MIN_GAP_S = 0.22;
/** A shift only flutters if the driver is actually ON it — rolling up through
 *  the gears off-throttle releases nothing. */
const SHIFT_MIN_GAS = 0.3;
/** A gearchange vents a flick of pressure, not the whole charge a full lift
 *  dumps, so the same curve plays back trimmed. */
const SHIFT_VOL_MUL = 0.55;

/**
 * H1255: the flutter between gears.
 *
 * The lift-off valve above can never fire on an automatic upshift, because the
 * throttle stays pinned right through it — so a car at full noise up the gears
 * was silent at the one moment a turbo is loudest. This is that shot: the
 * SHORT pool (a gearchange is a brief release, which is what those takes are),
 * trimmed under a full lift, on upshifts only.
 *
 * Silent unless a recorded kit is actually playing — the synth turbo path is
 * left exactly as H1222 shipped it.
 */
export function fireTurboShift(rpmNorm: number, gasA: number, stage: number): void {
  const ctx = audio.audioCtx;
  if (!ctx || !play.kit || gasA < SHIFT_MIN_GAS) return;
  if (play.lastShotAt >= 0 && ctx.currentTime - play.lastShotAt < SHIFT_MIN_GAP_S) return;
  const kit = kits[play.kit];
  if (!kit) return;
  fireShot(kit, Math.max(0, Math.min(1, rpmNorm)), stage, false, SHIFT_VOL_MUL);
}

/** Menu open / engine off — fade every turbo voice (mirrors duckFamilySample).
 *  The arm latch is cleared too: throttle is pinned entering a garage and
 *  reads 0 on exit, which would otherwise dump a phantom blow-off minutes
 *  later (the H1222 duck fixed exactly this for the synthetic valve). */
export function duckTurboSample(t: number): void {
  play.armed = false;
  play.gasDown = false;
  play.prevLoopGain = 0;
  play.lastShotAt = -1;
  play.master?.gain.setTargetAtTime(0, t, 0.15);
  cutShot();
}

/** Hard reset for race restarts / teleports (H1028 snap-to-silence). */
export function stopTurboSample(): void {
  const t = audio.audioCtx?.currentTime ?? 0;
  stopLoop(play.spool, t);
  stopLoop(play.limiter, t);
  cutShot();
  play.spool = null;
  play.limiter = null;
  play.kit = '';
  play.armed = false;
  play.gasDown = false;
  play.prevLoopGain = 0;
  play.lastShotAt = -1;
}
