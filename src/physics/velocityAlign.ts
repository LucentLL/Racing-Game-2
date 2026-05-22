/**
 * Velocity-direction alignment — the per-frame exponential-relax
 * idiom that drags the velocity heading (pVelAngle) toward the
 * chassis heading (pAngle).
 *
 * Why the velocity direction can DIFFER from the chassis heading
 * at all: tires slip. In grip state the slip is small and the
 * difference relaxes quickly toward zero (high gripAlign rate).
 * In drift state the difference is the slide angle, and it
 * relaxes much more slowly (low driftAlignRate) — the body and
 * the velocity vector are pointing in genuinely different
 * directions because the rear tires are sliding sideways.
 *
 * The two angles are kept on the unit circle modulo 2π so the
 * relaxation tracks the shortest path (a 359° difference is
 * really -1°, and trying to relax across 359° would spin the
 * wrong way around).
 *
 * Used by both the drift branch (L25058-L25061) and the grip
 * branch (L25100-L25103) of the legacy velocity-direction-update
 * block in update(). The 0B Phase skips this entirely — the
 * force integrator derives pVelAngle from actual CG displacement
 * and the friction-circle handles energy loss naturally.
 *
 * Monolith source: inside update() at L25058-L25061 and
 * L25100-L25103.
 */

/** Exponentially relax `pVelAngle` toward `pAngle` at the given
 *  rate, normalizing the angular difference to the shortest
 *  wraparound path.
 *
 *  FORMULA (1:1 with monolith):
 *    diff      = pAngle - pVelAngle
 *    diff     -= 2π × floor((diff + π) / 2π)   [wrap to (-π, π]]
 *    pVelAngle = pVelAngle + diff × alignRate × dt
 *
 *  (The monolith uses a while-loop pair to wrap; the math is
 *  equivalent.)
 *
 *  INPUTS:
 *    pVelAngle   current velocity direction, radians
 *    pAngle      current chassis heading, radians
 *    alignRate   per-second relaxation rate (1/s); higher = faster
 *                snap to heading. Grip uses 6-14, drift uses
 *                ~1-3 (the actual rate values are computed by
 *                upstream helpers — see compute*AlignRate hops).
 *    dt          frame timestep, seconds
 *
 *  Returns the new pVelAngle. NOT clamped to (-π, π] in the
 *  return — the caller may add to it further or wrap as needed.
 *
 *  At alignRate × dt = 1.0 the velocity snaps exactly to heading
 *  in one step (overshoot-free for the half-plane diff is in).
 *  In practice alignRate × dt stays well below 1 so this is a
 *  proportional relaxation, not a step jump.
 *
 *  Ported 1:1 from monolith L25058-L25061 / L25100-L25103 (the
 *  shared diff-normalize-then-relax block in the velocity-
 *  direction-update branches). */
export function alignVelocityAngle(
  pVelAngle: number,
  pAngle: number,
  alignRate: number,
  dt: number,
): number {
  let diff = pAngle - pVelAngle;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return pVelAngle + diff * alignRate * dt;
}

/** Off-throttle multiplier on drift align rate. Lifting off the
 *  throttle lets the tires regain grip without engine torque
 *  breaking them loose, so the car straightens out 1.8× faster
 *  than under power. This is what makes "lift to recover" work
 *  as a drift-correction technique.
 *
 *  Matches monolith `alignRate*=1.8` at L25048. */
export const DRIFT_OFF_THROTTLE_ALIGN_BOOST = 1.8;

/** FR drift-align multiplier. RWD rear slides more freely than
 *  the average drivetrain — lower alignment rate keeps the slide
 *  alive longer. 0.85× makes FR cars drift the longest of any
 *  setup that isn't intentionally rear-biased.
 *
 *  Matches monolith `alignRate*=0.85` at L25050. */
export const DRIFT_FR_ALIGN_MULT = 0.85;

/** MR drift-align multiplier. Mid-engine RWD: rear-biased weight
 *  makes the rear EVEN looser than FR — most spin-prone of any
 *  drivetrain. 0.75× alignment rate ↔ longest, hardest-to-catch
 *  slides. Realistic for the Lotus Exige / Ferrari 458 archetype.
 *
 *  Matches monolith `alignRate*=0.75` at L25051. */
