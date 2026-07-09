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
  const yawRate = dA / dt;
  const latAccel = player.pSpeed * yawRate;
  const longAccel = (player.pSpeed - _prevSpeed) / dt;
  _prevSpeed = player.pSpeed;
  _prevAngle = player.pAngle;

  const rollTarget = clamp1(latAccel / LAT_REF);
  const pitchTarget = clamp1(longAccel / LONG_REF);
  // Low-pass toward the target. k is capped at 1, so even a teleport spike moves
  // the lean by at most k per frame — no lurch.
  const k = Math.min(1, dt * LEAN_RATE);
  player.bodyRoll += (rollTarget - player.bodyRoll) * k;
  player.bodyPitch += (pitchTarget - player.bodyPitch) * k;
}
