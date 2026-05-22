/**
 * Kinematic-bicycle model — Phase 0A (v8.40) and 0B (v8.44).
 *
 * Replaces the legacy direct-yaw-assignment path with geometric
 * yaw routed through bicycle ODE:
 *
 *   yawRate = (v / L) * tan(delta)
 *
 * where L is wheelbase and delta is the equivalent front-wheel
 * steering angle.
 *
 * Phase 0A back-computes delta from the existing pAngVel (the
 * "desired" yaw), preserving all current upstream tuning
 * (turnRate, mass damping, high-speed damping, drivetrain
 * effects) while routing through kinematic geometry — this is
 * what constrains the rear axle to roll along heading in the
 * position-update step.
 *
 * Phase 0B passes delta forward to a force-based integrator
 * (slip angles, lateral tire forces with friction-circle
 * saturation, yaw torque → yawRate, lateral CG drift). When 0B
 * is active, the integrator handles BOTH grip and drift naturally
 * (Phase 0B Session B, v8.47 unified regime): drift emerges when
 * slip angles exceed the linear region and lateral forces
 * saturate at μ·Fz. pDrifting becomes derived (from slip
 * magnitude) rather than a driving input.
 *
 * Eligibility: GT4 cars only, not bikes/specials, no trailer, at
 * least some speed, bicycleModel setting enabled. Trailer
 * compound falls back to legacy (trailer has its own kinematic
 * ODE). 0A is grip-state-only; 0B handles unified grip+drift.
 *
 * Monolith source: inside update() at L24820-L25003.
 */

import type { Drivetrain } from './steering';

/** Wheelbase-to-body-length ratio. Real cars typically have a
 *  wheelbase that's 60-70 % of overall body length — the rest is
 *  front + rear overhang (bumpers, crash structure, engine bay
 *  forward of front axle). 0.65 is the midpoint of that range
 *  and matches the proportions of the GT4-class cars this model
 *  applies to.
 *
 *  Matches monolith `CAR().size[0]*0.65` at L24828. */
export const WHEELBASE_LENGTH_RATIO = 0.65;

/** Minimum wheelbase in game units. Floors the wheelbase
 *  derivation so an unusually short body (or a 0/undefined
 *  length) can't produce a numerically tiny Lwb that would
 *  explode the bicycle ODE's `yawRate = v / L × tan(delta)` —
 *  small L produces enormous yawRate from any wheel angle, and
 *  for any reasonable car body the cap (6 gu) is well below
 *  the natural wheelbase anyway, so this is a safety floor that
 *  never engages on normal cars.
 *
 *  Matches monolith `Math.max(6, ...)` at L24828. */
export const WHEELBASE_MIN = 6;

/** Compute the kinematic wheelbase (Lwb) from a car's body
 *  length. Used by the bicycle-model ODE as the rear-to-front
 *  axle distance.
 *
 *  FORMULA (1:1 with monolith):
 *    Lwb = max(WHEELBASE_MIN, bodyLength × WHEELBASE_LENGTH_RATIO)
 *
 *  INPUTS:
 *    bodyLength   CAR().size[0] — the overall body length in
 *                 game units (NOT the wheelbase itself; this
 *                 function derives wheelbase FROM body length).
 *
 *  The floor at WHEELBASE_MIN (6 gu) is defensive — every shipped
 *  car has a length × 0.65 well above that, so the floor protects
 *  against undefined/zero/very-short bodies producing a tiny Lwb
 *  that would blow up the bicycle ODE (`v / L` in the denominator).
 *
 *  Ported 1:1 from monolith L24828 (the Lwb derivation at the
 *  head of the bicycle-model branch). */
export function computeBicycleWheelbase(bodyLength: number): number {
  return Math.max(WHEELBASE_MIN, bodyLength * WHEELBASE_LENGTH_RATIO);
}

/** Minimum speed (game units / sec, either player OR world-frame)
 *  for the bicycle-model branch to be eligible. Below this, fall
 *  back to legacy direct-yaw — the bicycle ODE's v/L numerator
 *  collapses to ~0 and even the low-speed blend
 *  ([[computeLowSpeedGripDelta]]) wants a meaningful signed
 *  speed to work with.
 *
 *  Either absSpd OR _worldSpd above 0.5 satisfies the gate — the
 *  world-frame check exists because a car can have absSpd ≈ 0
 *  while drifting sideways at significant world speed (the chassis
 *  isn't moving forward but the body is translating). In that
 *  case the bicycle model still wants to engage.
 *
 *  Matches monolith `(absSpd>0.5 || _worldSpd>0.5)` at L24826. */
export const BICYCLE_MIN_SPEED = 0.5;

/** Determine whether the bicycle-model branch is eligible to fire
 *  on this frame. ALL conditions must hold:
 *
 *    1. body is NOT a bike (bikes use the lean chain instead;
 *       see steering.ts tickBikeLean / computeBikePAngVel)
 *    2. dyn0BEnabled  OR  not currently drifting
 *       (Phase 0A is grip-state-only; Phase 0B handles drift too
 *       via the unified force integrator)
 *    3. body is a GT4-class car (the bicycle model is calibrated
 *       and validated for the GT4 cars; specials/legacy cars
 *       stay on the direct-yaw path)
 *    4. NO trailer attached (trailer compound has its own
 *       kinematic ODE — running the bicycle model on the tractor
 *       would fight the trailer's hitch constraint)
 *    5. some speed in EITHER frame: absSpd > 0.5 OR worldSpd >
 *       0.5 — see [[BICYCLE_MIN_SPEED]] for why both frames are
 *       checked
 *    6. bicycleModelEnabled setting on
 *
 *  When ANY condition fails, the caller falls back to the
 *  legacy direct-yaw path (pAngVel from the upstream steering
 *  pipeline is used as-is). When eligible, the caller computes
 *  delta via [[computeGripDelta]] / [[computeLowSpeedGripDelta]]
 *  / [[computeDriftDelta]] (selected by speed × drift state)
 *  and either assigns geometric yaw to pAngVel (Phase 0A) or
 *  hands delta to the force integrator (Phase 0B).
 *
 *  Ported 1:1 from monolith L24825-L24826 (the eligibility
 *  conjunction at the head of the bicycle-model branch). */
export function isBicycleModelEligible(
  isBike: boolean,
  dyn0BEnabled: boolean,
  pDrifting: boolean,
  isGt4: boolean,
  hasTrailer: boolean,
  absSpd: number,
  worldSpd: number,
  bicycleModelEnabled: boolean,
): boolean {
  if (isBike) return false;
  if (!dyn0BEnabled && pDrifting) return false;
  if (!isGt4) return false;
  if (hasTrailer) return false;
  if (absSpd <= BICYCLE_MIN_SPEED && worldSpd <= BICYCLE_MIN_SPEED) return false;
  if (!bicycleModelEnabled) return false;
  return true;
}

/** Rear-axle world-space position, 2-tuple. Returned by
 *  [[initRearAxleFromCG]] for the bicycle-model position-update
 *  branch to use as the constrained pivot (rear axle rolls along
 *  heading; front axle gets pulled around by delta). */
export interface RearAxleInit {
  pRearX: number;
  pRearY: number;
}

/** Initialize the rear-axle world position from the CG world
 *  position. Called on the first eligible bicycle-model frame
 *  (or after a teleport / car switch — anything that breaks
 *  the rear-axle's frame-to-frame continuity).
 *
 *  FORMULA (1:1 with monolith):
 *    halfL = Lwb / 2
 *    pRearX = px - cos(pAngle) × halfL
 *    pRearY = py - sin(pAngle) × halfL
 *
 *  Rear axle sits half-a-wheelbase BEHIND the CG along the
 *  heading direction. The `- cos / - sin` produces the backward-
 *  along-heading vector (negate the forward unit vector).
 *
 *  INPUTS:
 *    px, py        chassis CG world position
 *    pAngle        chassis heading, radians
 *    wheelbase     Lwb from [[computeBicycleWheelbase]]
 *
 *  Returns the seeded {pRearX, pRearY}. Caller assigns to player
 *  state and sets pBicycleInit = true so subsequent frames use
 *  the integrated rear-axle position instead of re-seeding.
 *
 *  WHY THIS SEED EXISTS: the bicycle-model position update is
 *  framewise INCREMENTAL — each frame moves pRearX/pRearY along
 *  heading by `pSpeed × dt` and rotates the CG around it. To
 *  start, the rear axle has to be placed somewhere consistent
 *  with the CG; this function does that by placing it
 *  half-a-wheelbase behind CG in heading direction.
 *
 *  Re-seeding after teleport / car switch is handled by the
 *  caller resetting pBicycleInit to false, which makes the
 *  eligibility guard call this function again next frame.
 *
 *  Ported 1:1 from monolith L25116-L25120 (the pBicycleInit
 *  guard at the head of the bicycle-model position branch). */
export function initRearAxleFromCG(
  px: number,
  py: number,
  pAngle: number,
  wheelbase: number,
): RearAxleInit {
  const halfL = wheelbase * 0.5;
  return {
    pRearX: px - Math.cos(pAngle) * halfL,
    pRearY: py - Math.sin(pAngle) * halfL,
  };
}