export const DRIFT_MR_ALIGN_MULT = 0.75;

/** FF drift-align multiplier. FWD: front pulls hard, so a drift
 *  self-corrects much FASTER than RWD/AWD. 1.3× alignment rate
 *  ↔ short, snappy drifts that take real effort to sustain.
 *
 *  Matches monolith `alignRate*=1.3` at L25053. */
export const DRIFT_FF_ALIGN_MULT = 1.3;

/** E-brake drift-align multiplier (active while pEbrakeTimer > 0).
 *  Pulling the handbrake collapses rear grip — alignment rate
 *  drops to 25 % of normal for the duration of the e-brake
 *  window (~0.6 s, defined elsewhere). This mirrors the 0B path's
 *  70 % μ collapse on rear tires.
 *
 *  v8.98.34 added this for the legacy path so that an e-brake
 *  drift actually SUSTAINS instead of getting yanked back to
 *  heading by the normal align rate while the handbrake's still
 *  on. Before v98.34 the e-brake fired but the slide collapsed
 *  almost immediately.
 *
 *  Matches monolith `alignRate*=0.25` at L25057. */
export const DRIFT_EBRAKE_ALIGN_MULT = 0.25;

/** Drivetrain enum re-exported for callers — matches
 *  steering.ts's [[Drivetrain]] type. Kept as a local string
 *  union rather than an import to avoid a circular dep
 *  (velocityAlign is purely about alignment dynamics; the
 *  drivetrain enum lives near steering). Identical value set. */
export type Drivetrain = 'FR' | 'MR' | 'RR' | 'FF' | '4WD';

/** Compute the per-frame drift alignment rate by stacking the
 *  drivetrain / throttle / e-brake multipliers onto a car-specific
 *  base (CAR().driftAlignRate).
 *
 *  PIPELINE (1:1 with monolith):
 *    rate = baseRate
 *    if NOT throttle:   rate × 1.8     [DRIFT_OFF_THROTTLE_ALIGN_BOOST]
 *    if FR:             rate × 0.85    [DRIFT_FR_ALIGN_MULT]
 *    elif MR:           rate × 0.75    [DRIFT_MR_ALIGN_MULT]
 *    elif FF:           rate × 1.30    [DRIFT_FF_ALIGN_MULT]
 *    elif 4WD/RR:       no drivetrain multiplier
 *    if e-brake on:     rate × 0.25    [DRIFT_EBRAKE_ALIGN_MULT]
 *
 *  Multipliers compose multiplicatively, so an off-throttle FR
 *  e-brake drift gets: 1.8 × 0.85 × 0.25 = 0.3825× of baseRate
 *  — a deeply held slide.
 *
 *  INPUTS:
 *    baseRate         CAR().driftAlignRate — per-car base align
 *                     rate (slower = looser slides)
 *    isThrottle       gas held this frame
 *    drivetrain       'FR' / 'MR' / 'RR' / 'FF' / '4WD'
 *    ebrakeActive     pEbrakeTimer > 0
 *
 *  RETURNS the per-second alignment rate to feed into
 *  [[alignVelocityAngle]] for the drift branch.
 *
 *  Ported 1:1 from monolith L25046-L25057 (the drift align-rate
 *  composition block). */
export function computeDriftAlignRate(
  baseRate: number,
  isThrottle: boolean,
  drivetrain: Drivetrain,
  ebrakeActive: boolean,
): number {
  let rate = baseRate;
  if (!isThrottle) rate *= DRIFT_OFF_THROTTLE_ALIGN_BOOST;
  switch (drivetrain) {
    case 'FR': rate *= DRIFT_FR_ALIGN_MULT; break;
    case 'MR': rate *= DRIFT_MR_ALIGN_MULT; break;
    case 'FF': rate *= DRIFT_FF_ALIGN_MULT; break;
    // 'RR' and '4WD' have no drivetrain multiplier
  }
  if (ebrakeActive) rate *= DRIFT_EBRAKE_ALIGN_MULT;
  return rate;
}

