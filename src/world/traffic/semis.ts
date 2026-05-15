/**
 * Traffic semi-truck details — articulated trailer angle integration and
 * tractor↔trailer collision (separate from the player's articulation
 * physics in physics/trailer.ts).
 *
 * Ported from monolith L28102-28221. The two helpers:
 *   - updateTrafficTrailerAngles: per-frame articulation tick
 *   - updateTrafficSemiCollisions: keeps a semi from clipping into adjacent
 *     traffic during lane changes (the 53' wheelbase is too big for the
 *     base car-vs-car AABB).
 *
 * SCAFFOLD status: typed entries; bodies stubbed.
 */

import type { TrafficCar } from './types';

/** Per-frame articulated-trailer angle update for every traffic semi. */
export function updateTrafficTrailerAngles(
  _traffic: TrafficCar[],
  _dt: number,
): void {
  // TODO(C25-followup): port monolith L28102-28124.
}

/** Per-frame semi↔adjacent-car collision detection + slow-down. */
export function updateTrafficSemiCollisions(
  _traffic: TrafficCar[],
): void {
  // TODO(C25-followup): port monolith L28125-28221.
}
