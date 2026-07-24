/**
 * H1236: per-FAMILY engine sample layer — the drag-and-drop realism path.
 *
 * The locked architecture is synth-as-foundation, samples-as-optional-
 * layer. The V8 Muscle_Car set proved the two-loop template (H856:
 * idle loop + rev loop, ALL pitch from RPM-driven playbackRate); this
 * generalizes it to every engine family so real recordings can be
 * added without touching code:
 *
 *   1. Drop loops into public/audio/engines/  (e.g. i4_idle.wav,
 *      i4_rev.wav — seamless loops from any licensed pack)
 *   2. List them in public/audio/engines/manifest.json:
 *        { "families": { "i4": { "idle": "i4_idle.wav",
 *                                 "rev":  "i4_rev.wav" } } }
 *   3. Every car whose voice classifies to that family now plays the
 *      recording as its base voice; the pulse synth stays the voice of
 *      every family WITHOUT samples, and the FI layer (turbo/SC/BOV),
 *      shift pops, and clutch-cut keep riding on top of either.
 *
 * No manifest → no fetches, no errors, pure synth. Families are the
 * proceduralEngine EngineType keys: i4 i6 v6 v8 v10 v12 f4 rot b2 b4 hd.
 */

import { audio } from './state';
import { v8LoopIdx, v8TargetRate } from './v8Engine';

interface FamLoops {
  idle: AudioBuffer | null;
  rev: AudioBuffer | null;
}

const famBuffers: Record<string, FamLoops> = {};
let manifestTried = false;

const play = {
  family: '',
  loopIdx: -1,
  source: null as AudioBufferSourceNode | null,
  gain: null as GainNode | null,
};

/** Fetch the manifest + listed loops. Called once from initAudio. */
export function loadFamilySamples(ac: AudioContext): void {
  if (manifestTried) return;
  manifestTried = true;
  const base = import.meta.env.BASE_URL + 'audio/engines/';
  fetch(base + 'manifest.json')
    .then((r) => (r.ok ? r.json() : null))
    .then((m: { families?: Record<string, { idle?: string; rev?: string }> } | null) => {
      if (!m?.families) return;
      for (const [fam, files] of Object.entries(m.families)) {
        famBuffers[fam] = { idle: null, rev: null };
        for (const slot of ['idle', 'rev'] as const) {
          const f = files[slot];
          if (!f) continue;
          fetch(base + encodeURI(f))
            .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
            .then((buf) => ac.decodeAudioData(buf))
            .then((decoded) => { famBuffers[fam][slot] = decoded; })
            .catch((e) => console.warn(`[sampleEngine] ${fam}/${slot} (${f}) failed:`, e));
        }
      }
    })
    .catch(() => { /* no manifest — synth foundation carries everything */ });
}

/** Both loops decoded → this family's recording owns the base voice. */
export function familySampleReady(family: string): boolean {
  const b = famBuffers[family];
  return !!(b && b.idle && b.rev);
}

/** Per-frame update — same two-loop scheme as the V8 engine (H856):
 *  idle loop at rest, rev loop under way/throttle, pitch entirely from
 *  playbackRate, volume from load/speed with the H1223 built lift. */
export function updateFamilySample(
  family: string,
  eligible: boolean,
  gear: number,
  isGas: boolean,
  rpmNorm: number,
  absSpd: number,
  hpAggr: number,
): void {
  if (!audio.audioCtx || !audio.sfxGain) return;
  if (!eligible || !familySampleReady(family)) {
    if (play.source) stopFamilySample();
    return;
  }
  const t = audio.audioCtx.currentTime;
  const wantIdx = v8LoopIdx(gear, isGas, rpmNorm, absSpd);
  const idleVol = 0.15;
  const gasVol = isGas ? 0.25 + rpmNorm * 0.25 : 0;
  const spdVol = Math.min(0.15, absSpd * 0.002);
  const targetVol = Math.min(0.85, Math.min(0.7, idleVol + gasVol + spdVol) * (1 + hpAggr * 0.35));
  const targetRate = v8TargetRate(rpmNorm, wantIdx);

  if (family !== play.family || wantIdx !== play.loopIdx || !play.source) {
    const b = famBuffers[family];
    const buf = wantIdx === 0 ? b.idle : b.rev;
    if (!buf) return;
    if (play.source && play.gain) {
      play.gain.gain.setTargetAtTime(0, t, 0.08);
      const old = play.source;
      setTimeout(() => { try { old.stop(); } catch { /* already stopped */ } }, 300);
    }
    play.source = audio.audioCtx.createBufferSource();
    play.source.buffer = buf;
    play.source.loop = true;
    play.source.playbackRate.value = targetRate;
    play.gain = audio.audioCtx.createGain();
    play.gain.gain.value = 0;
    play.gain.gain.setTargetAtTime(targetVol, t, 0.1);
    play.source.connect(play.gain);
    play.gain.connect(audio.sfxGain);
    play.source.start();
    play.family = family;
    play.loopIdx = wantIdx;
  } else if (play.gain && play.source) {
    play.gain.gain.setTargetAtTime(targetVol, t, 0.05);
    play.source.playbackRate.setTargetAtTime(targetRate, t, 0.05);
  }
}

export function isFamilySampleActive(): boolean {
  return !!play.source;
}

export function duckFamilySample(t: number): void {
  play.gain?.gain.setTargetAtTime(0, t, 0.15);
}

export function stopFamilySample(): void {
  if (play.source) {
    const s = play.source;
    if (play.gain && audio.audioCtx) {
      try {
        play.gain.gain.cancelScheduledValues(audio.audioCtx.currentTime);
        play.gain.gain.setValueAtTime(0.0001, audio.audioCtx.currentTime);
      } catch { /* node in a bad state */ }
    }
    setTimeout(() => { try { s.stop(); } catch { /* already stopped */ } }, 50);
  }
  play.source = null;
  play.gain = null;
  play.family = '';
  play.loopIdx = -1;
}
