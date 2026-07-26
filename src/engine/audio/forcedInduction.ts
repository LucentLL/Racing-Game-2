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
 * H1254: all of the TURBO half above is now the FALLBACK. When the car's
 * recorded turbo kit is decoded (turboSample), the real recording owns the
 * turbo voice and the whistle/whine/whoosh/BOV synthesis below stays at
 * zero — the same single-voice rule the V8 sample (H858) and the recorded
 * engine families (H1226/H1237) already follow. The supercharger is still
 * fully synthetic: the pack is turbos only.
 *
 * Pure helpers (fiBoostTarget/fiBoostStep/fiShouldBlowOff/freq maps)
 * are exported for headless verification — sound itself is ear-tested.
 */

import { audio } from './state';
import {
  updateTurboSample,
  duckTurboSample,
  stopTurboSample,
} from './turboSample';

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

/** One integration step of the boost proxy (asymmetric first-order).
 *  H1229: stage slows the spool — a Stage 4 big turbo takes ~1.5× as
 *  long to build charge as the factory unit (spool time joins whistle
 *  pitch/gain and BOV volume as a stage-scaled "turbo size" cue). */
export function fiBoostStep(boost: number, target: number, dt: number, stage = 0): number {
  const k = target > boost ? SPOOL_UP_RATE / (1 + 0.12 * stage) : SPOOL_DOWN_RATE;
  return boost + (target - boost) * Math.min(1, k * dt);
}

/** Should this frame fire the blow-off valve? */
export function fiShouldBlowOff(
  boost: number, gasA: number, prevGasA: number, cooldown: number,
): boolean {
  return cooldown <= 0 && boost > BOV_MIN_BOOST
    && prevGasA > BOV_GAS_WAS && gasA < BOV_GAS_NOW;
}

/** H1223: which cars get the turbo voice. Factory TURBO always; any
 *  power stage adds one — the stage fiction is a turbo build for every
 *  car ("Stage 1 Turbo Kit", "Big Turbo + Intercooler", upgradeHeadroom's
 *  "NA engines turbo well") — EXCEPT blower cars: factory-SC (asp mult
 *  comment: "NA build + maybe a blower") AND the SC shop mod, whose
 *  build story is the blower the player actually paid for — stages
 *  louden the SC whine instead of stacking a second FI voice. */
export function fiTurboEligible(
  asp: string | undefined, powerStage: number, scModActive: boolean,
): boolean {
  if (asp === 'TURBO') return true;
  return powerStage >= 1 && asp !== 'SuperCharger' && !scModActive;
}

/** Compressor-wheel whistle pitch — rises with boost, not crank RPM.
 *  H1223: higher stages fit a physically bigger turbo — deeper base
 *  whistle, wider sweep. Stage 0 = the factory-turbo sound. */
export function fiWhineFreq(boost: number, stage: number): number {
  return (750 - 45 * stage) + (4200 + 180 * stage) * boost;
}

/** Whine loudness — perceptible only once meaningfully spooled.
 *  H1223: stage scales presence (bigger compressor, louder intake).
 *  H1225 rebalance (user: "disturbing electric whine"): lower level,
 *  steeper curve (^2 — only prominent near full boost), gentler stage
 *  scaling. The whistle is now mostly NOISE (see ensureNodes) — this
 *  gain drives the breathy bandpass; the sine sits at 25% underneath. */
export function fiWhineGain(boost: number, stage: number): number {
  return Math.pow(Math.max(0, boost), 2) * 0.035 * (1 + 0.15 * stage);
}

/** Belt-driven SC rotor whine — locked to crank RPM (no lag). */
export function scWhineFreq(rpm: number): number {
  return (rpm / 60) * 36;
}

export function scWhineGain(rpmNorm: number, gasA: number, stage: number): number {
  return (0.015 + 0.045 * rpmNorm) * (0.35 + 0.65 * gasA) * (1 + 0.10 * stage);
}

