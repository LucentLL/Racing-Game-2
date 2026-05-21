/**
 * Drivetrain-specific steering multipliers — pure functions applied
 * to baseSteer (the kinematic-bicycle desired-yaw-rate) per frame.
 *
 *   applyPowerOversteer   — on-throttle, FR/MR steer UP, FF/4WD DOWN
 *   applyTrailBrakeRotation — off-throttle braking ROTATES into corner
 *
 * Both are state-free transforms: take baseSteer + context scalars
 * + drivetrain enum, return modified baseSteer. The caller's
 * steering pipeline multiplies them in sequence so the effects
 * compose naturally (a player who lifts off throttle mid-corner and
 * trail-brakes gets the loss-of-power-rotation effect immediately,
 * before the trail-brake rotation effect adds back its own
 * contribution).
 *
 * Monolith source: inside update() at L24721-L24755 (the steering
 * block's RWD/FWD/AWD/Mid-engine branches).
 */

/** Drivetrain enum — matches the monolith's `cc.drivetrain` field.
 *
 *   'FR'  Front engine, rear-wheel drive. Classic muscle car, sports
 *         car. Power oversteers UP (rotates more into turn).
 *   'MR'  Mid engine, rear-wheel drive. Sports car, supercar (Lotus
 *         Exige, Ferrari 458). Snappier oversteer than FR — rear-
 *         biased weight rotates faster.
 *   'RR'  Rear engine, rear-wheel drive. Porsche 911. Pendulum
 *         dynamics, particularly on lift-off / brake. (Not currently
 *         in the power-oversteer table — falls through to FR's
 *         calibration.)
 *   'FF'  Front engine, front-wheel drive. Most economy cars.
 *         Power understeers (front tires saturated → pushes wide).
 *   '4WD' All-wheel drive. Subaru, Audi. Slight understeer bias,
 *         very stable. */
export type Drivetrain = 'FR' | 'MR' | 'RR' | 'FF' | '4WD';

/** Apply on-throttle drivetrain rotation. RWD cars get power
 *  OVERSTEER (rear pushes out → more rotation into turn); FWD/AWD
 *  get UNDERSTEER (front saturated → pushes wide).
 *
 *  Gates on throttle (`isThrottle`) AND meaningful steering input
 *  (`|steerInput| > 0.1`) — at very small steering inputs the
 *  drivetrain-rotation contribution is rounding noise relative to
 *  the baseSteer itself. Below the gate, returns baseSteer
 *  unchanged.
 *
 *  Effect scales with `throttleFactor = speedRatio * |steerInput|`:
 *  full effect at 1.0 (top speed + full lock), zero at 0 (parked or
 *  straight wheel). speedRatio is `|pSpeed| / topSpeed` — caller
 *  clamps to [0, 1] before passing in.
 *
 *  Drivetrain table (peak multipliers at throttleFactor = 1):
 *    FR    × 1.35  (35 % more rotation — RWD power oversteer)
 *    MR    × 1.45  (45 % — mid-engine rear weight rotates faster)
 *    FF    × 0.65  (35 % LESS — front saturated, pushes wide)
 *    4WD   × 0.88  (12 % less — AWD understeer bias, very stable)
 *    RR    pass-through (not in monolith's switch; defensive)
 *
 *  Ported 1:1 from monolith L24721-L24736 (the power-oversteer
 *  branch in update()'s steering block). */
export function applyPowerOversteer(
  baseSteer: number,
  drivetrain: Drivetrain,
  speedRatio: number,
  steerInput: number,
  isThrottle: boolean,
): number {
  if (!isThrottle) return baseSteer;
  if (Math.abs(steerInput) <= 0.1) return baseSteer;
  const throttleFactor = speedRatio * Math.abs(steerInput);
  switch (drivetrain) {
    case 'FR':  return baseSteer * (1 + throttleFactor * 0.35);
    case 'MR':  return baseSteer * (1 + throttleFactor * 0.45);
    case 'FF':  return baseSteer * (1 - throttleFactor * 0.35);
    case '4WD': return baseSteer * (1 - throttleFactor * 0.12);
    default:    return baseSteer;
  }
}

/** Apply off-throttle trail-brake rotation (v8.98.51). Braking
 *  while turning shifts weight forward → front tires bite → rear
 *  lightens → car rotates into the corner.
 *
 *  Before v8.98.51, brake input had ZERO effect on steering (only
 *  on speed), so mid-corner brake taps produced no rotation —
 *  unnatural, and made corner-entry trail-braking impossible.
 *
 *  Gates (ALL required):
 *    - brake held
 *    - gas NOT held
 *    - |steerInput| > 0.1
 *    - |pSpeed| > 5 (game units)
 *
 *  Below any gate, returns baseSteer unchanged.
 *
 *  Effect scales with brake amount, steering input, and a
 *  speed-clamped factor:
 *    brakeFactor = brakeAmount * |steerInput| * clamp(speedRatio + 0.3, 0, 1)
 *
 *  The +0.3 floor on speedRatio means the trail-brake effect
 *  still fires meaningfully even at low speed — a car at 30% of
 *  topSpeed gets ~60% of the rotation a car at 70% would. Below
 *  the speed gate (5 wpx/sec) the whole effect cuts.
 *
 *  Drivetrain table (peak multipliers at brakeFactor = 1):
 *    FR    × 1.50  (RWD trail-brakes well — rear lightens easily)
 *    MR    × 1.60  (mid-engine pivots best — rear weight bias)
 *    RR    × 1.55  (rear-engine pendulum — heavy rear, big lift)
 *    FF    × 1.25  (front-heavy resists — less rotation gained)
 *    4WD   × 1.30  (stable but less rotational)
 *    (any) × 1.35  (default fallthrough — unknown drivetrain)
 *
 *  Ported 1:1 from monolith L24738-L24755 (the trail-brake-rotation
 *  branch in update()'s steering block). */
export function applyTrailBrakeRotation(
  baseSteer: number,
  drivetrain: Drivetrain,
  brakeAmount: number,
  steerInput: number,
  speedRatio: number,
  absSpd: number,
  gas: boolean,
  brake: boolean,
): number {
  if (!brake || gas) return baseSteer;
  if (Math.abs(steerInput) <= 0.1) return baseSteer;
  if (absSpd <= 5) return baseSteer;
  const brakeFactor = brakeAmount * Math.abs(steerInput) * Math.min(1, speedRatio + 0.3);
  let trailMult: number;
  switch (drivetrain) {
    case 'FR':  trailMult = 1.0 + brakeFactor * 0.50; break;
    case 'MR':  trailMult = 1.0 + brakeFactor * 0.60; break;
    case 'RR':  trailMult = 1.0 + brakeFactor * 0.55; break;
    case 'FF':  trailMult = 1.0 + brakeFactor * 0.25; break;
    case '4WD': trailMult = 1.0 + brakeFactor * 0.30; break;
    default:    trailMult = 1.0 + brakeFactor * 0.35; break;
  }
  return baseSteer * trailMult;
}
