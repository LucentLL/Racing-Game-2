import { audio, type AudioFrameInputs } from './state';
import { sfxFlags } from './sfx';
import { fireExhaustPop } from './init';
import { updateTireSFX } from './tireGrain';
import {
  updateV8Engine, isV8Active, stopV8Engine, getV8Gain, v8LoopsReady, V8_SAMPLE_LAYER,
} from './v8Engine';
import {
  updateForcedInduction,
  duckForcedInduction,
  resetForcedInductionAudio,
} from './forcedInduction';
import {
  updatePulseEngine,
  duckPulseEngine,
  resetPulseEngineAudio,
  notifyPulseShift,
} from './pulseEngine';
import {
  updateFamilySample,
  familySampleReady,
  isFamilySampleActive,
  duckFamilySample,
  stopFamilySample,
} from './sampleEngine';
import { stopMufflerCooldown } from './foley';
import { fireTurboShift } from './turboSample';

/** H1028: snap the engine audio to silence immediately — cancel any in-flight
 *  frequency/gain ramps and stop the V8 sample loop — so a race restart /
 *  map teleport doesn't leave the end-of-race engine note stuck and looping.
 *  updateAudio resumes cleanly from idle on the next frame (pRpm was reset). */
export function resetEngineAudio(): void {
  stopV8Engine();
  stopFamilySample();
  // H1238: the hot-muffler cooldown is an independent voice — without
  // this it ticked on through a map teleport / race restart, exactly the
  // stuck-voice class this function exists to prevent (H1028).
  stopMufflerCooldown();
  resetForcedInductionAudio();
  resetPulseEngineAudio();
  audio.lastAudioRpm = 0;
  const ctx = audio.audioCtx;
  if (!ctx) return;
  const t = ctx.currentTime;
  for (const g of [audio.engNoiseGain, audio.engBassGain, audio.exhaustGain]) {
    if (!g) continue;
    try {
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(0.0001, t);
    } catch { /* audio node in a bad state — ignore */ }
  }
}

type EngineType = 'i4' | 'i6' | 'v6' | 'v8' | 'v10' | 'v12' | 'f4' | 'rot' | 'b2' | 'b4' | 'hd';

type EngineProfile = readonly [
  h1: number,
  h2: number,
  h3: number,
  h4: number,
  idleQ: number,
  revQ: number,
  exhHz: number,
  bassVol: number,
  exhVol: number,
  screamVol: number,
];

const CYL_MAP: Record<EngineType, number> = {
  i4: 4, i6: 6, v6: 6, v8: 8, v10: 10, v12: 12, f4: 4, rot: 3, b2: 2, b4: 4, hd: 2,
};

const ENGINE_PROFILES: Record<EngineType, EngineProfile> = {
  i4:  [0.6, 0.8, 0.5, 0.3,  5,  7, 2700, 0.10, 0.06, 0],
  i6:  [0.8, 0.6, 0.3, 0.15, 4,  9, 2600, 0.14, 0.08, 0],
  v6:  [0.7, 0.7, 0.4, 0.25, 4,  7, 2800, 0.16, 0.09, 0],
  v8:  [0.7, 1.0, 0.35, 0.2, 3,  6, 2700, 0.25, 0.12, 0],
  v10: [0.7, 0.9, 0.4, 0.3,  3,  6, 2500, 0.22, 0.10, 0],
  // H857: V12 — smooth, harmonically rich, higher firing frequency
  // (cyls/2=6 → fundHz is 1.5× a V8 at equal RPM). Refined top end, less
  // low-order rumble than a V8, broad upper harmonics.
  v12: [0.6, 1.0, 0.55, 0.4, 3,  7, 2400, 0.20, 0.10, 0],
  f4:  [0.8, 0.5, 0.6, 0.4,  3,  6, 2400, 0.18, 0.07, 0],
  rot: [0.4, 0.5, 0.7, 0.6,  6, 12, 3200, 0.04, 0.10, 0],
  b2:  [0.9, 0.5, 0.3, 0.2,  5,  8, 2800, 0.03, 0.05, 0.04],
  b4:  [0.5, 0.7, 0.6, 0.5,  5, 11, 3000, 0.02, 0.06, 0.10],
  hd:  [1.0, 0.8, 0.3, 0.15, 2,  4, 2200, 0.28, 0.14, 0],
};

