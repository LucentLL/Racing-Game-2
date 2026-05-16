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

/** Player pose + speed.
 *
 *  Units: WORLD-COORD pixels for px/py (1 world unit = 1 canvas pixel,
 *  same coord system the renderer uses). World tile coords from
 *  BASELINE_ROADS multiply by TILE (18) to land in this space.
 *  pAngle = radians; pSpeed = world-units per second.
 *
 *  fuel: 0..1 (1 = full tank). Decrements as the player drives;
 *  refuels at gas stations. Cuts acceleration at 0.
 *
 *  collisionFlash: 0..1 visual + cooldown timer for H18 traffic
 *  collision feedback. Ticks toward 0 each frame. While > 0, the
 *  car border draws red and new collision checks short-circuit (so
 *  one bump doesn't fire 60 times across consecutive frames).
 */
export interface PlayerState {
  px: number;
  py: number;
  pAngle: number;
  pSpeed: number;
  fuel: number;
  collisionFlash: number;
  /** H61 smoothed camera angle — lags player.pAngle by ~6 frames so
   *  the camera doesn't jerk on sharp inputs. Lerps toward pAngle each
   *  frame with shortest-arc handling. Render reads this for the
   *  camera rotate transform; everything else (car body, headlight
   *  cone) still uses player.pAngle so the car itself reacts crisply. */
  pCamAngle: number;
}

/** Spawn pose. H8: tile coord (1000, 1100) is approx downtown
 *  Charlotte (near I-277 inner-loop intersection). Multiply by TILE
 *  to get world coords. Subsequent ports replace this with a road-
 *  surface lookup (so the player can never spawn on grass / inside a
 *  building / over water). */
export function createPlayerState(): PlayerState {
  const TILE = 18;
  return {
    px: 1000 * TILE,
    py: 1100 * TILE,
    pAngle: 0,
    pSpeed: 0,
    fuel: 1,
    collisionFlash: 0,
    pCamAngle: 0,
  };
}

/** Per-frame camera-angle smoothing. Lerps pCamAngle toward pAngle via
 *  shortest-arc (so wrapping ±π doesn't unwind the long way around).
 *  Smoothing factor `k` is time-rate (1 = instant, 0.15 = ~6 frames at
 *  60fps to converge). */
export function tickCameraAngle(player: PlayerState, dt: number, k: number = 8.0): void {
  // Shortest-arc delta in (-π, π].
  let delta = player.pAngle - player.pCamAngle;
  delta = ((delta + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  // Exponential approach. At k=8 / dt=1/60 → 0.125 of remaining delta
  // per frame, ≈ 6 frames to settle within 50%.
  const t = 1 - Math.exp(-k * dt);
  player.pCamAngle += delta * t;
}
