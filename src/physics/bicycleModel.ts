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

/** Result of [[advancePhase0APosition]]: the new rear-axle
 *  world position (constrained to roll along heading) and the
 *  derived CG world position. */
export interface Phase0APositionStep {
  /** New rear-axle world X — rear advanced along (new) heading
   *  by pSpeed × dt. */
  pRearX: number;
  /** New rear-axle world Y. */
  pRearY: number;
  /** New CG world X — rear position + halfWheelbase forward
   *  along (new) heading. */
  nx: number;
  /** New CG world Y. */
  ny: number;
}

/** Advance the chassis position one tick using Phase 0A
 *  (v8.40) kinematic-bicycle constraints. The rear axle rolls
 *  along (new) body heading with NO lateral component possible
 *  — this is the structural fix for the "rear on ice" highway
 *  wiggle. Yaw is a geometric consequence.
 *
 *  FORMULA (1:1 with monolith):
 *    newRearX = pRearX + cos(pAngle) × pSpeed × dt
 *    newRearY = pRearY + sin(pAngle) × pSpeed × dt
 *    nx       = newRearX + cos(pAngle) × halfWheelbase
 *    ny       = newRearY + sin(pAngle) × halfWheelbase
 *
 *  Caller passes the ALREADY-UPDATED pAngle (after heading has
 *  been advanced by `pAngle += pAngVel × dt`). Using the new
 *  pAngle for both the rear-axle roll AND the CG offset is a
 *  semi-implicit Euler simplification — stable at typical frame
 *  rates and avoids sub-step drift.
 *
 *  WHY REAR-AXLE-CONSTRAINED (vs CG-centered): real cars steer
 *  by changing the front-wheel direction; the rear axle (in
 *  pure rolling) doesn't slip sideways. Modeling the rear as
 *  the rigid pivot and the CG as a halfWheelbase-forward
 *  offset produces:
 *  - At pure forward motion: rear rolls forward, CG follows in
 *    a straight line.
 *  - During yaw: rear rolls along the (yawed) heading; CG
 *    scribes an arc around the rear axle (the natural pivot
 *    point). The lateral CG drift during yaw is physically
 *    correct — a car turning has its CG offset from its
 *    instantaneous rotation center.
 *  - Eliminates the "rear-on-ice" wiggle that direct-yaw
 *    integration produces at high speed, because the rear is
 *    geometrically constrained to track heading.
 *
 *  PHASE 0A vs 0B: Phase 0A is the geometric (kinematic) path;
 *  Phase 0B is the force-based dynamic path. The rear-axle
 *  constraint is shared between them in spirit, but 0B's
 *  position integration uses the world-frame velocity directly
 *  (px += pVx × dt) rather than the rear-axle-rolls-along-
 *  heading derivation here. 0A's constraint is rigid; 0B
 *  allows the rear to have lateral slip (it's the integrator's
 *  v_lat that holds the slip momentum).
 *
 *  INPUTS:
 *    pRearX, pRearY   current rear-axle world position
 *    pAngle           NEW chassis heading (already advanced by
 *                     pAngVel × dt this frame)
 *    pSpeed           scalar speed (signed)
 *    dt               frame timestep (s)
 *    halfWheelbase    Lwb / 2 — distance from rear axle to CG
 *
 *  Returns the new rear-axle position AND the derived CG
 *  position. Caller then runs collision check on (nx, ny) and
 *  selects free-move / slide / bounce response.
 *
 *  Ported 1:1 from monolith L26249-L26257 (the Phase 0A
 *  position-advance block in the legacy bicycle-model branch). */