/** H857: parse the GT4_SPECS engine-type string ('V8 (OHV)', 'L6 (DOHC)',
 *  'V12 (DOHC)', 'Rotor2 (Rotary)', 'Boxer4', 'L4 (DOHC)'…) into a synth
 *  voice. Returns null for layouts with no dedicated profile so the caller
 *  falls back to the name-based guess. This is the data-accurate path —
 *  the catalog carries the real cylinder layout for nearly every car, so
 *  most cars no longer default to a generic I4. */
function parseEType(eType: string): EngineType | null {
  const s = eType.toUpperCase();
  if (s.startsWith('ROTOR') || s.includes('ROTARY')) return 'rot';
  if (s.includes('BOXER') || s.startsWith('F4') || s.startsWith('F6') || s.startsWith('B4') || s.startsWith('B6')) return 'f4';
  if (s.startsWith('V12') || s.startsWith('W12')) return 'v12';
  if (s.startsWith('V10')) return 'v10';
  if (s.startsWith('V8')) return 'v8';
  if (s.startsWith('V6')) return 'v6';
  if (s.startsWith('L6') || s.startsWith('I6') || s.startsWith('S6')) return 'i6';
  if (s.startsWith('L5') || s.startsWith('I5')) return 'i6';   // 5-cyl warble: closer to i6 than i4
  if (s.startsWith('L4') || s.startsWith('I4') || s.startsWith('S4') || s.startsWith('L3') || s.startsWith('L2')) return 'i4';
  return null;
}

export function classifyEngine(name: string, isBike: boolean, eType?: string): EngineType {
  if (isBike) {
    if (name.includes('Harley')) return 'hd';
    if (name.includes('250') || name.includes('CB500')) return 'b2';
    return 'b4';
  }
  // H857: authoritative GT4 layout first; name-guess only as a fallback.
  if (eType) {
    const fromSpec = parseEType(eType);
    if (fromSpec) return fromSpec;
  }
  if (name.includes('RX-7') || name.includes('Cosmo')) return 'rot';
  if (name.includes('Impreza') || name.includes('Legacy') || name.includes('SVX')) return 'f4';
  if (name.includes('Viper')) return 'v10';
  if (
    name.includes('Camaro') ||
    name.includes('Corvette') ||
    name.includes('Griffith') ||
    name.includes('Cerbera')
  ) return 'v8';
  if (
    name.includes('NSX') ||
    name.includes('Fairlady') ||
    name.includes('GTO') ||
    name.includes('Galant VR')
  ) return 'v6';
  if (
    name.includes('Skyline') ||
    name.includes('Supra') ||
    name.includes('Chaser') ||
    name.includes('Soarer') ||
    name.includes('Mark II') ||
    name.includes('400R') ||
    name.includes('DB7')
  ) return 'i6';
  return 'i4';
}

