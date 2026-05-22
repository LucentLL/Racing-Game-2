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

/** Base steering sensitivity scalar for cars. Multiplied on top of
 *  the user-facing slider value (0.5–2.0 centered at 1.0) so the
 *  default 1.0 slider becomes 0.55× actual steering. Slider at 0.5
 *  → 0.275× physics; slider at 2.0 → 1.10× physics.
 *
 *  v8.98.54 bumped this from 0.50 to 0.55 for "a bit more arcade
 *  responsiveness" per user feedback. v8.98.53 had previously
 *  raised it from 0.40 to 0.50 after the v8.98.52 high-speed
 *  damping cut left mid-to-high-speed turning "still dead."
 *
 *  Matches monolith `const STEER_SENS_BASE = 0.55` at L24678. */
export const STEER_SENS_BASE = 0.55;

/** Base steering sensitivity scalar for bikes. Half the raw slider
 *  value — v8.54 retuned from 1.0 (v8.45 full-raw) because
 *  full-raw made sport bikes too twitchy. With 0.5, the default 1.0
 *  slider gives bikes 0.5× physics response.
 *
 *  Bikes are otherwise tuned via their own lean-based steering
 *  chain (leanRate smoothing + bikeLeanDamp + bikeHSF high-speed
 *  damping) — the per-class base sens lets the same slider be
 *  used across bike/car without one feeling wrong relative to the
 *  other.
 *
 *  Matches monolith `const BIKE_STEER_SENS_BASE = 0.5` at L24679. */
export const BIKE_STEER_SENS_BASE = 0.5;

/** Compute the per-frame effective steering input. Combines:
 *
 *    raw steerInput  × user sensitivity slider × body-type base
 *
 *  Steer-sens slider is per-input-method: touch users get their
 *  own slider, keyboard/gamepad users share the other. Caller
 *  picks the right one (touchSens vs padSens) by passing
 *  whichever applies. Both default to 1.0 — pass that when no
 *  user setting is stored, or pass 1.0 directly.
 *
 *  Bikes bypass the car STEER_SENS_BASE; their entire steering
 *  chain (lean smoothing → turn rate from lean → high-speed
 *  damping) is calibrated against BIKE_STEER_SENS_BASE so applying
 *  the car base on top would compound to ~30 % of the bike's
 *  intended response.
 *
 *  Raw `steerInput` (the pre-multiplier value) is preserved by the
 *  caller for UI feedback — the steering-wheel HUD shows raw
 *  position, not the post-sensitivity scaled value.
 *
 *  Ported 1:1 from monolith L24678-L24685 (the STEER_SENS_BASE
 *  block at the top of the steering branch). */
export function computeEffectiveSteerInput(
  steerInput: number,
  isBike: boolean,
  sensSlider: number,
): number {
  const base = isBike ? BIKE_STEER_SENS_BASE : STEER_SENS_BASE;
  return steerInput * sensSlider * base;
}

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

/** Drift-state steering gain. Multiplied onto steerInputEff at the
 *  head of the drift branch — drifting cars respond MORE to stick
 *  input than gripping cars (because the rear is already loose,
 *  the front can pivot the car aggressively). The 2.2× is what
 *  makes drift feel "snappy" instead of "vague."
 *
 *  Matches monolith `steerInputEff*2.2` at L24691. */
export const DRIFT_STEER_GAIN = 2.2;

/** Drift-state speed-penalty coefficient. The driver-felt
 *  effectiveness of stick input drops with speed:
 *
 *    driftSpeedPenalty = 1 / (1 + speedRatio × 1.5)
 *
 *    speedRatio = 0.00  →  × 1.00   parking-lot drift, full bite
 *    speedRatio = 0.33  →  × 0.67
 *    speedRatio = 0.67  →  × 0.50
 *    speedRatio = 1.00  →  × 0.40   top-speed drift, 60 % damped
 *
 *  WHY HYPERBOLIC (not quadratic like the grip branch): in a real
 *  drift the slip-angle physics are doing most of the rotation —
 *  player input is a smaller correction on top, and that
 *  correction's authority falls off faster than the grip case
 *  because rear slip is already saturating the rotation budget.
 *
 *  Matches monolith `1/(1+speedRatio*1.5)` at L24690. */
