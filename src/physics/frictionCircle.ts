/**
 * Per-axle friction-circle physics. The friction circle is the
 * 2D limit on combined longitudinal + lateral force a tire can
 * exert: F_long² + F_lat² ≤ (μ × Fz)². Any combination inside
 * the circle is achievable; anything outside has to be clamped
 * to the boundary, with the demand-side (driver intent) deciding
 * which direction gets prioritized.
 *
 * The integrator's ordering:
 *   1. Compute F_circle = μ × Fz (the circle's radius)
 *   2. Apply combined-slip reduction to the LONGITUDINAL cap
 *      (v8.99.124.06): at high lateral slip, the tire can deliver
 *      less longitudinal force, leaving more headroom in the
 *      lateral budget.
 *   3. Clamp F_long to ±F_long_cap.
 *   4. Compute remaining lateral budget: sqrt(F_circle² - F_long²)
 *   5. Clamp F_lat to ±lateral budget.
 *
 * This module covers steps 1-2 in this hop; subsequent hops add
 * the clamp + lateral-budget steps.
 *
 * Monolith source: inside update() at L25692-L25784.
 */

import { combinedSlipFactor } from './tire';

/** Per-axle friction-circle radii + combined-slip-reduced
 *  longitudinal caps from [[computeFrictionCircle]]. The full
 *  F_circle is preserved as well as the slip-reduced F_long_cap
 *  because wheelspin detection (downstream) compares the
 *  REQUESTED F_long against the FULL circle, not the cap. */
export interface FrictionCircleData {
  /** Full friction-circle radius for the front axle: mu_F × Fz_F.
   *  This is "all the grip available" — both longitudinal and
   *  lateral demand collectively share this budget. */
  F_circle_F: number;
  /** Full friction-circle radius for the rear axle. */
  F_circle_R: number;
  /** Combined-slip-reduced longitudinal cap for the front axle
   *  (v8.99.124.06). At low slip, F_long_cap_F = F_circle_F;
   *  at higher slip, the cap shrinks toward 0.3 × F_circle_F. */
  F_long_cap_F: number;
  /** Combined-slip-reduced longitudinal cap for the rear axle. */
  F_long_cap_R: number;
}

/** Compute the friction-circle data for both axles, including
 *  the v8.99.124.06 combined-slip capacity reduction on the
 *  longitudinal force.
 *
 *  FORMULA (1:1 with monolith):
 *    F_circle_F   = mu_F × Fz_F
 *    F_circle_R   = mu_R × Fz_R
 *    F_long_cap_F = F_circle_F × combinedSlipFactor(|slipF|)
 *    F_long_cap_R = F_circle_R × combinedSlipFactor(|slipR|)
 *
 *  Where `combinedSlipFactor` (already in tire.ts) returns 1.0
 *  for slip ≤ peak (linear region) and ramps down to 0.3 at π/2
 *  (full sideways).
 *
 *  v8.99.124.06 BACKGROUND (combined-slip capacity reduction):
 *  User feedback was a high-speed donut on grass at 190 km/h
 *  in 5th gear — counter-flick had no effect, releasing the
 *  wheel for 10 s kept the car circling left. Tracing the force
 *  balance with held throttle:
 *
 *    1) Drivetrain demanded high F_long_R (wheelspin demand)
 *    2) Friction circle clamped F_long_R = F_circle_R (full
 *       saturation)
 *    3) F_lat_budget_R = √(F_circle_R² - F_long_R²) = 0
 *    4) Rear axle had ZERO lateral authority — couldn't push
 *       back
 *    5) Only F_lat_F at front provided yaw torque
 *    6) As body rotated, v_lat shifted, slipF oscillated ±,
 *       F_lat_F flipped between +13.1 and -13.1 (clamped)
 *    7) Net torque averaged ≈ 0 → pYawRate persisted with
 *       delta = 0
 *    8) Donut self-sustained until throttle release
 *
 *  Real tires don't behave this way. When the contact patch is
 *  sliding sideways at deep slip angles, the friction available
 *  for LONGITUDINAL traction drops along with lateral — Pacejka
 *  combined-slip. Without this, our model let the rear consume
 *  100 % of the friction circle for drive force at any slip
 *  angle, leaving zero for restoration.
 *
 *  FIX: reduce the friction-circle CAPACITY for longitudinal
 *  force when there's lateral slip. The full friction circle
 *  (F_circle_R) is still available — but only a fraction can
 *  be put into longitudinal at high lat slip; the remainder
 *  flows naturally into the lateral budget via the existing
 *  sqrt(F_circle² - F_long²) formula.
 *
 *  Below peak slip: full F_long capacity. Past peak: capacity
 *  drops linearly toward 30 % at π/2. At 60° slip the rear can
 *  only deliver ~56 % × F_circle_R longitudinally, leaving the
 *  remaining budget available for lateral restoring force.
 *
 *  GAMEPLAY IMPLICATION: held throttle in a deep drift no longer
 *  locks the rear at zero lat. Counter-flicks bite. Released
 *  wheel decays. Player still has full F_long when straight
 *  (slip < peak) — burnouts and acceleration unaffected. The
 *  penalty only kicks in once the tire is actually sliding
 *  sideways, matching real-tire behavior.
 *
 *  SYMMETRIC ON FRONT: F_long_F also gets the reduction —
 *  front wheelspin during burnouts on FWD/AWD also cedes
 *  longitudinal capacity at high front slip. Less common but
 *  physically consistent.
 *
 *  INPUTS:
 *    mu_F, mu_R     per-axle peak friction coefficients (from
 *                   tireCoefficients.ts pipeline)
 *    Fz_F, Fz_R     per-axle normal loads (from chassisFrame.ts
 *                   + weightTransfer.ts)
 *    slipF, slipR   per-axle slip angles (from
 *                   [[computeSlipAngles]] in bicycleModel.ts)
 *
 *  Ported 1:1 from monolith L25693 + L25739-L25745 (the friction-
 *  circle radius and the combined-slip-factored longitudinal
 *  cap pair). */
