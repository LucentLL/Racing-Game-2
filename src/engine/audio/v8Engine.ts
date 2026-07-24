import { audio } from './state';
import { sfxFlags, v8GearBuffers } from './sfx';

const v8State = {
  active: false,
  currentGearIdx: -1,
  source: null as AudioBufferSourceNode | null,
  gain: null as GainNode | null,
};

const V8_NAME_RE = /Viper|Camaro|Corvette|Griffith|Cerbera|Mustang/i;

/** Deprecated (H858): name-based V8 detection. Kept for API compat
 *  (re-exported from index.ts) but no longer used internally — V8
 *  sample eligibility now flows from the authoritative GT4 eType
 *  (eType === 'v8') decided in proceduralEngine, so ALL ~43 V8 cars use
 *  the real samples, not just the 6 names this regex matched. */
export function isV8Car(carName: string): boolean {
  return V8_NAME_RE.test(carName);
}

/** H856: V8 loop selector. Pre-H856 this returned min(7, gear+1) — one
 *  sample PER GEAR — so every upshift swapped to a higher loop and the
 *  engine pitch climbed with GEAR NUMBER (the user's "pitch just gets
 *  higher as gears increase" report). Now there are just TWO gear-agnostic
 *  loops: idle (0) when stopped and off-throttle, the rev/accel loop (1)
 *  otherwise. ALL audible pitch now comes from playbackRate (v8TargetRate,
 *  RPM-driven), so it rises with revs WITHIN a gear and DROPS at each
 *  upshift because rpmNorm drops — and never steps with gear. This is the
 *  template for future sampled engines (V6/I6/V12…): two loops + an
 *  RPM-driven rate, not a sample per gear. */
export function v8LoopIdx(gear: number, isGas: boolean, rpmNorm: number, absSpd: number): number {
  if ((gear <= 0 || absSpd < 1) && !(isGas && rpmNorm > 0.2)) return 0;
  return 1;
}

/** H856: V8 playback rate from normalized RPM. Pre-H856 this was
 *  0.92 + rpmNorm*0.16 — a ±8% range far too narrow to convey a rev sweep
 *  (gear selection did the real, wrong, pitch work). Now rpmNorm drives a
 *  ~1.3-octave sweep so the audible pitch tracks the tach: on the rev loop
 *  ~0.72 at idle → ~1.8 at redline. The idle loop gets a gentler range so a
 *  stationary engine doesn't sound artificially slow. */
export function v8TargetRate(rpmNorm: number, loopIdx: number): number {
  const r = Math.max(0, Math.min(1, rpmNorm));
  return loopIdx === 0 ? 0.92 + r * 0.30 : 0.72 + r * 1.08;
}

export function updateV8Engine(
  eligible: boolean,
  gear: number,
  isGas: boolean,
  rpmNorm: number,
  absSpd: number,
  hpAggr = 0,
): void {
  if (!sfxFlags.v8SamplesLoaded || !audio.audioCtx || !audio.sfxGain) return;

  // H858: eligibility decided by the caller from GT4 eType === 'v8'
  // (all V8 cars), replacing the 6-name regex.
  if (!eligible) {
    if (v8State.active) stopV8Engine();
    return;
  }

  const wantIdx = v8LoopIdx(gear, isGas, rpmNorm, absSpd);
  const t = audio.audioCtx.currentTime;

  if (!v8State.active) {
    v8State.active = true;
    v8State.currentGearIdx = -1;
  }

  const idleVol = 0.15;
  const gasVol = isGas ? 0.25 + rpmNorm * 0.25 : 0;
  const spdVol = Math.min(0.15, absSpd * 0.002);
  // H1223: the sample owns the base voice on V8 cars (synth gains are
  // zeroed), so the built-engine loudness lands here — hpAggr 0..0.6
  // lifts the loop up to ~21%, capped below clipping headroom.
  const targetVol = Math.min(0.85, Math.min(0.7, idleVol + gasVol + spdVol) * (1 + hpAggr * 0.35));
  const targetRate = v8TargetRate(rpmNorm, wantIdx);

  if (wantIdx !== v8State.currentGearIdx) {
    const buf = v8GearBuffers[wantIdx];
    if (!buf) return;
    if (v8State.source && v8State.gain) {
      v8State.gain.gain.setTargetAtTime(0, t, 0.08);
      const oldSrc = v8State.source;
      setTimeout(() => {
        try {
          oldSrc.stop();
        } catch {
          /* already stopped */
        }
      }, 300);
    }
    v8State.source = audio.audioCtx.createBufferSource();
    v8State.source.buffer = buf;
    v8State.source.loop = true;
    v8State.source.playbackRate.value = targetRate;
    v8State.gain = audio.audioCtx.createGain();
    v8State.gain.gain.value = 0;
    v8State.gain.gain.setTargetAtTime(targetVol, t, 0.1);
    v8State.source.connect(v8State.gain);
    v8State.gain.connect(audio.sfxGain);
    v8State.source.start();
    v8State.currentGearIdx = wantIdx;
  } else if (v8State.gain) {
    v8State.gain.gain.setTargetAtTime(targetVol, t, 0.05);
    if (v8State.source) {
      v8State.source.playbackRate.setTargetAtTime(targetRate, t, 0.05);
    }
  }
}

export function stopV8Engine(): void {
  if (v8State.source) {
    try {
      if (v8State.gain && audio.audioCtx) {
        v8State.gain.gain.setTargetAtTime(0, audio.audioCtx.currentTime, 0.1);
      }
      const s = v8State.source;
      setTimeout(() => {
        try {
          s.stop();
        } catch {
          /* already stopped */
        }
      }, 400);
    } catch {
      /* ignore */
    }
  }
  v8State.source = null;
  v8State.gain = null;
  v8State.active = false;
  v8State.currentGearIdx = -1;
}

export function isV8Active(): boolean {
  return v8State.active;
}

export function getV8Gain(): GainNode | null {
  return v8State.gain;
}
