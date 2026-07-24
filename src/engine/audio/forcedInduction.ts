/**
 * H1222: forced-induction audio layer — turbo spool whine + blow-off
 * release, supercharger whine. Data-driven from the GT4 `asp` field
 * ('TURBO' = 148 factory-turbo cars, 'SuperCharger' = 4 factory-SC
 * cars) plus the Phase 9 supercharger shop mod. Layers OVER the base
 * engine voice — both the procedural synth and the V8 sample keep it
 * (a turbo car keeps whistling when the sample owns the base voice),
 * so it must stay a garnish in the mix, never the lead.
 *
 * Physics has NO turbo model (the accel-chain turboMult is unported,
 * ≡1.0; coastDrag only spools DOWN), so this module integrates its own
 * boost proxy: target = throttle × exhaust-flow ramp above a spool RPM
 * floor, approached with asymmetric first-order lag (slow spool-up,
 * fast collapse). Lifting off at boost fires a one-shot blow-off
 * "psshh-tututu" (baked flutter envelope + downward-swept bandpass).
 *
 * The SC whine is mechanically locked to crank RPM (belt-driven —
 * no lag, no blow-off), a thin bandpassed sawtooth.
 *
 * Pure helpers (fiBoostTarget/fiBoostStep/fiShouldBlowOff/freq maps)
 * are exported for headless verification — sound itself is ear-tested.
 */

import { audio } from './state';

/** RPM-range fraction below which the turbo has no exhaust flow to
 *  spool against; boost target ramps 0→1 over the next 50%. */
const SPOOL_RPM_FLOOR = 0.22;
/** Spool-up rate (1/s) — ~0.36s to 63% of target. Collapse is faster:
 *  closed throttle kills drive pressure almost immediately. */
const SPOOL_UP_RATE = 2.8;
const SPOOL_DOWN_RATE = 9;
/** Blow-off trigger: throttle must drop through these on a frame while
 *  boosted, with a cooldown so pedal flutter can't machine-gun it. */
const BOV_GAS_WAS = 0.45;
const BOV_GAS_NOW = 0.2;
const BOV_MIN_BOOST = 0.3;
const BOV_COOLDOWN_S = 0.6;

/** Boost target from normalized RPM + analog throttle. */
export function fiBoostTarget(rpmNorm: number, gasA: number): number {
  const flow = Math.max(0, Math.min(1, (rpmNorm - SPOOL_RPM_FLOOR) / 0.5));
  return flow * Math.max(0, Math.min(1, gasA));
}

/** One integration step of the boost proxy (asymmetric first-order). */
export function fiBoostStep(boost: number, target: number, dt: number): number {
  const k = target > boost ? SPOOL_UP_RATE : SPOOL_DOWN_RATE;
  return boost + (target - boost) * Math.min(1, k * dt);
}

/** Should this frame fire the blow-off valve? */
export function fiShouldBlowOff(
  boost: number, gasA: number, prevGasA: number, cooldown: number,
): boolean {
  return cooldown <= 0 && boost > BOV_MIN_BOOST
    && prevGasA > BOV_GAS_WAS && gasA < BOV_GAS_NOW;
}

/** Compressor-wheel whistle pitch — rises with boost, not crank RPM. */
export function fiWhineFreq(boost: number): number {
  return 750 + 4200 * boost;
}

/** Whine loudness — perceptible only once meaningfully spooled. */
export function fiWhineGain(boost: number): number {
  return Math.pow(Math.max(0, boost), 1.5) * 0.05;
}

/** Belt-driven SC rotor whine — locked to crank RPM (no lag). */
export function scWhineFreq(rpm: number): number {
  return (rpm / 60) * 36;
}

export function scWhineGain(rpmNorm: number, gasA: number): number {
  return (0.015 + 0.045 * rpmNorm) * (0.35 + 0.65 * gasA);
}

const fi = {
  inited: false,
  boost: 0,
  prevGasA: 0,
  bovCooldown: 0,
  whineOsc: null as OscillatorNode | null,
  whineGain: null as GainNode | null,
  whooshFilter: null as BiquadFilterNode | null,
  whooshGain: null as GainNode | null,
  scOsc: null as OscillatorNode | null,
  scFilter: null as BiquadFilterNode | null,
  scGain: null as GainNode | null,
  noiseBuf: null as AudioBuffer | null,
  bovBuf: null as AudioBuffer | null,
  lastBovGain: null as GainNode | null,
};