/** Drift speed-loss speed-ratio coefficient. The energy bleed
 *  scales with speed as `(1 + speedRatio × 1.2)`:
 *
 *    speedRatio = 0.00  →  × 1.00  parking-lot drift, minimal bleed
 *    speedRatio = 0.50  →  × 1.60
 *    speedRatio = 1.00  →  × 2.20  top-speed drift, 2.2× bleed
 *
 *  WHY LINEAR-IN-RATIO (not quadratic in energy): the actual
 *  energy bled at any moment is `sin(slip) × bleed`; the energy
 *  IN the system at that moment is ~v². The 1.2 coefficient was
 *  empirically tuned to feel-right rather than physically
 *  derived. High-speed drifts feel like they scrub off speed
 *  hard; low-speed drifts barely bleed. That's the target feel.
 *
 *  Named distinctly from steering.ts's [[DRIFT_SPEED_PENALTY_COEFF]]
 *  (1.5) which is the hyperbolic INPUT rolloff during a drift —
 *  different concept, different formula, different value.
 *
 *  Matches monolith `1+speedRatio*1.2` at L25064. */
export const DRIFT_SPEED_BLEED_COEFF = 1.2;

/** Off-throttle drift speed-bleed multiplier. Off-throttle drifts
 *  lose speed 2.5× faster than on-throttle drifts.
 *
 *  WHY THE BIG SPREAD: a drift is a balance of two energy
 *  contributions — the engine pours torque INTO the system (which
 *  partially counteracts the slip bleed) and the tires take it
 *  OUT (slip × friction). Off-throttle has only the bleed; on-
 *  throttle is bleed minus engine contribution. The 2.5× ratio
 *  is what makes "stay on the throttle to hold the drift" the
 *  correct technique in the simulation, matching real drifting.
 *
 *  Matches monolith `isThrottle?1.0:2.5` at L25065. */
export const DRIFT_OFF_THROTTLE_BLEED_MULT = 2.5;

/** Apply the per-frame drift speed loss. Drifting bleeds energy
 *  through tire slip — slip angle, base loss rate, speed, and
 *  throttle state all factor in.
 *
 *  FORMULA (1:1 with monolith):
 *    spdPenalty   = 1 + speedRatio × 1.2
 *    throttleHold = isThrottle ? 1.0 : 2.5
 *    pSpeed      -= |sin(slipAngle)| × driftSlipLoss × spdPenalty
 *                                                   × throttleHold × dt
 *    clamp pSpeed to ≥ 0
 *
 *  INPUTS:
 *    pSpeed          current player speed (game units / sec).
 *                    The function returns the new value; doesn't
 *                    mutate.
 *    slipAngle       current chassis-vs-velocity angle (rad,
 *                    signed). |sin(·)| extracts the lateral
 *                    component — at slip=0 there's no bleed,
 *                    at slip=±π/2 it's maximum.
 *    driftSlipLoss   CAR().driftSlipLoss — per-car base bleed
 *                    rate (heavier/sportier cars bleed slower).
 *    speedRatio      |pSpeed| / topSpeed, pre-clamped to [0, 1].
 *    isThrottle      gas held this frame.
 *    dt              frame timestep in seconds.
 *
 *  SLIP-DIRECTION INDEPENDENCE: |sin(slipAngle)| means a left
 *  drift and a right drift bleed the same amount. The sign of
 *  the slip is meaningful for the alignment direction (handled
 *  by [[alignVelocityAngle]]), but for energy loss only the
 *  magnitude matters.
 *
 *  ENERGY FLOOR at zero: pSpeed is clamped at the bottom so a
 *  prolonged drift can't drive speed negative. Real drifts decay
 *  to a stop and the alignment relaxation catches up.
 *
 *  Ported 1:1 from monolith L25062-L25067 (the drift branch's
 *  speed-loss block at the tail of the velocity-direction-update). */
export function applyDriftSpeedLoss(
  pSpeed: number,
  slipAngle: number,
  driftSlipLoss: number,
  speedRatio: number,
  isThrottle: boolean,
  dt: number,
): number {
  const spdPenalty = 1 + speedRatio * DRIFT_SPEED_BLEED_COEFF;
  const throttleHold = isThrottle ? 1.0 : DRIFT_OFF_THROTTLE_BLEED_MULT;
  const bleed = Math.abs(Math.sin(slipAngle)) * driftSlipLoss * spdPenalty * throttleHold * dt;
  const next = pSpeed - bleed;
  return next < 0 ? 0 : next;
}

