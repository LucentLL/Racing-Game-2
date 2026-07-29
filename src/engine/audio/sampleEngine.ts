/**
 * H1237: per-family RECORDED engine voice — multi-band crossfade.
 *
 * The user bought real engine packs (Skril Studio i4 Japanese, Pro
 * licence), and they ship in the industry-standard layered format that
 * every serious racing game uses — which is far richer than the H856
 * two-loop template built for the Muscle_Car V8 set:
 *
 *   idle · idle_low · low · low_med · med · med_high · high ·
 *   very_high · maxRPM      (ascending RPM bands)
 *   × each middle band has an ON-throttle and an OFF-throttle take
 *
 * So this plays them the way the recordings were designed:
 *   - the two bands bracketing current RPM play simultaneously,
 *     crossfaded by position between them (continuous timbre, no steps)
 *   - within each band, the ON and OFF takes crossfade by throttle —
 *     the LOAD axis comes from REAL RECORDINGS of an engine under load
 *     vs coasting, which no amount of filtering can fake
 *   - each band's playbackRate = actualRPM / thatBand'sNominalRPM, so
 *     pitch is continuous and sits at 1.0 (untouched recording) right
 *     at each band's home RPM
 *
 * Adding a family stays drag-and-drop: drop loops in
 * public/audio/engines/<fam>/ and list bands in manifest.json. Families
 * without a manifest entry keep the H1225 pulse-synth voice; the FI
 * layer (turbo/SC/BOV), shift pops and the H1234 clutch-cut ride on top
 * of recordings exactly as they do on the synth.
 *
 * Unused-for-now pack extras worth wiring later: startup.wav /
 * engine_stop.wav (ignition), aggressiveness_on/off_fx.wav (a natural
 * fit for the H1223 power-stage aggression axis).
 */

import { audio } from './state';
import type { EngineVoice } from './engineVoice';
import { CAM_DROPOUT_RPM } from './iconicVoices';
import { registerFamilyFoley } from './foley';

/** Nominal rev-range position of each named band (0 = idle, 1 = redline). */
const BAND_FRACS: Record<string, number> = {
  idle: 0, idle_low: 0.10, low: 0.22, low_med: 0.35, med: 0.48,
  med_high: 0.62, high: 0.75, very_high: 0.88, maxRPM: 1,
};

interface Band {
  frac: number;
  on: AudioBuffer | null;
  off: AudioBuffer | null;
  /** Files still in flight — ready only counts fully decoded bands. */
  want: number;
  got: number;
}

/** A family's decoded bands, plus the manifest entry needed to fetch them. */
interface Family {
  def: ManifestFamily;
  dir: string;
  /** null until requestFamily() has started the fetch. */
  bands: Band[] | null;
  loading: boolean;
  failed: boolean;
  /** H1285: decoded crackle layers. Optional garnish — readiness never waits
   *  on them, they simply start contributing once decoded. */
  aggOn: AudioBuffer | null;
  aggOff: AudioBuffer | null;
}

const families: Record<string, Family> = {};
let manifestTried = false;
let manifestReady = false;

/**
 * H1268: how many decoded families to keep resident.
 *
 * One family is ~17 loops × ~1.4 s of 44.1 kHz stereo, and decodeAudioData
 * expands 16-bit source to 32-bit float per channel — so a family that is 0.7 MB
 * on disk as Vorbis is roughly 8 MB of AudioBuffer once decoded. The pack has 50
 * of them; holding all of them would be ~400 MB of RAM, which is an instant
 * out-of-memory on a phone. Three is enough to cover the player's car plus the
 * one they just switched from without re-fetching on a there-and-back swap.
 */
const RESIDENT_FAMILIES = 3;
/** Most-recently-requested first. */
const lru: string[] = [];

interface Player { src: AudioBufferSourceNode; gain: GainNode }
interface Slot { bandIdx: number; on: Player | null; off: Player | null }

