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

import type { Drivetrain } from './steering';

/** FF (front-wheel drive) base tractive-demand coefficient. The
 *  front axle's grip budget is the limit anyway, so the demand
 *  is set lower than RWD configurations to leave lateral grip
 *  headroom — "Civics couldn't turn" with peak demand at >1.0×
 *  grip (v8.52 backed off the v8.51 high-demand numbers). The
 *  power-boost multiplier on FF is also reduced (×0.4) since
 *  more boost would re-saturate the front grip.
 *
 *  Matches monolith `drivetrainCoef = 0.45 + powBoost*0.4`
 *  at L25554. */
export const DRIVETRAIN_COEF_FF_BASE = 0.45;
export const DRIVETRAIN_COEF_FF_POWBOOST_MULT = 0.4;

/** FR (front-engine RWD) base tractive-demand coefficient. The
 *  classic muscle / sports car layout — rear-wheel drive with
 *  forward weight bias. 0.60 base + full power-boost lets
 *  high-output FR (Viper, Mustang Cobra) saturate rear grip at
 *  launch.
 *
 *  Matches monolith `drivetrainCoef = 0.60 + powBoost` at
 *  L25555. */
export const DRIVETRAIN_COEF_FR_BASE = 0.60;

/** MR (mid-engine RWD) base tractive-demand coefficient. Higher
 *  than FR because the rear-biased weight distribution puts more
 *  load on the driven axle, allowing more torque to reach the
 *  road before spinning. 0.68 base + full power-boost.
 *
 *  Matches monolith `drivetrainCoef = 0.68 + powBoost` at
 *  L25556. */
export const DRIVETRAIN_COEF_MR_BASE = 0.68;

/** RR (rear-engine RWD) base tractive-demand coefficient.
 *  Highest base — most of the chassis weight sits over the
 *  driven axle (Porsche 911 archetype), so the most torque can
 *  hit the road. 0.72 base + full power-boost.
 *
 *  Matches monolith `drivetrainCoef = 0.72 + powBoost` at
 *  L25557. */
export const DRIVETRAIN_COEF_RR_BASE = 0.72;

/** 4WD base tractive-demand coefficient. Split across 4 contact
 *  patches, so each tire sees less of the load — paradoxically
 *  the COMBINED demand should reflect the lower per-tire share,
 *  which (after the per-axle split) ends up at a lower base
 *  than RWD configurations. 0.50 base + 0.6 × power-boost.
 *
 *  Matches monolith `drivetrainCoef = 0.50 + powBoost*0.6` at
 *  L25558. */
export const DRIVETRAIN_COEF_4WD_BASE = 0.50;
export const DRIVETRAIN_COEF_4WD_POWBOOST_MULT = 0.6;

/** Compute the drivetrain-specific tractive-demand coefficient
 *  with HP/kg power boost applied. Each drivetrain has its own
 *  base + a multiplier on the power boost
 *  ([[computePowerToWeightBoost]]).
 *
 *  TABLE (1:1 with monolith):
 *    FF     →  0.45 + powBoost × 0.4
 *    FR     →  0.60 + powBoost × 1.0
 *    MR     →  0.68 + powBoost × 1.0
 *    RR     →  0.72 + powBoost × 1.0
 *    4WD    →  0.50 + powBoost × 0.6
 *    (other)→  1.0  (defensive fallthrough; should be
 *                    unreachable for valid Drivetrain values)
 *
 *  v8.53 BACK-OFF: lowered from v8.51's 0.95-1.10 RWD numbers.
 *  On mobile where gasAmount is binary 0/1 (no feathering),
 *  the v8.52 values meant full gas saturated the rear friction
 *  circle at any RPM, triggering the wheelspin-yaw-boost every
 *  frame even going straight — "RWD breaks loose at any gas
 *  input." Now peak demand at full gas + peak RPM + low speed
 *  reaches ~65-75 % of grip, leaving headroom for straight-line
 *  throttle. Drift entry comes from compound saturation:
 *  ebrake (collapses rear μ) + throttle (eats remaining rear
 *  budget) + steering → yaw-boost fires.
 *
 *  WHY THE PER-DRIVETRAIN POWBOOST MULT VARIES: FF gets reduced
 *  (×0.4) because the front-grip limit binds anyway; 4WD gets
 *  intermediate (×0.6) because the four-patch split halves the
 *  effective rear demand; RWD configurations get full (×1.0)
 *  power-boost contribution.
 *
 *  INPUTS:
 *    drivetrain   chassis drivetrain enum
 *    powBoost     from [[computePowerToWeightBoost]]
 *
 *  Returns the demand coefficient. Caller multiplies into the
 *  F_drive composition (with torqueNorm, gasAmount, mass×g,
 *  tractionMult, gearRatioMult).
 *
 *  Ported 1:1 from monolith L25553-L25558 (the drivetrainCoef
 *  table in the longitudinal-force block). */
