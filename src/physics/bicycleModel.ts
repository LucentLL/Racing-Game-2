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
