/**
 * Legacy movement branch — runs for bikes, special vehicles (semi /
 * tow / cruiser), drift state, trailers, and the user-toggle-off branch.
 * Keeps the original arcade-feel update for vehicle classes that don't
 * benefit from the full dynamic-bicycle path in movement.ts.
 *
 * Ported from monolith L26378-26448 (~70 lines, smaller than its siblings).
 *
 * SCAFFOLD status: typed entry; body stubbed.
 */

import type { PlayerPhysicsState, FaultEffects, FrameInputs, CarSpec } from './types';

/** Per-frame legacy movement tick. Same signature as updateMovement so
 *  the caller can swap based on car type without branching.
 *
 *  TODO(C22-followup): port monolith L26378-26448. */
export function updateLegacyMovement(
  _state: PlayerPhysicsState,
  _inputs: FrameInputs,
  _car: CarSpec,
  _fx: FaultEffects,
  _onGrass: boolean,
  _hasTrailer: boolean,
  _dt: number,
): void {
  // TODO: L26378-26448.
}
