/**
 * H1096: visual "weight" — a smoothed body-lean state driven by the car's ACTUAL
 * lateral + longitudinal G, consumed by the camera to BANK into corners and DIP
 * under braking / settle on throttle. Purely cosmetic: it reads pAngle + pSpeed
 * and writes player.bodyRoll / bodyPitch; it has NO effect on handling.
 *
 * This is E1 of the driving-feel overhaul — the user's "too light / doesn't feel
 * like suspension rolls" complaint. The physics grip/weight pass (E2) is separate.
 *
 * Yaw rate is derived from the pAngle delta (not the phase0B-internal pYawRate)
 * so this stays decoupled from the integrator. All magnitudes are tunable below;
 * the final calibration is the user's drive-test.
 */
import type { PlayerState } from '@/state/player';

/** Lateral accel (world-px/s²) that saturates full roll. GRAVITY ≈ 47.7 px/s²,
 *  so ~0.85 g of cornering leans the camera fully. */
const LAT_REF = 40;
/** Longitudinal accel (world-px/s²) that saturates full pitch (~3 g of braking). */
const LONG_REF = 150;
/** Suspension-like settle rate of the smoothed lean (per second). Higher = snappier. */
const LEAN_RATE = 7;

let _prevSpeed = 0;
let _prevAngle = 0;
let _init = false;

function clamp1(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

/** Advance bodyRoll (lateral load, −1..1) and bodyPitch (longitudinal load:
 *  <0 braking/dive, >0 throttle/squat) once per rendered frame. */
export function updateBodyLean(player: PlayerState, dt: number): void {
  if (dt <= 0) return;
  if (!_init) {
    _prevSpeed = player.pSpeed;
    _prevAngle = player.pAngle;
    _init = true;
  }
  let dA = player.pAngle - _prevAngle;
  if (dA > Math.PI) dA -= 2 * Math.PI;
  else if (dA < -Math.PI) dA += 2 * Math.PI;
  const dSpeed = player.pSpeed - _prevSpeed;
  _prevSpeed = player.pSpeed;
  _prevAngle = player.pAngle;

  // H1100: TELEPORT / discontinuity guard. resetPlayerMotion zeroes the lean
  // but can't reach this module's _prev seed, so the first frame after a map
  // switch / fast-travel / respawn derived a bogus spike from the OLD pose
  // (verify-pass finding: a one-frame ~full-sway pop). Normal driving never
  // exceeds ~0.05 rad or ~7 px/s per 60 fps frame; anything past these bounds
  // is a warp (or a tab-resume mega-frame) — reseed and let the lean decay
  // toward 0 instead of spiking.
  if (Math.abs(dA) > 0.35 || Math.abs(dSpeed) > 80) {
    player.bodyRoll *= 0.5;
    player.bodyPitch *= 0.5;
    return;
  }
  const yawRate = dA / dt;
  const latAccel = player.pSpeed * yawRate;
  const longAccel = dSpeed / dt;

  // Targets are clamped to ±1 (clamp1) — THAT is what bounds a spike; the k
  // low-pass below only shapes how fast the lean settles (≤1 step per frame).
  const rollTarget = clamp1(latAccel / LAT_REF);
  const pitchTarget = clamp1(longAccel / LONG_REF);
  const k = Math.min(1, dt * LEAN_RATE);
  player.bodyRoll += (rollTarget - player.bodyRoll) * k;
  player.bodyPitch += (pitchTarget - player.bodyPitch) * k;
}
