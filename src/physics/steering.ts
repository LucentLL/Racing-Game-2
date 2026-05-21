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

/** Alignment-pull coefficient. Real misaligned wheels (toe-out,
 *  bad camber, broken track rod) pull ~1-3°/sec at highway speed;
 *  v8.99.13 retuned from 0.30 to 0.10 because the pre-retune value
 *  drove the car in a circle into a ditch within seconds — felt
 *  more like a stuck steering wheel than a real alignment fault.
 *  The 0.10 coefficient gives ~0.85°/sec, which matches the
 *  driver-felt magnitude of a typical 1-degree toe misalignment.
 *
 *  Matches monolith `* 0.10` at L24786. */
export const ALIGNMENT_PULL_COEFFICIENT = 0.10;

/** Speed (game units) below which alignment pull is suppressed.
 *  Without this gate, a parked car would slowly veer one way as
 *  the player held the wheel straight — visually wrong (a parked
 *  car with misaligned wheels just sits there). Matches monolith
 *  `absSpd > 3` at L24786. */
const ALIGNMENT_PULL_SPEED_GATE = 3;

/** Apply alignment-pull additive offset to a steering rate. The
 *  `pull` is the per-frame signed pull magnitude from fxFault.steerPull
 *  (positive = veers right in Y-down canvas, negative = left, zero =
 *  no alignment fault active).
 *
 *  Scales with `spdFactor` (a 0..1 speed-ramp the caller already
 *  computes for other effects) so the pull is most pronounced at
 *  highway speed where misaligned wheels generate the most lateral
 *  force, weaker at city speed where the effect is felt-but-
 *  manageable.
 *
 *  Pass-through (returns steeringRate unchanged) when:
 *    - pull is exactly 0 (no alignment fault active)
 *    - absSpd ≤ ALIGNMENT_PULL_SPEED_GATE (3 game units, ~stopped)
 *
 *  Additive, not multiplicative — alignment pull is an
 *  offset-from-straight, not a steering-amplifier. The driver
 *  must hold counter-steer to stay straight; correcting the pull
 *  is what makes alignment-fault driving feel "tiring."
 *
 *  Ported 1:1 from monolith L24786 (the alignment-pull line at the
 *  end of the steering fault block). */
export function applyAlignmentPull(
  steeringRate: number,
  pull: number,
  spdFactor: number,
  absSpd: number,
): number {
  if (pull === 0) return steeringRate;
  if (absSpd <= ALIGNMENT_PULL_SPEED_GATE) return steeringRate;
  return steeringRate + pull * spdFactor * ALIGNMENT_PULL_COEFFICIENT;
}

/** Speed (mph) at which the power-steering-loss effect fully
 *  releases. Below 25 mph the assist is missed; at 25+ the rolling
 *  tires + caster self-align make steering light regardless of
 *  pump assist, so the fault contributes nothing.
 *
 *  Matches monolith `_psMph / 25` in all three duplicated PS-loss
 *  blocks (L24770-L24772, L24778-L24780, L25994-L25997). */
export const POWER_STEERING_FAULT_RELIEF_MPH = 25;

/** Peak steering reduction at 0 mph. A power-steering-loss fault
 *  (ps_leak, hose burst) or engine stall reduces effective
 *  steering rate to 40 % at parking-lot speed — heavy wheel,
 *  "armstrong steering". Real PS systems lose ~60 % of effort
 *  reduction when the pump dies; this is a 1:1 match for that
 *  driver-felt magnitude.
 *
 *  Matches monolith `1 - 0.60 * _psLo` in all three duplicates. */
export const POWER_STEERING_FAULT_MAX_REDUCTION = 0.60;

/** Apply speed-scaled power-steering-loss multiplier to a steering
 *  rate. Returns the modified rate.
 *
 *  CURVE (linear ramp):
 *    0 mph   → × 0.40   heaviest (parking lot)
 *    12 mph  → × 0.70
 *    25 mph  → × 1.00   no effect (highway)
 *    25+ mph → × 1.00
 *
 *  WHY SPEED-SCALED: real power-steering systems assist most at low
 *  speed because that's when tire scrub is highest. Above ~25 mph,
 *  steering effort becomes light regardless of assist (rolling
 *  tires + caster self-align). Pre-v8.99.13 code applied a flat
 *  0.7× everywhere, which was backwards — felt like the steering
 *  was hardest on the highway. The speed ramp inverts that to
 *  match reality.
 *
 *  Caller composes this with either pAngVel (legacy steering path)
 *  or pYawRate (0B kinematic-bicycle path) depending on which
 *  steering variable is in scope. Both call sites in the monolith
 *  apply the SAME ramp — extracted here so the formula has one
 *  source of truth.
 *
 *  ALSO USED FOR ENGINE STALL — when the engine dies, the PS pump
 *  loses pressure and the wheel goes heavy on the same curve.
 *  Caller passes any condition (fault flag OR engine-stall flag)
 *  and the same multiplier applies.
 *
 *  `scaleMs` is the wpx/sec ↔ m/s conversion (4.864) so absSpd in
 *  game units maps to real mph via `absSpd / scaleMs * 2.237`.
 *  Injected to keep this module agnostic of where the canonical
 *  constant lives.
 *
 *  Ported 1:1 from monolith L24769-L24781 + L25994-L26003 (the
 *  three duplicated PS-loss blocks across steering paths). */
export function applyPowerSteeringFault(
  steeringRate: number,
  absSpd: number,
  scaleMs: number,
): number {
  const mph = absSpd / scaleMs * 2.237;
  const lo = Math.max(0, 1 - mph / POWER_STEERING_FAULT_RELIEF_MPH);
  return steeringRate * (1 - POWER_STEERING_FAULT_MAX_REDUCTION * lo);
}

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