/** Initial state of the Phase 0B force-integrator's per-axle
 *  variables. See [[initDyn0BIntegratorState]] for the docstring
 *  on why pYawRate starts at 0 rather than mirroring pAngVel. */
export interface Dyn0BInitialState {
  /** World-frame velocity x-component (game units / sec).
   *  Composed from heading × current speed: pVx = cos(pAngle)
   *  × pSpeed. */
  pVx: number;
  /** World-frame velocity y-component. */
  pVy: number;
  /** Yaw rate (radians / sec). Starts at 0 regardless of the
   *  desired-yaw signal pAngVel — see [[initDyn0BIntegratorState]]
   *  for the rationale. */
  pYawRate: number;
}

/** Seed the Phase 0B force-integrator state on the first
 *  eligible frame. After this call, the caller sets
 *  `pDyn0BInit = true` so subsequent frames use the integrated
 *  state instead of re-seeding.
 *
 *  FORMULA (1:1 with monolith):
 *    pVx       = cos(pAngle) × pSpeed
 *    pVy       = sin(pAngle) × pSpeed
 *    pYawRate  = 0
 *
 *  WHY pYawRate STARTS AT ZERO (not pAngVel — critical):
 *  At this point in the update pipeline, pAngVel is the
 *  "DESIRED" yaw from steering input (a target, not a real
 *  rotational state). Initializing pYawRate to that target
 *  would manufacture per-axle slip angles on the very first
 *  frame, and since the rear-axle lever arm and slip both grow
 *  with yaw rate, the rear lateral force would exceed the
 *  front's, producing NEGATIVE NET TORQUE that drives yawRate
 *  straight back to zero. Result: car would refuse to turn.
 *
 *  Starting from zero lets the integrator converge to a
 *  steady-state yaw naturally — front-axle cornering force
 *  generates real yaw torque, yaw rate builds, slip angles
 *  develop, and the system finds equilibrium.
 *
 *  WHY pVx/pVy ARE COMPOSED FROM HEADING × SPEED: at the
 *  bicycle-model boundary the legacy path uses pSpeed × pAngle
 *  for movement. The Phase 0B integrator works in world-frame
 *  velocity (vx, vy). The seed assumes velocity is aligned with
 *  heading (no slip) at the start — which is the typical case
 *  when the player just transitioned to a bicycle-eligible
 *  state (entered grip from drift, exceeded speed gate, etc.).
 *
 *  Caller is responsible for setting pDyn0BInit = true after
 *  consuming the returned values. Re-seeding (after car switch,
 *  teleport, or going through the eligibility boundary again)
 *  is signaled by the caller clearing pDyn0BInit, which makes
 *  this function fire next frame.
 *
 *  Ported 1:1 from monolith L25310-L25315 (the !pDyn0BInit
 *  guard at the head of the Phase 0B integrator). */
export function initDyn0BIntegratorState(
  pAngle: number,
  pSpeed: number,
): Dyn0BInitialState {
  return {
    pVx: Math.cos(pAngle) * pSpeed,
    pVy: Math.sin(pAngle) * pSpeed,
    pYawRate: 0,
  };
}

/** Minimum |pSpeed| (game units / sec) for the antiparallel
 *  velocity rotation to engage. Below this, the antiparallel
 *  state is meaningless (the car is essentially stopped) and
 *  the rotation could amplify numerical noise.
 *
 *  Matches monolith `Math.abs(pSpeed) > 5` at L25345. */
export const ANTIPARALLEL_SPEED_GATE = 5;

/** Minimum velocity magnitude (game units / sec) below which the
 *  rotation step is skipped. A nearly-zero velocity vector has
 *  no meaningful direction to rotate; rotating it would amplify
 *  floating-point noise. 0.5 is well below any realistic moving-
 *  car velocity.
 *
 *  Matches monolith `_spdMag > 0.5` at L25349. */
export const ANTIPARALLEL_VELOCITY_MAG_GATE = 0.5;

/** Per-frame fraction of the heading-vs-velocity angle gap that
 *  the world velocity rotates through during the antiparallel
 *  fix. 0.2 ↔ ~5-frame relax to zero gap at 60 fps. Fast enough
 *  to clear the post-180° state in well under a second; slow
 *  enough that the rotation looks smooth rather than snapping.
 *
 *  Matches monolith `_angDiff * 0.2` at L25354. */
export const ANTIPARALLEL_ROTATE_RATE = 0.2;

/** World-velocity tuple returned by
 *  [[applyAntiparallelVelocityRotation]]. */
export interface WorldVelocity {
  pVx: number;
  pVy: number;
}

/** Apply the v8.99.69 antiparallel velocity rotation — the post-
 *  180° momentum-preservation fix.
 *
 *  WHY THIS EXISTS: when the player completes a 180° rotation
 *  (e-brake spin, hard counter-rotation), the chassis heading
 *  has flipped but the world velocity vector still points the
 *  old way (it carried momentum through). With gas held, the
 *  v_long blend would scalar-relax v_long from negative toward
 *  positive pSpeed, passing through zero — the "car appears to
 *  come to a complete stop for a moment" symptom the user
 *  reported.
 *
 *  THE FIX: instead of scalar-blending v_long through zero,
 *  ROTATE the world velocity vector toward the heading direction
 *  while preserving its magnitude. The east→north→west arc
 *  keeps |v| constant — no stop.
 *
 *  FORMULA (1:1 with monolith):
 *    preVLong       = pVx × cos(pAngle) + pVy × sin(pAngle)
 *    antiparallel   = gas AND |pSpeed| > 5 AND preVLong × pSpeed < 0
 *    if antiparallel:
 *      spdMag = √(pVx² + pVy²)
 *      if spdMag > 0.5:
 *        velAng     = atan2(pVy, pVx)
 *        angDiff    = wrap(pAngle - velAng, ±π)
 *        newVelAng  = velAng + angDiff × 0.2
 *        pVx        = cos(newVelAng) × spdMag
 *        pVy        = sin(newVelAng) × spdMag
 *
 *  WHEN antiparallel FIRES:
 *  - gas held: only matters during throttle-on momentum
 *    transitions; off-throttle the player isn't "trying to go
 *    forward" so the post-180° feel doesn't apply.
 *  - |pSpeed| > 5: above the [[ANTIPARALLEL_SPEED_GATE]] —
 *    below this the chassis is essentially stopped and the
 *    antiparallel state is moot.
 *  - preVLong × pSpeed < 0: STRICT antiparallel check (sign
 *    disagreement between body-frame longitudinal velocity
 *    component and signed speed). The dot-product test is what
 *    distinguishes "post-180° spin" from "ordinary cornering
 *    slip" — only sign-flipped states pass.
 *
 *  AFTER THIS RUNS: the world velocity is no longer antiparallel
 *  to heading, so the standard scalar v_long blend at the next
 *  integrator step operates normally (without passing through
 *  zero).
 *
 *  Returns the (possibly rotated) {pVx, pVy}. If any gate fails,
 *  returns the input unchanged.
 *
 *  Ported 1:1 from monolith L25341-L25358 (the v8.99.69 REHOOK
 *  block before the v_long_coupled / v_long_new computation). */
/** Body-frame velocity tuple returned by
 *  [[worldToBodyVelocity]]. `v_long` is the velocity component
 *  along the chassis heading; `v_lat` is the perpendicular
 *  (positive = leftward, in screen coords where +y is down). */
export interface BodyFrameVelocity {
  v_long: number;
  v_lat: number;
}

/** Transform a world-frame velocity (pVx, pVy) into body-frame
 *  components — longitudinal (along heading) and lateral
 *  (perpendicular to heading).
 *
 *  FORMULA (1:1 with monolith):
 *    v_long =  pVx × cos(pAngle) + pVy × sin(pAngle)
 *    v_lat  = -pVx × sin(pAngle) + pVy × cos(pAngle)
 *
 *  This is the standard 2D rotation matrix applied to a vector
 *  — `R(-pAngle) × v_world`. The negation gives the inverse
 *  rotation, taking a world-frame quantity into the body's
 *  local axes (where +x is forward, +y is leftward).
 *
 *  SIGN CONVENTION:
 *  - v_long > 0: moving forward along heading
 *  - v_long < 0: moving BACKWARD along heading (reversing)
 *  - v_lat  > 0: moving LEFTWARD (the body's left side, which
 *                is the screen's up-direction at pAngle=0 in a
 *                +y-down canvas)
 *  - v_lat  < 0: moving RIGHTWARD
 *
 *  USED EXTENSIVELY by the Phase 0B integrator: world-to-body
 *  on the CG velocity, then again on each axle's world-frame
 *  velocity (after adding ω × r) to get the slip-angle inputs.
 *  Five+ call sites at L25360-L25361, L25419-L25422.
 *
 *  Ported 1:1 from monolith L25360-L25361 (the
 *  `v_long_cur = pVx*cosA + pVy*sinA` and
 *  `v_lat_cur = -pVx*sinA + pVy*cosA` pair, plus its repeats
 *  for per-axle transforms). */
export function worldToBodyVelocity(
  pVx: number,
  pVy: number,
  pAngle: number,
): BodyFrameVelocity {
  const cosA = Math.cos(pAngle);
  const sinA = Math.sin(pAngle);
  return {
    v_long:  pVx * cosA + pVy * sinA,
    v_lat:  -pVx * sinA + pVy * cosA,
  };
}

