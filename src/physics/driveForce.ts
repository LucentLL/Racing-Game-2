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