export const DRIFT_SPEED_PENALTY_COEFF = 1.5;

/** Drift-state slip-force base coefficient. The "auto-rotation"
 *  contribution to yaw rate scales as:
 *
 *    slipForce = sin(slipAngle) × (1.2 + speedRatio × 1.2) × massDamp
 *
 *  At parking-lot speed the slip-force is 1.2 × sin(slipAngle);
 *  at top speed it doubles to 2.4 × sin(slipAngle). Faster drifts
 *  generate proportionally more "the rear wants to keep coming
 *  around" rotation — exactly the feel of a real big drift, where
 *  catching the slide gets harder the faster you're going.
 *
 *  Both `1.2` magnitudes are tied (same constant, applied twice in
 *  `(a + speedRatio*a)` form) — keeping them named together
 *  preserves that coupling. Matches monolith
 *  `(1.2+speedRatio*1.2)` at L24693. */
export const DRIFT_SLIP_FORCE_COEFF = 1.2;

/** Compute the drift-state per-frame angular velocity (pAngVel).
 *  This is the drift-state counterpart of [[computeGripBaseSteer]] —
 *  it sits at the head of the drift branch and OWNS the entire
 *  pAngVel value, replacing both the baseSteer formula and the
 *  drivetrain modifiers (drivetrain effects don't apply during a
 *  drift — the car's already past the grip limit).
 *
 *  TWO ADDITIVE COMPONENTS:
 *    driftSteer = steerInputEff × 2.2 × spdFactor × penalty × massDamp
 *    slipForce  = sin(slipAngle) × (1.2 + speedRatio × 1.2) × massDamp
 *    pAngVel    = driftSteer + slipForce
 *
 *  where `penalty = 1 / (1 + speedRatio × 1.5)` (see
 *  [[DRIFT_SPEED_PENALTY_COEFF]]).
 *
 *  WHY ADDITIVE (not multiplicative): driftSteer is what the
 *  driver can DO; slipForce is what's HAPPENING regardless. They
 *  combine so the player can either fight the rotation (counter-
 *  steer) or amplify it (steer into the slide) — multiplying them
 *  would couple inputs in a way that doesn't match real drift
 *  dynamics.
 *
 *  INPUTS:
 *    steerInputEff   post-sensitivity steering input (from
 *                    [[computeEffectiveSteerInput]])
 *    slipAngle       current chassis-vs-velocity angle (radians,
 *                    signed — positive = rear sliding one way)
 *    speedRatio      |pSpeed| / topSpeed, pre-clamped to [0, 1]
 *    spdFactor       0..1 speed ramp the caller computes for
 *                    several effects
 *    massDamp        chassis-mass damping scalar — applied to
 *                    BOTH terms so heavier cars are uniformly less
 *                    rotational in a drift
 *
 *  Note that the bike `bikeLeanPos *= 0.9` decay at L24688 is NOT
 *  part of this function — it's a separate state mutation handled
 *  by the caller (drift state decays the visual lean toward zero
 *  because bikes don't lean during a slide, they sit upright).
 *
 *  Ported 1:1 from monolith L24689-L24694 (the drift-state branch
 *  of update()'s steering block, excluding the bike-lean decay). */
export function computeDriftPAngVel(
  steerInputEff: number,
  slipAngle: number,
  speedRatio: number,
  spdFactor: number,
  massDamp: number,
): number {
  const driftSpeedPenalty = 1 / (1 + speedRatio * DRIFT_SPEED_PENALTY_COEFF);
  const driftSteer = steerInputEff * DRIFT_STEER_GAIN * spdFactor * driftSpeedPenalty * massDamp;
  const slipForce = Math.sin(slipAngle) * (DRIFT_SLIP_FORCE_COEFF + speedRatio * DRIFT_SLIP_FORCE_COEFF) * massDamp;
  return driftSteer + slipForce;
}

