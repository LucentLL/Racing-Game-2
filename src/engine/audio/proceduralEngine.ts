import { audio, type AudioFrameInputs } from './state';
import { sfxFlags } from './sfx';
import { fireExhaustPop } from './init';
import { updateTireSFX } from './tireGrain';
import { updateV8Engine, isV8Active } from './v8Engine';

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

  if (uiOpen) {
    audio.engNoiseGain?.gain.setTargetAtTime(0, t, 0.15);
    audio.engBassGain?.gain.setTargetAtTime(0, t, 0.15);
    audio.exhaustGain?.gain.setTargetAtTime(0, t, 0.15);
    audio.tireGain?.gain.setTargetAtTime(0, t, 0.15);
    audio.brakePadGain?.gain.setTargetAtTime(0, t, 0.15);
    return;
  }

  const eType = classifyEngine(car.name, car.isBike, car.eType);
  const cyls = CYL_MAP[eType];
  const fundHz = Math.max(20, (player.rpm / 60) * (cyls / 2));
  const rpmRange = Math.max(1, car.redline - car.idleRPM);
  const rpmNorm = Math.max(0, Math.min(1, (player.rpm - car.idleRPM) / rpmRange));
  const P = ENGINE_PROFILES[eType];

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
  audio.engBassGain?.gain.setTargetAtTime(P[7] + rpmNorm * P[7], t, 0.03);

  audio.exhaust?.frequency.setTargetAtTime(P[6] + rpmNorm * 300, t, 0.02);
  audio.exhaustGain?.gain.setTargetAtTime(P[8] + rpmNorm * P[8] * 1.5, t, 0.03);

  const screamAmt = P[9];
  if (screamAmt > 0) {
    audio.bikeScream?.frequency.setTargetAtTime(4500 + rpmNorm * 3000, t, 0.02);
    audio.bikeScreamGain?.gain.setTargetAtTime(rpmNorm * rpmNorm * screamAmt, t, 0.03);
  } else {
    audio.bikeScreamGain?.gain.setTargetAtTime(0, t, 0.02);
  }

  if (player.gear !== audio.lastGear && player.gear > 0 && audio.lastGear > 0) {
    fireExhaustPop();
    if (Math.random() > 0.4) setTimeout(fireExhaustPop, 40 + Math.random() * 80);
    if (Math.random() > 0.7) setTimeout(fireExhaustPop, 120 + Math.random() * 60);
  }
  audio.lastGear = player.gear;
  if (absSpd < 3 && rpmNorm < 0.15 && Math.random() < 0.004) fireExhaustPop();
  if (player.rpm >= car.redline * 0.97 && controls.gas && Math.random() < 0.02) fireExhaustPop();

  const isHardAccel = controls.gas && player.gear <= 2 && rpmNorm > 0.6 && !player.drifting;
  const wsReal = player.wheelspinRatio > 0.15;
  const wsLaunch = player.gear <= 2 && player.wheelGap > 3;
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
  );

  let screechVol = 0;
  if (!sfxFlags.tireSamplesLoaded && audio.tireGain) {
    if (player.drifting && absSpd > 8 && Math.abs(player.slipAngle) > 0.15) {
      screechVol =
        Math.min(0.3, (Math.abs(player.slipAngle) - 0.15) * 1.5) * Math.min(1, absSpd / 40);
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

  updateV8Engine(car.name, player.gear, controls.gas, rpmNorm, absSpd);
  if (isV8Active()) {
    audio.engNoiseGain?.gain.setTargetAtTime(0.05, t, 0.1);
    audio.engBassGain?.gain.setTargetAtTime(0, t, 0.05);
    audio.exhaustGain?.gain.setTargetAtTime(0, t, 0.05);
  }
}