/** Base grip alignment rate for cars. Velocity vector relaxes
 *  toward heading at 8/s by default — that's tight enough that
 *  small slip angles get straightened out quickly but loose
 *  enough that real-physics slip-and-recover dynamics still
 *  emerge.
 *
 *  Matches monolith `let gripAlign=8` at L25070. */
export const GRIP_ALIGN_BASE = 8;

/** Bike grip alignment rate. Bikes have very high grip — a single
 *  contact patch per axle but the rider's weight is concentrated
 *  on it (high normal force per unit area). Velocity vector
 *  tracks heading tightly: 14/s ↔ ~70 ms relax time.
 *
 *  Matches monolith `gripAlign=14` at L25072. */
export const GRIP_ALIGN_BIKE = 14;

/** FR-on-throttle grip alignment. RWD with power applied: rear
 *  is slightly looser even in the grip state (tail-happy), so
 *  alignment drops below the default 8 to ~6.5. Off-throttle FR
 *  falls back to the default 8 — the difference is what gives
 *  the cars a "throttle-on understeer-relief" feel.
 *
 *  Matches monolith `gripAlign=6.5` at L25074. */
export const GRIP_ALIGN_FR_THROTTLE = 6.5;

/** MR-on-throttle grip alignment. Mid-engine RWD with power:
 *  most spin-prone configuration, alignment drops to 6/s — even
 *  looser than FR. The Lotus / Ferrari archetype, "the rear
 *  steps out under power if you're not careful."
 *
 *  Matches monolith `gripAlign=6` at L25075. */
export const GRIP_ALIGN_MR_THROTTLE = 6;

/** FF grip alignment. FWD: front pulls velocity line tight.
 *  Above the default — 10/s — because the driven front tires
 *  give very direct steering-to-velocity authority.
 *
 *  Matches monolith `gripAlign=10` at L25077. */
export const GRIP_ALIGN_FF = 10;

/** 4WD grip alignment. Power across both axles, planted feel.
 *  9/s — slightly above the default car base but well below the
 *  FF case (4WD has weight to manage at both ends, doesn't snap
 *  as directly as a FF).
 *
 *  Matches monolith `gripAlign=9` at L25079. */
export const GRIP_ALIGN_4WD = 9;

/** Grass grip alignment multiplier. Reduced grip — velocity line
 *  decouples partially. 0.45× ↔ tires still track but the car
 *  slides much further before recovering. Distinct from the
 *  steering response on grass ([[GRASS_STEER_MULT]] = 0.50,
 *  steering.ts) — different formulas, different concerns.
 *
 *  Matches monolith `gripAlign*=0.45` at L25081. */
export const GRIP_ALIGN_GRASS_MULT = 0.45;

/** E-brake grip alignment multiplier (active while
 *  pEbrakeTimer > 0). Collapses grip-state alignment to 30 %
 *  even before drift hysteresis catches the slide — without
 *  this, gripAlign would snap pVelAngle back to pAngle
 *  immediately and the e-brake would never trigger a sustained
 *  drift state.
 *
 *  v8.98.34 added this for the legacy path. Mirrors the 0B
 *  path's rear-μ collapse but applied to the grip-align rate
 *  instead of through tire forces.
 *
 *  Matches monolith `gripAlign*=0.30` at L25085. */
export const GRIP_ALIGN_EBRAKE_MULT = 0.30;

/** Compute the per-frame grip alignment rate (pre-momentum-resist)
 *  by selecting a base value from vehicle/drivetrain × throttle
 *  state, then stacking the surface and e-brake modifiers.
 *
 *  PIPELINE (1:1 with monolith):
 *    base =
 *      bike                     →  14
 *      FR  AND throttle         →   6.5
 *      MR  AND throttle         →   6
 *      FF                       →  10
 *      4WD                      →   9
 *      otherwise (FR/MR off-gas →   8 (GRIP_ALIGN_BASE)
 *                 or RR / car)
 *    if onGrass:        base × 0.45
 *    if ebrakeActive:   base × 0.30
 *
 *  IMPORTANT FR/MR THROTTLE DISTINCTION: FR and MR drop the
 *  alignment rate ONLY when on throttle. Off-throttle they fall
 *  through to the default 8 — modeling the "lift to recover"
 *  intuition where backing off power lets the rear tires regain
 *  alignment authority.
 *
 *  RETURNS the base alignment rate before momentum resistance
 *  is applied. Caller divides by [[computeMomentumResist]] to
 *  get the final per-frame rate fed to [[alignVelocityAngle]].
 *
 *  INPUTS:
 *    isBike           CAR().isBike
 *    drivetrain       'FR' / 'MR' / 'RR' / 'FF' / '4WD'
 *    isThrottle       gas held this frame
 *    onGrass          surface is grass
 *    ebrakeActive     pEbrakeTimer > 0
 *
 *  Ported 1:1 from monolith L25070-L25085 (the grip-align rate
 *  base + modifier block in the grip branch of the velocity-
 *  direction-update). */