export function computeDrivetrainCoef(
  drivetrain: Drivetrain,
  powBoost: number,
): number {
  switch (drivetrain) {
    case 'FF':  return DRIVETRAIN_COEF_FF_BASE  + powBoost * DRIVETRAIN_COEF_FF_POWBOOST_MULT;
    case 'FR':  return DRIVETRAIN_COEF_FR_BASE  + powBoost;
    case 'MR':  return DRIVETRAIN_COEF_MR_BASE  + powBoost;
    case 'RR':  return DRIVETRAIN_COEF_RR_BASE  + powBoost;
    case '4WD': return DRIVETRAIN_COEF_4WD_BASE + powBoost * DRIVETRAIN_COEF_4WD_POWBOOST_MULT;
    default:    return 1.0;
  }
}

/** Compute the v8.98.56 gear-ratio multiplier on drive force.
 *  torqueNorm is engine torque; actual WHEEL torque depends on
 *  the current gear ratio. gearSpeeds[N] is inversely
 *  proportional to gear ratio, so:
 *
 *    gearRatioMult = gearSpeeds[1] / gearSpeeds[pGear]
 *
 *  approximates "current gear's wheel torque relative to first
 *  gear's wheel torque."
 *
 *  TYPICAL VALUES (1:1 with monolith):
 *    Gear 1:  1.0×   (unchanged — launch wheelspin tuning preserved)
 *    Gear 3:  ~0.38× (5-speed typical) — S14 no longer
 *                    phantom-wheelspins
 *    Gear 5:  ~0.20× — high-gear cruise has plenty of grip
 *                    headroom
 *
 *  WHY THIS WAS NEEDED (v8.98.56 fix): pre-v8.98.56, drive
 *  force scaled with peak engine torque regardless of gear,
 *  which meant high-RPM 3rd-gear acceleration produced the
 *  same friction-circle demand as 1st-gear launches. The S14
 *  (and similar mid-power RWD) would phantom-wheelspin under
 *  light throttle at highway speed — visually wrong and
 *  triggering the wheelspin-yaw-boost when no real wheelspin
 *  was happening.
 *
 *  GUARDS (all required for non-1.0 return):
 *  - gearSpeeds array exists
 *  - pGear >= 1                  (not in reverse; reverse pGear=0
 *                                 would divide-by-zero on
 *                                 gearSpeeds[0])
 *  - gearSpeeds[pGear] > 0
 *  - gearSpeeds[1] > 0
 *  Any failure returns 1.0 (no scaling).
 *
 *  REVERSE INTENTIONALLY EXCLUDED: in reverse the rev-limiter
 *  and combined-slip mechanics handle drive-force limiting via
 *  different paths — the gear-ratio multiplier would be
 *  meaningless against the negative gearSpeeds[0] anyway.
 *
 *  INPUTS:
 *    gearSpeeds   cc.gearSpeeds — array indexed by gear, each
 *                 entry being the speed at which auto-shift
 *                 would up-shift from that gear; undefined OK
 *    pGear        current selected gear (0 = reverse, 1..N =
 *                 forward gears)
 *
 *  Returns the wheel-torque-ratio multiplier; 1.0 when in
 *  reverse, in 1st gear, or when data is missing.
 *
 *  Ported 1:1 from monolith L25566-L25569 (the gear-ratio
 *  multiplier block in the longitudinal-force composition). */
export function computeGearRatioMult(
  gearSpeeds: readonly number[] | undefined,
  pGear: number,
): number {
  if (!gearSpeeds) return 1.0;
  if (pGear < 1) return 1.0;
  if (!(gearSpeeds[pGear] > 0)) return 1.0;
  if (!(gearSpeeds[1] > 0)) return 1.0;
  return gearSpeeds[1] / gearSpeeds[pGear];
}
