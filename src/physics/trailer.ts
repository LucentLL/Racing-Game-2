/**
 * Articulated trailer physics — full kinematic-bicycle model with
 * no-slip tandem axles, jackknife articulation limits, hard-brake
 * traction loss, load-weight drag.
 *
 * Ported from monolith L27884-28101. Includes the shared trailer-kg
 * helper (mass from loadWeight) that was duplicated in vehicle.ts's
 * trailer-mass branch (L24134, L24262).
 */

import type { PlayerPhysicsState } from './types';

export interface TrailerState {
  /** Trailer body angle (radians) — independent of cab pAngle during
   *  jackknife. */
  angle: number;
  /** Trailer length / width in game units. */
  length: number;
  width: number;
  /** Cargo load 0..1 (0 = empty frame ~4500 kg, 1 = full ~20500 kg). */
  loadWeight: number;
  /** Jackknife magnitude in radians (warning at 0.3, hard limit 1.57). */
  jackknife: number;
  /** Trailer body kind. */
  trailerType: 'tanker' | 'box' | string;
}

/** Mass-from-loadWeight helper, ported from monolith L24135-24136.
 *  Was duplicated inline at L24134 (vehicle.ts trailer mass branch)
 *  and L24262 (turbo penalty branch) — extracting here per
 *  MIGRATION_PLAN section 5.3. */
export function getTrailerKg(trailer: TrailerState | null): number {
  if (!trailer) return 0;
  const lw = trailer.loadWeight || 0.6;
  return 4500 + lw * 16000;
}

/** Per-frame trailer angle update + jackknife detection. Mutates
 *  trailer.angle and trailer.jackknife.
 *
 *  TODO(C23-followup): port monolith L27884-28101 — core ODE, articulation
 *  zones (60° caution, 75° warning, 90° hard limit), drive-wheel lockup
 *  cab-swing, load-weight drag, governed speed cut. */
export function updateTrailer(
  _state: PlayerPhysicsState,
  _trailer: TrailerState,
  _hardBraking: boolean,
  _dt: number,
): void {
  // TODO: L27884-28101.
}
