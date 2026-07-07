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

/** H1060: slip magnitude (rad) at which the camera treats the car
 *  as fully sliding — the velocity-blend weight and the drift
 *  filter/lerp rates saturate here. ~20°: past this the chassis is
 *  unmistakably slideways. Below it everything scales linearly, so
 *  camera behavior has NO one-frame discontinuity at the drift
 *  classifier's flag flip (the old pDrifting-keyed rates stepped
 *  6→4/s and 10→14/s in a single frame at drift entry/exit). */
export const CAM_SLIP_FULL = 0.35;

/** Advance the pVelAngle low-pass filter by one tick. Returns
 *  the new pVelAngleFiltered.
 *
 *  FORMULA (monolith shape; H1060 made the rate continuous):
 *    diff = pVelAngle - pVelAngleFiltered
 *    wrap diff to (-π, π]
 *    rate = 10 + (14 - 10) × slipT      [was: pDrifting ? 14 : 10]
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
  slipT: number,
  dt: number,
): number {
  let diff = pVelAngle - pVelAngleFiltered;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  const rate = CAM_VEL_FILTER_RATE_GRIP
    + (CAM_VEL_FILTER_RATE_DRIFT - CAM_VEL_FILTER_RATE_GRIP) * slipT;
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

/** H1060: maximum velocity-direction weight in the forward cam
 *  target. During a full slide the camera aims 65 % of the way
 *  from heading toward the travel direction — the chassis still
 *  visibly rotates off the travel axis (drift stays readable, the
 *  NFS drift look), but the camera's home base is the HEADING. */
export const CAM_VEL_WEIGHT_MAX = 0.65;

/** Select the per-frame camera-orientation target. The smoothed
 *  pCamAngle will lerp toward this value.
 *
 *  H1060 REDESIGN — the camera's forward target is now the CHASSIS
 *  HEADING with a slip-proportional blend toward the filtered
 *  velocity direction, instead of the velocity direction outright.
 *
 *  WHY: the old velocity-target cam manufactured the reported
 *  "car rubber-bands back to the camera direction" visual even
 *  with perfect physics. In a steady 60 mph corner the sprite sat
 *  8-14° rotated into the turn (slip + two cascaded filter lags);
 *  on steering release the physics stopped yawing within ~0.2 s
 *  but the camera kept chasing the velocity direction for another
 *  0.3-0.5 s — the whole world counter-rotated under a car that
 *  was no longer turning, reading as the car springing back to
 *  screen-up. Targeting the heading pins the car sprite in grip
 *  (nothing left to unwind on release), while the slip blend
 *  keeps slides readable: the more sideways the car actually is,
 *  the more the camera holds the travel direction and lets the
 *  chassis rotate in frame (Blackbox NFS drift-cam behavior).
 *
 *  BRANCHES:
 *    if |pSpeed| <= 5:           camTarget = pAngle (chassis)
 *    if pSpeed < -0.5:
 *      semi-with-trailer:        camTarget = pVelAngleFiltered
 *      otherwise:                camTarget = pAngle (reverse-
 *                                            driving shouldn't
 *                                            spin the world)
 *    else (forward):             camTarget = pAngle
 *                                  + 0.65 × slipT × wrap(pVelAngleFiltered − pAngle)
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
  slipT: number,
): number {
  if (Math.abs(pSpeed) <= CAM_TARGET_SPEED_GATE) return pAngle;
  if (pSpeed < CAM_TARGET_REVERSE_GATE) {
    // v8.92 semi-trailer exception: keep full velocity-follow while
    // backing a rig so the trailer stays visible behind the cab.
    return isSemiWithTrailer ? pVelAngleFiltered : pAngle;
  }
  // H1060: heading-based target with slip-proportional velocity blend.
  let diff = pVelAngleFiltered - pAngle;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  return pAngle + CAM_VEL_WEIGHT_MAX * slipT * diff;
}

/** pCamAngle lerp rate (1/s) in the grip state. 6/s ↔ ~170 ms
 *  time constant. Fast enough that the cam tracks the chassis
 *  through corner entries without dragging behind, slow enough
 *  that minor steering inputs don't shake the world.
 *
 *  Matches monolith `6` at L26548. */
export const CAM_LERP_RATE_GRIP = 6;

/** pCamAngle lerp rate (1/s) during drift. 4/s ↔ ~250 ms time
 *  constant. SLOWER than grip — opposite of the velocity filter
 *  ([[CAM_VEL_FILTER_RATE_DRIFT]] is FASTER than its grip
 *  counterpart).
 *
 *  WHY SLOWER (CAMERA, NOT FILTER): the filter responds faster
 *  during drift so the cam-target stays close to actual velocity
 *  direction (drift cam needs to follow the chassis through the
 *  slide). But the camera ANGLE LERP toward that target should
 *  be SLOWER during drift — gives the visual sense of "the world
 *  is tumbling slowly while the car is sliding," a more
 *  cinematic feel. Snapping the camera instantly to the target
 *  would make drift look frantic; a slower lerp produces the
 *  characteristic "drift movie" camera motion.
 *
 *  Matches monolith `4` at L26548. */
export const CAM_LERP_RATE_DRIFT = 4;

/** Advance the smoothed camera-angle (pCamAngle) toward the
 *  selected target by one tick.
 *
 *  FORMULA (1:1 with monolith):
 *    camDiff = camTarget - pCamAngle
 *    wrap camDiff to (-π, π]
 *    rate = pDrifting ? 4 : 6
 *    pCamAngle += camDiff × rate × dt
 *
 *  Returns the new pCamAngle. Standard exponential relax
 *  toward target with shortest-path angle wrap.
 *
 *  WHY THE WRAPAROUND: same as in [[tickPVelAngleFilter]] —
 *  angles on the unit circle require shortest-path normalization
 *  or the lerp chases the wrong direction.
 *
 *  WHY SLOWER DURING DRIFT (vs the FASTER filter rate): see
 *  [[CAM_LERP_RATE_DRIFT]] docstring. Different rates serve
 *  different purposes — the filter chases the noisy true
 *  velocity; the camera angle smooths the chase into a stable
 *  visual trajectory.
 *
 *  INPUTS:
 *    pCamAngle     current smoothed camera heading
 *    camTarget     selected target from [[selectCamTarget]]
 *    pDrifting     drift state flag
 *    dt            frame timestep (s)
 *
 *  Returns the new pCamAngle.
 *
 *  Ported 1:1 from monolith L26545-L26548 (the pCamAngle lerp
 *  block at the tail of the camera-angle section). */
export function tickPCamAngle(
  pCamAngle: number,
  camTarget: number,
  slipT: number,
  dt: number,
): number {
  let camDiff = camTarget - pCamAngle;
  while (camDiff > Math.PI) camDiff -= 2 * Math.PI;
  while (camDiff < -Math.PI) camDiff += 2 * Math.PI;
  // H1060: continuous grip↔drift rate blend (was a one-frame 6→4/s
  // step on the pDrifting flag flip — a visible camera-speed snap
  // at drift exit, right when the accumulated error was largest).
  const rate = CAM_LERP_RATE_GRIP
    + (CAM_LERP_RATE_DRIFT - CAM_LERP_RATE_GRIP) * slipT;
  return pCamAngle + camDiff * rate * dt;
}