export function updateAudio(input: AudioFrameInputs): void {
  if (!audio.audioStarted || !audio.audioCtx) return;
  if (audio.audioCtx.state === 'suspended') void audio.audioCtx.resume();
  const t = audio.audioCtx.currentTime;
  const { player, controls, car, uiOpen, dt } = input;
  const absSpd = Math.abs(player.speed);

  // H1238: engine-off takes the same all-voices fade as an open menu.
  if (uiOpen || input.engineOff) {
    audio.engNoiseGain?.gain.setTargetAtTime(0, t, 0.15);
    audio.engBassGain?.gain.setTargetAtTime(0, t, 0.15);
    audio.exhaustGain?.gain.setTargetAtTime(0, t, 0.15);
    audio.tireGain?.gain.setTargetAtTime(0, t, 0.15);
    audio.brakePadGain?.gain.setTargetAtTime(0, t, 0.15);
    // H1221: monolith parity (L18389) — fade the V8 sample loop too;
    // the early return skips updateV8Engine, which otherwise left the
    // loop playing at its last volume under Home/editor. Recovers on
    // close: updateV8Engine re-targets its volume every frame.
    getV8Gain()?.gain.setTargetAtTime(0, t, 0.15);
    duckForcedInduction(t);
    duckPulseEngine(t);
    duckFamilySample(t);
    return;
  }

  // H1234: audible-rpm conditioning (ear-test 9: "accelerating sounds
  // awful and cartoonish" while the lab's sliders sounded fine). The
  // kinematic pRpm dives ~50% in ~100ms on every auto upshift and
  // bounces 4% @~12Hz on the limiter — through a clean harmonic voice
  // that IS a slide whistle. The audible pitch may rise instantly but
  // falls at a capped mechanical rate; teleport-scale drops (>5000rpm,
  // e.g. map switch under a stale state) snap through.
  let aRpm = player.rpm;
  if (audio.lastAudioRpm > 0 && aRpm < audio.lastAudioRpm) {
    aRpm = audio.lastAudioRpm - aRpm > 5000
      ? aRpm
      : Math.max(aRpm, audio.lastAudioRpm - 4200 * dt);
  }
  audio.lastAudioRpm = aRpm;

  const eType = classifyEngine(car.name, car.isBike, car.eType);
  const cyls = CYL_MAP[eType];
  const fundHz = Math.max(20, (aRpm / 60) * (cyls / 2));
  const rpmRange = Math.max(1, car.redline - car.idleRPM);
  const rpmNorm = Math.max(0, Math.min(1, (aRpm - car.idleRPM) / rpmRange));
  const P = ENGINE_PROFILES[eType];
  // H1223: built-engine aggression — a staged car runs a freer exhaust
  // and makes more noise per the same profile. Tracks the ACTUAL output
  // gain (hpRatio = effective/stock HP), not the stage number — the
  // turbo whine tracks stage (hardware fitted), this tracks power made.
  // Slope 0.667 saturates the 0.6 cap exactly at +90% HP, the
  // small-displacement-NA stage-4 ceiling; monster platform builds
  // (Supra 2.5x) cap earlier by design.
  const hpAggr = Math.min(0.6, Math.max(0, (car.hpRatio ?? 1) - 1) * 0.667);

  // H1225: pulse-train worklet voice — per-cylinder firing synthesis
  // with the real pattern per engine family and a genuine throttle/load
  // axis. When ready it OWNS every non-V8-sample car and the legacy
  // noise-resonator bank goes fully silent (same single-voice rule as
  // the V8 sample, H858). The resonator path below survives only as
  // the no-AudioWorklet fallback.
  // H1225 review fix: ownership keys on the two loop buffers actually
  // being decoded (v8LoopsReady), NOT the any-of-8 v8SamplesLoaded flag —
  // a partial load previously silenced both voices on every V8 car.
  // H1226: and on the V8_SAMPLE_LAYER flag — sample off by default so
  // V8s speak the same pulse-train language as the rest of the game.
  const v8Owns = eType === 'v8' && V8_SAMPLE_LAYER && v8LoopsReady();
  // H1236: per-family recording loops (manifest-driven) outrank the
  // synth as the base voice; FI/pops/clutch-cut still layer on top.
  const famOwns = familySampleReady(eType);
  const pulseOn = updatePulseEngine({
    name: car.name,
    voiceKey: eType,
    cyls,
    rpm: aRpm,
    rpmNorm,
    load: controls.gasAmount,
    hpAggr,
    v8SampleOwns: v8Owns || famOwns,
  });

  if (pulseOn || famOwns) {
    audio.engNoiseGain?.gain.setTargetAtTime(0, t, 0.05);
    audio.engBassGain?.gain.setTargetAtTime(0, t, 0.05);
    audio.exhaustGain?.gain.setTargetAtTime(0, t, 0.05);
  } else {
    audio.engRes1?.frequency.setTargetAtTime(fundHz, t, 0.005);
    audio.engRes2?.frequency.setTargetAtTime(fundHz * 2, t, 0.005);
    audio.engRes3?.frequency.setTargetAtTime(fundHz * 3, t, 0.005);
    audio.engRes4?.frequency.setTargetAtTime(fundHz * 4, t, 0.005);

    const q1 = P[4] + (P[5] - P[4]) * rpmNorm;
    audio.engRes1?.Q.setTargetAtTime(q1, t, 0.02);
    audio.engRes2?.Q.setTargetAtTime(q1 * 0.8, t, 0.02);
    audio.engRes3?.Q.setTargetAtTime(q1 * 0.6, t, 0.02);

    audio.r1g?.gain.setTargetAtTime(P[0], t, 0.02);
    audio.r2g?.gain.setTargetAtTime(P[1], t, 0.02);
    audio.r3g?.gain.setTargetAtTime(P[2], t, 0.02);
    audio.r4g?.gain.setTargetAtTime(P[3], t, 0.02);

    audio.engNoiseGain?.gain.setTargetAtTime(0.4 + rpmNorm * 0.5, t, 0.03);

    audio.engBass?.frequency.setTargetAtTime(Math.max(18, fundHz * 0.5), t, 0.005);
    audio.engBassGain?.gain.setTargetAtTime(
      (P[7] + rpmNorm * P[7]) * (1 + hpAggr * 0.5), t, 0.03,
    );

    audio.exhaust?.frequency.setTargetAtTime(P[6] + rpmNorm * 300, t, 0.02);
    audio.exhaustGain?.gain.setTargetAtTime(
      (P[8] + rpmNorm * P[8] * 1.5) * (1 + hpAggr), t, 0.03,
    );
  }

  // H1222: forced-induction layer — rides on top of whichever base
  // voice owns the car (synth or V8 sample), so it is NOT silenced by
  // the isV8Active block below. H1223: bikes are excluded from the
  // stage-turbo fiction (their build bucket isn't a turbo kit) by
  // zeroing the stage here — no bike is factory-TURBO, so they get
  // no FI voice at all.
  // H1254: car.voice.turboKit picks which of the 10 recorded turbochargers
  // this car runs; absent (or still loading) falls back to the synth whistle.
  updateForcedInduction(
    car.asp, !!car.supercharged, car.isBike ? 0 : (car.powerStage ?? 0),
    aRpm, rpmNorm, controls.gasAmount, dt, car.voice?.turboKit,
  );

  // Bike scream is part of the legacy voice — silent when the worklet owns.
  const screamAmt = pulseOn ? 0 : P[9];
  if (screamAmt > 0) {
    audio.bikeScream?.frequency.setTargetAtTime(4500 + rpmNorm * 3000, t, 0.02);
    audio.bikeScreamGain?.gain.setTargetAtTime(rpmNorm * rpmNorm * screamAmt, t, 0.03);
  } else {
    audio.bikeScreamGain?.gain.setTargetAtTime(0, t, 0.02);
  }

  if (player.gear !== audio.lastGear && player.gear > 0 && audio.lastGear > 0) {
    // H1234: clutch-cut duck under the pops — the shift's rpm dive
    // plays at -10dB instead of singing the full slide.
    notifyPulseShift();
    fireExhaustPop();
    // H1255: turbo flutter between gears. Upshifts only, and it reads aRpm
    // (rate-limited on the way down by the H1234 conditioning) so the shot is
    // sized by the revs the car shifted AT, not the dive it lands in.
    if (player.gear > audio.lastGear) {
      fireTurboShift(rpmNorm, controls.gasAmount, car.isBike ? 0 : (car.powerStage ?? 0));
    }
    if (Math.random() > 0.4) setTimeout(fireExhaustPop, 40 + Math.random() * 80);
    if (Math.random() > 0.7) setTimeout(fireExhaustPop, 120 + Math.random() * 60);
  }
  audio.lastGear = player.gear;
  // H1223: built engines burble at idle and crackle at redline more
  // often. Rolls are dt-scaled RATES (base 0.24/s idle, 1.2/s redline —
  // the old 0.004/0.02 per-frame odds at 60fps), so a 144Hz monitor no
  // longer pops 2.4x faster than a phone; built max ~2.1/s at redline
  // stays crackle, not machine-gun (each pop is a 125ms burst).
  if (absSpd < 3 && rpmNorm < 0.15 && Math.random() < 0.24 * (1 + hpAggr * 1.5) * dt) fireExhaustPop();
  if (aRpm >= car.redline * 0.97 && controls.gas && Math.random() < 1.2 * (1 + hpAggr * 1.2) * dt) fireExhaustPop();

  // H1160: launch screech + chirp require REAL throttle (>0.7, the skid
  // marks' burnout threshold) — the boolean gas is true at 2% trigger
  // travel, so feathering the pedal squealed the tires (user report; the
  // H752 analog pass fixed physics + skids but never this audio gate).
  // wsReal stays amount-ungated: physics wheelspin demand already scales
  // with gasAmount, so a real ratio >0.15 at part throttle is genuine.
  // wsLaunch also caps at absSpd<30 so mid-2nd-gear flooring doesn't
  // screech (matches the skidMarks burnout window).
  const isHardAccel = controls.gas && controls.gasAmount > 0.7
    && player.gear <= 2 && rpmNorm > 0.6 && !player.drifting;
  const wsReal = player.wheelspinRatio > 0.15;
  const wsLaunch = player.gear <= 2 && player.wheelGap > 3
    && controls.gasAmount > 0.7 && absSpd < 30;
  const isWheelspin = controls.gas && (wsReal || wsLaunch) && !player.drifting && absSpd > 3;

  updateTireSFX(
    absSpd,
    player.drifting || isWheelspin,
    isWheelspin ? Math.min(0.35, 0.18 + player.wheelGap * 0.01) : player.slipAngle,
    controls.braking,
    controls.ebrk,
    isHardAccel,
    dt,
    player.speed,
    controls.brakeAmount,
    player.onRoad,
    player.gripUse ?? 0,
  );

  let screechVol = 0;
  if (!sfxFlags.tireSamplesLoaded && audio.tireGain) {
    if (player.drifting && absSpd > 8 && Math.abs(player.slipAngle) > 0.15) {
      screechVol =
        Math.min(0.3, (Math.abs(player.slipAngle) - 0.15) * 1.5) * Math.min(1, absSpd / 40);
    }
    // H1250: same pre-limit cornering scrub on the SYNTH path, so players
    // without the tyre sample pack get the feedback too. Matches the
    // tireGrain thresholds (0.72 start, squared ramp).
    const _grip = player.gripUse ?? 0;
    if (_grip > 0.72 && absSpd > 26 && player.onRoad && !player.drifting) {
      const t2 = Math.min(1, (_grip - 0.72) / 0.28);
      screechVol = Math.max(screechVol, 0.18 * t2 * t2);
    }
    if (isWheelspin) {
      screechVol = Math.max(screechVol, Math.min(0.25, player.wheelGap * 0.02));
    }
    const synthLockThresh = player.onRoad ? 0.80 : 0.40;
    if (
      controls.braking &&
      !controls.ebrk &&
      player.speed > 0 &&
      absSpd > 35 &&
      controls.brakeAmount >= synthLockThresh &&
      !player.drifting
    ) {
      screechVol = Math.max(screechVol, 0.08);
    }
    if (controls.ebrk && absSpd > 15 && !player.drifting) {
      screechVol = Math.max(screechVol, 0.08);
    }
  }
  audio.tireGain?.gain.setTargetAtTime(screechVol, t, 0.015);
  audio.tireFilter?.frequency.setTargetAtTime(1800 + absSpd * 20, t, 0.02);

  if (audio.brakePadGain && audio.brakePadFilter) {
    const padLockThresh = player.onRoad ? 0.80 : 0.40;
    const isLockup =
      (controls.braking &&
        !controls.ebrk &&
        player.speed > 0 &&
        absSpd > 35 &&
        controls.brakeAmount >= padLockThresh) ||
      (controls.ebrk && absSpd > 15);
    let padVol = 0;
    if (controls.braking && !controls.ebrk && !isLockup && !player.drifting && absSpd > 1) {
      padVol = Math.min(0.18, 0.04 + (controls.brakeAmount || 0.5) * 0.10) * Math.min(1, absSpd / 15);
    }
    audio.brakePadGain.gain.setTargetAtTime(padVol, t, 0.04);
    audio.brakePadFilter.frequency.setTargetAtTime(280 + absSpd * 4, t, 0.04);
  }

  // H858: ALL V8 cars use the real sample loops (eType === 'v8'), not just
  // 6 hardcoded names. When the V8 sample owns the car, FULLY silence the
  // procedural resonators (was 0.05 — a faint hybrid bleed) so there's a
  // single clean V8 voice, not synth-under-sample.
  updateV8Engine(v8Owns, player.gear, controls.gas, rpmNorm, absSpd, hpAggr);
  // H1237: recorded multi-band voice — RPM-band crossfade with the
  // on/off-throttle takes carrying the load axis.
  updateFamilySample(
    eType, famOwns && !v8Owns,
    aRpm, car.idleRPM, car.redline, rpmNorm, controls.gasAmount, hpAggr,
    car.voice,
  );
  if (isFamilySampleActive()) {
    audio.bikeScreamGain?.gain.setTargetAtTime(0, t, 0.05);
  }
  if (isV8Active()) {
    audio.engNoiseGain?.gain.setTargetAtTime(0, t, 0.1);
    audio.engBassGain?.gain.setTargetAtTime(0, t, 0.05);
    audio.exhaustGain?.gain.setTargetAtTime(0, t, 0.05);
  }
}