/** Magnitude threshold (game units / sec) above which v_long and
 *  pSpeed are considered "still mismatched," keeping the
 *  longitudinal blend in its slow-relax state instead of
 *  switching back to instantaneous override.
 *
 *  WHY THIS GATE EXISTS (v8.99.65): the post-drift timer
 *  (0.5 s) can expire before a ~60-gu/s gap (from a post-180°
 *  velocity flip) has finished converging at 0.02/frame. Without
 *  this gate, blend snaps to 1.0 at timer expiry and the
 *  remaining gap is wiped in one frame — a hard visual snap.
 *  The convergence-based gate keeps the slow blend open until
 *  the gap closes to ≤ 5 gu/s. In normal grip driving v_long ≈
 *  pSpeed so this gate is inactive (behavior matches v8.99.64).
 *
 *  Matches monolith `Math.abs(v_long_cur - pSpeed) > 5` at
 *  L25362. */
export const LONG_MISMATCH_GATE = 5;

/** Longitudinal blend coefficient for the grip-driving state.
 *  1.0 = full instantaneous override: v_long_new = pSpeed (the
 *  authoritative scalar speed wins). Grip driving has no slip
 *  along the longitudinal axis (tires roll), so the body-frame
 *  v_long should always match the integrated pSpeed.
 *
 *  Matches monolith `_longBlend = 1.0` at L25373. */
export const LONG_BLEND_GRIP = 1.0;

/** Longitudinal blend coefficient for the drift / post-drift /
 *  mismatch / e-brake states. 0.02 per frame ↔ ~50-frame half-
 *  life at 60 fps. Slow enough that v_long carries forward
 *  momentum through the rotation (180° spin keeps energy),
 *  fast enough that the engine gradually regains authority
 *  within ~1-2 s post-drift.
 *
 *  WHY NOT 0: a purely conservative integration (blend=0) would
 *  let v_long drift away from pSpeed indefinitely. 0.02 is the
 *  smallest value that still relaxes the gap on a reasonable
 *  timescale.
 *
 *  Matches monolith `_longBlend = 0.02` at L25373. */
export const LONG_BLEND_DRIFT = 0.02;

/** Compute the longitudinal blend coefficient — how aggressively
 *  to drag the body-frame v_long toward the scalar pSpeed.
 *
 *  GRIP STATE (blend = 1.0): instantaneous override. v_long
 *  fully matches pSpeed every frame.
 *
 *  DRIFT / TRANSITION (blend = 0.02): slow relaxation. v_long
 *  evolves with the integrator's bicycle-model kinematics, so
 *  the slide carries forward momentum through the rotation
 *  instead of being dragged around with the heading.
 *
 *  FOUR CONDITIONS TRIGGER THE SLOW BLEND (any one is enough):
 *  - pDrifting             actively drifting now
 *  - pPostDriftTimer > 0   recently exited drift; let v_long
 *                          relax over the post-drift window
 *  - |v_long - pSpeed| > 5 convergence-based gate; keeps slow
 *                          blend open until the mismatch closes,
 *                          even if pPostDriftTimer expired
 *  - pEbrakeTimer > 0      handbrake active; treat as
 *                          drift-equivalent so e-brake taps
 *                          that haven't yet pushed slip past
 *                          driftEnterThresh still preserve
 *                          momentum (v8.99.86 fix)
 *
 *  WHY THE v_long-PRESERVATION MATTERS: with full instantaneous
 *  override during drift, the pVx/pVy reconstruction would drag
 *  world velocity along with heading rotation — "zero momentum
 *  carried into the circle, velocity just shifts from linear to
 *  radial." The 0.02 blend lets the friction-circle physics and
 *  kinematic coupling produce the natural drift trajectory
 *  instead of the engine snapping v_world to heading every frame.
 *
 *  INPUTS:
 *    pDrifting         current drift flag
 *    pPostDriftTimer   remaining post-drift relaxation timer (s)
 *    vLong             body-frame longitudinal velocity from
 *                      [[worldToBodyVelocity]]
 *    pSpeed            scalar authoritative speed (gu/s)
 *    pEbrakeTimer      remaining e-brake countdown (s)
 *
 *  Returns 1.0 (grip) or 0.02 (drift/transition).
 *
 *  Ported 1:1 from monolith L25362-L25373 (the _blendActive
 *  conjunction and _longBlend ternary). */
export function computeLongBlend(
  pDrifting: boolean,
  pPostDriftTimer: number,
  vLong: number,
  pSpeed: number,
  pEbrakeTimer: number,
): number {
  const longMismatch = Math.abs(vLong - pSpeed) > LONG_MISMATCH_GATE;
  const blendActive = pDrifting || pPostDriftTimer > 0 || longMismatch || pEbrakeTimer > 0;
  return blendActive ? LONG_BLEND_DRIFT : LONG_BLEND_GRIP;
}

/** Advance the longitudinal velocity component by one tick, then
 *  recompose into a world-frame velocity. This is step 1 of the
 *  Phase 0B integrator's per-frame velocity update — the
 *  v8.99.89 SYMMETRIC KINEMATIC COUPLING fix.
 *
 *  THREE-STAGE PIPELINE (1:1 with monolith):
 *    1. Symmetric coupling (the v8.99.89 fix):
 *         v_long_coupled = v_long + v_lat × pYawRate × dt
 *    2. Authoritative-speed blend:
 *         v_long_new = v_long_coupled
 *                      + (pSpeed - v_long_coupled) × longBlend
 *    3. Body → world recompose:
 *         pVx = cos(pAngle) × v_long_new - sin(pAngle) × v_lat
 *         pVy = sin(pAngle) × v_long_new + cos(pAngle) × v_lat
 *
 *  v_lat is PRESERVED through the recompose (not modified by
 *  this step) — the lateral velocity gets its own integration at
 *  a later step (step 8 in the monolith) where the force-based
 *  v_lat ODE runs.
 *
 *  WHY THE SYMMETRIC COUPLING (v8.99.89):
 *  The 2D bicycle-model body-frame equations are:
 *    u̇ = Fx_body/m + v × ψ̇   ← longitudinal (this function)
 *    v̇ = Fy_body/m − u × ψ̇   ← lateral (handled at step 8)
 *  Pre-v8.99.89 only the lateral equation had its coupling
 *  term. The missing +v × ψ̇ term in the longitudinal equation
 *  meant body-frame integration was non-conservative: world
 *  velocity rotated ~75 % as fast as heading each frame
 *  (numerical verification: u=100, v=-150, ψ̇=1rad/s → +0.33°
 *  velocity drag per frame vs +0.48° heading rotation). Over a
 *  full e-brake turn this accumulated into the "perfect circle"
 *  trajectory the user reported across v8.99.53→v8.99.88.
 *
 *  With the symmetric coupling: same test case gives +0.002°
 *  velocity drag per frame (essentially zero; only second-order
 *  integration noise). Under pure rotation with no forces, world
 *  velocity is preserved exactly — what momentum conservation
 *  demands.
 *
 *  INTERACTION WITH THE BLEND:
 *  - GRIP (longBlend=1.0): v_long_new = pSpeed (override wins,
 *    coupling term irrelevant — instantaneously snapped back)
 *  - DRIFT (longBlend=0.02): coupling dominates and v_long
 *    evolves with the correct bicycle-model kinematics; the
 *    slide carries forward momentum through the rotation
 *
 *  WHY v_lat IS NOT MODIFIED HERE: step 8's lateral integration
 *  already uses `v_long_new × pYawRate` for its coupling term —
 *  the v_long_coupled value here automatically propagates the
 *  corrected longitudinal into the lateral ODE. No change to
 *  step 8 needed.
 *
 *  INPUTS:
 *    vLong, vLat   body-frame velocity components from
 *                  [[worldToBodyVelocity]] applied to the
 *                  (possibly post-antiparallel-rotated) pVx, pVy
 *    pYawRate      current chassis yaw rate (rad/s)
 *    dt            frame timestep (s)
 *    pSpeed        scalar authoritative speed (gu/s)
 *    longBlend     coefficient from [[computeLongBlend]]
 *    pAngle        chassis heading (rad)
 *
 *  Returns the new world-frame {pVx, pVy}.
 *
 *  Ported 1:1 from monolith L25406-L25409 (the v8.99.89
 *  symmetric kinematic coupling + blend + recompose lines). */
/** Per-axle body-frame velocity result from
 *  [[computeAxleVelocities]]. Each axle carries its own (v_long,
 *  v_lat) for use in slip-angle computation downstream. */
export interface AxleVelocities {
  vF: BodyFrameVelocity;
  vR: BodyFrameVelocity;
}

