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

/** Minimum |pSpeed| (gu/s) for the camera to follow filtered
 *  velocity direction. Below this the chassis is essentially
 *  stopped and the velocity vector is dominated by numerical
 *  noise — falling back to chassis heading produces a stable
 *  cam orientation at parking-lot speeds.
 *
 *  Matches monolith `Math.abs(pSpeed) > 5` at L26531. */
export const CAM_TARGET_SPEED_GATE = 5;

/** pSpeed threshold (signed gu/s) below which the chassis is
 *  considered to be reversing. The asymmetric threshold (-0.5
 *  vs the symmetric ±5 gate above) means: forward motion at
 *  5+ uses filtered velocity; reverse motion at -0.5 to -5 uses
 *  chassis heading anyway; reverse at -5+ uses chassis heading
 *  (instead of momentum) except for semi-with-trailer where
 *  seeing the trailer behind during backing matters more.
 *
 *  Matches monolith `pSpeed < -0.5` at L26538. */
export const CAM_TARGET_REVERSE_GATE = -0.5;

/** Select the per-frame camera-orientation target. The smoothed
 *  pCamAngle will lerp toward this value.
 *
 *  THREE BRANCHES (1:1 with monolith):
 *    if |pSpeed| <= 5:           camTarget = pAngle (chassis)
 *    if pSpeed < -0.5 AND
 *       NOT semi-with-trailer:   camTarget = pAngle (chassis;
 *                                              reverse-driving
 *                                              shouldn't spin
 *                                              the world)
 *    else:                       camTarget = pVelAngleFiltered
 *
 *  v8.92 SEMI-TRAILER EXCEPTION: a semi with an attached
 *  trailer/tanker REVERSING uses the filtered velocity direction
 *  (not chassis heading) so the player can see the trailer
 *  behind them during backing maneuvers — essential for jackknife
 *  recovery and parking the rig. For all other vehicles, reverse
 *  driving keeps the camera oriented to heading so simple
 *  parking/backing doesn't spin the whole world.
 *
 *  WHY THE LOW-SPEED FALLBACK TO pAngle: at slow speed, pVelAngle
 *  (and therefore pVelAngleFiltered) is dominated by numerical
 *  noise — the actual displacement is tiny and atan2 produces
 *  random-direction values. Falling back to chassis heading
 *  produces a stable cam orientation at parking-lot speeds.
 *
 *  INPUTS:
 *    pAngle              chassis heading
 *    pVelAngleFiltered   smoothed velocity direction (from
 *                        [[tickPVelAngleFilter]])
 *    pSpeed              scalar speed (signed)
 *    isSemiWithTrailer   CAR().bodyType === 'semi' && !!LIFE.trailer
 *
 *  Returns the cam target angle. Caller passes this to
 *  [[tickPCamAngle]] (next hop) for the smoothed lerp.
 *
 *  Ported 1:1 from monolith L26530-L26543 (the camTarget
 *  selection block in the camera-angle section). */
export function selectCamTarget(
  pAngle: number,
  pVelAngleFiltered: number,
  pSpeed: number,
  isSemiWithTrailer: boolean,
): number {
  if (Math.abs(pSpeed) <= CAM_TARGET_SPEED_GATE) return pAngle;
  if (pSpeed < CAM_TARGET_REVERSE_GATE && !isSemiWithTrailer) return pAngle;
  return pVelAngleFiltered;
}
