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

/** Reference chassis mass (kg) for the rotational-inertia damping
 *  factor. Cars at this mass get massDamp = 1.0 (no penalty); ones
 *  above lose authority, ones below gain it. 1200 kg is roughly a
 *  mid-size compact (Honda Civic, mid-90s) — pre-tuned to feel
 *  "neutral" relative to the catalog's lineup.
 *
 *  Matches monolith `Math.sqrt(1200/...)` at L24167. */
export const MASS_DAMP_REF_KG = 1200;

/** Minimum effective mass (kg) for the massDamp denominator. Cars
 *  lighter than this (rare — sport bikes are typically 200-300 kg,
 *  but those go through the bike chain, not this one) get clamped
 *  to 800 kg so the sqrt doesn't produce unbounded amplification.
 *  An 800 kg car gets sqrt(1200/800) ≈ 1.22× the rotational
 *  authority of the reference 1200 kg car.
 *
 *  Matches monolith `Math.max(800, ...)` at L24167. */
export const MASS_DAMP_MIN_KG = 800;

/** Mass threshold (kg) above which the heavy-vehicle massDamp floor
 *  engages. The semi (8165 kg) and box truck (6580 kg) would
 *  otherwise get sqrt(1200/8165) ≈ 0.38 and ≈ 0.43 — but those
 *  vehicles ALREADY have their chassis inertia baked into per-car
 *  turnRate (long wheelbase → smaller wbFactor) and yawInertia
 *  (long chassisL → divisor in turnR). Multiplying massDamp on top
 *  double-counts the rotational mass and paralyzes steering even
 *  at moderate speed. The floor lets the chassis-derived damping
 *  carry the load and limits massDamp to a modest extra penalty.
 *
 *  Matches monolith `CAR().mass>=3000` at L24178. */
export const MASS_DAMP_HEAVY_THRESHOLD_KG = 3000;

/** Floor value for the heavy-vehicle massDamp clamp (vehicles
 *  ≥ [[MASS_DAMP_HEAVY_THRESHOLD_KG]]). 0.70 was tuned to keep the
 *  semi and box-truck steerable at full stick without the chassis-
 *  inertia double-count paralysis. Cars stay below the threshold
 *  (all ≤ 2200 kg in the catalog) and are unaffected.
 *
 *  Matches monolith `Math.max(massDamp, 0.70)` at L24178. */
export const MASS_DAMP_HEAVY_FLOOR = 0.70;

/** Base trailer mass (kg) — empty trailer weight before load. A
 *  bare flatbed / unloaded tanker. Matches monolith `4500` at
 *  L24181. */
export const MASS_DAMP_TRAILER_BASE_KG = 4500;

/** Max load mass (kg) — multiplied by loadWeight (0..1) to scale
 *  the trailer's mass between empty (just BASE) and fully loaded
 *  (BASE + LOAD_MAX_KG). A fully-loaded tanker ↔ 4500 + 16000 =
 *  20500 kg ≈ the legal limit for a US single-trailer rig.
 *
 *  Matches monolith `16000` at L24182. */
export const MASS_DAMP_TRAILER_LOAD_MAX_KG = 16000;

/** Trailer rotational-inertia coupling fraction. Only 60 % of the
 *  trailer's mass couples into the cab's rotational inertia — the
 *  hitch is a single articulation point, and the trailer's CG is
 *  far behind the cab, so the trailer's tail doesn't resist cab
 *  yaw as much as its bulk would suggest. 0.6 was tuned to match
 *  the felt sluggishness of a loaded semi vs an empty one.
 *
 *  Matches monolith `trailerKg*0.6` at L24183. */
export const MASS_DAMP_TRAILER_COUPLING = 0.6;