/** Quadratic-in-speed damping coefficient for car grip steering.
 *  baseSteer is multiplied by `(1 - speedRatio² × 0.25)`, giving:
 *
 *    speedRatio = 0.00  →  × 1.00   parking-lot speed, full response
 *    speedRatio = 0.50  →  × 0.94
 *    speedRatio = 0.75  →  × 0.86
 *    speedRatio = 1.00  →  × 0.75   top speed, 25 % damped
 *
 *  WHY QUADRATIC: linear speed-damping felt mushy in the midband
 *  (a 25 % cut at top speed becomes a 12 % cut at half — overshoots
 *  the "still responsive" zone). Quadratic keeps low-speed turning
 *  fully alive and only really bites in the upper third where
 *  high-speed twitchiness would otherwise hurt stability.
 *
 *  v8.98.52 retuned from 0.38 to 0.25 after user feedback that the
 *  car still felt like a "cargo ship at speed" with 0.38. Bikes
 *  have a parallel but more aggressive coefficient (0.40) baked
 *  into their own steering chain — kept separate so the two body
 *  types can be tuned independently.
 *
 *  Matches monolith `highSpeedFactor=1-speedRatio*speedRatio*0.25`
 *  at L24701. */
export const GRIP_HSF_QUAD_COEFF = 0.25;

/** Grass steering multiplier — front tires have less grip on grass,
 *  steering response drops to 50 %. Front-axle effect only (rear-
 *  grass yaw damping is handled elsewhere). Matches monolith
 *  `baseSteer*=0.5` at L24716. */
export const GRASS_STEER_MULT = 0.5;

/** Trailer steering multiplier — pulling a trailer reduces turn
 *  rate to 65 %, giving the longer combo a wider turning radius
 *  even before the trailer's own kinematics push back through the
 *  hitch. Matches monolith `baseSteer*=0.65` at L24718. */
export const TRAILER_STEER_MULT = 0.65;

/** Compute the grip-state baseSteer for cars. This is the value the
 *  drivetrain modifiers ([[applyPowerOversteer]] /
 *  [[applyTrailBrakeRotation]]) and the fault layer
 *  ([[applyPowerSteeringFault]] / [[applyAlignmentPull]]) operate
 *  on — it's the head of the grip-state steering pipeline.
 *
 *  FORMULA:
 *    baseSteer = steerInputEff × turnRate × spdFactor × hsf × massDamp
 *    if onGrass:    baseSteer × GRASS_STEER_MULT   (0.50)
 *    if hasTrailer: baseSteer × TRAILER_STEER_MULT (0.65)
 *
 *  where `hsf = 1 - speedRatio² × GRIP_HSF_QUAD_COEFF` (quadratic
 *  high-speed damping; see [[GRIP_HSF_QUAD_COEFF]]).
 *
 *  INPUTS:
 *    steerInputEff   post-sensitivity steering input (from
 *                    [[computeEffectiveSteerInput]])
 *    turnRate        per-car maximum yaw rate (CAR().turnRate)
 *    spdFactor       0..1 speed ramp the caller computes for
 *                    several effects (suppresses steering at very
 *                    low speed)
 *    speedRatio      |pSpeed| / topSpeed, pre-clamped to [0, 1]
 *    massDamp        chassis-mass damping scalar (heavier cars
 *                    resist input)
 *    onGrass         true if player's surface is grass
 *    hasTrailer      true if a trailer is hitched
 *
 *  Bike path is NOT this function — bikes go through their own
 *  lean→turn chain (BIKE_STEER_SENS_BASE, leanRate smoothing,
 *  bikeHSF damping) and bypass turnRate entirely as an "amplifier"
 *  of stick input.
 *
 *  Ported 1:1 from monolith L24714-L24718 (the grip-state head of
 *  update()'s car steering branch). */
export function computeGripBaseSteer(
  steerInputEff: number,
  turnRate: number,
  spdFactor: number,
  speedRatio: number,
  massDamp: number,
  onGrass: boolean,
  hasTrailer: boolean,
): number {
  const highSpeedFactor = 1 - speedRatio * speedRatio * GRIP_HSF_QUAD_COEFF;
  let baseSteer = steerInputEff * turnRate * spdFactor * highSpeedFactor * massDamp;
  if (onGrass) baseSteer *= GRASS_STEER_MULT;
  if (hasTrailer) baseSteer *= TRAILER_STEER_MULT;
  return baseSteer;
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