const play = {
  family: '',
  master: null as GainNode | null,
  /** H1251: per-car tone shaping on the family master — a peaking formant
   *  plus a high shelf for exhaust openness. Two biquads TOTAL regardless of
   *  how many cars exist, because the voice is a parameter set, not a graph. */
  peak: null as BiquadFilterNode | null,
  shelf: null as BiquadFilterNode | null,
  slots: [
    { bandIdx: -1, on: null, off: null } as Slot,
    { bandIdx: -1, on: null, off: null } as Slot,
  ],
  /** H1270: the low band of the crossfade pair, held as STATE so it can carry
   *  hysteresis. Derived fresh each frame before this, which made an rpm needle
   *  sitting on a band edge re-derive a different pair every few frames. */
  loIdx: -1,
  /** H1273: players retargeted away and now fading out. They stay AUDIBLE for
   *  ~250 ms, so they keep getting retuned — see the retune pass in
   *  updateFamilySample. `frac` is the band they carry, which is what their
   *  pitch has to be derived from. */
  fading: [] as Array<{ p: Player; frac: number; until: number }>,
  /** H1276: whether the aggressive cam profile is currently engaged. State,
   *  not a per-frame derivation, because engagement is hysteretic. */
  camOn: false,
  /** H1278: firing-wobble oscillator state. Phase advances with the engine
   *  cycle (rpm/60 × order Hz); the two multipliers are what the current
   *  frame applies to playback rate and master level. */
  lopePhase: 0,
  lopeT: 0,
  lopeWobble: 1,
  lopeLevel: 1,
  /** H1285: the two crackle-layer players (ON under throttle, OFF on the
   *  overrun) + the gains/rate the current frame computed, kept as state so
   *  the aggcheck probe can read what was applied. */
  aggOn: null as Player | null,
  aggOff: null as Player | null,
  aggOnG: 0,
  aggOffG: 0,
  aggRate: 1,
};

/**
 * H1270: how far past a band edge the rev needle must travel before the
 * crossfade pair actually changes, as a fraction of the rev range.
 *
 * Without it, ordinary cruising breathes across an edge and re-derives the pair
 * many times a second, and every flip restarts the outgoing band's source nodes.
 *
 * 0.025 is a quarter of the narrowest gap in BAND_FRACS (idle->idle_low is 0.10,
 * the rest are 0.11-0.13) so it can never skip a band, and at a 7000 rpm range
 * it is a 175 rpm dead zone. That has to clear real rpm jitter, not just
 * throttle-hold noise: the H1234 note in proceduralEngine measures a 4% bounce
 * on the limiter, and a probe at 1.5% dither across an edge still churned 6 new
 * source nodes a second at half this value.
 */
const BAND_HYST = 0.025;

/**
 * H1273: smoothing time constant on playbackRate. Was 0.04, which is where the
 * LAST of the phantom-second-engine artefacts lived.
 *
 * A slot that has been tracking RPM lags its target by roughly this constant; a
 * slot STARTED this frame begins exactly on target (startPlayer assigns
 * playbackRate.value directly). So right after a band change the two slots are
 * lagging by different amounts and therefore sound at different pitches - 72
 * cents apart at 0.04 on an RX-7 pull, both plainly audible. Measured against
 * the probe: 0.04 -> 72 cents, 0.02 -> 19, 0.012 -> 5, 0.008 -> 1.
 *
 * 0.012 is chosen rather than the minimum because the smoothing here is largely
 * redundant - proceduralEngine already conditions the RPM this is derived from
 * (its H1234 audible-rpm rate cap) - but a little is still worth keeping against
 * per-frame jitter. 5 cents is a twentieth of a semitone: inaudible.
 */
const RATE_TC = 0.012;

/** Manifest shape: { families: { i4: { dir?, bands: { med: {on,off} … } } } } */
interface ManifestBand { on?: string; off?: string; single?: string }
/** H1285: the overrun/hard-pull crackle layers + the vendor's prefab tuning.
 *  `vol`/`pitch` are (time, value) keyframes over normalized RPM — the pitch
 *  curve typically runs 0.1 → 1.0, which is what turns one crackle loop into
 *  a sparse deep burble at idle and full-rate crackle at redline. `master` is
 *  the vendor's own per-family level. All parsed from the pack's exterior HQ
 *  prefab by scripts/importEnginePack.mjs. */
interface ManifestAgg {
  on: string;
  off: string;
  master?: number;
  vol?: Array<[number, number]>;
  pitch?: Array<[number, number]>;
}
interface ManifestFamily {
  dir?: string;
  bands: Record<string, ManifestBand | string>;
  agg?: ManifestAgg;
  /** H1286: per-family ignition takes — the starter/catch and the shutdown.
   *  `startS` is the startup take's duration so the engine-on flip can land
   *  just before the crank ends (crank lengths vary per family). Registered
   *  with foley.ts at manifest load; fetched by prefetchFamilyFoley. */
  foley?: { start?: string; stop?: string; startS?: number };
}