/** Mass-momentum baseline (kg). A car at this mass produces
 *  `massMomentum = 1.0`. Above this mass, the momentum factor
 *  grows linearly. Below it, the factor clamps at 1.0 (lighter
 *  cars don't get a momentum DISCOUNT, just no surcharge).
 *
 *  800 kg matches roughly a lightweight sports car / Lotus Elise
 *  archetype — the reference point chosen so most cars in the
 *  game have a meaningful but moderate mass-momentum value.
 *
 *  Matches monolith `CAR().mass-800` at L25093. */
export const MOMENTUM_MASS_BASELINE = 800;

/** Default per-kg-above-baseline mass-momentum coefficient when
 *  the gameplay setting is absent or zero. 0.0003 gives a 1500 kg
 *  car a massMomentum of 1 + (1500-800)*0.0003 = 1.21, so
 *  ~21 % stronger momentum resistance than the 800 kg reference.
 *
 *  v8.99.83 added the physMassMomentum knob (default 0.0003,
 *  player can raise to 0.0008-0.0012) so heavy cars feel
 *  meaningfully different from light ones — a gravity cue for
 *  top-down where there's no visual "this car is heavy" signal.
 *
 *  Matches monolith fallback `||0.0003` at L25092. */
export const DEFAULT_PHYS_MASS_MOMENTUM = 0.0003;

/** Default global momentum coefficient when the gameplay setting
 *  is absent or zero. 6.0 produces meaningful momentum resistance
 *  at highway speed (at speedRatio=1, baseline mass: momentum
 *  resist = 1 + 6 = 7×, dividing gripAlign by 7).
 *
 *  v8.99.83 added the physMomentumCoef knob — players can lower
 *  to 2-4 to reduce "banana peel" decoupling at high speed, or
 *  raise above 6 to emulate heavy understeer. Default 6.0 keeps
 *  the original feel.
 *
 *  Matches monolith fallback `||6.0` at L25097. */
export const DEFAULT_PHYS_MOMENTUM_COEF = 6.0;

/** Compute the momentum resistance factor that scales DOWN the
 *  grip alignment rate at high speed. The intuition: forward
 *  momentum dominates at speed — tires can point anywhere but
 *  the vehicle keeps going where it was going. Heavy vehicles
 *  resist heading-direction-change more.
 *
 *  FORMULA (1:1 with monolith):
 *    physMM       = physMassMomentum  || DEFAULT_PHYS_MASS_MOMENTUM
 *    physMC       = physMomentumCoef  || DEFAULT_PHYS_MOMENTUM_COEF
 *    massMomentum = 1 + max(0, (carMass - 800) × physMM)
 *    resist       = 1 + speedRatio² × physMC × massMomentum
 *
 *  Caller divides gripAlign by this value before passing to
 *  [[alignVelocityAngle]]:
 *    finalAlign = gripAlign / resist
 *
 *  PROPERTIES:
 *  - speedRatio² scaling is quadratic — gentle at low speed,
 *    massive at high speed. A car at half top-speed gets ~25 %
 *    of the resistance a top-speed car gets.
 *  - mass effect clamped at 1.0 for cars LIGHTER than 800 kg
 *    (no momentum DISCOUNT — keeps the formula well-behaved at
 *    the extremes of the car-mass distribution).
 *  - `||` fallback treats 0 as "use default" (monolith idiom).
 *    Players are not expected to set physMassMomentum or
 *    physMomentumCoef to exactly 0; the fallback handles
 *    undefined/missing settings gracefully.
 *
 *  INPUTS:
 *    carMass            CAR().mass in kg
 *    speedRatio         |pSpeed| / topSpeed, pre-clamped to [0,1]
 *    physMassMomentum   LIFE.gameplaySettings.physMassMomentum;
 *                       pass 0 or undefined for default
 *    physMomentumCoef   LIFE.gameplaySettings.physMomentumCoef;
 *                       pass 0 or undefined for default
 *
 *  Ported 1:1 from monolith L25086-L25099 (the momentum-resist
 *  block in the grip branch). */