/** Compute per-axle body-frame velocities from the CG velocity
 *  and yaw rate. The relationship is the standard rigid-body
 *  velocity-at-a-point formula:
 *
 *    v_axle = v_cg + ω × r
 *
 *  where r is the world-frame vector from CG to the axle.
 *  Front axle: r_F = a × (cos(pAngle), sin(pAngle))
 *  Rear axle:  r_R = -b × (cos(pAngle), sin(pAngle))
 *
 *  In 2D with ω along +z, the cross product simplifies to:
 *    ω × r = (-ω × r_y, +ω × r_x)
 *
 *  WORLD-FRAME AXLE VELOCITIES (1:1 with monolith):
 *    vFx = pVx - pYawRate × a × sin(pAngle)
 *    vFy = pVy + pYawRate × a × cos(pAngle)
 *    vRx = pVx + pYawRate × b × sin(pAngle)
 *    vRy = pVy - pYawRate × b × cos(pAngle)
 *
 *  Then [[worldToBodyVelocity]] applies to each pair to produce
 *  body-frame components for the slip-angle computation.
 *
 *  WHY EACH AXLE NEEDS ITS OWN VELOCITY (not just CG): slip
 *  angle at the front and rear differ because the chassis is
 *  rotating. Even with zero CG slip, a yawing chassis has its
 *  front and rear axles tracing different circular arcs around
 *  the CG — at different velocity vectors. The slip-angle
 *  computation needs the per-axle vector, not the CG's, to
 *  produce physically correct tire forces.
 *
 *  SIGN CONVENTION (recap):
 *  - a, b > 0  (from [[computeAxleLeverArms]])
 *  - Front axle is AHEAD of CG along heading
 *  - Rear axle is BEHIND CG along heading
 *  - Under positive yaw rate (counter-clockwise in y-down coords)
 *    the front swings one direction, rear swings the other —
 *    the +/- difference between vFx/vRx and vFy/vRy formulas
 *    captures this directly.
 *
 *  INPUTS:
 *    pVx, pVy      current CG world velocity
 *    pYawRate      current chassis yaw rate (rad/s)
 *    pAngle        current chassis heading (rad)
 *    a, b          CG→front and CG→rear distances from
 *                  [[computeAxleLeverArms]]
 *
 *  Returns {vF, vR} — each a BodyFrameVelocity with (v_long,
 *  v_lat). Pure function.
 *
 *  Ported 1:1 from monolith L25411-L25422 (the per-axle velocity
 *  block, step 2 of the Phase 0B integrator). */
/** Epsilon (game units / sec) added to |v_long| in the slip-
 *  angle atan2 to prevent divide-by-zero AND stabilize the slip
 *  formula at low speed. Without this, a stopped car (v_long=0)
 *  with any v_lat > 0 would produce slip = ±π/2, snapping the
 *  tire force to peak instantaneously — visually wrong and
 *  numerically unstable.
 *
 *  0.5 is well below any realistic non-stopped longitudinal
 *  velocity (one frame at 30 mph is ~2.2 gu/s) so the epsilon
 *  only matters at the parking-lot extreme.
 *
 *  Matches monolith `const eps = 0.5` at L25425. */
export const SLIP_ANGLE_EPS = 0.5;

/** Per-axle slip angles from [[computeSlipAngles]]. Both in
 *  radians, signed. */
export interface SlipAngles {
  slipF: number;
  slipR: number;
}

/** Compute front and rear slip angles from per-axle body-frame
 *  velocities and the front-wheel steering angle (delta).
 *
 *  FORMULA (1:1 with monolith):
 *    slipF = atan2(vF_lat, |vF_long| + ε) - delta
 *    slipR = atan2(vR_lat, |vR_long| + ε)
 *
 *  PHYSICAL MEANING: slip angle is the angle between the wheel's
 *  POINTING direction and its actual VELOCITY direction. For a
 *  freely-rolling tire in pure grip, slipR ≈ 0 (rear wheels
 *  point along chassis heading, velocity is along chassis
 *  heading too). The front-wheel slipF includes the steering
 *  angle delta, since the front wheels can be turned away from
 *  chassis heading.
 *
 *  SIGN CONVENTION:
 *  - slip > 0: lateral velocity is to the LEFT of the wheel's
 *              pointing direction (in body frame) → tire wants
 *              to push to the RIGHT (opposing slip)
 *  - slip < 0: mirror
 *
 *  WHY |v_long| (NOT signed v_long) IN THE DENOMINATOR: slip
 *  angle is rotationally invariant in the longitudinal sign —
 *  a reversing car with the same lateral velocity-vs-pointing
 *  geometry has the same slip-angle physics. Using |v_long|
 *  flattens out reverse motion's atan2 sign without losing the
 *  lateral information from the numerator.
 *
 *  EPSILON IN DENOMINATOR: see [[SLIP_ANGLE_EPS]] docstring —
 *  prevents divide-by-zero and snaps-to-π/2 at parking speeds.
 *
 *  WHY ONLY slipF GETS THE delta SUBTRACTION: delta is the
 *  steering angle, only applied to the front wheels. The
 *  geometric reasoning: front wheels pointed in direction
 *  (pAngle + delta), so slip is "the difference between front
 *  velocity direction and front pointing direction." The atan2
 *  gives the front velocity direction relative to chassis, then
 *  subtracting delta yields the velocity-vs-pointing angle.
 *
 *  INPUTS:
 *    vF, vR    per-axle body-frame velocities from
 *              [[computeAxleVelocities]]
 *    delta     front-wheel steering angle (rad) from
 *              [[selectBicycleDelta]]
 *
 *  Returns {slipF, slipR}. Pure function.
 *
 *  Ported 1:1 from monolith L25425-L25427 (the slip-angle pair
 *  at step 3 of the Phase 0B integrator). */
export function computeSlipAngles(
  vF: BodyFrameVelocity,
  vR: BodyFrameVelocity,
  delta: number,
): SlipAngles {
  const slipF = Math.atan2(vF.v_lat, Math.abs(vF.v_long) + SLIP_ANGLE_EPS) - delta;
  const slipR = Math.atan2(vR.v_lat, Math.abs(vR.v_long) + SLIP_ANGLE_EPS);
  return { slipF, slipR };
}

export function computeAxleVelocities(
  pVx: number,
  pVy: number,
  pYawRate: number,
  pAngle: number,
  a: number,
  b: number,
): AxleVelocities {
  const cosA = Math.cos(pAngle);
  const sinA = Math.sin(pAngle);
  const vFx = pVx - pYawRate * a * sinA;
  const vFy = pVy + pYawRate * a * cosA;
  const vRx = pVx + pYawRate * b * sinA;
  const vRy = pVy - pYawRate * b * cosA;
  return {
    vF: {
      v_long:  vFx * cosA + vFy * sinA,
      v_lat:  -vFx * sinA + vFy * cosA,
    },
    vR: {
      v_long:  vRx * cosA + vRy * sinA,
      v_lat:  -vRx * sinA + vRy * cosA,
    },
  };
}

export function applyLongitudinalIntegration(
  vLong: number,
  vLat: number,
  pYawRate: number,
  dt: number,
  pSpeed: number,
  longBlend: number,
  pAngle: number,
): WorldVelocity {
  const vLongCoupled = vLong + vLat * pYawRate * dt;
  const vLongNew = vLongCoupled + (pSpeed - vLongCoupled) * longBlend;
  const cosA = Math.cos(pAngle);
  const sinA = Math.sin(pAngle);
  return {
    pVx: cosA * vLongNew - sinA * vLat,
    pVy: sinA * vLongNew + cosA * vLat,
  };
}

/** Grip-state lateral velocity damping rate (1/s). Rolling
 *  resistance and tire relaxation prevent v_lat buildup in
 *  steady state when slip angles are zero — without this, any
 *  numerical noise would slowly accumulate into a phantom drift.
 *  0.8 ↔ ~80 % decay per second in the absence of forcing, which
 *  is fast enough to suppress noise but slow enough that genuine
 *  slip dynamics aren't artificially damped out.
 *
 *  Matches monolith `0.8` at L25838 (the non-ebrake branch of
 *  the _latDamp ternary). */
export const LAT_DAMP_GRIP = 0.8;

/** Active-ebrake lateral velocity damping rate (1/s). v8.98.63
 *  dropped this from 0.8 to 0.1 during e-brake hold so v_lat
 *  can PERSIST — velocity keeps pointing in the car's original
 *  direction while heading rotates = momentum-preservation
 *  slide. Normal driving still gets 0.8 (keeps grip-state
 *  stable, no drift buildup).
 *
 *  v8.99.124.04 GATE CHANGED from pEbrakeTimer>0 to active ebrk
 *  input. The throttle-sustain block auto-refreshes
 *  pEbrakeTimer to 0.4 every frame during gas-held drift, and
 *  the OLD pEbrakeTimer>0 gate routed that into the slide-feel
 *  damping regime → v_lat orbited with pYawRate indefinitely
 *  under almost-no damping. Player's counter-flick had no force
 *  authority. Bicycle physics can't reach that state — the rear
 *  should be free to regrip when steering input is no longer
 *  driving the slide.
 *
 *  Now `ebrk` (the live INPUT flag, not the residual timer) is
 *  the only thing that drops damping into slide-feel territory.
 *  Player input regains physics authority over v_lat.
 *
 *  Matches monolith `0.1` at L25838 (the ebrake branch of the
 *  _latDamp ternary). */
export const LAT_DAMP_EBRAKE_ACTIVE = 0.1;

