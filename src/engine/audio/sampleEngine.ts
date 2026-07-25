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

const families: Record<string, Band[]> = {};
let manifestTried = false;

interface Player { src: AudioBufferSourceNode; gain: GainNode }
interface Slot { bandIdx: number; on: Player | null; off: Player | null }

const play = {
  family: '',
  master: null as GainNode | null,
  slots: [
    { bandIdx: -1, on: null, off: null } as Slot,
    { bandIdx: -1, on: null, off: null } as Slot,
  ],
};

/** Manifest shape: { families: { i4: { dir?, bands: { med: {on,off} … } } } } */
interface ManifestBand { on?: string; off?: string; single?: string }
interface ManifestFamily { dir?: string; bands: Record<string, ManifestBand | string> }

export function loadFamilySamples(ac: AudioContext): void {
  if (manifestTried) return;
  manifestTried = true;
  const base = import.meta.env.BASE_URL + 'audio/engines/';
  fetch(base + 'manifest.json')
    .then((r) => (r.ok ? r.json() : null))
    .then((m: { families?: Record<string, ManifestFamily> } | null) => {
      if (!m?.families) return;
      for (const [fam, def] of Object.entries(m.families)) {
        const dir = base + (def.dir ?? fam) + '/';
        const bands: Band[] = [];
        for (const [name, entry] of Object.entries(def.bands ?? {})) {
          const frac = BAND_FRACS[name];
          if (frac == null) {
            console.warn(`[sampleEngine] unknown band "${name}" in family ${fam}`);
            continue;
          }
          const files = typeof entry === 'string'
            ? { single: entry }
            : entry;
          const band: Band = { frac, on: null, off: null, want: 0, got: 0 };
          const slots: Array<[keyof ManifestBand, 'on' | 'off']> = [
            ['single', 'on'], ['on', 'on'], ['off', 'off'],
          ];
          for (const [key, target] of slots) {
            const f = files[key];
            if (!f) continue;
            band.want++;
            fetch(dir + encodeURI(f))
              .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
              .then((buf) => ac.decodeAudioData(buf))
              .then((decoded) => {
                band[target] = decoded;
                // A 'single' file (idle / maxRPM) serves both load states.
                if (key === 'single') band.off = decoded;
                band.got++;
              })
              .catch((e) => console.warn(`[sampleEngine] ${fam}/${name}/${key} (${f}):`, e));
          }
          bands.push(band);
        }
        bands.sort((a, b) => a.frac - b.frac);
        families[fam] = bands;
      }
    })
    .catch(() => { /* no manifest — the pulse synth carries every family */ });
}

/** True once every listed band of this family is fully decoded. */
export function familySampleReady(family: string): boolean {
  const bands = families[family];
  if (!bands || bands.length < 2) return false;
  return bands.every((b) => b.want > 0 && b.got >= b.want && b.on);
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

/** Point a slot at a band index, crossfading out whatever it held. */
function retargetSlot(slot: Slot, bands: Band[], idx: number, rate: number, t: number): void {
  if (slot.bandIdx === idx) return;
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
    play.master.connect(audio.sfxGain);
  }
  const bands = families[family];
  if (family !== play.family) {
    stopFamilySample();
    play.family = family;
  }

  // Bracketing band pair + crossfade position between them.
  const r = Math.max(0, Math.min(1, rpmNorm));
  let lo = 0;
  for (let i = 0; i < bands.length; i++) if (bands[i].frac <= r) lo = i;
  const hi = Math.min(bands.length - 1, lo + 1);
  const span = bands[hi].frac - bands[lo].frac;
  const x = span > 0 ? Math.max(0, Math.min(1, (r - bands[lo].frac) / span)) : 0;
  const weights = [1 - x, x];
  const idxs = [lo, hi];

  const range = Math.max(1, redline - idleRPM);
  // Master level: recordings already carry load character via on/off,
  // so this only opens up modestly with throttle (+ the H1223 build lift).
  // Level-MATCHED to the pulse synth (measured: raw bands ran ~3× the
  // synth's WOT RMS, which would make every i4 jarringly loud next to a
  // synth-voiced car in the same session).
  const vol = Math.min(0.5, (0.24 + 0.24 * load) * (1 + hpAggr * 0.3));
  play.master.gain.setTargetAtTime(vol, t, 0.05);

  for (let s = 0; s < 2; s++) {
    const slot = play.slots[s];
    const idx = idxs[s];
    const band = bands[idx];
    // Pitch: 1.0 exactly at the band's home RPM, drifting only between
    // bands — keeps the recording's own character intact.
    const bandRpm = idleRPM + band.frac * range;
    const rate = Math.max(0.72, Math.min(1.4, rpm / Math.max(1, bandRpm)));
    retargetSlot(slot, bands, idx, rate, t);
    const w = weights[s];
    // The load axis, straight from the recordings.
    if (slot.on) {
      slot.on.gain.gain.setTargetAtTime(w * load, t, 0.04);
      slot.on.src.playbackRate.setTargetAtTime(rate, t, 0.04);
    }
    if (slot.off) {
      slot.off.gain.gain.setTargetAtTime(w * (1 - load), t, 0.04);
      slot.off.src.playbackRate.setTargetAtTime(rate, t, 0.04);
    } else if (slot.on) {
      // Band has a single take — it covers both load states.
      slot.on.gain.gain.setTargetAtTime(w, t, 0.04);
    }
  }
}

export function isFamilySampleActive(): boolean {
  return !!play.family;
}

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
  play.family = '';
}
