/**
 * Tire physics — NFS Blackbox two-state model. Slip angle + slip ratio
 * blend between "grip" (gripMu × normal load) and "drift" (kinetic
 * friction at the contact patch). The two-state switch lets the car
 * carry momentum through long drifts while still recovering grip when
 * straightened.
 *
 * Ported from monolith L24217-24720. Two helpers were nested inside
 * update(dt): _tireCurve (slip angle → lateral force) and
 * _combinedSlipFactor (combines longitudinal + lateral slip into a
 * combined-grip factor 0..1).
 *
 * SCAFFOLD status: types + key entry points; bodies stubbed.
 */

import type { PlayerPhysicsState, FaultEffects, CarSpec } from './types';

/** Slip-angle → lateral force curve (Pacejka-like). Peaks near 5° slip,
 *  falls off past ~12° for the kinetic regime. From _tireCurve. */
export function tireCurve(_slipAngle: number, _gripPeak: number): number {
  // TODO(C21-followup): port the polynomial / table interp from
  // monolith L24221+.
  return 0;
}

/** Combines longitudinal slip (wheelspin/lockup) with lateral slip (sideways
 *  drift) into a single grip factor 0..1. Lower = less available friction. */
export function combinedSlipFactor(_slipLon: number, _slipLat: number): number {
  // TODO(C21-followup): port from L24230+.
  return 1.0;
}

/** Per-frame tire-physics tick. Updates rotational inertia, slip-state
 *  classification, applies grip vs drift force balance, and pushes the
 *  result into state.vx/vy. */
export function updateTirePhysics(
  _state: PlayerPhysicsState,
  _car: CarSpec,
  _fx: FaultEffects,
  _onGrass: boolean,
  _dt: number,
): void {
  // TODO: monolith L24247-24720.
}