/** Lazy one-time node setup (same run-forever-at-gain-0 scheme as the
 *  init.ts synth bank; lazy because most cars are NA and never need it). */
function ensureNodes(): boolean {
  if (fi.inited) return true;
  const ctx = audio.audioCtx;
  if (!ctx || !audio.sfxGain) return false;

  // Turbo whistle: near-pure tone, pitch driven by boost.
  fi.whineOsc = ctx.createOscillator();
  fi.whineOsc.type = 'triangle';
  fi.whineOsc.frequency.value = fiWhineFreq(0);
  fi.whineGain = ctx.createGain();
  fi.whineGain.gain.value = 0;
  fi.whineOsc.connect(fi.whineGain);
  fi.whineGain.connect(audio.sfxGain);
  fi.whineOsc.start();

  // Induction whoosh: bandpassed noise under the whistle.
  fi.noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const nd = fi.noiseBuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  const whooshSrc = ctx.createBufferSource();
  whooshSrc.buffer = fi.noiseBuf;
  whooshSrc.loop = true;
  fi.whooshFilter = ctx.createBiquadFilter();
  fi.whooshFilter.type = 'bandpass';
  fi.whooshFilter.frequency.value = 1400;
  fi.whooshFilter.Q.value = 0.8;
  fi.whooshGain = ctx.createGain();
  fi.whooshGain.gain.value = 0;
  whooshSrc.connect(fi.whooshFilter);
  fi.whooshFilter.connect(fi.whooshGain);
  fi.whooshGain.connect(audio.sfxGain);
  whooshSrc.start();

  // SC rotor whine: thin sawtooth, bandpass tracks the fundamental.
  fi.scOsc = ctx.createOscillator();
  fi.scOsc.type = 'sawtooth';
  fi.scOsc.frequency.value = 400;
  fi.scFilter = ctx.createBiquadFilter();
  fi.scFilter.type = 'bandpass';
  fi.scFilter.frequency.value = 400;
  fi.scFilter.Q.value = 5;
  fi.scGain = ctx.createGain();
  fi.scGain.gain.value = 0;
  fi.scOsc.connect(fi.scFilter);
  fi.scFilter.connect(fi.scGain);
  fi.scGain.connect(audio.sfxGain);
  fi.scOsc.start();

  fi.inited = true;
  return true;
}

/** One-shot blow-off: noise burst with a baked flutter tail
 *  ("psshh-tututu"), through a bandpass swept 2600→1100 Hz. The buffer
 *  is synthesized ONCE and reused — the envelope is deterministic and
 *  a repeated noise burst is indistinguishable by ear, so per-fire
 *  synthesis would only buy ~74KB of GC garbage per lift on phones. */
function fireBlowOff(intensity: number): void {
  const ctx = audio.audioCtx;
  if (!ctx || !audio.sfxGain) return;
  if (!fi.bovBuf) {
    const dur = 0.42;
    const n = Math.floor(ctx.sampleRate * dur);
    fi.bovBuf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = fi.bovBuf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      const tt = i / ctx.sampleRate;
      // Straight hiss for the first 60ms, then 33Hz flutter under the decay.
      const flutter = tt < 0.06 ? 1 : 0.45 + 0.55 * Math.abs(Math.sin(2 * Math.PI * 33 * tt));
      d[i] = (Math.random() * 2 - 1) * Math.exp(-tt / 0.13) * flutter;
    }
  }
  const src = ctx.createBufferSource();
  src.buffer = fi.bovBuf;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 1.2;
  const t = ctx.currentTime;
  bp.frequency.setValueAtTime(2600, t);
  bp.frequency.linearRampToValueAtTime(1100, t + 0.3);
  const g = ctx.createGain();
  g.gain.value = Math.min(0.4, 0.18 + 0.22 * intensity);
  src.connect(bp);
  bp.connect(g);
  g.connect(audio.sfxGain);
  src.start();
  // Tracked so resetForcedInductionAudio can kill an in-flight psshh
  // on a race restart / teleport (H1028 snap-to-silence contract).
  fi.lastBovGain = g;
}

