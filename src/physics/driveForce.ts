/**
 * Per-axle longitudinal drive-force pipeline. Composes engine
 * torque (normalized via the torque curve and possibly boosted
 * by Phase 9 supercharger mod) with drivetrain-specific demand
 * coefficients, gear-ratio scaling, and a manual-transmission
 * rev limiter, then splits the resulting F_drive across axles
 * based on drivetrain layout.
 *
 * Sits between the engine-torque-curve lookup (torqueCurve.ts's
 * getTorqueAtRPM) and the friction-circle clamp downstream —
 * produces the F_long_F / F_long_R values that will be eaten
 * into the friction-circle budget and combined-slip-factored
 * before final lateral-force evaluation.
 *
 * Monolith source: inside update() at L25497-L25620 (the
 * isThrottle branch of the Phase 0B integrator's longitudinal-
 * force block, plus the brake branch at L25621-L25629).
 */

/** Phase 9 supercharger sweet-spot boost magnitude. Below 60 %
 *  RPM, the torque-curve multiplier is exactly 1.30 (+30 %) —
 *  where NA engines feel weak compared to forced induction.
 *  Tapers down to +15 % at redline as airflow limits bite.
 *
 *  Matches monolith `1.30` at L25531. */
export const SUPERCHARGER_BOOST_PEAK = 1.30;

/** Phase 9 supercharger high-RPM taper magnitude. Above 60 %
 *  RPM, boost linearly drops by this amount across the
 *  remaining 40 % of the RPM range. At redline:
 *    boost = 1.30 - 0.15 × 1.0 = 1.15  (+15 %)
 *
 *  Matches monolith `0.15` at L25531. */
export const SUPERCHARGER_TAPER_MAGNITUDE = 0.15;

/** RPM-fraction threshold above which the supercharger boost
 *  starts tapering. Below this, full peak boost (1.30) applies;
 *  above, it drops linearly toward redline.
 *
 *  Matches monolith `0.6` at L25531. */
export const SUPERCHARGER_TAPER_START = 0.6;

/** Apply Phase 9 (v8.63) supercharger torque multiplier. The
 *  Roots-style blower model: belt-driven forced induction with
 *  flat low/mid-RPM boost, tapering at redline where airflow
 *  limits bite.
 *
 *  TORQUE MULTIPLIER BY RPM FRACTION:
 *    0 - 60 % RPM:   × 1.30   (peak boost — sweet spot where
 *                              NA engines feel weak)
 *    60 - 100 % RPM: tapers from × 1.30 down to × 1.15
 *                              (high-RPM airflow fall-off)
 *
 *  FORMULA (1:1 with monolith):
 *    rpmFrac = clamp((rpm - idle) / (redline - idle), 0, 1)
 *    boost   = 1.30 - 0.15 × max(0, (rpmFrac - 0.6) / 0.4)
 *    return torqueNorm × boost
 *
 *  ELIGIBILITY (caller's responsibility — this function only
 *  applies the boost when called):
 *  - LIFE.supercharged                  (player has the mod
 *                                        installed)
 *  - cc.gt4.canSC === 1                 (per-car eligibility;
 *                                        46/366 cars qualify —
 *                                        mostly classic muscle,
 *                                        NA V8 Corvettes, NA
 *                                        luxury sedans; turbo
 *                                        cars excluded since
 *                                        they already have
 *                                        forced induction)
 *  - gameplaySettings.supercharger !==
 *    false                              (console-flippable A/B
 *                                        without uninstalling)
 *
 *  WHY ROOTS CHARACTER (not centrifugal): Roots-style blowers
 *  produce instant low-RPM boost (the helix displaces a fixed
 *  air volume per revolution); centrifugal compressors need
 *  RPM to build pressure. The flat low-RPM + taper-at-redline
 *  shape matches the Roots character that fits the classic
 *  muscle/NA-V8 archetypes in the eligibility list.
 *
 *  INPUTS:
 *    torqueNorm   normalized torque (0..1+) from
 *                 [[getTorqueAtRPM]]; the supercharger pushes
 *                 it above 1.0
 *    pRPM         current engine RPM
 *    idleRPM      cc.idleRPM
 *    redline      cc.redline
 *
 *  Returns the boosted torqueNorm. Caller composes with
 *  power/drivetrain/gear scalars to get F_drive.
 *
 *  Ported 1:1 from monolith L25528-L25533 (the Phase 9
 *  supercharger torque-boost block). */