export function advancePhase0APosition(
  pRearX: number,
  pRearY: number,
  pAngle: number,
  pSpeed: number,
  dt: number,
  halfWheelbase: number,
): Phase0APositionStep {
  const cosA = Math.cos(pAngle);
  const sinA = Math.sin(pAngle);
  const newRearX = pRearX + cosA * pSpeed * dt;
  const newRearY = pRearY + sinA * pSpeed * dt;
  return {
    pRearX: newRearX,
    pRearY: newRearY,
    nx: newRearX + cosA * halfWheelbase,
    ny: newRearY + sinA * halfWheelbase,
  };
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
/** Steering-magnitude threshold below which the driver is
 *  considered to have "released the wheel" for the self-
 *  aligning yaw-damping tier. v8.99.124.07 bumped the neutral-
 *  steering tier from 0.7 to 2.5/s, gated on this threshold.
 *
 *  Matches monolith `Math.abs(steerInput) < 0.1` at L25966. */
export const YAW_DAMP_STEER_NEUTRAL_GATE = 0.1;

/** Steering-magnitude threshold below which the driver is
 *  considered IDLE (combined with no gas and no ebrk) for the
 *  v8.99.91 driver-idle yaw-damping path. Tighter than the
 *  neutral-steer gate because we want only truly hands-off
 *  states.
 *
 *  Matches monolith `Math.abs(steerInput) < 0.05` at L25967. */
export const YAW_DAMP_IDLE_STEER_GATE = 0.05;

/** Yaw damping rate (1/s) in the grip state. Light value
 *  because the slip-angle feedback (rear-axle lateral force
 *  opposing yaw) already provides primary stabilization. Too
 *  much damping here prevents yaw from building up to
 *  meaningful values during sustained cornering.
 *
 *  Matches monolith `0.4` at L25970. */
export const YAW_DAMP_GRIP_STATE = 0.4;

/** Yaw damping rate (1/s) during active drift WITH active
 *  driver input (steering held, throttle, or e-brake). Light
 *  value — the slip feedback already kills runaway yaw; we
 *  don't need extra help in drift. v8.98.52 dropped this from
 *  0.2 to 0.15 with the new throttle-sustain and wheelspin-yaw
 *  tiers — slides needed a little more inertia to reward
 *  throttle modulation without fighting it.
 *
 *  Matches monolith `0.15` at L25969. */
export const YAW_DAMP_DRIFT_ACTIVE_INPUT = 0.15;

/** Yaw damping rate (1/s) during drift when STEERING is
 *  neutral (driver released the wheel; gas / ebrk state
 *  irrelevant). v8.99.124.07 bumped this from 0.7 to 2.5 — the
 *  SELF-ALIGNING-TORQUE tier per the user's analogy: real cars
 *  have caster angle, pneumatic trail, and kingpin inclination
 *  that together produce a torque pulling wheels back to center
 *  when the driver releases the wheel.
 *
 *  Without this, a force-balance equilibrium at high slip
 *  (front and rear restoring torques cancel, τ ≈ 0) lets
 *  pYawRate orbit indefinitely. 2.5/s cuts the yaw rate to ~95 %
 *  in 0.22 s, to ~10 % in 0.38 s — clean exit when the player
 *  releases the wheel.
 *
 *  Matches monolith `2.5` at L25969. */
export const YAW_DAMP_DRIFT_NEUTRAL_STEER = 2.5;

/** Yaw damping rate (1/s) during drift when the driver is
 *  completely IDLE: steering < 0.05, no gas, no e-brake.
 *  v8.99.91 added this tier — at 90° slip the moment-balance
 *  yields τ ≈ 0 from forces alone, so yaw self-sustains. 0.8/s
 *  bleeds 5.1 rad/s yaw to 1 rad/s over ~2 seconds — feels
 *  like momentum, not a snap, but exits a "stuck in a circle"
 *  state naturally.
 *
 *  Matches monolith `0.8` at L25969. */
export const YAW_DAMP_DRIFT_IDLE = 0.8;

/** Apply yaw damping by one tick. Tier selection depends on
 *  drift state and driver input:
 *
 *  TIER TABLE (1:1 with monolith):
 *    pDrifting=false: 0.4/s  (grip-state stabilization)
 *    pDrifting=true:
 *      driver IDLE   (|steer|<0.05 & !gas & !ebrk):  0.8/s
 *      neutral steer (|steer|<0.10):                  2.5/s
 *      active drift  (otherwise):                     0.15/s
 *
 *  Where `pYawRate × = max(0, 1 - yawDamp × dt)`.
 *
 *  v8.99.124.07 SELF-ALIGNING-TORQUE TIER (the 2.5/s value):
 *  User feedback was that a straight steering wheel should
 *  eventually take over: "Held long enough straight the car
 *  should eventually 'balance forces' and go straight with the
 *  steering wheel. Same way you have to fight the steering
 *  wheel to turn because the steering components want the car
 *  to go straight (assuming they aren't damaged)."
 *
 *  Real cars have caster angle, pneumatic trail, and kingpin
 *  inclination producing self-aligning torque that pulls wheels
 *  back to center. Prior logic only boosted yawDamp when ALL
 *  inputs were neutral (no gas, no ebrake, no steering). With
 *  gas held and steering released — a perfectly normal "I'm
 *  done turning, let me straighten" gesture — yawDamp stayed
 *  at 0.15/s and the car kept rotating sluggishly. What
 *  governs straightening is the WHEEL position, not the
 *  throttle. A driver coasting on the highway with feet off vs
 *  holding gas should both straighten the same way when
 *  releasing the wheel.
 *
 *  v8.99.124.07 BUMPED FROM 0.7 → 2.5 /s. Diagnosis from user's
 *  high-speed-grass donut at neutral steering: even after the
 *  v8.99.124.06 combined-slip fix freed up rear lateral budget,
 *  the system reached a force-balance equilibrium where τ ≈ 0
 *  (front and rear restoring torques cancel) and pYawRate
 *  persisted. 0.7/s damping bled it too slowly (ω < 0.5 in
 *  0.81 s, ω < 0.1 in 1.77 s — sluggish exit). 2.5/s gives
 *  ω < 0.5 in 0.22 s, ω < 0.1 in 0.38 s — clean exit matching
 *  real-car self-aligning feel.
 *
 *  v8.99.91 DRIVER-IDLE TIER (0.8/s): for the "perfect circle
 *  with 0 steering" symptom at 90° slip where τ = a·F_F − b·F_R
 *  ≈ 0 (moment-balance). Without this, no natural exit — the
 *  player must actively counter-steer or tap brake to break
 *  out. Gated on full input neutral so it does NOT interfere
 *  with active drifts. Reverted v8.99.87 tried `slipMag*2.5`
 *  (ratcheting up to 3.75/s at 1.5 rad slip) which snapped
 *  pDrifting off → killed `_slipRev` RPM bonus → engine-brake
 *  drained pSpeed to 0. Constant 0.8 avoids that cascade.
 *
 *  Active drifts (steering held) still get 0.15/s — committed
 *  slides feel sustained as before. The 2.5/s only fires when
 *  the player has truly released.
 *
 *  INPUTS:
 *    pYawRate     pre-damping yaw rate (after the wheelspin
 *                 boost from [[applyWheelspinYawBoost]])
 *    steerInput   raw steering input
 *    pDrifting    drift state flag
 *    gas          gas held this frame
 *    ebrk         e-brake input flag (LIVE, not timer)
 *    dt           frame timestep (s)
 *
 *  Returns the damped pYawRate. Pure function.
 *
 *  Ported 1:1 from monolith L25966-L25971 (the yaw-damping
 *  block in the Phase 0B integrator). */
export function applyYawDamping(
  pYawRate: number,
  steerInput: number,
  pDrifting: boolean,
  gas: boolean,
  ebrk: boolean,
  dt: number,
): number {
  const steerMag = Math.abs(steerInput);
  const steerNeutral = steerMag < YAW_DAMP_STEER_NEUTRAL_GATE;
  const driverIdle = steerMag < YAW_DAMP_IDLE_STEER_GATE && !gas && !ebrk;
  let yawDamp: number;
  if (pDrifting) {
    if (driverIdle) yawDamp = YAW_DAMP_DRIFT_IDLE;
    else if (steerNeutral) yawDamp = YAW_DAMP_DRIFT_NEUTRAL_STEER;
    else yawDamp = YAW_DAMP_DRIFT_ACTIVE_INPUT;
  } else {
    yawDamp = YAW_DAMP_GRIP_STATE;
  }
  return pYawRate * Math.max(0, 1 - yawDamp * dt);
}

/** |pSpeed| threshold below which the low-speed collapse engages.
 *  Walking pace, ~1 gu/s ≈ 0.2 m/s. Combined with the world-
 *  speed gate, this distinguishes "truly stopped" from "slow
 *  forward motion."
 *
 *  Matches monolith `pSpeed<1.0 && pSpeed>-1.0` at L25980. */
export const LOW_SPEED_COLLAPSE_PSPEED_GATE = 1.0;

/** World-velocity-squared threshold below which the low-speed
 *  collapse engages. 4.0 ↔ |v| < 2 gu/s — enough margin that the
 *  collapse only fires when the car is genuinely stopped.
 *
 *  WHY world-speed SEPARATE FROM pSpeed (v8.99.55): during a
 *  drift, pSpeed can drop to near-zero via the longBlend even
 *  though the car is physically sliding at 50+ gu/s (v_lat holds
 *  the momentum via the centripetal coupling). Firing the
 *  collapse in that case would nuke v_lat → drift collapses to
 *  a stop. Requiring BOTH low forward speed AND low world-frame
 *  speed means only true standstill triggers the anti-wiggle.
 *
 *  Matches monolith `_worldSpdSq<4.0` at L25980. */
export const LOW_SPEED_COLLAPSE_WORLD_SQ_GATE = 4.0;

/** Per-frame multiplier on v_lat and pYawRate when the low-speed
 *  collapse engages. 0.6 ↔ 40 % decay per frame. Aggressive
 *  enough to suppress numerical wiggle within a few frames but
 *  not instantaneous (preserves a tiny bit of carry-over so the
 *  transition into and out of standstill isn't a hard snap).
 *
 *  Matches monolith `*=0.6` at L25981-L25982. */
export const LOW_SPEED_COLLAPSE_FACTOR = 0.6;

/** Per-frame collapse result returned by
 *  [[applyLowSpeedCollapse]]. */
export interface LowSpeedCollapseResult {
  v_lat: number;
  pYawRate: number;
}

/** Apply the low-speed collapse — below walking pace, decay
 *  v_lat and pYawRate to prevent numerical wiggle from
 *  accumulating into visible drift / spin when the car is
 *  essentially stopped.
 *
 *  FORMULA (1:1 with monolith):
 *    worldSpdSq = pVx² + pVy²
 *    if |pSpeed| < 1.0 AND worldSpdSq < 4.0:
 *      v_lat    × = 0.6
 *      pYawRate × = 0.6
 *    (else unchanged)
 *
 *  WHY BOTH GATES (v8.99.55): during a drift, pSpeed can drop
 *  to near-zero via the longBlend even though the car is
 *  physically sliding at 50+ gu/s (v_lat holds the momentum
 *  via the centripetal coupling from
 *  [[integrateLateralVelocity]]). Firing the collapse in that
 *  case would nuke v_lat → drift collapses to a stop. Requiring
 *  BOTH low forward speed AND low world-frame speed means only
 *  true standstill triggers the anti-wiggle.
 *
 *  WHY 0.6 (NOT 0): aggressive but not instantaneous. 40 %
 *  decay per frame suppresses wiggle within a handful of frames
 *  while preserving a tiny bit of carry-over so transitions
 *  into and out of standstill aren't hard snaps.
 *
 *  WHY THIS RUNS AFTER YAW DAMPING: this is a safety net for
 *  the standstill state. Yaw damping handles the dynamic
 *  cases; this is the "we're actually stopped and want to be
 *  truly still" anti-wiggle.
 *
 *  INPUTS:
 *    v_lat        post-integration lateral velocity (from
 *                 [[integrateLateralVelocity]])
 *    pYawRate     post-damping yaw rate (from
 *                 [[applyYawDamping]])
 *    pSpeed       scalar speed (signed)
 *    pVx, pVy     world-frame velocity components — squared
 *                 magnitude is checked against the world-speed
 *                 gate
 *
 *  Returns the {v_lat, pYawRate} pair (possibly collapsed).
 *
 *  Ported 1:1 from monolith L25979-L25983 (the low-speed
 *  anti-wiggle collapse block). */
export function applyLowSpeedCollapse(
  v_lat: number,
  pYawRate: number,
  pSpeed: number,
  pVx: number,
  pVy: number,
): LowSpeedCollapseResult {
  const worldSpdSq = pVx * pVx + pVy * pVy;
  if (pSpeed < LOW_SPEED_COLLAPSE_PSPEED_GATE
      && pSpeed > -LOW_SPEED_COLLAPSE_PSPEED_GATE
      && worldSpdSq < LOW_SPEED_COLLAPSE_WORLD_SQ_GATE) {
    return {
      v_lat: v_lat * LOW_SPEED_COLLAPSE_FACTOR,
      pYawRate: pYawRate * LOW_SPEED_COLLAPSE_FACTOR,
    };
  }
  return { v_lat, pYawRate };
}

/** Result of [[updateHeadingAndRecompose]]: the new chassis
 *  heading and the world-frame velocity recomposed against the
 *  updated heading. */
export interface HeadingRecomposeResult {
  pAngle: number;
  pVx: number;
  pVy: number;
}

/** Advance the chassis heading and recompose the world-frame
 *  velocity against the new heading. Step 11 of the Phase 0B
 *  integrator — runs AFTER yaw damping
 *  ([[applyYawDamping]]), low-speed collapse
 *  ([[applyLowSpeedCollapse]]), and fault layer modifiers
 *  (applyPowerSteeringFault / applyAlignmentPull) have all
 *  contributed to pYawRate.
 *
 *  FORMULA (1:1 with monolith):
 *    pAngle += pYawRate × dt
 *    cosA2  = cos(pAngle)
 *    sinA2  = sin(pAngle)
 *    pVx    = cosA2 × v_long_new - sinA2 × v_lat_new
 *    pVy    = sinA2 × v_long_new + cosA2 × v_lat_new
 *
 *  WHY THE RECOMPOSE USES THE NEW pAngle: this is the
 *  body→world transform applied with the UPDATED heading. The
 *  body-frame components (v_long_new, v_lat_new) were computed
 *  in the previous body-frame and are now rotated to match
 *  the new heading direction. This is what propagates the
 *  centripetal-coupling term in [[integrateLateralVelocity]]
 *  into a world-frame velocity that stays fixed in space as
 *  the chassis yaws — the momentum-preservation slide
 *  trajectory.
 *
 *  CONTRAST WITH STEP 1 ([[applyLongitudinalIntegration]]):
 *  step 1 recomposed pVx/pVy after updating v_long but BEFORE
 *  the force integration; step 11 recomposes again AFTER the
 *  force integration (using v_lat_new which reflects the
 *  applied lateral forces) AND after the heading has stepped
 *  forward. Both recomposes are necessary — step 1's gives the
 *  integrator a consistent pVx/pVy to start from; step 11's
 *  produces the final per-frame velocity for the position
 *  integration step that follows.
 *
 *  WHY THE HEADING UPDATE USES FORWARD-EULER: same rationale
 *  as [[integrateYawRate]] — the per-frame dt is small enough
 *  (~1/60 s) that local Euler error stays negligible, and the
 *  upstream damping + clamps prevent it from accumulating.
 *
 *  INPUTS:
 *    pAngle       pre-update heading (rad)
 *    pYawRate     post-damping-and-faults yaw rate (rad/s)
 *    dt           frame timestep (s)
 *    v_long_new   body-frame longitudinal velocity (after step 1)
 *    v_lat_new    body-frame lateral velocity (after step 8 +
 *                 low-speed collapse)
 *
 *  Returns {pAngle, pVx, pVy}. Caller assigns each.
 *
 *  Ported 1:1 from monolith L26009-L26012 (step 11 of the
 *  Phase 0B integrator: heading update + world-velocity
 *  recompose). */
export function updateHeadingAndRecompose(
  pAngle: number,
  pYawRate: number,
  dt: number,
  v_long_new: number,
  v_lat_new: number,
): HeadingRecomposeResult {
  const newAngle = pAngle + pYawRate * dt;
  const cosA2 = Math.cos(newAngle);
  const sinA2 = Math.sin(newAngle);
  return {
    pAngle: newAngle,
    pVx: cosA2 * v_long_new - sinA2 * v_lat_new,
    pVy: sinA2 * v_long_new + cosA2 * v_lat_new,
  };
}

/** pSpeed re-projection blend rate per frame in the grip state.
 *  0.02 = 2 % blend per frame ↔ ~0.83 s time constant at 60 fps.
 *  Fast enough to keep pSpeed synced with the actual forward
 *  motion projection during normal driving.
 *
 *  Matches monolith `0.02` in `_projBlendRate` at L26099. */
export const PSPEED_PROJ_BLEND_GRIP = 0.02;

/** pSpeed re-projection blend rate per frame during a drift.
 *  v8.99.55 dropped this from 0.02 to 0.005 (time constant 0.83s
 *  → 3.3s). At high slip angles, projLong → 0 (velocity
 *  perpendicular to heading). The default blend rate pulled
 *  pSpeed to ~0 in ~1 second, crashing engine RPM and killing
 *  the "gas-held slide" feel. Slower drift blend keeps pSpeed
 *  near the original speed through multi-second drifts → engine
 *  keeps revving → wheelspin audio/visual stays active →
 *  "traction broken" feel preserved.
 *
 *  Matches monolith `0.005` in `_projBlendRate` at L26099. */
export const PSPEED_PROJ_BLEND_DRIFT = 0.005;

/** Re-project pSpeed from the world-frame velocity after all
 *  per-frame forces have been applied. The lateral slip bleeds
 *  energy that the integrator's pSpeed integration doesn't see,
 *  so a gentle blend toward the longitudinal projection of
 *  world velocity keeps energy conservation honest over time.
 *
 *  FORMULA (1:1 with monolith):
 *    projLong = pVx × cos(pAngle) + pVy × sin(pAngle)
 *    blendRate = pDrifting ? 0.005 : 0.02
 *    if NOT gas OR projLong > pSpeed:
 *      pSpeed = pSpeed × (1 - blendRate) + projLong × blendRate
 *
 *  WHY GENTLE BLEND (NOT FULL OVERRIDE): the acceleration block
 *  already set pSpeed via the engine-torque pipeline; full
 *  override would discard that integration. The 0.02 per-frame
 *  blend takes a small CORRECTION from the projection so energy
 *  drift over time doesn't accumulate, but the per-frame engine
 *  torque still drives the dominant pSpeed motion.
 *
 *  WHY SLOWER DURING DRIFT (v8.99.55): at high slip angles
 *  projLong → 0 (velocity perpendicular to heading). The
 *  default 0.02 blend pulled pSpeed to ~0 in ~1 second,
 *  crashing engine RPM and killing the gas-held-slide feel.
 *  0.005 keeps pSpeed near the original through multi-second
 *  drifts so the engine keeps revving and the "traction broken"
 *  audio/visual stays active. On drift exit, blend returns to
 *  0.02 for quick grip-state realignment.
 *
 *  WHY GATE DOWNWARD BLEND ON !gas (v8.99.65): when gas is
 *  held, the engine is COMMANDING power — projLong shouldn't
 *  drag pSpeed DOWN regardless of slip/heading. Without this
 *  gate, 180° drifts flipped projLong negative and crashed
 *  pSpeed toward zero despite gas being held → engine went
 *  silent. Upward blend (projLong > pSpeed) still runs so
 *  genuine catch-up works (e.g. when surface friction creates
 *  more forward motion than the accel block produced).
 *
 *  INPUTS:
 *    pSpeed       current scalar speed (from accel pipeline)
 *    pVx, pVy     world-frame velocity (from
 *                 [[updateHeadingAndRecompose]])
 *    pAngle       updated chassis heading
 *    pDrifting    drift state flag
 *    gasHeld      gas input held this frame
 *
 *  Returns the new pSpeed.
 *
 *  Ported 1:1 from monolith L26084-L26102 (step 13 of the Phase
 *  0B integrator: pSpeed re-projection from world velocity). */
export function reprojectPSpeed(
  pSpeed: number,
  pVx: number,
  pVy: number,
  pAngle: number,
  pDrifting: boolean,
  gasHeld: boolean,
): number {
  const cosA = Math.cos(pAngle);
  const sinA = Math.sin(pAngle);
  const projLong = pVx * cosA + pVy * sinA;
  const blendRate = pDrifting ? PSPEED_PROJ_BLEND_DRIFT : PSPEED_PROJ_BLEND_GRIP;
  if (!gasHeld || projLong > pSpeed) {
    return pSpeed * (1 - blendRate) + projLong * blendRate;
  }
  return pSpeed;
}

/** Default drift-state entry slip threshold (radians). 0.26 rad
 *  ≈ 15°. v8.99.59 bumped from 0.18 (10°) — pre-coupling, slipMax
 *  rarely reached 0.18 in normal driving because yaw rotated
 *  heading without producing real slip. Post-coupling, wheelspin
 *  yaw + centripetal coupling can push slip past 0.18 from minor
 *  gas/steer inputs, tripping drift state unintentionally. 0.26
 *  is firmly in the breakaway regime — normal cornering (3-5°)
 *  and moderate power-oversteer (8-12°) stay grip-classified.
 *
 *  v8.99.85 exposed this as a user knob (physDriftEnterThresh).
 *  Raise to 0.45-0.60 rad if cars drift-circle from small inputs.
 *  E-brake path is gated separately so raising this does NOT
 *  affect intentional drift entry.
 *
 *  Matches monolith fallback `||0.26` at L26121. */
export const DRIFT_ENTER_THRESH_DEFAULT = 0.26;

/** Drift-state exit slip threshold (radians). 0.10 rad ≈ 6°. The
 *  hysteresis band: once drifting, the car must drop BELOW 6 °
 *  slip to exit grip-classify. The gap from 6° (exit) to 15°
 *  (enter) prevents oscillation when slip hovers near the
 *  threshold.
 *
 *  Matches monolith `driftExitThresh = 0.10` at L26122. */
export const DRIFT_EXIT_THRESH = 0.10;

/** Minimum speed (gu/s) for drift classification to fire at all.
 *  Below this, the chassis is essentially stopped and any "slip"
 *  is numerical noise. Checked against both absSpd and
 *  _worldSpd; the OR means either frame's speed must clear the
 *  gate.
 *
 *  Matches monolith `absSpd>5 || _worldSpd>5` at L26124. */
export const DRIFT_SPEED_GATE = 5;

/** Post-drift recovery window (seconds). When the player exits
 *  drift, this timer arms — during the window the wheelspin-yaw
 *  boost ([[applyWheelspinYawBoost]] gated on this) is
 *  suppressed and the standard slip-threshold path is blocked.
 *  Player must pull e-brake to intentionally re-enter drift.
 *  Prevents automatic re-entry cascade after an e-brake drift
 *  ends.
 *
 *  Matches monolith `pPostDriftTimer = 0.5` at L26131. */
export const DRIFT_POST_RECOVERY = 0.5;

/** Drift-state classification result returned by
 *  [[classifyDriftState]]. */
export interface DriftStateResult {
  /** Updated drift flag. */
  pDrifting: boolean;
  /** Updated post-drift recovery countdown — armed to
   *  [[DRIFT_POST_RECOVERY]] (0.5s) on a drift→grip transition,
   *  otherwise pass-through (caller decays it elsewhere in the
   *  frame). */
  pPostDriftTimer: number;
}

/** Phase 0B Session B drift-state classification. Derives the
 *  pDrifting flag from actual post-integrator slip with
 *  hysteresis + e-brake override + speed gate + post-drift
 *  recovery.
 *
 *  STATE MACHINE (1:1 with monolith):
 *    slipMax = max(|slipF|, |slipR|)
 *    if NOT (absSpd > 5 OR worldSpd > 5):
 *      pDrifting = false (low-speed clear)
 *      pPostDriftTimer unchanged
 *    elif pDrifting:
 *      if slipMax < 0.10 AND !ebrakeActive:
 *        pDrifting = false
 *        pPostDriftTimer = 0.5 (arm recovery)
 *      else: unchanged
 *    else (pDrifting == false):
 *      if ebrakeActive:
 *        pDrifting = true (deliberate re-entry overrides
 *                          recovery window)
 *      elif slipMax > driftEnterThresh AND pPostDriftTimer <= 0:
 *        pDrifting = true
 *      else: unchanged
 *
 *  HYSTERESIS BAND: enter at slipMax > 0.26 rad (~15°), exit at
 *  slipMax < 0.10 rad (~6°). The gap prevents oscillation when
 *  slip hovers near the threshold.
 *
 *  EBRAKE OVERRIDE: an active e-brake (pEbrakeTimer > 0) keeps
 *  the car drifting regardless of instantaneous slip, AND
 *  overrides the post-drift recovery window for deliberate re-
 *  entry. Player can always engage drift via e-brake.
 *
 *  v8.99.63 POST-DRIFT GRACE: pPostDriftTimer arms to 0.5s on
 *  the drift→grip transition. During the window, the slip-
 *  threshold path is blocked (only e-brake can re-enter).
 *  Prevents automatic re-entry cascade after an e-brake drift.
 *  Caller decays the timer elsewhere in the frame.
 *
 *  v8.49 EBRAKE COUNTS AS DRIFTING: while the e-brake timer is
 *  active, the rear is locked regardless of instantaneous slip
 *  magnitude. The check `!ebrakeActive` on the exit path
 *  prevents drift from ending mid-handbrake.
 *
 *  v8.99.85 USER KNOB: driftEnterThresh is overridable via
 *  LIFE.gameplaySettings.physDriftEnterThresh. Raise to
 *  0.45-0.60 rad if cars drift-circle from small inputs. The
 *  e-brake path is unaffected.
 *
 *  INPUTS:
 *    slipF, slipR     post-integrator slip angles from
 *                     [[computeSlipAngles]]
 *    pDrifting        current drift flag
 *    pPostDriftTimer  current recovery countdown
 *    absSpd           |pSpeed| (gu/s)
 *    worldSpd         |world velocity| (gu/s)
 *    pEbrakeTimer     e-brake countdown (active when > 0)
 *    driftEnterThresh resolved enter threshold (caller applies
 *                     the [[DRIFT_ENTER_THRESH_DEFAULT]] / 0.26
 *                     fallback if the setting is absent)
 *
 *  Returns the new {pDrifting, pPostDriftTimer}.
 *
 *  Ported 1:1 from monolith L26109-L26142 (the drift-state
 *  classification block, step 14 of the Phase 0B integrator). */
/** Compute the chassis-vs-velocity slip angle (pSlipAngle) —
 *  the body-vs-velocity angle used by minimap, HUD, skidmark
 *  decisions, and various effect layers.
 *
 *  FORMULA (1:1 with monolith):
 *    pSlipAngle = pAngle - pVelAngle
 *    wrap to (-π, π]
 *
 *  SIGN CONVENTION:
 *  - pSlipAngle > 0: chassis pointing LEFT of velocity (sliding
 *    rightward in body frame, or steered into a left turn that
 *    the velocity hasn't caught up to yet)
 *  - pSlipAngle < 0: mirror
 *  - |pSlipAngle| ≈ 0: grip driving (chassis tracks velocity)
 *  - |pSlipAngle| large: drift state
 *
 *  DIFFERENT FROM slipF / slipR: those are per-axle slip angles
 *  (the angle between each axle's POINTING direction and its
 *  VELOCITY direction), used by the tire-force model. pSlipAngle
 *  is the CHASSIS body-vs-velocity angle, used by downstream
 *  consumers (UI, skidmarks, audio). They're related but not
 *  identical — at the same chassis slip, slipF and slipR differ
 *  because the front and rear axles have different velocities
 *  due to yaw rotation.
 *
 *  WRAPAROUND: the angle is normalized to (-π, π] so the
 *  shortest-path representation is used. Without it, a chassis
 *  facing east with velocity facing west would produce a
 *  ±π pSlipAngle (180° backward), which is mathematically
 *  correct but confuses any consumer that interprets sign as
 *  "left-of-velocity vs right-of-velocity."
 *
 *  Pure function. Used as a global write at the integrator's
 *  tail; caller assigns to player.pSlipAngle.
 *
 *  Ported 1:1 from monolith L26144-L26146 (the pSlipAngle update
 *  in step 14 of the Phase 0B integrator). */
export function computePSlipAngle(
  pAngle: number,
  pVelAngle: number,
): number {
  let slip = pAngle - pVelAngle;
  while (slip > Math.PI) slip -= 2 * Math.PI;
  while (slip < -Math.PI) slip += 2 * Math.PI;
  return slip;
}

/** Base quadratic-in-vlat coefficient for the pSpeed lateral-
 *  velocity drag. Multiplied with vlat² × driftMult × dt to
 *  produce the per-frame pSpeed decrement.
 *
 *  Tuned so straight-line highway tracking (vlat ≈ 0) costs
 *  nothing — the v² shape ensures that — while genuine slides
 *  bleed energy meaningfully.
 *
 *  Matches monolith `0.0025` at L26185. */
export const LAT_DRAG_COEFF = 0.0025;

/** Drift-state lateral-drag multiplier when throttle is held.
 *  v8.99.80 dropped this from 1.2 to 0.2 after user feedback:
 *  "powerslide after pulling e-brake and accelerating after
 *  feels great on bikes. Can the same be done for cars? They
 *  still have the issue coming to complete stop at end of
 *  e-brake turn."
 *
 *  At 162 km/h (~219 gu/s) with v_lat ≈ 190 gu/s, the old 1.2×
 *  produced ~108 gu/s² of drain — pSpeed lost ~50 % over a
 *  1-second slide. When the drift exited and v_lat damping
 *  killed the sideways momentum, actual ground speed snapped
 *  to that crushed pSpeed → the "complete stop" symptom.
 *  Earlier v8.99.64/65/69 patches addressed downstream symptoms
 *  (v_long blend, projLong gate, antiparallel velocity rotation)
 *  but didn't touch the pSpeed drain itself.
 *
 *  0.2× leaves a token cost (~18 gu/s² at the same v_lat, ≈ 8 %
 *  loss over 1 s) so spamming e-brake isn't free speed, while
 *  giving the engine authority to sustain pSpeed through the
 *  slide.
 *
 *  Matches monolith `0.2` at L26184. */
export const LAT_DRAG_DRIFT_THROTTLE = 0.2;

/** Drift-state lateral-drag multiplier when throttle is NOT
 *  held. Off-throttle drifts retain the full 2.2× drag —
 *  realistic coast-to-stop behavior (no power to keep the
 *  tires loose; cold friction dominates).
 *
 *  Matches monolith `2.2` at L26184. */
export const LAT_DRAG_DRIFT_OFF_THROTTLE = 2.2;

/** Apply the lateral-velocity drag — pSpeed bleed from sideways
 *  motion. Quadratic in vlat, scaled by drift state and throttle.
 *
 *  FORMULA (1:1 with monolith):
 *    vlat     = -pVx × sin(pAngle) + pVy × cos(pAngle)
 *    driftMult = pDrifting ? (isThrottle ? 0.2 : 2.2) : 1.0
 *    latDrag  = |vlat|² × 0.0025 × driftMult
 *    pSpeed  -= sign(pSpeed || 1) × latDrag × dt
 *    if pSpeed < 0 AND |pSpeed| < latDrag × dt: pSpeed = 0
 *
 *  WHY ALWAYS APPLIES (not gated on pDrifting): any sideways
 *  motion represents tire scrubbing energy. Without this drag,
 *  short impulses (e-brake taps below the drift threshold)
 *  could rotate the car without costing speed, letting players
 *  U-turn at highway speed by spamming ebrake. The v² shape
 *  ensures straight-line tracking (vlat ≈ 0) costs nothing
 *  while genuine slides cost meaningfully.
 *
 *  v8.49 SOFTENED DAMPING DURING DRIFT: drift was eating
 *  lateral velocity so fast that slides never developed from
 *  ebrake impulses. The driftMult tuning + the v_lat damping
 *  multipliers were both reworked.
 *
 *  WHY sign(pSpeed || 1): when pSpeed is exactly 0, sign(0) = 0,
 *  which would freeze pSpeed at 0. `|| 1` makes it sign(1) = 1
 *  so the drag fires as positive even from zero. The
 *  cross-zero clamp below catches the resulting overshoot.
 *
 *  WHY THE CROSS-ZERO CLAMP: if drag would have pushed pSpeed
 *  past zero (from positive into negative), snap to zero
 *  instead. Prevents the lateral drag from spinning the car
 *  backward at the end of a slow drift.
 *
 *  INPUTS:
 *    pSpeed       current scalar speed (post-projection from
 *                 [[reprojectPSpeed]])
 *    pVx, pVy     world-frame velocity (from
 *                 [[updateHeadingAndRecompose]])
 *    pAngle       updated chassis heading
 *    pDrifting    drift state flag
 *    isThrottle   gas held this frame
 *    dt           frame timestep (s)
 *
 *  Returns the new pSpeed.
 *
 *  Ported 1:1 from monolith L26163-L26187 (step 15 head — the
 *  pSpeed bleed half of the lateral-velocity drag block). */
export function applyLateralVelocityDrag(
  pSpeed: number,
  pVx: number,
  pVy: number,
  pAngle: number,
  pDrifting: boolean,
  isThrottle: boolean,
  dt: number,
): number {
  const vlat = -pVx * Math.sin(pAngle) + pVy * Math.cos(pAngle);
  const vlatMag = Math.abs(vlat);
  const driftMult = pDrifting
    ? (isThrottle ? LAT_DRAG_DRIFT_THROTTLE : LAT_DRAG_DRIFT_OFF_THROTTLE)
    : 1.0;
  const latDrag = vlatMag * vlatMag * LAT_DRAG_COEFF * driftMult;
  const dragDelta = latDrag * dt;
  let newPSpeed = pSpeed - Math.sign(pSpeed || 1) * dragDelta;
  if (newPSpeed < 0 && Math.abs(newPSpeed) < dragDelta) newPSpeed = 0;
  return newPSpeed;
}

/** Post-integration v_lat damping rate (1/s) when the LIVE ebrk
 *  input is held. 0.3 ↔ slide-pull feel; full v_lat preservation
 *  as designed for handbrake drifts. The lowest tier — keeps
 *  sideways momentum intact through the e-brake window.
 *
 *  Matches monolith `0.3` (ebrk branch) at L26238. */
export const VLAT_POSTDAMP_EBRAKE_ACTIVE = 0.3;

/** Post-integration v_lat damping rate (1/s) during drift state
 *  WITHOUT active ebrk input. v8.99.124.04 introduced this
 *  middle tier — drifts can develop to ~30° slip steady state,
 *  but v_lat decays fast enough that it cannot orbit with
 *  pYawRate. Counter-flicks have authority.
 *
 *  Matches monolith `0.8` (drift branch) at L26238. */
export const VLAT_POSTDAMP_DRIFT = 0.8;

/** Post-integration v_lat damping rate (1/s) in the grip state.
 *  5.0 ↔ aggressive damping kills any accidental slip and keeps
 *  straight-line tracking tight. The default for normal driving.
 *
 *  Matches monolith `5.0` (grip branch) at L26238. */
export const VLAT_POSTDAMP_GRIP = 5.0;

/** Damp the body-frame lateral velocity and recompose into
 *  world-frame velocity. Step 15 tail of the Phase 0B integrator.
 *
 *  FORMULA (1:1 with monolith):
 *    vlat       = -pVx × sin(pAngle) + pVy × cos(pAngle)
 *    postDamp   = ebrk ? 0.3 : (pDrifting ? 0.8 : 5.0)
 *    vlatDamped = vlat × max(0, 1 - postDamp × dt)
 *    pVx        = cos(pAngle) × projLong - sin(pAngle) × vlatDamped
 *    pVy        = sin(pAngle) × projLong + cos(pAngle) × vlatDamped
 *
 *  THREE-TIER DAMPING (v8.99.124.04):
 *  - Active ebrk: 0.3/s — slide-pull feel, full v_lat
 *    preservation
 *  - Drift, no active ebrk: 0.8/s — drifts develop to ~30 °
 *    steady state, v_lat can't orbit with pYawRate
 *  - Grip: 5.0/s — straight-line tracking unchanged
 *
 *  WHY THE LIVE ebrk INPUT (NOT pEbrakeTimer): pre-v8.99.124.04
 *  gate was `pDrifting || pEbrakeTimer > 0` which routed the
 *  throttle-sustain pEbrakeTimer refresh (auto-bumped to 0.4
 *  every frame during gas-held drift) into the slide-feel
 *  damping. Combined with mu_R collapse from the same
 *  throttle-sustain, v_lat formed a stable orbit with pYawRate
 *  via the kinematic coupling — donuts didn't decay, and
 *  counter-flicks during forward drifts had no authority. The
 *  live `ebrk` input now decides the slide-pull regime; the
 *  pEbrakeTimer still collapses mu_R (drift feel) but damping
 *  no longer follows it.
 *
 *  WHY THIS RUNS AFTER reprojectPSpeed: the world-frame
 *  recompose uses `projLong` (the longitudinal projection
 *  computed inside [[reprojectPSpeed]]). This step takes the
 *  already-updated pSpeed-driven longitudinal and combines with
 *  the damped lateral to produce the final world-frame velocity
 *  for the next integrator pass.
 *
 *  v8.99.81 BUG HISTORY: pre-v8.99.81, this damping pass looked
 *  only at pDrifting. During an ebrake pull BEFORE slip reached
 *  the drift-enter threshold, the 5.0/s grip-state damping
 *  annihilated v_lat every frame — 50× stronger than step 8's
 *  ebrake-gated 0.1/s. The coupling term built ~260 gu/s² of
 *  v_lat at v_long=200, yaw=1.3, but that's ~4 gu/s per frame,
 *  which 5.0/s damping killed (91 % surviving per frame). Slip
 *  never exceeded the drift threshold, pDrifting stayed false,
 *  damping stayed at 5.0/s → self-reinforcing perfect-circle
 *  spin. The ebrake gate let slip build naturally through the
 *  0.75 s rear-μ collapse window, drift state engages, and the
 *  coupling term finally does what v8.99.53 intended.
 *
 *  v8.99.124.02 noted in monolith: REVERTED slip-aware damping
 *  reduction from v8.99.124.00. Kept as a docstring trail.
 *
 *  INPUTS:
 *    pVx, pVy     world-frame velocity from
 *                 [[updateHeadingAndRecompose]]
 *    pAngle       updated chassis heading
 *    projLong     longitudinal projection from
 *                 [[reprojectPSpeed]] (computed inside it as
 *                 `pVx × cos(pAngle) + pVy × sin(pAngle)`;
 *                 caller passes the same value here for
 *                 consistency)
 *    pDrifting    drift flag (post-classification from
 *                 [[classifyDriftState]])
 *    ebrkActive   LIVE ebrk input flag
 *    dt           frame timestep (s)
 *
 *  Returns the recomposed {pVx, pVy} with damped lateral.
 *
 *  Ported 1:1 from monolith L26238-L26241 (step 15 tail — the
 *  three-tier v_lat damping + world-frame recompose). */
export function dampLateralVelocityAndRecompose(
  pVx: number,
  pVy: number,
  pAngle: number,
  projLong: number,
  pDrifting: boolean,
  ebrkActive: boolean,
  dt: number,
): WorldVelocity {
  const cosA = Math.cos(pAngle);
  const sinA = Math.sin(pAngle);
  const vlat = -pVx * sinA + pVy * cosA;
  const postDamp = ebrkActive
    ? VLAT_POSTDAMP_EBRAKE_ACTIVE
    : pDrifting
      ? VLAT_POSTDAMP_DRIFT
      : VLAT_POSTDAMP_GRIP;
  const vlatDamped = vlat * Math.max(0, 1 - postDamp * dt);
  return {
    pVx: cosA * projLong - sinA * vlatDamped,
    pVy: sinA * projLong + cosA * vlatDamped,
  };
}

export function classifyDriftState(
  slipF: number,
  slipR: number,
  pDrifting: boolean,
  pPostDriftTimer: number,
  absSpd: number,
  worldSpd: number,
  pEbrakeTimer: number,
  driftEnterThresh: number,
): DriftStateResult {
  if (absSpd <= DRIFT_SPEED_GATE && worldSpd <= DRIFT_SPEED_GATE) {
    return { pDrifting: false, pPostDriftTimer };
  }
  const slipMax = Math.max(Math.abs(slipF), Math.abs(slipR));
  const ebrakeActive = pEbrakeTimer > 0;
  if (pDrifting) {
    if (slipMax < DRIFT_EXIT_THRESH && !ebrakeActive) {
      return { pDrifting: false, pPostDriftTimer: DRIFT_POST_RECOVERY };
    }
    return { pDrifting: true, pPostDriftTimer };
  }
  if (ebrakeActive) {
    return { pDrifting: true, pPostDriftTimer };
  }
  if (slipMax > driftEnterThresh && pPostDriftTimer <= 0) {
    return { pDrifting: true, pPostDriftTimer };
  }
  return { pDrifting: false, pPostDriftTimer };
}

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