/** Per-frame update, called from proceduralEngine.updateAudio.
 *  `scModActive` is the already-gated shop-mod flag (canSC + setting,
 *  mirrored from the physics gate at the gameLoop call site). */
export function updateForcedInduction(
  asp: string | undefined,
  scModActive: boolean,
  rpm: number,
  rpmNorm: number,
  gasA: number,
  dt: number,
): void {
  const turbo = asp === 'TURBO';
  const sc = asp === 'SuperCharger' || scModActive;
  if (!turbo && !sc) {
    // NA car: nothing to do unless a previous car left nodes live.
    if (fi.inited && audio.audioCtx) duckForcedInduction(audio.audioCtx.currentTime);
    fi.boost = 0;
    return;
  }
  if (!ensureNodes() || !audio.audioCtx) return;
  const t = audio.audioCtx.currentTime;

  if (turbo) {
    fi.bovCooldown = Math.max(0, fi.bovCooldown - dt);
    const target = fiBoostTarget(rpmNorm, gasA);
    fi.boost = fiBoostStep(fi.boost, target, dt);
    if (fiShouldBlowOff(fi.boost, gasA, fi.prevGasA, fi.bovCooldown)) {
      fireBlowOff(fi.boost);
      // The valve dumps the charge — collapse boost so the whine dives
      // with the psshh instead of fading on the normal lag curve.
      fi.boost *= 0.3;
      fi.bovCooldown = BOV_COOLDOWN_S;
    }
    fi.whineOsc?.frequency.setTargetAtTime(fiWhineFreq(fi.boost), t, 0.03);
    fi.whineGain?.gain.setTargetAtTime(fiWhineGain(fi.boost), t, 0.05);
    fi.whooshFilter?.frequency.setTargetAtTime(1400 + 1800 * fi.boost, t, 0.05);
    fi.whooshGain?.gain.setTargetAtTime(fi.boost * gasA * 0.035, t, 0.06);
  } else {
    fi.boost = 0;
    fi.whineGain?.gain.setTargetAtTime(0, t, 0.05);
    fi.whooshGain?.gain.setTargetAtTime(0, t, 0.05);
  }

  if (sc) {
    const f = Math.max(60, scWhineFreq(rpm));
    fi.scOsc?.frequency.setTargetAtTime(f, t, 0.02);
    fi.scFilter?.frequency.setTargetAtTime(f, t, 0.02);
    fi.scGain?.gain.setTargetAtTime(scWhineGain(rpmNorm, gasA), t, 0.05);
  } else {
    fi.scGain?.gain.setTargetAtTime(0, t, 0.05);
  }

  fi.prevGasA = gasA;
}

/** Fade all FI voices (menu open — mirrors the synth-bank fade).
 *  Also collapses the boost proxy: updateForcedInduction is skipped
 *  while a menu is open, and stale boost/prevGasA would otherwise fire
 *  a phantom blow-off on the first frame after it closes (throttle
 *  was pinned entering the garage, gas reads 0 on exit — the trigger
 *  edge, minutes late). The real turbo spools down while parked too. */
export function duckForcedInduction(t: number): void {
  fi.boost = 0;
  fi.prevGasA = 0;
  if (!fi.inited) return;
  fi.whineGain?.gain.setTargetAtTime(0, t, 0.15);
  fi.whooshGain?.gain.setTargetAtTime(0, t, 0.15);
  fi.scGain?.gain.setTargetAtTime(0, t, 0.15);
}

/** Hard-silence + state reset for race restarts / teleports (H1028
 *  contract — resume cleanly from idle next frame). */
export function resetForcedInductionAudio(): void {
  fi.boost = 0;
  fi.prevGasA = 0;
  fi.bovCooldown = 0;
  const ctx = audio.audioCtx;
  if (!ctx || !fi.inited) return;
  const t = ctx.currentTime;
  for (const g of [fi.whineGain, fi.whooshGain, fi.scGain, fi.lastBovGain]) {
    if (!g) continue;
    try {
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(0.0001, t);
    } catch { /* audio node in a bad state — ignore */ }
  }
  fi.lastBovGain = null;
}