export function applySuperchargerBoost(
  torqueNorm: number,
  pRPM: number,
  idleRPM: number,
  redline: number,
): number {
  const rpmFrac = Math.max(0, Math.min(1, (pRPM - idleRPM) / (redline - idleRPM)));
  const taperT = Math.max(0, (rpmFrac - SUPERCHARGER_TAPER_START) / (1 - SUPERCHARGER_TAPER_START));
  const boost = SUPERCHARGER_BOOST_PEAK - SUPERCHARGER_TAPER_MAGNITUDE * taperT;
  return torqueNorm * boost;
}

/** Default horsepower when cc.hp is missing. 200 hp is a
 *  midrange road-car archetype that produces sensible boost=0
 *  for the power-to-weight formula.
 *
 *  Matches monolith fallback `cc.hp || 200` at L25551. */
export const POWER_BOOST_DEFAULT_HP = 200;

/** Power-to-weight ratio (hp/kg) below which the boost is zero.
 *  0.15 hp/kg ≈ 200 hp at 1300 kg — typical economy/midrange
 *  car. Above this threshold, the boost linearly ramps up.
 *
 *  Matches monolith `_hpPerKg - 0.15` at L25552. */
export const POWER_BOOST_HP_KG_THRESHOLD = 0.15;

/** Slope of the power-to-weight boost per unit of hp/kg above
 *  threshold. 1.5 means a hp/kg of 0.25 (Viper-class) yields
 *  (0.25 - 0.15) × 1.5 = 0.15 boost. At 0.33 hp/kg (supercar)
 *  the formula hits the ceiling at 0.30.
 *
 *  Matches monolith `* 1.5` at L25552. */
export const POWER_BOOST_SLOPE = 1.5;

/** Maximum power-to-weight boost magnitude. Capped at +0.30 so
 *  even the most extreme supercars (Veyron 0.42 hp/kg, LMR
 *  0.50+) get the same maximum drivetrain authority. This
 *  keeps the highest-output cars from spinning indefinitely at
 *  launch.
 *
 *  Matches monolith `Math.min(0.30, ...)` at L25552. */
export const POWER_BOOST_MAX = 0.30;

/** Compute the power-to-weight (hp/kg) boost to drivetrain
 *  torque demand. The boost is ~0 for economy/midrange cars
 *  and ramps up to +30 % for supercar-class power densities.
 *
 *  v8.98.35 added this so a 450 hp Viper at 1560 kg (0.29 hp/kg)
 *  actually exceeds rear grip in first gear on dry pavement —
 *  before this, the v8.53 drivetrain coefficients left ~65-75 %
 *  grip headroom (fine for a Civic, but unrealistic for any
 *  high-output RWD).
 *
 *  FORMULA (1:1 with monolith):
 *    hpPerKg = (cc.hp || 200) / max(400, cc.mass || 1200)
 *    boost   = min(0.30, max(0, (hpPerKg - 0.15) × 1.5))
 *
 *  CALIBRATION POINTS:
 *    0.10 hp/kg (economy):           boost = 0    (no change)
 *    0.15 hp/kg (midrange):          boost = 0    (threshold)
 *    0.20 hp/kg (sport):             boost = 0.075
 *    0.25 hp/kg (sports car):        boost = 0.15
 *    0.29 hp/kg (Viper):             boost = 0.21
 *    0.33 hp/kg (supercar):          boost = 0.27
 *    0.35+ hp/kg (extreme):          boost = 0.30 (capped)
 *
 *  COMPOSES WITH DRIVETRAIN COEFFICIENT (next hop): the boost
 *  scales differently per drivetrain because the rear-grip
 *  budget that gets eaten is different per drivetrain. FF cars
 *  multiply boost by 0.4 (front-limited grip anyway), 4WD by
 *  0.6 (split across 4 patches), RWD/MR/RR get the full boost.
 *
 *  WHY 200 / 1200 / 400 FALLBACKS: missing data shouldn't blow
 *  up the formula. Defaults produce sensible midrange-car
 *  values that yield boost = 0.
 *
 *  INPUTS:
 *    carHp        cc.hp — chassis horsepower; undefined → 200
 *    carMass      cc.mass — chassis mass (kg); undefined → 1200,
 *                 floored at 400 (matches
 *                 [[sanitizeChassisMass]] semantics)
 *
 *  Returns the boost magnitude in [0, 0.30].
 *
 *  Ported 1:1 from monolith L25551-L25552 (the powBoost block at
 *  the head of the drivetrain-coefficient computation). */
export function computePowerToWeightBoost(
  carHp: number | undefined,
  carMass: number | undefined,
): number {
  const hp = carHp || POWER_BOOST_DEFAULT_HP;
  const mass = Math.max(400, carMass || 1200);
  const hpPerKg = hp / mass;
  return Math.min(POWER_BOOST_MAX, Math.max(0, (hpPerKg - POWER_BOOST_HP_KG_THRESHOLD) * POWER_BOOST_SLOPE));
}