/** Compute the chassis rotational-inertia damping scalar (massDamp)
 *  — the factor that scales every steering input by the chassis's
 *  rotational inertia. Heavier cars resist yaw input; lighter ones
 *  rotate eagerly.
 *
 *  THREE-STAGE PIPELINE (1:1 with monolith):
 *    1. Base:           sqrt(REF_KG / max(MIN_KG, chassisMass))
 *    2. Heavy floor:    if chassisMass ≥ 3000 kg, clamp to ≥ 0.70
 *    3. Trailer mult:   if trailerLoadWeight !== null:
 *                         trailerKg = 4500 + loadWeight × 16000
 *                         massDamp ×= sqrt(chassisMass /
 *                           max(1, chassisMass + trailerKg × 0.6))
 *
 *  WHY SQRT (not linear): rotational inertia scales with mass, but
 *  ANGULAR ACCELERATION scales as 1/I. Reducing the linear ratio
 *  through a square-root produces the "felt" inertia response — a
 *  4× heavier car feels 2× slower to rotate, not 4× slower. Cuts
 *  the high-end penalty so heavy cars are still drivable, not
 *  paralyzed.
 *
 *  WHY THE TRAILER COUPLING IS SQRT-WRAPPED: the inner ratio
 *  `chassisMass / (chassisMass + trailerKg × 0.6)` produces the
 *  "effective inertia fraction" the cab can still actuate. Taking
 *  the sqrt of THAT (then multiplying onto the base massDamp) mirrors
 *  the same physical curve as the chassis-only path — a doubling
 *  of trailer mass produces √2 × the damping penalty, not 2×.
 *
 *  WHY THE HEAVY FLOOR (v8.99.122.12): semi/box-truck/tow-truck
 *  chassis already encode their length in turnRate (per-vehicle
 *  CAR().turnRate is small for long vehicles via wbFactor) and in
 *  yawInertia (large chassisL → larger divisor in turn rate). Without
 *  the floor, multiplying their tiny massDamp (~0.38) on top of
 *  their already-small turnRate produced ~9°/s yaw at full stick
 *  even at moderate speed — paralyzed steering. The floor caps the
 *  per-mass penalty so the chassis-derived damping carries the load.
 *
 *  INPUTS:
 *    chassisMass         CAR().mass — bare-chassis mass in kg
 *    trailerLoadWeight   LIFE.trailer && (LIFE.trailer.loadWeight ?? 0.6),
 *                        OR null when no trailer is hitched. The 0.6
 *                        default mirrors the monolith's
 *                        `LIFE.trailer.loadWeight || 0.6` fallback
 *                        at L24182 — caller is responsible for
 *                        applying that default when handing in the
 *                        value.
 *
 *  Returns the chassis massDamp scalar in (0, 1]. Pure function.
 *
 *  Ported 1:1 from monolith L24167-L24184 (the massDamp computation
 *  at the head of the steering block). */
