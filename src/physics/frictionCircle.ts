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

/** Compute the remaining lateral-force budget for one axle after
 *  the longitudinal forces have been allocated:
 *
 *    F_lat_budget = sqrt(F_circle² - F_long²)
 *
 *  PHYSICAL MEANING: the friction circle has total radius
 *  F_circle. After F_long has used up some of that radius for
 *  drive/brake demand, the remaining LATERAL room is the
 *  pythagorean complement — the side of a right triangle where
 *  the hypotenuse is F_circle and one leg is F_long.
 *
 *  CONSEQUENCES:
 *  - At F_long = 0:        F_lat_budget = F_circle (full
 *                          cornering grip; no drive/brake)
 *  - At F_long = F_circle: F_lat_budget = 0       (no cornering
 *                          grip; all budget consumed)
 *  - At F_long ≈ F_circle/2: F_lat_budget ≈ 0.87 × F_circle
 *                          (87 % — still most of it; the trade-
 *                          off is non-linear)
 *
 *  WHY THE max(0, ...) GUARD: in normal flow F_long is already
 *  clamped to ≤ F_long_cap ≤ F_circle, so F_circle² - F_long²
 *  is non-negative. The guard defends against numerical
 *  weirdness (rounding errors at the cap boundary, or callers
 *  passing pre-clamp values).
 *
 *  WHY APPLIED PER-AXLE (caller calls twice): front and rear
 *  have independent friction circles (different μ, different
 *  Fz) and independent F_long allocations. Their lateral
 *  budgets are computed separately and fed into the per-axle
 *  lateral force clamp.
 *
 *  INPUTS:
 *    F_circle    full friction-circle radius for the axle
 *                (mu × Fz, from [[computeFrictionCircle]])
 *    F_long      post-clamp longitudinal force for the axle
 *                (from [[clampLongitudinalForces]])
 *
 *  Returns the lateral budget (≥ 0).
 *
 *  Ported 1:1 from monolith L25776-L25777 (the per-axle
 *  pythagorean lateral-budget pair). */
export function computeLateralBudget(
  F_circle: number,
  F_long: number,
): number {
  return Math.sqrt(Math.max(0, F_circle * F_circle - F_long * F_long));
}

/** Per-axle lateral force tuple returned by
 *  [[clampLateralForces]]. */
export interface AxleLateralForces {
  F_lat_F: number;
  F_lat_R: number;
}

/** Clamp the requested per-axle lateral forces to within
 *  ±F_lat_budget. The lateral budgets are computed AFTER
 *  longitudinal allocation by [[computeLateralBudget]], so
 *  whatever lateral force the tire could in theory generate
 *  (from slip × C_α via the Pacejka curve in tire.ts) is now
 *  bounded by the remaining friction-circle headroom.
 *
 *  FORMULA (1:1 with monolith):
 *    F_lat_F = clamp(F_lat_F_req, ±F_lat_budget_F)
 *    F_lat_R = clamp(F_lat_R_req, ±F_lat_budget_R)
 *
 *  SYMMETRIC CLAMP: a positive budget clamps both positive and
 *  negative requests to ±budget. The lateral force direction is
 *  determined by slip angle sign; the magnitude is capped by
 *  available grip.
 *
 *  WHEN THE CLAMP BITES: under aggressive throttle or braking
 *  combined with hard cornering, F_lat_budget shrinks toward
 *  zero (drive/brake demand has consumed the friction circle).
 *  The lateral tire force the slip angle would naturally
 *  generate (often ≫ budget at high slip) gets capped to what
 *  the circle can deliver. This is the friction-circle effect
 *  in action — drivers feel "the more you accelerate, the less
 *  the car turns" as a real physical limit, not a gameplay
 *  hack.
 *
 *  RELATIONSHIP TO TIRE.TS lateralTireForce: lateralTireForce
 *  produces the REQUESTED magnitude from the Pacejka-style slip
 *  curve. This function imposes the friction-circle envelope
 *  on top. The min-of-the-two (the natural curve vs the circle
 *  envelope) is what hits the chassis — matching real-tire
 *  behavior where the contact patch sees min(demand,
 *  available).
 *
 *  Returns {F_lat_F, F_lat_R}. Pure function.
 *
 *  Ported 1:1 from monolith L25779-L25784 (the per-axle
 *  symmetric lateral clamp block). */
export function clampLateralForces(
  F_lat_F_req: number,
  F_lat_R_req: number,
  F_lat_budget_F: number,
  F_lat_budget_R: number,
): AxleLateralForces {
  let F_lat_F = F_lat_F_req;
  let F_lat_R = F_lat_R_req;
  if (F_lat_F >  F_lat_budget_F) F_lat_F =  F_lat_budget_F;
  if (F_lat_F < -F_lat_budget_F) F_lat_F = -F_lat_budget_F;
  if (F_lat_R >  F_lat_budget_R) F_lat_R =  F_lat_budget_R;
  if (F_lat_R < -F_lat_budget_R) F_lat_R = -F_lat_budget_R;
  return { F_lat_F, F_lat_R };
}