/** Integrate body-frame lateral velocity by one tick. Step 8 of
 *  the Phase 0B integrator — incorporates the v8.99.53 centripetal
 *  coupling fix and the v8.99.124.04 damping refactor.
 *
 *  FORMULA (1:1 with monolith):
 *    v_lat_new = v_lat + (F_tot_lat_body / mass
 *                          - v_long_new × pYawRate) × dt
 *    latDamp   = ebrkActive ? 0.1 : 0.8
 *    v_lat_new × = max(0, 1 - latDamp × dt)
 *
 *  THREE COMPONENTS:
 *  1. Force-driven acceleration: F_tot_lat_body / mass × dt —
 *     standard Newton, body-frame lateral force from
 *     [[projectLateralToBodyFrame]] / mass.
 *  2. Centripetal coupling: -v_long_new × pYawRate × dt — the
 *     `-u·r` term from the standard 2D bicycle model
 *     (v8.99.53 fix; see below).
 *  3. Exponential damping: × max(0, 1 - latDamp × dt) — tire
 *     relaxation / rolling resistance.
 *
 *  v8.99.53 CENTRIPETAL COUPLING (the -v_long × ω term):
 *  When the car yaws while moving forward, this term produces
 *  v_lat growth in body frame that corresponds to a world-
 *  velocity vector that STAYS FIXED IN SPACE as heading rotates
 *  — i.e. momentum preservation. Without this term, world
 *  velocity implicitly rotated with heading on every frame →
 *  perfect grip / instant pivot (the "blue line" bug). With it,
 *  heading can rotate freely while velocity persists in its
 *  original direction → "yellow line" sideways slide. Rear-μ
 *  collapse (e-brake) prevents tire force from killing the
 *  v_lat → slip angle grows → drift state engages → skid marks
 *  emit.
 *
 *  v8.99.124.04 DAMPING REGIME (the gate fix):
 *  Pre-v124.04: gate was `pEbrakeTimer > 0`. The throttle-
 *  sustain block auto-refreshed pEbrakeTimer to 0.4 every frame
 *  during gas-held drift, which routed v_lat into the 0.1/s
 *  slide-feel damping regime → v_lat orbited with pYawRate
 *  indefinitely under almost-no damping → counter-flick had no
 *  authority. Real physics can't reach that state — rear should
 *  be free to regrip when steering input no longer drives the
 *  slide.
 *
 *  Post-v124.04: only the live `ebrk` input drops damping into
 *  slide-feel territory (0.1/s). Throttle-sustain can still
 *  collapse mu_R via pEbrakeTimer (the wheelspin/yaw-boost path
 *  uses it for drift feel), but damping no longer follows.
 *  Player input regains physics authority.
 *
 *  v8.99.124.02 (in the docstring trail above this in the
 *  monolith): REVERTED slip-aware damping reduction from
 *  v8.99.124.00. Keeping that note here for historical context.
 *
 *  INPUTS:
 *    v_lat            current body-frame lateral velocity
 *    F_tot_lat_body   body-frame lateral force sum from
 *                     [[projectLateralToBodyFrame]]
 *    mass             chassis mass (kg), post-sanitize
 *    v_long_new       updated longitudinal velocity from
 *                     [[applyLongitudinalIntegration]]
 *    pYawRate         current chassis yaw rate (rad/s)
 *    dt               frame timestep (s)
 *    ebrkActive       LIVE ebrk input flag — drops damping into
 *                     slide-feel regime when true (NOT the
 *                     pEbrakeTimer; see v124.04 fix above)
 *
 *  Returns the new v_lat. Pure function.
 *
 *  Ported 1:1 from monolith L25800-L25839 (step 8 of the Phase
 *  0B integrator's body-frame lateral velocity update). */
export function integrateLateralVelocity(
  v_lat: number,
  F_tot_lat_body: number,
  mass: number,
  v_long_new: number,
  pYawRate: number,
  dt: number,
  ebrkActive: boolean,
): number {
  let v_lat_new = v_lat + (F_tot_lat_body / mass - v_long_new * pYawRate) * dt;
  const latDamp = ebrkActive ? LAT_DAMP_EBRAKE_ACTIVE : LAT_DAMP_GRIP;
  v_lat_new *= Math.max(0, 1 - latDamp * dt);
  return v_lat_new;
}

/** Integrate the chassis yaw rate by one tick from per-axle
 *  lateral forces and moment of inertia.
 *
 *  FORMULA (1:1 with monolith):
 *    τ        = a × F_lat_F - b × F_lat_R
 *    yawAccel = τ / I
 *    pYawRate += yawAccel × dt
 *
 *  PHYSICS: torque around CG = (front lateral force × moment
 *  arm to CG) - (rear lateral force × moment arm to CG). The
 *  minus sign on the rear term comes from the sign convention:
 *  the rear axle sits at r_R = -b along heading, so its moment
 *  arm has the opposite sign in the cross product. The math
 *  works out to `a × F_lat_F - b × F_lat_R` (not + because
 *  of that sign flip baked into the formula).
 *
 *  GENERAL INTUITION:
 *  - Pure front-axle force → τ > 0 → positive yawAccel →
 *    chassis rotates one way (counter-clockwise in y-down
 *    coords).
 *  - Pure rear-axle force in the SAME direction → τ < 0 →
 *    rotates the other way. The "front pulls" / "rear pushes
 *    away" intuition.
 *  - Balanced forces (a × F_lat_F = b × F_lat_R) → zero net
 *    torque → straight-line stable cornering (the front and
 *    rear track the same arc).
 *  - During drift, F_lat_F is at the limit (steering input)
 *    and F_lat_R is small (rear's friction circle is
 *    consumed by longitudinal demand) → net positive τ →
 *    rotation continues despite the player's intention.
 *    The wheelspin-yaw-boost / lateral-budget-restoration
 *    mechanics from upstream prevent this from spiraling.
 *
 *  WHY DIRECT ω INTEGRATION (not Verlet or semi-implicit):
 *  the Phase 0B integrator uses simple forward-Euler on the
 *  rate. The damping in v_lat ([[integrateLateralVelocity]])
 *  and the friction-circle clamps prevent numerical instability
 *  from accumulating despite Euler's known drift, and the per-
 *  frame dt (~1/60 s) is small enough that the local error
 *  stays negligible.
 *
 *  INPUTS:
 *    pYawRate    current chassis yaw rate (rad/s)
 *    F_lat_F     post-clamp front lateral force (from
 *                [[clampLateralForces]])
 *    F_lat_R     post-clamp rear lateral force
 *    a, b        CG → axle moment arms (from
 *                [[computeAxleLeverArms]] in chassisFrame.ts)
 *    I           chassis yaw inertia (from
 *                [[computeChassisYawInertia]])
 *    dt          frame timestep (s)
 *
 *  Returns the new pYawRate. Pure function.
 *
 *  NOTE: this is the pre-wheelspin-boost yaw rate. The
 *  wheelspin-yaw boost (next hop) adds an impulse to the
 *  return value of this function — applied AFTER the standard
 *  τ/I integration to model the kinetic-friction rotation that
 *  emerges when rear wheels exceed the friction-circle.
 *
 *  Ported 1:1 from monolith L25843-L25845 (step 9 of the Phase
 *  0B integrator's yaw-torque integration). */
export function integrateYawRate(
  pYawRate: number,
  F_lat_F: number,
  F_lat_R: number,
  a: number,
  b: number,
  I: number,
  dt: number,
): number {
  const tau = a * F_lat_F - b * F_lat_R;
  const yawAccel = tau / I;
  return pYawRate + yawAccel * dt;
}

/** Steering-magnitude gate for wheelspin yaw boost during an
 *  e-brake hold. Lower than the normal gate because pulling the
 *  handbrake already signals commitment to a slide — requiring
 *  20 %+ extra stick on top feels sluggish, especially on grass
 *  where steering response is already halved (v8.98.35).
 *
 *  Matches monolith `0.05` at L25871. */
export const WHEELSPIN_YAW_STEER_GATE_EBRAKE = 0.05;

/** Steering-magnitude gate for wheelspin yaw boost outside the
 *  e-brake window. v8.99.59 bumped this from 0.20 to 0.35 —
 *  minor stick brushes were tripping wheelspin yaw under
 *  coupling. 35 % stick is a clear "deliberate cornering input"
 *  signal; deliberate hard corners still fire normally.
 *
 *  Matches monolith `0.35` at L25871. */
export const WHEELSPIN_YAW_STEER_GATE_NORMAL = 0.35;

/** Wheelspin yaw boost multiplier during an active e-brake
 *  hold. 2.0 makes ebrake + gas + turn THE drift-entry gesture
 *  (the player expects this combo to fire decisively).
 *
 *  Matches monolith `2.0` at L25890. */
export const WHEELSPIN_YAW_MULT_EBRAKE = 2.0;

/** Wheelspin yaw boost multiplier during an active drift state
 *  WITHOUT held e-brake. v8.98.52 added this middle tier so
 *  throttle-produced wheelspin still rotates the car decisively
 *  during sustain — 1.5× gives throttle meaningful rotation
 *  authority. Held e-brake still wins at 2.0×.
 *
 *  Matches monolith `1.5` at L25890. */
export const WHEELSPIN_YAW_MULT_DRIFT_NO_EBRAKE = 1.5;

