/**
 * Movement integration — velocity to position, dynamic bicycle integrator,
 * yaw inertia, downforce, longitudinal weight transfer, per-axle μ scaling,
 * supercharger mod, LSD differential, kinematic-bicycle position update.
 *
 * Ported from monolith L25193-26377. The largest single block in update(dt).
 *
 * SCAFFOLD status: types in place; updateMovement body stubbed.
 */

import type { PlayerPhysicsState, FaultEffects, CarSpec, FrameInputs } from './types';

/** Per-frame movement tick. Integrates velocity → position with full
 *  dynamic-bicycle physics. Mutates state.px / py / vx / vy / pAngle /
 *  pAngVel based on the current vehicle dynamics state.
 *
 *  TODO(C22-followup): port monolith L25193-26377. */
export function updateMovement(
  _state: PlayerPhysicsState,
  _inputs: FrameInputs,
  _car: CarSpec,
  _fx: FaultEffects,
  _onGrass: boolean,
  _hasTrailer: boolean,
  _dt: number,
): void {
  // TODO: L25193-26377.
}
