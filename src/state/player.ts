/**
 * Player pose + arcade-tier kinematic state.
 *
 * H6: this is INTENTIONALLY simpler than the monolith's player state
 * (which carries 40+ fields for tire slip, gear, RPM, engine load,
 * fuel, etc., in L17648-17985). The fields here are the minimum to
 * drive a triangle around an empty plane — px/py position, pAngle
 * heading, pSpeed scalar speed. Subsequent H commits grow this struct
 * as physics/tire/steering bodies port and start needing real state.
 *
 * The richer state lives on a separate type in src/physics/ when those
 * ports land; this file stays the pose-only contract that render and
 * camera read from.
 */

/** Player pose + speed (units: tiles for px/py, radians for pAngle,
 *  tiles-per-second for pSpeed). */
export interface PlayerState {
  px: number;
  py: number;
  pAngle: number;
  pSpeed: number;
}

/** Spawn pose. Centered on a notional 100×100 plane so the H6 car has
 *  some headroom regardless of viewport size. World map generation
 *  will replace this with a real spawn lookup. */
export function createPlayerState(): PlayerState {
  return { px: 50, py: 50, pAngle: 0, pSpeed: 0 };
}