/** Wheelspin yaw boost multiplier in the normal (grip-state)
 *  case. v8.99.59 dropped this from 1.0 to 0.35 — pre-coupling
 *  (v8.99.53), 1.0 was invisible (yaw rotated heading without
 *  real sliding). Post-coupling, 1.0 was a cascade trigger
 *  that dropped the car into drift state from any minor
 *  steer+throttle input. 0.35 preserves the power-oversteer
 *  feel on RWD corner-exits but doesn't blow past
 *  driftEnterThresh on its own.
 *
 *  Matches monolith `0.35` at L25890. */
export const WHEELSPIN_YAW_MULT_NORMAL = 0.35;

/** Wheelspin yaw surface multiplier on grass. v8.99.55 added
 *  this cap — off-road, wheelspinRatio grows disproportionately
 *  (torque demand unchanged but budget slashed), so the
 *  product `wheelspinRatio × F_circle_R` is actually LARGER
 *  on grass than pavement. Without the cap, slight throttle
 *  brushes off-road produced 720° spins.
 *
 *  Matches monolith `_wsSurf = 0.4` at L25901. */
export const WHEELSPIN_YAW_SURF_GRASS = 0.4;

/** Wheelspin yaw surface multiplier on dirt / canyon (tiles
 *  12, 14, 16). Less reduction than grass because dirt
 *  produces less extreme low-μ behavior.
 *
 *  Matches monolith `_wsSurf = 0.6` at L25902. */
export const WHEELSPIN_YAW_SURF_DIRT = 0.6;

/** Base force coefficient inside the wheelspin yaw impulse
 *  formula. 0.8 is empirically tuned to produce the right peak
 *  rotation impulse magnitude at full wheelspin.
 *
 *  Matches monolith `0.8` at L25903. */
export const WHEELSPIN_YAW_FORCE_COEFF = 0.8;

/** Apply the wheelspin-yaw impulse — when rear drive demand
 *  exceeds the friction circle (or front, for FF), simulate the
 *  rotation that kinetic-friction wheels produce in a corner.
 *  Adds an impulse on top of the standard τ/I integration from
 *  [[integrateYawRate]].
 *
 *  v8.52 introduced this; v8.53 added the steering gate to
 *  prevent straight-line wheelspin (burnouts) from spinning the
 *  car with no steering input. Real world: straight-line
 *  wheelspin is a burnout (goes straight); cornering wheelspin
 *  is power oversteer.
 *
 *  FORMULA (1:1 with monolith):
 *    if NOT RWD (drv not in FR/MR/RR):  return unchanged
 *    if wheelspinRatio <= 0:             return unchanged
 *    if pPostDriftTimer > 0:             return unchanged (v8.99.63)
 *    steerGate = pEbrakeTimer > 0 ? 0.05 : 0.35
 *    if |steerInput| <= steerGate:       return unchanged
 *    ebrakeMult = pEbrakeTimer > 0  → 2.0
 *                  pDrifting         → 1.5
 *                  otherwise         → 0.35
 *    surfMult = onGrass ? 0.4 : onDirt ? 0.6 : 1.0
 *    wsYaw = sign(steerInput) × |steerInput| × wheelspinRatio
 *            × b × F_circle_R × 0.8
 *            × ebrakeMult × surfMult
 *    pYawRate += (wsYaw / I) × dt
 *
 *  THREE-TIER MULTIPLIER (ebrakeMult):
 *  - EBRAKE HELD (2.0): the "drift-entry gesture" — ebrake + gas
 *    + turn produces decisive rotation. Player expects this combo
 *    to win over anything else.
 *  - DRIFT-NO-EBRAKE (1.5): throttle-sustain tier; during an
 *    active drift WITHOUT held e-brake, throttle-produced
 *    wheelspin still rotates the car decisively so the slide
 *    sustains. Held e-brake still wins.
 *  - NORMAL (0.35): grip-state corner-exit power-oversteer
 *    contribution. Subtle enough that minor stick-throttle
 *    brushes don't cascade into drift state.
 *
 *  v8.99.63 POST-DRIFT GATE: pPostDriftTimer > 0 suppresses the
 *  boost during the post-drift recovery window. Prevents
 *  automatic re-entry cascade after an e-brake drift ends.
 *  Player can still re-enter drift by pulling e-brake (the kick
 *  fires via its own press-edge path, not this boost).
 *
 *  v8.99.55 SURFACE CAPS: off-road, wheelspinRatio grows
 *  disproportionately because torque demand is unchanged but
 *  budget is slashed. The product `ratio × F_circle_R` ends up
 *  larger on grass than pavement, which post-v8.99.53 coupling
 *  meant real 720° spins on slight throttle brushes off-road.
 *  Grass capped to 0.4×, dirt to 0.6×, pavement unchanged.
 *  Off-road still feels loose from natural low-μ behavior
 *  (reduced F_lat budgets), but stops being a pirouette machine
 *  on throttle touches.
 *
 *  RWD-ONLY ELIGIBILITY: only FR/MR/RR drivetrains fire this
 *  boost. FF has its own front-saturation understeer (handled
 *  implicitly by the friction circle), and 4WD distributes
 *  wheelspin across both axles so the rotation effect
 *  cancels — the boost doesn't apply.
 *
 *  INPUTS:
 *    pYawRate          current yaw rate after
 *                      [[integrateYawRate]]
 *    wheelspinRatio    from [[detectWheelspinRatio]]
 *    drivetrain        chassis drivetrain
 *    steerInput        raw steering input (signed, [-1, 1])
 *    pEbrakeTimer      e-brake countdown
 *    pDrifting         drift state flag
 *    pPostDriftTimer   post-drift recovery countdown
 *    onGrass           surface is grass
 *    onDirt            surface is dirt / canyon (tiles 12/14/16)
 *    b                 CG → rear axle distance
 *    F_circle_R        full rear friction-circle radius
 *    I                 chassis yaw inertia
 *    dt                frame timestep (s)
 *
 *  Returns the updated pYawRate. If any gate fails, returns the
 *  input unchanged.
 *
 *  Ported 1:1 from monolith L25855-L25906 (the wheelspin-yaw-
 *  boost block at the tail of step 9 of the Phase 0B
 *  integrator). */
export function applyWheelspinYawBoost(
  pYawRate: number,
  wheelspinRatio: number,
  drivetrain: Drivetrain,
  steerInput: number,
  pEbrakeTimer: number,
  pDrifting: boolean,
  pPostDriftTimer: number,
  onGrass: boolean,
  onDirt: boolean,
  b: number,
  F_circle_R: number,
  I: number,
  dt: number,
): number {
  if (wheelspinRatio <= 0) return pYawRate;
  if (drivetrain !== 'FR' && drivetrain !== 'MR' && drivetrain !== 'RR') return pYawRate;
  const steerMag = Math.abs(steerInput);
  const steerGate = pEbrakeTimer > 0 ? WHEELSPIN_YAW_STEER_GATE_EBRAKE : WHEELSPIN_YAW_STEER_GATE_NORMAL;
  if (steerMag <= steerGate) return pYawRate;
  if (pPostDriftTimer > 0) return pYawRate;
  const dir = Math.sign(steerInput);
  const ebrakeMult = pEbrakeTimer > 0
    ? WHEELSPIN_YAW_MULT_EBRAKE
    : pDrifting
      ? WHEELSPIN_YAW_MULT_DRIFT_NO_EBRAKE
      : WHEELSPIN_YAW_MULT_NORMAL;
  let surfMult = 1.0;
  if (onGrass) surfMult = WHEELSPIN_YAW_SURF_GRASS;
  else if (onDirt) surfMult = WHEELSPIN_YAW_SURF_DIRT;
  const wsYaw = dir * steerMag * wheelspinRatio * b * F_circle_R * WHEELSPIN_YAW_FORCE_COEFF * ebrakeMult * surfMult;
  return pYawRate + (wsYaw / I) * dt;
}

export function applyAntiparallelVelocityRotation(
  pVx: number,
  pVy: number,
  pAngle: number,
  pSpeed: number,
  gasHeld: boolean,
): WorldVelocity {
  if (!gasHeld) return { pVx, pVy };
  if (Math.abs(pSpeed) <= ANTIPARALLEL_SPEED_GATE) return { pVx, pVy };
  const cosA = Math.cos(pAngle);
  const sinA = Math.sin(pAngle);
  const preVLong = pVx * cosA + pVy * sinA;
  if (preVLong * pSpeed >= 0) return { pVx, pVy };
  const spdMag = Math.sqrt(pVx * pVx + pVy * pVy);
  if (spdMag <= ANTIPARALLEL_VELOCITY_MAG_GATE) return { pVx, pVy };
  const velAng = Math.atan2(pVy, pVx);
  let angDiff = pAngle - velAng;
  while (angDiff > Math.PI) angDiff -= 2 * Math.PI;
  while (angDiff < -Math.PI) angDiff += 2 * Math.PI;
  const newVelAng = velAng + angDiff * ANTIPARALLEL_ROTATE_RATE;
  return {
    pVx: Math.cos(newVelAng) * spdMag,
    pVy: Math.sin(newVelAng) * spdMag,
  };
}

