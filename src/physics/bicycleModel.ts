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