/** Base URL of the engine-audio tree. */
function engineBase(): string {
  return import.meta.env.BASE_URL + 'audio/engines/';
}

/**
 * Fetch the MANIFEST only. It is a few KB of JSON listing 50 families; the
 * audio itself is pulled per family by requestFamily().
 *
 * Before H1268 this fetched every band of every family the moment audio
 * initialised. That was fine with one family (8 MB) and catastrophic with the
 * full pack: ~31 MB over the wire on page load and, worse, ~400 MB of decoded
 * AudioBuffer resident at once. Now nothing is fetched until a car actually
 * needs a voice.
 */
export function loadFamilySamples(_ac: AudioContext): void {
  if (manifestTried) return;
  manifestTried = true;
  fetch(engineBase() + 'manifest.json')
    .then((r) => (r.ok ? r.json() : null))
    .then((m: { families?: Record<string, ManifestFamily> } | null) => {
      if (!m?.families) return;
      for (const [fam, def] of Object.entries(m.families)) {
        const dir = engineBase() + (def.dir ?? fam) + '/';
        families[fam] = {
          def,
          dir,
          bands: null,
          loading: false,
          failed: false,
          aggOn: null,
          aggOff: null,
        };
        // H1286: hand the ignition takes to the foley layer — it owns the
        // start/stop sequencing and the engine-off prefetch.
        if (def.foley) registerFamilyFoley(fam, dir, def.foley);
      }
      manifestReady = true;
    })
    .catch(() => { /* no manifest — the pulse synth carries every family */ });
}

/** Drop the least-recently-requested families once too many are resident. */
function evictBeyondBudget(): void {
  while (lru.length > RESIDENT_FAMILIES) {
    const victim = lru.pop();
    if (!victim || victim === play.family) continue;   // never evict what's audible
    const f = families[victim];
    if (!f) continue;
    // Only the decoded buffers go; the manifest entry stays so a re-request is
    // a plain re-fetch. Any AudioBufferSourceNode still holding a buffer keeps
    // it alive until it stops — dropping our reference cannot break playback.
    f.bands = null;
    f.aggOn = null;
    f.aggOff = null;
    f.loading = false;
  }
}

/**
 * Start loading a family's bands if they are not already resident or in flight.
 * Safe to call every frame: it dedupes on `loading` and no-ops once decoded.
 * Returns nothing — callers poll familySampleReady and keep the synth voice
 * until it flips true, so a family that arrives mid-drive simply takes over.
 */
export function requestFamily(family: string): void {
  if (!family || !manifestReady) return;
  const f = families[family];
  if (!f || f.failed) return;
  // Refresh recency even when already resident, so the car being driven is
  // never the one evicted.
  const at = lru.indexOf(family);
  if (at >= 0) lru.splice(at, 1);
  lru.unshift(family);
  if (f.bands || f.loading) { evictBeyondBudget(); return; }
  const ac = audio.audioCtx;
  if (!ac) return;
  f.loading = true;

  const bands: Band[] = [];
  for (const [name, entry] of Object.entries(f.def.bands ?? {})) {
    const frac = BAND_FRACS[name];
    if (frac == null) {
      console.warn(`[sampleEngine] unknown band "${name}" in family ${family}`);
      continue;
    }
    const files = typeof entry === 'string' ? { single: entry } : entry;
    const band: Band = { frac, on: null, off: null, want: 0, got: 0 };
    const slots: Array<[keyof ManifestBand, 'on' | 'off']> = [
      ['single', 'on'], ['on', 'on'], ['off', 'off'],
    ];
    for (const [key, target] of slots) {
      const file = files[key];
      if (!file) continue;
      band.want++;
      fetch(f.dir + encodeURI(file))
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
        .then((buf) => ac.decodeAudioData(buf))
        .then((decoded) => {
          // The family may have been evicted while this was in flight; writing
          // into a detached Band array is harmless and simply gets collected.
          band[target] = decoded;
          if (key === 'single') band.off = decoded;   // idle / maxRPM serve both
          band.got++;
        })
        .catch((e) => console.warn(`[sampleEngine] ${family}/${name}/${key} (${file}):`, e));
    }
    bands.push(band);
  }
  bands.sort((a, b) => a.frac - b.frac);
  f.bands = bands;
  if (bands.length < 2) f.failed = true;              // unusable, stop retrying

  // H1285: the crackle layers ride along, non-blocking — familySampleReady
  // never waits on them, they just start contributing once decoded.
  const agg = f.def.agg;
  if (agg?.on && agg?.off) {
    const fetchAgg = (file: string, target: 'aggOn' | 'aggOff'): void => {
      fetch(f.dir + encodeURI(file))
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
        .then((buf) => ac.decodeAudioData(buf))
        .then((decoded) => { f[target] = decoded; })
        .catch((e) => console.warn(`[sampleEngine] ${family}/agg (${file}):`, e));
    };
    fetchAgg(agg.on, 'aggOn');
    fetchAgg(agg.off, 'aggOff');
  }
  evictBeyondBudget();
}