/** Max physical front-wheel steering angle in the grip state, in
 *  radians. ~35° matches the real-world full-lock of most road
 *  cars (rack-and-pinion limited).
 *
 *  Matches monolith `0.6` at L24845. */
export const MAX_DELTA_GRIP = 0.6;

/** Max physical front-wheel steering angle in the drift state, in
 *  radians. ~70° — raised above the grip cap so counter-steer can
 *  reach a wheel angle that lets the front slip angle actually
 *  flip sign, giving the driver real authority to exit a slide.
 *
 *  WHY 70° EXISTS: at chassis slip ~86°, a delta capped to 35°
 *  (the grip value) can never produce a slipF < 0 — the car stays
 *  locked in the slide regardless of counter-steer input. Raising
 *  to 70° gives the driver enough wheel-angle range to actually
 *  reverse the slip-front sign.
 *
 *  NOT a grip cheat: the 0B integrator force-circle-clamps lateral
 *  force by μ, so a huge delta just means "saturated outer edge
 *  of the friction circle" — no unphysical grip boost emerges.
 *
 *  HISTORY: tried and reverted in v8.99.87 ("insufficient
 *  evidence"), restored in v8.99.91. The v87 revert happened
 *  while the target-yaw override was still sign-flipping driver
 *  input, so counter-steer was meaningless regardless of maxDelta.
 *  With the target-yaw fix now in place, expanded delta gives the
 *  driver real authority to exit a slide.
 *
 *  Matches monolith `1.2` at L24845. */
export const MAX_DELTA_DRIFT = 1.2;

/** Maximum physical front-wheel steering angle, in radians. Larger
 *  during a drift to grant counter-steer authority; smaller in
 *  grip to match real-car rack-and-pinion limits.
 *
 *  See [[MAX_DELTA_GRIP]] (0.6 ≈ 35°) and [[MAX_DELTA_DRIFT]]
 *  (1.2 ≈ 70°) for the values and the v8.99.91 history of why
 *  the drift case needs a higher cap to make counter-steer
 *  functional.
 *
 *  Ported 1:1 from monolith L24845 (the maxDelta ternary at the
 *  head of the delta-computation block). */
export function computeBicycleMaxDelta(pDrifting: boolean): number {
  return pDrifting ? MAX_DELTA_DRIFT : MAX_DELTA_GRIP;
}

/** Compute the geometric yaw rate from the bicycle ODE. This is
 *  the kinematic-bicycle model's defining equation:
 *
 *    yawRate = (v / L) × tan(delta)
 *
 *  where:
 *    v       longitudinal velocity (signed — negative when
 *            reversing)
 *    L       wheelbase (from [[computeBicycleWheelbase]])
 *    delta   front-wheel steering angle, in radians
 *
 *  Derivation: under the kinematic-bicycle assumption (no tire
 *  slip — the wheels roll without sliding), the rear axle must
 *  travel along the body's heading. Geometry then forces the
 *  front axle along a circle whose radius depends on delta, and
 *  the body rotates around the rear-axle pivot at a rate that
 *  works out to v/L × tan(delta).
 *
 *  PROPERTIES:
 *  - Sign-correct in reverse: vSigned negative + delta positive →
 *    yawRate negative. The body rotates the opposite way around
 *    in reverse, which matches the physical behavior of a real
 *    car backing out of a parking space.
 *  - Magnitude scales with speed: at v=0 the yaw rate is zero
 *    regardless of wheel angle (a parked car with full lock
 *    doesn't rotate). The Phase 0A/0B branches handle this with
 *    a low-speed blend so parking-lot maneuvers still work.
 *  - tan(delta) goes to infinity at ±π/2; in practice the maxDelta
 *    cap ([[computeBicycleMaxDelta]]: 0.6 grip, 1.2 drift) keeps
 *    delta well within the linear-ish region of tan.
 *
 *  PHASE 0A: this yaw rate is assigned directly to pAngVel as
 *  the body's per-frame angular velocity. PHASE 0B: this is
 *  computed as a reference/fallback but pAngVel is set by the
 *  force integrator instead (which uses delta as the front-wheel
 *  slip-angle input).
 *
 *  Ported 1:1 from monolith L24994 (`(vSigned/Lwb)*Math.tan(delta)`
 *  at the end of the delta-computation block). */
export function computeGeometricYaw(
  vSigned: number,
  wheelbase: number,
  delta: number,
): number {
  return (vSigned / wheelbase) * Math.tan(delta);
}

/** Compute the front-wheel steering angle (delta) directly from
 *  driver stick input during a 0B drift. Bypasses the bicycle-
 *  model inverse — driver intent maps straight to wheel angle:
 *
 *    delta = clamp(steerInputEff × maxDelta, -maxDelta, maxDelta)
 *
 *  WHY DIRECT MAPPING (v8.99.91 fix, "DRIFT COUNTER-STEER FIX"):
 *  in the inverse-bicycle path used by grip state,
 *    delta = atan(desiredYaw × Lwb / vAbs)
 *  but during a drift `desiredYaw ≡ pAngVel = driftSteer +
 *  slipForce`, and slipForce can be huge and opposite-signed to
 *  the driver's input. At slip=-86°, slipForce ≈ -2.4 rad/s; even
 *  full-right stick's driftSteer (~+1.5 rad/s at speedRatio 0.33)
 *  can't overpower it, so atan() produces NEGATIVE delta — driver
 *  presses right, front wheels turn LEFT, yaw diverges further.
 *
 *  HUD evidence from the bug report:
 *    str=+0.97, delt=-7° (sign inversion).
 *
 *  In the 0B force integrator, the "slip auto-rotates the car"
 *  physics is ALREADY produced by F_lat_R saturating at 84° rear
 *  slip → real yaw torque τ = a·F_lat_F − b·F_lat_R. Routing
 *  slipForce into delta as well double-counts the slip-rotation
 *  effect AND pollutes the driver's steering channel.
 *
 *  USED IN TWO PLACES (same formula in both):
 *  1. Low-speed drift carve-out (vAbs<3, dynPhysics0B on)
 *     at monolith L24880-L24883 — the v8.99.124.01 fix that
 *     restored counter-steer authority during stationary
 *     burnout donuts.
 *  2. High-speed 0B-drift bypass (vAbs≥3, pDrifting,
 *     dynPhysics0B on) at monolith L24907-L24909.
 *
 *  Caller composes the eligibility (drift state, 0B enabled) and
 *  this function returns the resulting delta. The clamping is
 *  done here so callers don't have to repeat it.
 *
 *  Ported 1:1 from monolith L24881-L24883 / L24907-L24909 (the
 *  drift-state direct-mapping in the bicycle-model delta branch). */
export function computeDriftDelta(
  steerInputEff: number,
  maxDelta: number,
): number {
  const raw = steerInputEff * maxDelta;
  if (raw > maxDelta) return maxDelta;
  if (raw < -maxDelta) return -maxDelta;
  return raw;
}

/** Compute the grip-state front-wheel steering angle (delta) by
 *  combining the bicycle-INVERSE formula with a physical-delta
 *  override that fires when the driver is committed past what
 *  the smooth target-yaw inverse would allow.
 *
 *  TWO CANDIDATES (computed every frame):
 *    inverseDelta  = atan(desiredYaw × Lwb / vAbs)
 *    physicalDelta = steerInputEff × maxDelta
 *
 *  SELECTION RULE:
 *    1. inverseDelta == 0      →  use physicalDelta
 *    2. same sign AND
 *       |physical| > |inverse| →  use physicalDelta
 *    3. otherwise              →  use inverseDelta
 *    (then clamp to ±maxDelta)
 *
 *  WHY THE OVERRIDE EXISTS (v8.99.124.00 loss-of-traction fix,
 *  driven by user-supplied "With Traction vs Loss of Traction"
 *  trajectory diagrams):
 *
 *  The bicycle-INVERSE `atan(desiredYaw × Lwb / vAbs)` is a
 *  CONTROL inverse — it computes whatever wheel angle is needed
 *  to produce the smooth, calibrated target yaw rate at the
 *  current speed. Because:
 *    - `desiredYaw` is already speed-tuned upstream
 *      (highSpeedFactor = 1 - speedRatio² × 0.25, from H397's
 *      GRIP_HSF_QUAD_COEFF), AND
 *    - vAbs is in the denominator of the atan,
 *
 *  the formula auto-shrinks delta HARD at highway speed: at v=200
 *  gu/s with full-lock input, atan() yields delta ≈ 3-5° even
 *  though the player has the wheel at ~30° of lock. The friction
 *  circle (μ·Fz) is therefore NEVER saturated by lateral demand
 *  — the wheel angle is silently capped to whatever the available
 *  grip can deliver smoothly. Result: every turn is a clean
 *  circular arc regardless of steering aggression ("blue line" /
 *  Path-1 trajectory in the user diagrams).
 *
 *  User-visible symptom (verbatim from the bug report): "When I
 *  lose traction on the highway or at high speed, while turning
 *  the tires, the car still turns in a relatively perfect circle.
 *  If losing traction, the car should maintain most of its
 *  inertia even with tires turned."
 *
 *  BEHAVIOR BREAKDOWN with the override:
 *  - Low speed (vAbs small): atan term is large, dominates →
 *    tight smooth turning preserved exactly. inverseDelta wins.
 *  - High speed, light/moderate input: inverse and physical
 *    similar magnitude → no behavior change (smooth highway turns).
 *  - High speed, committed input: inverse auto-shrinks tiny while
 *    physical stays at the player's actual stick position →
 *    physical wins. Wheel angle now reflects driver intent →
 *    friction circle saturates → tire-curve falloff (v8.99.93)
 *    reduces F_lat past peak slip → ω growth slows → kinematic
 *    coupling `-v_long·ω` (v8.99.53) accumulates v_lat → world
 *    velocity vector persists in original direction while heading
 *    rotates. This is the "red dashed line" / Path-2 trajectory.
 *
 *  Once slip exceeds driftEnterThresh (0.26 rad) the existing
 *  drift state engages naturally and the unified 0B integrator
 *  carries the slide via its already-implemented physics — no
 *  new drift-path code needed. Skidmarks/audio/visuals already
 *  gate on pDrifting in the natural way.
 *
 *  OPPOSITE-SIGN GUARD (rule 3 falls through to inverseDelta):
 *  during transient corrections (counter-steer crossing zero) the
 *  two values can briefly disagree in sign. In that case the
 *  inverseDelta is honored, which is more stable than letting the
 *  player's stick position momentarily override the control
 *  surface.
 *
 *  Ported 1:1 from monolith L24960-L24971 (the grip-state branch
 *  of the bicycle-model delta computation). */
