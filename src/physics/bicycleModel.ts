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