/** H1285: piecewise-linear read of a vendor prefab curve. Keyframes are
 *  (time, value) over 0..1; outside the keyed span the edge value holds. */
function evalCurve(
  keys: Array<[number, number]> | undefined,
  x: number,
  fallback: number,
): number {
  if (!keys || keys.length === 0) return fallback;
  if (keys.length === 1) return keys[0][1];
  if (x <= keys[0][0]) return keys[0][1];
  const last = keys[keys.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < keys.length; i++) {
    if (x <= keys[i][0]) {
      const [t0, v0] = keys[i - 1];
      const [t1, v1] = keys[i];
      const span = t1 - t0;
      return span > 0 ? v0 + (v1 - v0) * ((x - t0) / span) : v1;
    }
  }
  return last[1];
}

/** True once every listed band of this family is fully decoded and resident. */
export function familySampleReady(family: string): boolean {
  const bands = families[family]?.bands;
  if (!bands || bands.length < 2) return false;
  return bands.every((b) => b.want > 0 && b.got >= b.want && b.on);
}

/** True when the manifest lists this family at all — i.e. requesting it is
 *  worthwhile. Lets a caller distinguish "loading" from "no such recording". */
export function familyExists(family: string): boolean {
  return !!families[family] && !families[family].failed;
}

function stopPlayer(p: Player | null, t: number): void {
  if (!p) return;
  p.gain.gain.setTargetAtTime(0, t, 0.06);
  const s = p.src;
  setTimeout(() => { try { s.stop(); } catch { /* already stopped */ } }, 250);
}

function startPlayer(buf: AudioBuffer, rate: number): Player | null {
  if (!audio.audioCtx || !play.master) return null;
  const src = audio.audioCtx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.playbackRate.value = rate;
  const gain = audio.audioCtx.createGain();
  gain.gain.value = 0;
  src.connect(gain);
  gain.connect(play.master);
  src.start();
  return { src, gain };
}

/**
 * H1273 — WHERE A BAND LIVES ON THE REV RANGE. Geometric, not linear.
 *
 * A band used to be pinned at `idleRPM + frac * (redline - idleRPM)`. Pitch is
 * logarithmic, so on a linear ladder the low bands land absurdly close together
 * in RATIO terms — and the ratio is exactly what the playback rate has to be to
 * pitch a recording onto the current RPM. On the RX-7 FD (idle 500, redline
 * 7500) the first two rungs were 2.40x and 1.70x apart, both past the 1.5 rate
 * clamp. A clamped slot stops tracking RPM: it sits at a fixed pitch while its
 * crossfade partner tracks correctly, and the two are then audible together,
 * 214-663 cents apart through the whole bottom of the rev range. That is the
 * user's "multiple engines revving at different intervals", and it is worst
 * pulling away from idle, which is where every rev-up starts.
 *
 * It was not an RX-7 problem: 378 of 380 cars broke the clamp somewhere.
 * Geometrically, adjacent rungs sit `(redline/idle) ^ (frac gap)` apart, which
 * across the whole catalog peaks at 1.474 — inside the clamp for every car, so
 * it never binds and the two slots stay in exact unison. Endpoints are
 * unchanged (frac 0 = idle, frac 1 = redline).
 */
function bandRpmAt(frac: number, idleRPM: number, redline: number): number {
  const idle = Math.max(1, idleRPM);
  const span = Math.max(1.0001, redline / idle);
  return idle * Math.pow(span, frac);
}

/** Where the current RPM sits on that same geometric ladder, 0..1. Falls back
 *  to the caller's linear rpmNorm if the car's rev range is unusable. */