const fi = {
  inited: false,
  boost: 0,
  prevGasA: 0,
  bovCooldown: 0,
  whineOsc: null as OscillatorNode | null,
  whineGain: null as GainNode | null,
  whistleFilter: null as BiquadFilterNode | null,
  whistleGain: null as GainNode | null,
  whooshFilter: null as BiquadFilterNode | null,
  whooshGain: null as GainNode | null,
  scOsc: null as OscillatorNode | null,
  scFilter: null as BiquadFilterNode | null,
  scGain: null as GainNode | null,
  scWhistleFilter: null as BiquadFilterNode | null,
  scWhistleGain: null as GainNode | null,
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

  // Shared noise loop for all the air sounds.
  fi.noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const nd = fi.noiseBuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

  // Turbo whistle — H1225 rework: a real spool whine is moving AIR, not
  // a tone (user report: pure triangle = "disturbing electric whine").
  // Voice is narrowband NOISE (high-Q bandpass tracking the whine freq)
  // with a faint sine 25% underneath for pitch definition.
  const whistleSrc = ctx.createBufferSource();
  whistleSrc.buffer = fi.noiseBuf;
  whistleSrc.loop = true;
  fi.whistleFilter = ctx.createBiquadFilter();
  fi.whistleFilter.type = 'bandpass';
  fi.whistleFilter.frequency.value = fiWhineFreq(0, 0);
  fi.whistleFilter.Q.value = 14;
  fi.whistleGain = ctx.createGain();
  fi.whistleGain.gain.value = 0;
  whistleSrc.connect(fi.whistleFilter);
  fi.whistleFilter.connect(fi.whistleGain);
  fi.whistleGain.connect(audio.sfxGain);
  whistleSrc.start();

  fi.whineOsc = ctx.createOscillator();
  fi.whineOsc.type = 'sine';
  fi.whineOsc.frequency.value = fiWhineFreq(0, 0);
  fi.whineGain = ctx.createGain();
  fi.whineGain.gain.value = 0;
  fi.whineOsc.connect(fi.whineGain);
  fi.whineGain.connect(audio.sfxGain);
  fi.whineOsc.start();

  // Induction whoosh: broadband air under the whistle.
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

  // SC rotor whine — H1230 rework (user: same "alien whine" disease as
  // the old turbo triangle; ref = classic Roots gear-mesh zing). A
  // narrow bandpass AT the sawtooth's own fundamental collapsed it to a
  // near-pure tone. Now: breathy noise whistle at the mesh frequency
  // LEADS (high-Q noise, like the turbo whistle), and the sawtooth
  // passes a WIDE bandpass centered on its 2nd harmonic (Q 2.2) so a
  // harmonic STACK gets through — zing, not theremin.
  const scWhistleSrc = ctx.createBufferSource();
  scWhistleSrc.buffer = fi.noiseBuf;
  scWhistleSrc.loop = true;
  scWhistleSrc.playbackRate.value = 1.09; // decorrelate from the turbo whistle loop
  fi.scWhistleFilter = ctx.createBiquadFilter();
  fi.scWhistleFilter.type = 'bandpass';
  fi.scWhistleFilter.frequency.value = 400;
  fi.scWhistleFilter.Q.value = 12;
  fi.scWhistleGain = ctx.createGain();
  fi.scWhistleGain.gain.value = 0;
  scWhistleSrc.connect(fi.scWhistleFilter);
  fi.scWhistleFilter.connect(fi.scWhistleGain);
  fi.scWhistleGain.connect(audio.sfxGain);
  scWhistleSrc.start();

  fi.scOsc = ctx.createOscillator();
  fi.scOsc.type = 'sawtooth';
  fi.scOsc.frequency.value = 400;
  fi.scFilter = ctx.createBiquadFilter();
  fi.scFilter.type = 'bandpass';
  fi.scFilter.frequency.value = 800;
  fi.scFilter.Q.value = 2.2;
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
 *  synthesis would only buy ~74KB of GC garbage per lift on phones.
 *  H1223: stage scales the release volume (bigger charge dumped). */
function fireBlowOff(intensity: number, stage: number): void {
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
  g.gain.value = Math.min(0.5, (0.18 + 0.22 * intensity) * (1 + 0.15 * stage));
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
 *  mirrored from the physics gate at the gameLoop call site).
 *  H1223: `powerStage` (0-4) turbos staged NA cars and upsizes the
 *  turbo on staged factory-turbo cars (see fiTurboEligible). */
export function updateForcedInduction(
  asp: string | undefined,
  scModActive: boolean,
  powerStage: number,
  rpm: number,
  rpmNorm: number,
  gasA: number,
  dt: number,
  /** H1254: the car's recorded turbo kit (engineVoice.turboKit). Absent, or
   *  still loading, and the synthetic whistle below carries the car. */
  turboKit?: string,
): void {
  const stage = Math.max(0, Math.min(4, powerStage));
  const turbo = fiTurboEligible(asp, stage, scModActive);
  const sc = asp === 'SuperCharger' || scModActive;
  // H1254: ask the recording first — it both plays the turbo and tells us
  // whether it managed to. Called even for a non-turbo car so swapping out of
  // one stops the loops.
  const recorded = updateTurboSample(turboKit ?? '', turbo, rpmNorm, gasA, stage);
  if (!turbo && !sc) {
    // NA car: nothing to do unless a previous car left nodes live.
    if (fi.inited && audio.audioCtx) duckForcedInduction(audio.audioCtx.currentTime);
    fi.boost = 0;
    return;
  }
  // The synth bank is only worth building for the voices actually needed —
  // a recorded turbo on an NA-blower-free car never touches an oscillator.
  const needSynth = sc || (turbo && !recorded);
  if (!audio.audioCtx) return;
  if (needSynth && !ensureNodes()) return;
  const t = audio.audioCtx.currentTime;

  if (turbo && !recorded) {
    fi.bovCooldown = Math.max(0, fi.bovCooldown - dt);
    const target = fiBoostTarget(rpmNorm, gasA);
    fi.boost = fiBoostStep(fi.boost, target, dt, stage);
    if (fiShouldBlowOff(fi.boost, gasA, fi.prevGasA, fi.bovCooldown)) {
      fireBlowOff(fi.boost, stage);
      // The valve dumps the charge — collapse boost so the whine dives
      // with the psshh instead of fading on the normal lag curve.
      fi.boost *= 0.3;
      fi.bovCooldown = BOV_COOLDOWN_S;
    }
    const wf = fiWhineFreq(fi.boost, stage);
    const wg = fiWhineGain(fi.boost, stage);
    // Review fix: WebAudio's bandpass is unity-peak-gain — at Q=14 the
    // narrowband noise comes out ~0.09 RMS per unit gain, so the raw wg
    // left the sine dominant (the exact "electric" voice this rework
    // removes). ×4 puts the AIR in front; the sine sits 8-10× under it.
    fi.whistleFilter?.frequency.setTargetAtTime(wf, t, 0.03);
    fi.whistleGain?.gain.setTargetAtTime(wg * 4, t, 0.05);
    fi.whineOsc?.frequency.setTargetAtTime(wf, t, 0.03);
    fi.whineGain?.gain.setTargetAtTime(wg * 0.05, t, 0.05);
    fi.whooshFilter?.frequency.setTargetAtTime(1400 + 1800 * fi.boost, t, 0.05);
    fi.whooshGain?.gain.setTargetAtTime(
      fi.boost * gasA * 0.035 * (1 + 0.15 * stage), t, 0.06,
    );
  } else {
    // Either an NA/blower car, or the recording owns the turbo. Collapse the
    // boost proxy as well as the gains: if the samples were to drop out later
    // the synth must resume from spooled-down, not mid-charge.
    fi.boost = 0;
    fi.bovCooldown = 0;
    fi.whineGain?.gain.setTargetAtTime(0, t, 0.05);
    fi.whistleGain?.gain.setTargetAtTime(0, t, 0.05);
    fi.whooshGain?.gain.setTargetAtTime(0, t, 0.05);
  }

  if (sc) {
    const f = Math.max(60, scWhineFreq(rpm));
    const sg = scWhineGain(rpmNorm, gasA, stage);
    // Breathy mesh whistle leads (unity-gain BP comp ×3.2), harmonic
    // sawtooth stack underneath.
    fi.scWhistleFilter?.frequency.setTargetAtTime(f, t, 0.02);
    fi.scWhistleGain?.gain.setTargetAtTime(sg * 3.2, t, 0.05);
    fi.scOsc?.frequency.setTargetAtTime(f, t, 0.02);
    fi.scFilter?.frequency.setTargetAtTime(f * 2, t, 0.02);
    fi.scGain?.gain.setTargetAtTime(sg * 0.35, t, 0.05);
  } else {
    fi.scGain?.gain.setTargetAtTime(0, t, 0.05);
    fi.scWhistleGain?.gain.setTargetAtTime(0, t, 0.05);
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
  // H1254: before the fi.inited bail — the recorded turbo has its own graph
  // and is very much alive on a car whose synth bank was never built.
  duckTurboSample(t);
  if (!fi.inited) return;
  fi.whineGain?.gain.setTargetAtTime(0, t, 0.15);
  fi.whistleGain?.gain.setTargetAtTime(0, t, 0.15);
  fi.whooshGain?.gain.setTargetAtTime(0, t, 0.15);
  fi.scGain?.gain.setTargetAtTime(0, t, 0.15);
  fi.scWhistleGain?.gain.setTargetAtTime(0, t, 0.15);
}

/** Hard-silence + state reset for race restarts / teleports (H1028
 *  contract — resume cleanly from idle next frame). */
export function resetForcedInductionAudio(): void {
  fi.boost = 0;
  fi.prevGasA = 0;
  fi.bovCooldown = 0;
  // H1254: same contract for the recorded voice — kill the spool loops and any
  // in-flight blow-off, then resume clean from idle next frame.
  stopTurboSample();
  const ctx = audio.audioCtx;
  if (!ctx || !fi.inited) return;
  const t = ctx.currentTime;
  for (const g of [fi.whineGain, fi.whistleGain, fi.whooshGain, fi.scGain, fi.scWhistleGain, fi.lastBovGain]) {
    if (!g) continue;
    try {
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(0.0001, t);
    } catch { /* audio node in a bad state — ignore */ }
  }
  fi.lastBovGain = null;
}