/** Speed threshold (game units) below which the grip-state delta
 *  computation switches from the inverse-bicycle formula
 *  ([[computeGripDelta]]) to the low-speed blend
 *  ([[computeLowSpeedGripDelta]]).
 *
 *  WHY 3: at vAbs < 3, the bicycle ODE `yawRate = v/L × tan(delta)`
 *  has so little speed in the numerator that delta alone can't
 *  produce meaningful yaw — a parking-lot maneuver would feel
 *  dead. The low-speed blend uses a fraction of desiredYaw
 *  directly, preserving the tight low-speed turning that real
 *  cars achieve via wheel angle rather than speed.
 *
 *  Matches monolith `vAbs<3` at L24847. */
export const LOW_SPEED_BICYCLE_THRESHOLD = 3;

/** Low-speed grip-blend coefficient. At parking-lot speeds the
 *  delta is a small fraction of the desired yaw rate — not the
 *  inverse-bicycle formula, just a direct blend:
 *
 *    delta = clamp(desiredYaw × 0.4, ±maxDelta)
 *
 *  WHY 0.4: empirically tuned so that the desiredYaw coming out
 *  of the upstream steering pipeline (which already includes
 *  spdFactor that suppresses turning at very low speed) maps to
 *  a sensible parking-lot wheel angle. Lower would feel dead;
 *  higher would oversteer in tight maneuvers. Note the upstream
 *  spdFactor=0 at v=0 makes desiredYaw tiny in grip state at
 *  v=0, so the blend produces tiny delta — no accidental snap-
 *  rotation when stationary.
 *
 *  Matches monolith `desiredYaw*0.4` at L24885. */
export const LOW_SPEED_BLEND_COEFF = 0.4;

/** Compute the grip-state delta in the low-speed regime
 *  (vAbs < [[LOW_SPEED_BICYCLE_THRESHOLD]] = 3 gu/s).
 *
 *  FORMULA (1:1 with monolith):
 *    delta = clamp(desiredYaw × 0.4, ±maxDelta)
 *
 *  WHY THIS BRANCH EXISTS: the bicycle ODE used by
 *  [[computeGripDelta]] has v in the numerator, so at v=0 no
 *  finite delta can produce yaw — the inverse formula
 *  `atan(desiredYaw × Lwb / vAbs)` blows up to ±π/2 (saturates
 *  to ±maxDelta). The blow-up is mathematically the "correct
 *  inverse" but feels wrong: pressing the stick produces a
 *  snap-to-full-lock that doesn't match how real cars
 *  parking-lot-maneuver.
 *
 *  Real cars at parking speeds turn via WHEEL ANGLE (a fraction
 *  of full lock for a typical lot maneuver), not via the
 *  bicycle-ODE relationship. The low-speed blend models this by
 *  using a fraction of the desiredYaw signal directly as the
 *  wheel angle.
 *
 *  GATING: caller selects this function when:
 *  - vAbs < LOW_SPEED_BICYCLE_THRESHOLD (3 gu/s), AND
 *  - NOT (pDrifting AND dynPhysics0B) — the drift carve-out at
 *    L24880-L24883 uses [[computeDriftDelta]] instead, because
 *    in drift state pAngVel ≡ slipForce dominates and the
 *    desiredYaw blend would override driver counter-steer.
 *
 *  SAFETY: upstream spdFactor=0 at v=0 makes desiredYaw tiny in
 *  the grip state at standstill, so this branch produces tiny
 *  delta even at the absolute zero-speed boundary — no accidental
 *  snap rotation.
 *
 *  Ported 1:1 from monolith L24885 (the grip-state branch of the
 *  v<3 fork). */
export function computeLowSpeedGripDelta(
  desiredYaw: number,
  maxDelta: number,
): number {
  const blended = desiredYaw * LOW_SPEED_BLEND_COEFF;
  if (blended > maxDelta) return maxDelta;
  if (blended < -maxDelta) return -maxDelta;
  return blended;
}

export function computeGripDelta(
  desiredYaw: number,
  wheelbase: number,
  vAbs: number,
  steerInputEff: number,
  maxDelta: number,
): number {
  const inverseDelta = Math.atan(desiredYaw * wheelbase / vAbs);
  const physicalDelta = steerInputEff * maxDelta;
  let delta: number;
  if (inverseDelta === 0) {
    delta = physicalDelta;
  } else if (Math.sign(physicalDelta) === Math.sign(inverseDelta)
             && Math.abs(physicalDelta) > Math.abs(inverseDelta)) {
    delta = physicalDelta;
  } else {
    delta = inverseDelta;
  }
  if (delta > maxDelta) return maxDelta;
  if (delta < -maxDelta) return -maxDelta;
  return delta;
}

/** Select and compute the front-wheel steering angle (delta) for
 *  the bicycle-model branch. Picks between three primitives based
 *  on speed regime and drift state:
 *
 *    vAbs < 3, drift+0B  →  [[computeDriftDelta]]      (carve-out)
 *    vAbs < 3, otherwise →  [[computeLowSpeedGripDelta]]
 *    vAbs ≥ 3, drift+0B  →  [[computeDriftDelta]]      (bypass)
 *    vAbs ≥ 3, otherwise →  [[computeGripDelta]]       (inverse)
 *
 *  Notice that the drift-state path is THE SAME function at both
 *  speed regimes — `computeDriftDelta`'s "direct stick→delta"
 *  mapping is the right answer regardless of speed when the 0B
 *  force integrator is going to consume delta, because driver
 *  authority must override what the upstream pAngVel signal
 *  would imply (which is polluted by slipForce; see H406's
 *  COUNTER-STEER FIX docs).
 *
 *  The grip-state path DIFFERS between regimes because:
 *  - At low speed the bicycle ODE's `v` in the numerator
 *    collapses to ~0 and the inverse formula blows up to ±π/2.
 *    [[computeLowSpeedGripDelta]] sidesteps this with a direct
 *    blend of desiredYaw × 0.4.
 *  - At normal speed the inverse-bicycle is the correct control
 *    formula, refined by the physical-delta override
 *    ([[computeGripDelta]]) that handles the loss-of-traction
 *    case at the high-speed extreme.
 *
 *  INPUTS:
 *    steerInputEff     post-sensitivity stick input (from
 *                      steering.ts computeEffectiveSteerInput H396)
 *    desiredYaw        the upstream pAngVel value, AFTER the
 *                      grip/drift branches of the steering block
 *                      have produced it. Carries all upstream
 *                      tuning (turnRate, massDamp, HSF, drivetrain
 *                      effects, fault layer).
 *    wheelbase         Lwb from [[computeBicycleWheelbase]]
 *    vAbs              |pSpeed| in game units / sec
 *    maxDelta          from [[computeBicycleMaxDelta]]
 *    pDrifting         current drift-state flag
 *    dyn0BEnabled      LIFE.gameplaySettings.dynPhysics0B
 *
 *  Returns delta in radians, already clamped to ±maxDelta by the
 *  underlying primitive.
 *
 *  Ported 1:1 from monolith L24847-L24972 (the three-way branch
 *  in the bicycle-model delta-computation block). */
export function selectBicycleDelta(
  steerInputEff: number,
  desiredYaw: number,
  wheelbase: number,
  vAbs: number,
  maxDelta: number,
  pDrifting: boolean,
  dyn0BEnabled: boolean,
): number {
  const driftPath = pDrifting && dyn0BEnabled;
  if (vAbs < LOW_SPEED_BICYCLE_THRESHOLD) {
    if (driftPath) return computeDriftDelta(steerInputEff, maxDelta);
    return computeLowSpeedGripDelta(desiredYaw, maxDelta);
  }
  if (driftPath) return computeDriftDelta(steerInputEff, maxDelta);
  return computeGripDelta(desiredYaw, wheelbase, vAbs, steerInputEff, maxDelta);
}