function geoPos(rpm: number, idleRPM: number, redline: number, fallback: number): number {
  const idle = Math.max(1, idleRPM);
  if (!(redline > idle)) return fallback;
  return Math.log(Math.max(idle, rpm) / idle) / Math.log(redline / idle);
}

/**
 * H1270 — THE DOUBLED-ENGINE FIX. Keep a band that is already playing.
 *
 * The two slots were bound to POSITION: slot 0 always held the low band of the
 * pair and slot 1 the high one. So the moment the rev needle crossed an edge,
 * `lo` became the index `hi` had been holding — and retargetSlot, which only
 * compares its own slot's bandIdx, could not see that the OTHER slot was
 * already playing that exact recording at near-full volume. It tore that loop
 * down (a 250 ms fade, not a stop) and started a brand-new source for the same
 * AudioBuffer from sample position 0.
 *
 * The result was two copies of the identical recording running a few hundred
 * milliseconds out of phase at nearly equal gain — which is exactly what the
 * user described as "two sets of audio playing at once". Measured on a stubbed
 * WebAudio probe before this fix: a WOT sweep created 30 sources with 8 live at
 * the peak and two copies of very_high_on.ogg 0.4 dB apart; a realistic drive
 * had a duplicated buffer audible on a third of all frames.
 *
 * Slots are bound to BAND IDENTITY now: if the pair simply shifted along, the
 * slots swap and the surviving loop keeps playing, uninterrupted and in phase.
 * Only a genuinely new band ever starts a new source.
 */
function reconcileSlots(lo: number, hi: number): void {
  const [s0, s1] = play.slots;
  // The one case that matters, and the one that used to double: the band slot 1
  // holds is the band slot 0 now wants. Swapping is free and keeps it playing.
  if (s1.bandIdx === lo || s0.bandIdx === hi) {
    play.slots[0] = s1;
    play.slots[1] = s0;
  }
}

/** Point a slot at a band index, crossfading out whatever it held. */
function retargetSlot(slot: Slot, bands: Band[], idx: number, rate: number, t: number): void {
  if (slot.bandIdx === idx) return;
  // H1273: hand the outgoing players to the fading list before dropping the
  // reference, so they can be kept in tune on the way out. Nothing used to
  // retune them, so a player fading over 250 ms held its last playback rate
  // while the engine kept climbing — a detuned ghost of the engine underneath
  // the real one, worst during exactly the hard rev-up the user described.
  const oldFrac = bands[slot.bandIdx]?.frac;
  if (oldFrac !== undefined) {
    if (slot.on) play.fading.push({ p: slot.on, frac: oldFrac, until: t + 0.3 });
    if (slot.off) play.fading.push({ p: slot.off, frac: oldFrac, until: t + 0.3 });
  }
  stopPlayer(slot.on, t);
  stopPlayer(slot.off, t);
  slot.on = null;
  slot.off = null;
  slot.bandIdx = idx;
  const b = bands[idx];
  if (!b) return;
  if (b.on) slot.on = startPlayer(b.on, rate);
  if (b.off && b.off !== b.on) slot.off = startPlayer(b.off, rate);
}