export function computeMomentumResist(
  carMass: number,
  speedRatio: number,
  physMassMomentum: number | undefined,
  physMomentumCoef: number | undefined,
): number {
  const physMM = physMassMomentum || DEFAULT_PHYS_MASS_MOMENTUM;
  const physMC = physMomentumCoef || DEFAULT_PHYS_MOMENTUM_COEF;
  const massMomentum = 1 + Math.max(0, (carMass - MOMENTUM_MASS_BASELINE) * physMM);
  return 1 + speedRatio * speedRatio * physMC * massMomentum;
}

/** Minimum speed (game units / sec) at which the legacy velocity-
 *  direction-update branches (drift / grip) apply. Below this the
 *  reset branch ([[resetVelocityDirection]]) fires instead —
 *  there's no meaningful velocity vector to align toward heading
 *  when the car isn't really moving.
 *
 *  Matches monolith `absSpd>1` at L25043. */
export const VELOCITY_UPDATE_MIN_SPEED = 1;

/** Result tuple returned by [[resetVelocityDirection]]: the
 *  velocity heading synced to chassis heading, plus a flag for
 *  whether the drift state should be cleared and the drift
 *  intensity zeroed. */
export interface VelocityResetResult {
  /** New pVelAngle — always equals the chassis pAngle when this
   *  branch fires. */
  pVelAngle: number;
  /** New pDrifting flag — always false. Caller assigns. */
  pDrifting: false;
  /** New pDrift intensity — always 0. Caller assigns. */
  pDrift: 0;
}

/** Force-sync the velocity vector to heading and clear any
 *  active drift state. Fires when the legacy velocity-direction-
 *  update branches don't apply — specifically when:
 *
 *    - 0B Phase is active (the force integrator handles
 *      pVelAngle directly from CG displacement, so the legacy
 *      relax-toward-heading shouldn't run), OR
 *    - absSpd ≤ 1 (no meaningful velocity vector to align)
 *
 *  The caller decides the gate; this function just produces
 *  the reset values. Returns:
 *    - pVelAngle = pAngle  (instantaneous snap, no relaxation)
 *    - pDrifting = false
 *    - pDrift    = 0
 *
 *  WHY ALSO CLEAR DRIFT STATE: at very low speed (absSpd ≤ 1)
 *  the car has effectively stopped — any lingering pDrifting
 *  flag from before would mis-classify the next frame's
 *  re-acceleration as a drift continuation rather than a fresh
 *  start. Clearing it on every low-speed frame is defensive but
 *  cheap.
 *
 *  Ported 1:1 from monolith L25106-L25108 (the else branch of
 *  the legacy velocity-direction-update block). */
export function resetVelocityDirection(pAngle: number): VelocityResetResult {
  return {
    pVelAngle: pAngle,
    pDrifting: false,
    pDrift: 0,
  };
}

export function computeGripAlignRate(
  isBike: boolean,
  drivetrain: Drivetrain,
  isThrottle: boolean,
  onGrass: boolean,
  ebrakeActive: boolean,
): number {
  let rate: number;
  if (isBike) {
    rate = GRIP_ALIGN_BIKE;
  } else if (drivetrain === 'FR' && isThrottle) {
    rate = GRIP_ALIGN_FR_THROTTLE;
  } else if (drivetrain === 'MR' && isThrottle) {
    rate = GRIP_ALIGN_MR_THROTTLE;
  } else if (drivetrain === 'FF') {
    rate = GRIP_ALIGN_FF;
  } else if (drivetrain === '4WD') {
    rate = GRIP_ALIGN_4WD;
  } else {
    rate = GRIP_ALIGN_BASE;
  }
  if (onGrass) rate *= GRIP_ALIGN_GRASS_MULT;
  if (ebrakeActive) rate *= GRIP_ALIGN_EBRAKE_MULT;
  return rate;
}
