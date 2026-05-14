/**
 * Vehicle propulsion — acceleration, torque curve, turbo spool, drivetrain
 * inertia, LSD traction, downforce grip bonus, trailer mass factor.
 *
 * Ported from monolith L24070-24208. The torque-curve lookup (GT4 or
 * legacy fraction-based) is the main per-frame compute.
 *
 * SCAFFOLD status: types extracted; updateAcceleration body stubbed.
 */

import type { PlayerPhysicsState, FaultEffects, FrameInputs, CarSpec } from './types';

/** GT4 RPM-indexed torque lookup. From _torqueCurveAtRPM. */
export function getTorqueAtRPM(_car: CarSpec, _rpm: number): number {
  // TODO(C21-followup): port the GT4 piecewise-linear sample interpolation
  // (was inline in update at L24081). For now, returns 1.0 so callers
  // type-check; real port is a one-page extraction from torque.ts data.
  return 1.0;
}

/**
 * Per-frame acceleration tick. Reads gas/brake/cruise/onGrass/turboBoost,
 * produces the new pSpeed. Mutates state.pSpeed and state.turboBoost.
 *
 * TODO(C21-followup): port monolith L24070-24208 — torque calc, gear mult,
 * turbo spool, inertia, traction, downforce, trailer mass, grass penalty,
 * fault accelMult, brake force, and the final pSpeed integration.
 */
export function updateAcceleration(
  _state: PlayerPhysicsState,
  _inputs: FrameInputs,
  _car: CarSpec,
  _fx: FaultEffects,
  _onGrass: boolean,
  _hasTrailer: boolean,
  _trailerKg: number,
  _dt: number,
): void {
  // TODO: L24070-24208.
}