export function updateFamilySample(
  family: string,
  eligible: boolean,
  rpm: number,
  idleRPM: number,
  redline: number,
  rpmNorm: number,
  load: number,
  hpAggr: number,
  /** H1251: per-car character applied to the shared family recording. Omitted
   *  = neutral, i.e. exactly the H1237 behaviour. */
  voice?: EngineVoice,
): void {
  if (!audio.audioCtx || !audio.sfxGain) return;
  if (!eligible || !familySampleReady(family)) {
    if (play.family) stopFamilySample();
    return;
  }
  const ctx = audio.audioCtx;
  const t = ctx.currentTime;
  if (!play.master) {
    play.master = ctx.createGain();
    play.master.gain.value = 1;
    // H1251: master -> peaking formant -> high shelf -> sfx. Both default to
    // 0 dB, so a car with no voice offsets is bit-identical to pre-H1251.
    play.peak = ctx.createBiquadFilter();
    play.peak.type = 'peaking';
    play.peak.frequency.value = 600;
    play.peak.Q.value = 0.9;
    play.peak.gain.value = 0;
    play.shelf = ctx.createBiquadFilter();
    play.shelf.type = 'highshelf';
    play.shelf.frequency.value = 2600;
    play.shelf.gain.value = 0;
    play.master.connect(play.peak);
    play.peak.connect(play.shelf);
    play.shelf.connect(audio.sfxGain);
  }
  // familySampleReady already proved these are resident and decoded.
  const bands = families[family]?.bands;
  if (!bands) return;
  if (family !== play.family) {
    stopFamilySample();
    play.family = family;
  }

  // Bracketing band pair + crossfade position between them.
  //
  // H1270: `lo` is now STATE with a dead zone around each edge, not a fresh
  // derivation every frame. Re-deriving it meant a needle resting on a band
  // boundary flipped the pair back and forth several times a second, and every
  // flip used to tear down and restart loops (see reconcileSlots).
  // H1273: band position is GEOMETRIC, not linear — see bandRpmAt below.
  const r = Math.max(0, Math.min(1, geoPos(rpm, idleRPM, redline, rpmNorm)));
  const last = bands.length - 1;
  let lo = play.loIdx;
  if (lo < 0 || lo > last) {
    lo = 0;
    for (let i = 0; i < bands.length; i++) if (bands[i].frac <= r) lo = i;
  } else {
    // Advance only once the needle is clearly past the NEXT edge, and retreat
    // only once it is clearly below this band's own. Loop, so a genuine hard
    // acceleration that jumps several bands in one frame still keeps up.
    while (lo < last && r >= bands[lo + 1].frac + BAND_HYST) lo++;
    while (lo > 0 && r < bands[lo].frac - BAND_HYST) lo--;
  }
  play.loIdx = lo;
  const hi = Math.min(last, lo + 1);
  reconcileSlots(lo, hi);
  const span = bands[hi].frac - bands[lo].frac;
  const x = span > 0 ? Math.max(0, Math.min(1, (r - bands[lo].frac) / span)) : 0;
  const weights = [1 - x, x];
  const idxs = [lo, hi];

  // H1278: THE FIRING WOBBLE. A physical lope is a once-per-cycle unevenness,
  // so the oscillator's frequency is rpm-locked (rpm/60 × order Hz — ~6.7 Hz
  // for a half-order lope at 800 rpm) and its depth fades to nothing by
  // fadeTop, where real pulses fuse smooth. Applied as pitch wobble on the
  // slot rates (tc 0.012 passes 7 Hz cleanly) plus a gentler level pulse on
  // the master (tc 0.05 rounds it off — that's fine, it's the seasoning).
  // Zero new audio nodes; two multipliers computed per frame.
  {
    const dt = Math.max(0, Math.min(0.1, t - play.lopeT));
    play.lopeT = t;
    const lope = voice?.lope;
    if (lope && lope.depth > 0) {
      play.lopePhase = (play.lopePhase + Math.PI * 2 * (rpm / 60) * lope.order * dt) % (Math.PI * 2);
      const idleF = Math.max(1, idleRPM);
      const fade = Math.max(0, Math.min(1, (lope.fadeTop - rpm) / Math.max(1, lope.fadeTop - idleF)));
      const d = lope.depth * fade * fade;
      play.lopeWobble = 1 + d * Math.sin(play.lopePhase + lope.phase);
      play.lopeLevel = 1 + d * 1.2 * Math.sin(play.lopePhase + lope.phase + 1.1);
    } else {
      play.lopeWobble = 1;
      play.lopeLevel = 1;
    }
  }

  // Master level: recordings already carry load character via on/off,
  // so this only opens up modestly with throttle (+ the H1223 build lift).
  // Level-MATCHED to the pulse synth (measured: raw bands ran ~3× the
  // synth's WOT RMS, which would make every i4 jarringly loud next to a
  // synth-voiced car in the same session).
  const vol = Math.min(0.5, (0.24 + 0.24 * load) * (1 + hpAggr * 0.3))
    * (voice?.levelMul ?? 1) * (play.camOn && voice?.cam ? voice.cam.levelMul : 1)
    * play.lopeLevel;
  play.master.gain.setTargetAtTime(vol, t, 0.05);
  // H1276: THE CAM CHANGEOVER. On a VTEC/MIVEC engine the rocker arms lock
  // together within one revolution and the engine becomes a different engine —
  // the one noise a 90s Honda is known for, and the one thing a set of
  // monotone spec-derived axes structurally cannot say.
  //
  // Engagement carries the same hysteresis the real ECU does, so an engine
  // held right at the crossover picks a profile and stays there instead of
  // chattering between the two.
  //
  // The swap is a target change on filters that are already being ramped at
  // tc 0.08 — about 80 ms, which is the right order for a crossover: fast
  // enough to read as a step, slow enough not to click. Zero new audio nodes.
  const cam = voice?.cam;
  if (cam) {
    play.camOn = rpm >= (play.camOn ? cam.rpm - CAM_DROPOUT_RPM : cam.rpm);
  } else {
    play.camOn = false;
  }
  const camOn = play.camOn && !!cam;
  if (play.peak && play.shelf) {
    const basePeakHz = voice?.peakHz ?? 600;
    const basePeakDb = voice?.peakDb ?? 0;
    const baseShelf = voice?.shelfDb ?? 0;
    play.peak.frequency.setTargetAtTime(
      camOn ? basePeakHz * cam!.peakHzMul : basePeakHz, t, 0.08);
    play.peak.gain.setTargetAtTime(
      camOn ? Math.min(6, basePeakDb + cam!.peakDbAdd) : basePeakDb, t, 0.08);
    play.shelf.gain.setTargetAtTime(
      camOn ? Math.min(9, baseShelf + cam!.shelfAdd) : baseShelf, t, 0.08);
  }
  const rateMul = voice?.rateMul ?? 1;

  for (let s = 0; s < 2; s++) {
    const slot = play.slots[s];
    const idx = idxs[s];
    const band = bands[idx];
    // Pitch: 1.0 exactly at the band's home RPM, drifting only between
    // bands — keeps the recording's own character intact.
    const bandRpm = bandRpmAt(band.frac, idleRPM, redline);
    // H1251: the per-car pitch offset rides ON TOP of the band tracking, so
    // the recording still sits at its home RPM — the car just isn't the same
    // engine as the one that was recorded. H1278: the lope wobble multiplies
    // in here too; its depth is capped against the safe pitch window at
    // derivation time, so it can never drive a slot into this clamp.
    const rate = Math.max(0.66, Math.min(1.5, (rpm / Math.max(1, bandRpm)) * rateMul * play.lopeWobble));
    retargetSlot(slot, bands, idx, rate, t);
    const w = weights[s];
    // The load axis, straight from the recordings.
    if (slot.on) {
      slot.on.gain.gain.setTargetAtTime(w * load, t, 0.04);
      slot.on.src.playbackRate.setTargetAtTime(rate, t, RATE_TC);
    }
    if (slot.off) {
      slot.off.gain.gain.setTargetAtTime(w * (1 - load), t, 0.04);
      slot.off.src.playbackRate.setTargetAtTime(rate, t, RATE_TC);
    } else if (slot.on) {
      // Band has a single take — it covers both load states.
      slot.on.gain.gain.setTargetAtTime(w, t, 0.04);
    }
  }

  // H1273: keep the fading players IN TUNE while they die. Each still tracks
  // the current RPM from its OWN band's home RPM, so a listener hears one
  // engine getting quieter, not a second one going flat behind it.
  for (let i = play.fading.length - 1; i >= 0; i--) {
    const f = play.fading[i];
    if (t >= f.until) { play.fading.splice(i, 1); continue; }
    const bRpm = bandRpmAt(f.frac, idleRPM, redline);
    const rt = Math.max(0.66, Math.min(1.5, (rpm / Math.max(1, bRpm)) * rateMul * play.lopeWobble));
    f.p.src.playbackRate.setTargetAtTime(rt, t, RATE_TC);
  }

  // H1285: OVERRUN / HARD-PULL CRACKLE — the pack's aggressiveness layers,
  // finally wired. Two short loops ride the family master and split by the
  // SAME load axis the band takes use: ON crackles under throttle at high
  // rpm, OFF is the overrun burble that blooms on a lift and dies away as
  // the revs fall (the vendor's volume curve rises with rpm, so the decay
  // falls out of physics rather than an envelope). The vendor's per-family
  // master + curves come from its own prefab tuning; the car's say is
  // voice.agg — the exhaust-ladder rung — times a small power-build kicker.
  // The pitch curve is the character trick: ~0.1x rate at idle turns the
  // crackle texture into sparse deep pops; 1x at redline is full send.
  {
    const fam = families[family];
    const aggDef = fam?.def.agg;
    if (aggDef && fam.aggOn && fam.aggOff) {
      if (!play.aggOn) play.aggOn = startPlayer(fam.aggOn, 1);
      if (!play.aggOff) play.aggOff = startPlayer(fam.aggOff, 1);
      const master = (aggDef.master ?? 1)
        * (voice?.agg ?? 0.35)
        * (1 + hpAggr * 0.25);
      const volC = evalCurve(aggDef.vol, r, 0.2 + 0.8 * r);
      // Vendor boosts the ON layer while bouncing the limiter
      // (revLimiterAggressTweaker ~2). Our equivalent condition: pinned at
      // the top of the range under throttle.
      const limiterBoost = r > 0.97 && load > 0.5 ? 1.8 : 1;
      play.aggOnG = Math.min(1.2, master * volC * load * limiterBoost);
      play.aggOffG = Math.min(1.2, master * volC * (1 - load));
      play.aggRate = Math.max(0.05, Math.min(2.5,
        evalCurve(aggDef.pitch, r, 0.1 + 0.9 * r) * rateMul));
      if (play.aggOn) {
        play.aggOn.gain.gain.setTargetAtTime(play.aggOnG, t, 0.045);
        play.aggOn.src.playbackRate.setTargetAtTime(play.aggRate, t, RATE_TC);
      }
      if (play.aggOff) {
        play.aggOff.gain.gain.setTargetAtTime(play.aggOffG, t, 0.045);
        play.aggOff.src.playbackRate.setTargetAtTime(play.aggRate, t, RATE_TC);
      }
    }
  }
}

