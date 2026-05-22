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