export function computeMassDamp(
  chassisMass: number,
  trailerLoadWeight: number | null,
): number {
  let massDamp = Math.sqrt(
    MASS_DAMP_REF_KG / Math.max(MASS_DAMP_MIN_KG, chassisMass),
  );
  if (chassisMass >= MASS_DAMP_HEAVY_THRESHOLD_KG) {
    massDamp = Math.max(massDamp, MASS_DAMP_HEAVY_FLOOR);
  }
  if (trailerLoadWeight !== null) {
    const trailerKg = MASS_DAMP_TRAILER_BASE_KG
                    + trailerLoadWeight * MASS_DAMP_TRAILER_LOAD_MAX_KG;
    massDamp *= Math.sqrt(
      chassisMass / Math.max(1, chassisMass + trailerKg * MASS_DAMP_TRAILER_COUPLING),
    );
  }
  return massDamp;
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

// ───────────────────────────────────────────────────────────────────
// Bike steering chain (MotoGP-style: stick controls lean, lean
// controls turn). Bikes bypass turnRate-as-direct-yaw and instead
// route stick input through a smoothed lean state, then derive the
// per-frame angular velocity from current lean magnitude. Three
// stages: lean target damping → lean smoothing tick → turn-from-lean.
// ───────────────────────────────────────────────────────────────────

/** Bike lean-target high-speed damping coefficient. Stick input
 *  scales the LEAN TARGET (not the turn rate directly), and that
 *  target is itself reduced at high speed to prevent twitchy lean
 *  inputs:
 *
 *    bikeLeanDamp = 1 - speedRatio² × 0.45
 *
 *    speedRatio = 0.00  →  × 1.00   parking lot, full lean target
 *    speedRatio = 0.50  →  × 0.89
 *    speedRatio = 0.75  →  × 0.75
 *    speedRatio = 1.00  →  × 0.55   top speed, 45 % damped target
 *
 *  WHY MORE AGGRESSIVE THAN CARS (0.45 vs 0.25): real bikes are
 *  much more lean-sensitive at high speed — a 30°-lean input that
 *  feels balanced at 30 mph would high-side a rider at 120 mph.
 *  The damping caps the lean angle the stick can request, so the
 *  player can't accidentally over-lean past the bike's stability
 *  envelope.
 *
 *  Matches monolith `bikeLeanDamp=1-speedRatio*speedRatio*0.45` at
 *  L24705. */
export const BIKE_LEAN_DAMP_QUAD_COEFF = 0.45;

/** Bike lean-target gain. Full stick (steerInputEff = 1.0, after
 *  BIKE_STEER_SENS_BASE applied) requests a target lean position of
 *  4.0 units. Combined with the high-speed damping, peak achievable
 *  lean is 4.0 at parking-lot speed and 2.2 at top speed.
 *
 *  Lean "units" here are an internal scalar — they're divided by
 *  this same value in the turn-from-lean stage (leanNorm =
 *  bikeLeanPos / 4.0) so the absolute magnitude of the scale
 *  cancels out. What matters is that the target and the
 *  normalization use the SAME constant.
 *
 *  Matches monolith `steerInputEff*4.0` at L24706. */
export const BIKE_LEAN_MAX = 4.0;

/** Bike lean smoothing rate, in inverse seconds. The lean state is
 *  driven toward the target at:
 *
 *    bikeLeanPos += (leanTarget - bikeLeanPos) × 3.5 × dt
 *
 *  At dt = 1/60s that's about 5.8 %/frame, so reaching ~95 % of a
 *  step-input target takes ~50 frames (~0.85s) — enough to feel
 *  like the bike is "rolling" into the lean rather than snapping
 *  to a stick position, but fast enough that the lean tracks
 *  trail-braking corner-entry adjustments.
 *
 *  This rate is intentionally NOT the same as a generic input
 *  smoothing — it's a model of physical lean dynamics (the rider
 *  has to shift weight, the bike has to roll, the tires have to
 *  build slip angle), and the value was tuned together with
 *  BIKE_STEER_SENS_BASE so the two reach the right joint feel.
 *
 *  Matches monolith `const leanRate=3.5` at L24707. */
export const BIKE_LEAN_SMOOTHING_RATE = 3.5;

/** Advance the bike's smoothed lean state by one tick. The returned
 *  bikeLeanPos drives [[computeBikePAngVel]] (the next stage in the
 *  bike chain) — see that function for the lean→turn relationship.
 *
 *  TARGET: stick input × BIKE_LEAN_MAX, damped by speed
 *    leanTarget = steerInputEff × 4.0 × (1 - speedRatio² × 0.45)
 *
 *  SMOOTHING: exponential approach toward the target
 *    bikeLeanPos += (leanTarget - bikeLeanPos) × 3.5 × dt
 *
 *  PURE FUNCTION: takes the current bikeLeanPos plus inputs,
 *  returns the new bikeLeanPos. Caller is responsible for storing
 *  it back into the bike's persistent state for next frame.
 *
 *  Two related bike-state mutations are NOT in this function and
 *  are handled separately by the caller:
 *    - `bikeLeanPos *= 0.9` during a drift (L24688) — the visual
 *      lean decays toward zero because bikes sit upright in a
 *      slide.
 *    - Lean-position clamping (if any) at the bike-physics
 *      boundary.
 *
 *  Caller should call this only when the bike is in the grip
 *  state (the drift branch owns its own lean handling).
 *
 *  Ported 1:1 from monolith L24705-L24708 (the bike-only lean
 *  smoothing block of update()'s grip-state steering branch). */
export function tickBikeLean(
  bikeLeanPos: number,
  steerInputEff: number,
  speedRatio: number,
  dt: number,
): number {
  const bikeLeanDamp = 1 - speedRatio * speedRatio * BIKE_LEAN_DAMP_QUAD_COEFF;
  const leanTarget = steerInputEff * BIKE_LEAN_MAX * bikeLeanDamp;
  return bikeLeanPos + (leanTarget - bikeLeanPos) * BIKE_LEAN_SMOOTHING_RATE * dt;
}

/** Bike turn-from-lean exponent. The lean magnitude is normalized
 *  to [0, 1] then raised to this exponent before being applied
 *  as the yaw-rate scalar:
 *
 *    turnFromLean = sign(leanNorm) × |leanNorm|^1.3
 *
 *    leanNorm = 0.25  →  × 0.17   small lean, gentle turn
 *    leanNorm = 0.50  →  × 0.41
 *    leanNorm = 0.75  →  × 0.69
 *    leanNorm = 1.00  →  × 1.00   full lean, full turn
 *
 *  WHY > 1 (vs linear): a slight bike lean shouldn't produce a
 *  proportional turn — real bikes need MORE lean than the linear
 *  amount before they really start carving. The 1.3 exponent
 *  models this "lean threshold" feel without introducing a hard
 *  deadband (which would feel mushy at the centre).
 *
 *  Sign-preserved via `Math.sign() × pow(abs(), 1.3)` so the curve
 *  is symmetric around zero (a left lean produces a mirror-
 *  symmetric right-lean response).
 *
 *  Matches monolith `Math.pow(Math.abs(leanNorm),1.3)` at
 *  L24710. */
export const BIKE_LEAN_TURN_EXPONENT = 1.3;

/** Bike high-speed yaw damping coefficient (the bike-side
 *  counterpart of [[GRIP_HSF_QUAD_COEFF]]). Final yaw rate is
 *  multiplied by `(1 - speedRatio² × 0.40)`, giving:
 *
 *    speedRatio = 0.00  →  × 1.00   parking lot, full response
 *    speedRatio = 0.50  →  × 0.90
 *    speedRatio = 0.75  →  × 0.78
 *    speedRatio = 1.00  →  × 0.60   top speed, 40 % damped
 *
 *  WHY MORE THAN CARS (0.40 vs 0.25): bikes have a smaller
 *  contact patch, less rotational inertia, and (importantly) the
 *  player has already paid a 0.45-coefficient damping cost on the
 *  LEAN TARGET stage (BIKE_LEAN_DAMP_QUAD_COEFF). The 0.40 yaw
 *  damping on top compounds with that, giving a deeply damped but
 *  still controllable bike at top speed where over-input would
 *  otherwise high-side.
 *
 *  Matches monolith `bikeHSF=1-speedRatio*speedRatio*0.40` at
 *  L24711. */
export const BIKE_HSF_QUAD_COEFF = 0.40;

/** Compute the bike-state per-frame angular velocity from the
 *  smoothed lean state. This is stage 2 of the bike steering
 *  chain — operates on the `bikeLeanPos` advanced by
 *  [[tickBikeLean]] and replaces the entire car-grip baseSteer
 *  formula ([[computeGripBaseSteer]]) for bikes.
 *
 *  FORMULA (1:1 with monolith):
 *    leanNorm     = bikeLeanPos / BIKE_LEAN_MAX
 *    turnFromLean = sign(leanNorm) × |leanNorm|^1.3
 *    bikeHSF      = 1 - speedRatio² × 0.40
 *    pAngVel      = turnFromLean × turnRate × spdFactor × bikeHSF
 *
 *  The literal `1.0` multiplier at L24712 is intentionally NOT
 *  exposed as a constant — it's a "no extra scalar" marker, kept
 *  in the monolith to match the parallel position of `massDamp` in
 *  the car formula. Omitted here for clarity (multiplying by 1
 *  drops out).
 *
 *  INPUTS:
 *    bikeLeanPos     current smoothed lean state (from
 *                    [[tickBikeLean]] this frame)
 *    turnRate        per-bike maximum yaw rate (CAR().turnRate)
 *    spdFactor       0..1 speed ramp the caller computes for
 *                    several effects
 *    speedRatio      |pSpeed| / topSpeed, pre-clamped to [0, 1]
 *
 *  NOTE: massDamp is NOT in the bike formula. The monolith
 *  intentionally omits it from L24712 — bikes are tuned through
 *  the lean chain alone, and adding chassis-mass damping on top
 *  would double-count what the lean smoothing already provides.
 *
 *  Ported 1:1 from monolith L24709-L24712 (the turn-from-lean
 *  stage of update()'s bike steering branch). */
export function computeBikePAngVel(
  bikeLeanPos: number,
  turnRate: number,
  spdFactor: number,
  speedRatio: number,
): number {
  const leanNorm = bikeLeanPos / BIKE_LEAN_MAX;
  const turnFromLean = Math.sign(leanNorm) * Math.pow(Math.abs(leanNorm), BIKE_LEAN_TURN_EXPONENT);
  const bikeHSF = 1 - speedRatio * speedRatio * BIKE_HSF_QUAD_COEFF;
  return turnFromLean * turnRate * spdFactor * bikeHSF;
}

/** Flip the yaw-rate sign when reversing. A car moving BACKWARD
 *  with the steering wheel turned LEFT rotates the chassis the
 *  OPPOSITE way around — same as backing out of a parking space
 *  with the wheel cranked: the rear end swings the way the wheels
 *  point, which is the inverse of forward-motion behavior.
 *
 *  Sits at the very tail of the steering pipeline, after both the
 *  grip and drift branches have produced their pAngVel — applies
 *  uniformly regardless of which branch ran. Uses `pSpeed`
 *  (signed) rather than `absSpd` because the sign IS the signal.
 *
 *  At pSpeed = 0 the multiplier is undefined-by-condition (the
 *  strict `< 0` predicate excludes the boundary), which is fine —
 *  pAngVel at a complete standstill is moot, the chassis isn't
 *  rotating anyway. The boundary case at pSpeed exactly 0 returns
 *  pAngVel unchanged.
 *
 *  Ported 1:1 from monolith L24789 (the single-line reverse-yaw
 *  flip at the end of update()'s steering block, after both
 *  grip and drift branches close). */
export function applyReverseYawFlip(
  pAngVel: number,
  pSpeed: number,
): number {
  return pSpeed < 0 ? -pAngVel : pAngVel;
}

/** Per-frame decay multiplier for bike lean during a drift. A bike
 *  entering the drift state has its visual lean decayed toward
 *  zero at 0.9 per frame, because:
 *
 *    - Real bikes don't lean during a slide (the rear is breaking
 *      free, the front isn't carving) — riders sit upright and
 *      counter-steer through the chassis, not the lean.
 *    - The lean smoothing tick ([[tickBikeLean]]) is bypassed
 *      during a drift (the drift branch owns pAngVel directly via
 *      [[computeDriftPAngVel]]), so without this decay the
 *      bikeLeanPos would freeze at whatever value it held when
 *      the drift started, leaving the rider looking permanently
 *      leaned-over while clearly sliding sideways.
 *
 *  The 0.9 coefficient at 60 fps gives a ~6-frame half-life
 *  (0.9^6 ≈ 0.53), so the visual lean decays to roughly zero
 *  within ~½ second of entering a drift — fast enough to look
 *  natural, slow enough not to "pop."
 *
 *  Matches monolith `bikeLeanPos*=0.9` at L24688. */
export const BIKE_DRIFT_LEAN_DECAY = 0.9;

/** Decay the bike's smoothed lean state during a drift. Returns
 *  the new bikeLeanPos. Caller is responsible for invoking this
 *  ONLY when both the bike is drifting AND the body type is bike;
 *  the monolith gates on `if(CAR().isBike)` inside the drift
 *  branch and we keep the same caller-gated pattern.
 *
 *  This is the bike-only counterpart of "what happens to the
 *  unused stage-1 lean state during a drift." Cars don't have
 *  this concept (they use baseSteer directly, no smoothed state).
 *
 *  Ported 1:1 from monolith L24688 (the single-line bike lean
 *  decay inside the drift branch of update()'s steering block). */
export function decayBikeLeanInDrift(bikeLeanPos: number): number {
  return bikeLeanPos * BIKE_DRIFT_LEAN_DECAY;
}