export function isFamilySampleActive(): boolean {
  return !!play.family;
}

/** H1270: test surface for tools/audiolab/voicecheck.mjs. The band crossfade is
 *  where a user-reported doubling lived, so it gets a probe that can drive it
 *  without a browser: installTestFamily injects decoded bands directly (no
 *  fetch, no decodeAudioData) and currentLoIdx exposes the hysteresis state. */
export const _sampleInternals = {
  installTestFamily(
    name: string,
    bands: Array<{ frac: number; on: unknown; off: unknown }>,
    agg?: { def: ManifestAgg; on: unknown; off: unknown },
  ): void {
    families[name] = {
      def: { bands: {}, ...(agg ? { agg: agg.def } : {}) } as unknown as ManifestFamily,
      dir: '', loading: false, failed: false,
      aggOn: (agg?.on ?? null) as AudioBuffer | null,
      aggOff: (agg?.off ?? null) as AudioBuffer | null,
      bands: bands.map((b) => ({
        frac: b.frac,
        on: b.on as AudioBuffer,
        off: b.off as AudioBuffer,
        want: 1, got: 1,
      })),
    };
  },
  currentLoIdx(): number { return play.loIdx; },
  camEngaged(): boolean { return play.camOn; },
  /** H1278: the rate multiplier the firing wobble applied this frame. */
  lopeWobble(): number { return play.lopeWobble; },
  /** H1285: what the crackle layers were told to do this frame. */
  aggState(): { onG: number; offG: number; rate: number; live: boolean } {
    return {
      onG: play.aggOnG, offG: play.aggOffG, rate: play.aggRate,
      live: !!(play.aggOn && play.aggOff),
    };
  },
  filterState(): { peakHz: number; peakDb: number; shelfDb: number } {
    return {
      peakHz: play.peak?.frequency.value ?? 0,
      peakDb: play.peak?.gain.value ?? 0,
      shelfDb: play.shelf?.gain.value ?? 0,
    };
  },
  bandRpmAt,
};

export function duckFamilySample(t: number): void {
  play.master?.gain.setTargetAtTime(0, t, 0.15);
}

export function stopFamilySample(): void {
  const t = audio.audioCtx?.currentTime ?? 0;
  for (const slot of play.slots) {
    stopPlayer(slot.on, t);
    stopPlayer(slot.off, t);
    slot.on = null;
    slot.off = null;
    slot.bandIdx = -1;
  }
  // H1285: the crackle layers die with the voice.
  stopPlayer(play.aggOn, t);
  stopPlayer(play.aggOff, t);
  play.aggOn = null;
  play.aggOff = null;
  play.aggOnG = 0;
  play.aggOffG = 0;
  play.aggRate = 1;
  play.family = '';
  play.loIdx = -1;   // H1270: next family re-derives its band pair from scratch
  play.fading.length = 0;
  play.camOn = false;
  play.lopePhase = 0;
  play.lopeWobble = 1;
  play.lopeLevel = 1;
}
