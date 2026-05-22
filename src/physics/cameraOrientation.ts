/**
 * Camera-orientation state derivation — per-frame computation of
 * the values the render/camera module consumes (pVelAngleFiltered,
 * pCamAngle).
 *
 * These are NOT the camera-projection / perspective math (which
 * lives in src/render/camera.ts), but the upstream orientation
 * inputs that come from the physics update loop:
 *
 *   pVelAngleFiltered  — low-passed velocity direction so the
 *                        camera doesn't jitter when bicycle-model
 *                        slip produces high-frequency pVelAngle
 *                        noise.
 *   pCamAngle          — the smoothed camera-heading target that
 *                        the render code reads each frame.
 *
 * Monolith source: inside update() at L26518-L26548.
 */

/** Low-pass filter rate (1/s) for pVelAngle in the grip state.
 *  10/s ↔ ~100 ms time constant. The pVelAngle reading itself is
 *  the instantaneous CG velocity direction; under the bicycle
 *  model, that contains real kinematic slip jitter that the
 *  physics needs but that would shake the camera. The filter
 *  feeds the camera a smoothed copy.
 *
 *  Matches monolith `10` at L26528. */
export const CAM_VEL_FILTER_RATE_GRIP = 10;

/** Low-pass filter rate (1/s) for pVelAngle during drift. 14/s ↔
 *  ~70 ms time constant. Faster filter rate during drift so the
 *  drift-cam (which is following the chassis through the slide)
 *  still reacts to the player's intent rather than lagging
 *  comically behind the action.
 *
 *  Matches monolith `14` at L26528. */
export const CAM_VEL_FILTER_RATE_DRIFT = 14;

/** Advance the pVelAngle low-pass filter by one tick. Returns
 *  the new pVelAngleFiltered.
 *
 *  FORMULA (1:1 with monolith):
 *    diff = pVelAngle - pVelAngleFiltered
 *    wrap diff to (-π, π]
 *    rate = pDrifting ? 14 : 10
 *    pVelAngleFiltered += diff × rate × dt
 *
 *  WHY THE WRAPAROUND: pVelAngle and pVelAngleFiltered are angles
 *  on the unit circle. A naive `pVelAngle - pVelAngleFiltered`
 *  could span 359° when the shortest path is -1°; the filter
 *  would chase the wrong way around the circle. Wrapping to
 *  (-π, π] ensures the shortest path.
 *
 *  WHY FASTER RATE DURING DRIFT: a drift cam follows the chassis
 *  through the slide. The velocity vector swings rapidly as
 *  drift develops — slow filter would have the camera lagging
 *  comically behind the action. 14/s ↔ ~70 ms vs grip's 100 ms
 *  keeps the cam-orientation responsive enough that drift looks
 *  intentional.
 *
 *  INPUTS:
 *    pVelAngleFiltered   current filtered value
 *    pVelAngle           instantaneous CG velocity direction
 *    pDrifting           drift state flag
 *    dt                  frame timestep (s)
 *
 *  Returns the new pVelAngleFiltered.
 *
 *  Ported 1:1 from monolith L26524-L26528 (the pVelAngleFiltered
 *  low-pass update at the head of the camera-angle block). */
export function tickPVelAngleFilter(
  pVelAngleFiltered: number,
  pVelAngle: number,
  pDrifting: boolean,
  dt: number,
): number {
  let diff = pVelAngle - pVelAngleFiltered;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  const rate = pDrifting ? CAM_VEL_FILTER_RATE_DRIFT : CAM_VEL_FILTER_RATE_GRIP;
  return pVelAngleFiltered + diff * rate * dt;
}