export function computeFrictionCircle(
  mu_F: number,
  mu_R: number,
  Fz_F: number,
  Fz_R: number,
  slipF: number,
  slipR: number,
): FrictionCircleData {
  const F_circle_F = mu_F * Fz_F;
  const F_circle_R = mu_R * Fz_R;
  return {
    F_circle_F,
    F_circle_R,
    F_long_cap_F: F_circle_F * combinedSlipFactor(Math.abs(slipF)),
    F_long_cap_R: F_circle_R * combinedSlipFactor(Math.abs(slipR)),
  };
}

/** Per-axle longitudinal force tuple — re-exported with the same
 *  shape as driveForce.ts's AxleLongitudinalForces for the
 *  clamp-pipeline functions in this module. */
export interface AxleLongitudinalForces {
  F_long_F: number;
  F_long_R: number;
}

/** Clamp the requested per-axle longitudinal forces to within
 *  ±F_long_cap (the combined-slip-reduced friction-circle
 *  longitudinal budget).
 *
 *  FORMULA (1:1 with monolith):
 *    F_long_F = clamp(F_long_F, ±F_long_cap_F)
 *    F_long_R = clamp(F_long_R, ±F_long_cap_R)
 *
 *  SYMMETRIC CLAMP: a positive cap clamps both positive (drive)
 *  and negative (brake) requests to ±cap. The lateral-slip-
 *  induced cap reduction therefore limits both acceleration AND
 *  braking authority equally during a deep slide — matches the
 *  physics (a sliding contact patch can't generate either drive
 *  or brake force at full grip).
 *
 *  WHY THIS RUNS BEFORE LATERAL CLAMPING: the longitudinal
 *  budget gets first-priority allocation from the friction
 *  circle. Whatever's left (sqrt(F_circle² - F_long²)) becomes
 *  the lateral budget for [[clampLateralForces]] downstream.
 *  This priority ordering matches real-tire behavior — drivers
 *  feel "drive demand eats grip budget for cornering," which
 *  is what motivates the friction-circle abstraction.
 *
 *  Returns the clamped forces. Pure function. Caller preserves
 *  the pre-clamp values separately if needed for wheelspin
 *  detection (which compares the REQUESTED F_long against the
 *  FULL F_circle, not the post-clamp value).
 *
 *  Ported 1:1 from monolith L25751-L25754 (the four-line per-
 *  axle longitudinal clamp). */
export function clampLongitudinalForces(
  forces: AxleLongitudinalForces,
  F_long_cap_F: number,
  F_long_cap_R: number,
): AxleLongitudinalForces {
  let F_long_F = forces.F_long_F;
  let F_long_R = forces.F_long_R;
  if (F_long_F >  F_long_cap_F) F_long_F =  F_long_cap_F;
  if (F_long_F < -F_long_cap_F) F_long_F = -F_long_cap_F;
  if (F_long_R >  F_long_cap_R) F_long_R =  F_long_cap_R;
  if (F_long_R < -F_long_cap_R) F_long_R = -F_long_cap_R;
  return { F_long_F, F_long_R };
}
