/**
 * Steering subsystem. Includes the deduplicated power-steering-fault helper
 * that was inlined 3× in the monolith (L24851, L26076, L26082).
 *
 * SCAFFOLD status: the power-steering helper is fully extracted and
 * working. The full updateSteering(dt) entry (~400 lines monolith
 * L24721-25119) is stubbed with a TODO — port deferred to follow-up
 * since the surface is heavily dependent on PlayerPhysicsState mutation.
 */

import type { PlayerPhysicsState, FaultEffects, FrameInputs, CarSpec } from './types';

/**
 * Power-steering fault — reduces angular velocity when speed is low.
 * MUST be called regardless of whether the steering fault is active,
 * since the multiplier is zero when ps_leak isn't in faults.
 *
 * Was duplicated 3× in the monolith:
 *   L24851 — main steering update
 *   L26076 — drift-mode override
 *   L26082 — legacy bike branch
 *
 * Formula: at 0 mph, pAngVel is multiplied by (1 - 0.60). At 25 mph and
 * above the multiplier reaches 1.0 (no reduction). The transition is
 * linear in mph (= |pSpeed| / SCALE_MS * 2.237).
 *
 * @param pAngVel  current angular velocity (rad/sec)
 * @param absSpd   absolute forward speed |pSpeed|
 * @param SCALE_MS meters-per-game-unit scaling
 * @param active   true when the ps_leak fault is in LIFE.faults
 * @returns reduced angular velocity
 */
export function applyPowerSteeringFault(
  pAngVel: number,
  absSpd: number,
  SCALE_MS: number,
  active: boolean,
): number {
  if (!active) return pAngVel;
  const psMph = absSpd / SCALE_MS * 2.237;
  const psLo = Math.max(0, 1 - psMph / 25);
  return pAngVel * (1 - 0.60 * psLo);
}

/** Main steering tick — drivetrain-aware steering response, trail-brake
 *  rotation, drive-under-power effects, fault steer-pull and steer-slow.
 *
 *  TODO(C21-followup): port monolith L24721-25119. */
export function updateSteering(
  _state: PlayerPhysicsState,
  _inputs: FrameInputs,
  _car: CarSpec,
  _fx: FaultEffects,
  _dt: number,
  _SCALE_MS: number,
): void {
  // TODO: L24721-25119.
}
