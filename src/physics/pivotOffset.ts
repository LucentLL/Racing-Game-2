/**
 * Drivetrain-specific rotation pivot offset (legacy / pre-bicycle-
 * model path).
 *
 * Real cars don't rotate around their center of gravity — they
 * rotate around an axle (or somewhere between, depending on
 * weight distribution and which end is driven):
 *
 *   FR / MR  — driven rear pushes the rear out; chassis pivots
 *              around the FRONT axle while the rear swings wide.
 *   FF       — driven front pulls the car through; chassis pivots
 *              around the REAR axle while the front noses into
 *              the turn.
 *   4WD      — split power across both axles → pivot near CG.
 *
 * Implemented as a post-rotation position swing: after pAngle
 * advances by dAng = pAngVel × dt, the CG is shifted
 * perpendicular to heading by `pivotShift × sin(dAng)`. This
 * approximates "rotated around a point offset by pivotShift from
 * CG" without changing the rotation math itself.
 *
 * Only applies in LEGACY mode (Phase 0A/0B's bicycle model
 * produces the correct rotation point naturally via the rear-axle
 * constraint, so this hack is bypassed when _useBicyclePos is
 * true). Bikes are also exempt (they have their own lean-derived
 * pivot dynamics).
 *
 * Monolith source: inside update() at L25005-L25025.
 */

import type { Drivetrain } from './steering';

/** Half-wheelbase coefficient: ratio of body length used as the
 *  "half-wheelbase" magnitude for pivot offsets. Slightly less
 *  than 0.5 because the wheelbase is shorter than the overall
 *  body length (front + rear overhang outside the axles).
 *
 *  Distinct from [[WHEELBASE_LENGTH_RATIO]] (0.65) — the pivot
 *  code wants the HALF-wheelbase for offsets-from-CG, not the
 *  full wheelbase the bicycle ODE uses for axle-to-axle distance.
 *  0.35 ≈ 0.65 / 2 (close enough; this constant predates the
 *  bicycle-model port and was tuned independently).
 *
 *  Matches monolith `CAR().size[0]*0.35` at L25010. */
export const HALF_WHEELBASE_RATIO = 0.35;

/** FR pivot ratio of half-wheelbase. RWD with rear push: chassis
 *  pivots around a point WELL AHEAD of CG (≈ near front axle),
 *  the rear swings out and feels loose. 0.6 of half-wheelbase
 *  puts the pivot ~60 % of the way from CG to the front axle.
 *
 *  Matches monolith `pivotShift=halfLen*0.6` at L25013. */
export const FR_PIVOT_FRAC = 0.6;

/** MR pivot ratio of half-wheelbase. Mid-engine RWD: rear-biased
 *  weight makes the rear swing even harder than FR, so the pivot
 *  sits FURTHER ahead (0.7 vs 0.6). Drivers feel mid-engine cars
 *  as "snappy" — this is part of what produces that sensation.
 *
 *  Matches monolith `pivotShift=halfLen*0.7` at L25014. */
export const MR_PIVOT_FRAC = 0.7;

/** FF pivot ratio of half-wheelbase, NEGATIVE because the pivot
 *  sits BEHIND CG (≈ near rear axle). FWD pulls the front around
 *  while the rear stays planted; CG appears to nose into the
 *  turn instead of swinging out. 0.4 of half-wheelbase, behind.
 *
 *  Matches monolith `pivotShift=-halfLen*0.4` at L25015. */
export const FF_PIVOT_FRAC = -0.4;

/** 4WD pivot ratio of half-wheelbase. Power split across both
 *  axles produces a pivot NEAR CG (0.1, only slightly ahead) —
 *  AWD cars rotate around their middle, which is why they feel
 *  "neutral" or "planted" relative to RWD/FWD.
 *
 *  Matches monolith `pivotShift=halfLen*0.1` at L25016. */
export const AWD_PIVOT_FRAC = 0.1;

/** Compute the drivetrain-dependent pivot offset from CG, in
 *  game-units, for use in the legacy (non-bicycle-model) post-
 *  rotation position swing.
 *
 *  POSITIVE pivotShift = pivot ahead of CG (rear swings outward,
 *  FR/MR/4WD behavior).
 *  NEGATIVE pivotShift = pivot behind CG (front noses inward,
 *  FF behavior).
 *
 *  FORMULA (1:1 with monolith):
 *    halfLen    = bodyLength × HALF_WHEELBASE_RATIO
 *    pivotShift =
 *      FR  → halfLen × FR_PIVOT_FRAC   ( 0.6 × halfLen)
 *      MR  → halfLen × MR_PIVOT_FRAC   ( 0.7 × halfLen)
 *      FF  → halfLen × FF_PIVOT_FRAC   (-0.4 × halfLen)
 *      4WD → halfLen × AWD_PIVOT_FRAC  ( 0.1 × halfLen)
 *      RR  → 0 (defensive fallthrough; the monolith's chain has
 *             no RR case so it stays at the initialized 0)
 *
 *  Caller is responsible for the eligibility gates (NOT a bike,
 *  NOT in bicycle-model mode) — see the surrounding
 *  applyPivotSwing call site in update() for the gate combination.
 *
 *  Ported 1:1 from monolith L25010-L25017 (the pivotShift lookup
 *  in the post-rotation-pivot block). */
export function computeDrivetrainPivotShift(
  drivetrain: Drivetrain,
  bodyLength: number,
): number {
  const halfLen = bodyLength * HALF_WHEELBASE_RATIO;
  switch (drivetrain) {
    case 'FR':  return halfLen * FR_PIVOT_FRAC;
    case 'MR':  return halfLen * MR_PIVOT_FRAC;
    case 'FF':  return halfLen * FF_PIVOT_FRAC;
    case '4WD': return halfLen * AWD_PIVOT_FRAC;
    default:    return 0;
  }
}

/** Minimum pivot-shift magnitude (game units) below which the
 *  swing is too small to register visually. 0.1 gu corresponds to
 *  ~½ pixel at typical render scale; below this the position
 *  delta is sub-pixel noise.
 *
 *  Matches monolith `Math.abs(pivotShift)>0.1` at L25019. */
export const PIVOT_SHIFT_GATE = 0.1;

/** Minimum |pAngVel| (radians / sec) below which the rotation is
 *  too slow to produce a perceptible swing. 0.01 rad/s ≈ 0.6°/sec,
 *  which is well below the threshold of feeling rotation.
 *
 *  Matches monolith `Math.abs(pAngVel)>0.01` at L25019. */
export const PIVOT_ANG_VEL_GATE = 0.01;

/** Minimum |absSpd| (game units / sec) for the pivot swing to
 *  apply. Below 2 gu/s the car is essentially stopped and the
 *  CG-swing approximation breaks down (no forward motion means
 *  no "pivot around an axle ahead of CG" geometry).
 *
 *  Matches monolith `absSpd>2` at L25019. */
export const PIVOT_SPEED_GATE = 2;

/** Player position 2-tuple returned by [[applyPivotSwing]]. */
export interface PivotSwingResult {
  px: number;
  py: number;
}

/** Apply the legacy post-rotation pivot swing — shift the CG
 *  perpendicular to heading so the chassis appears to have
 *  rotated around an offset point instead of around the CG
 *  itself.
 *
 *  FORMULA (1:1 with monolith):
 *    dAng  = pAngVel × dt
 *    swing = pivotShift × sin(dAng)
 *    px   += cos(pAngle + π/2) × swing
 *    py   += sin(pAngle + π/2) × swing
 *
 *  The `pAngle + π/2` rotation produces a unit vector
 *  PERPENDICULAR to heading (heading.x = cos(pAngle), so the
 *  +π/2 rotation gives -sin(pAngle), +cos(pAngle) — which is the
 *  left-normal direction in screen coords). Positive swing
 *  shifts the CG left of heading; negative swing shifts right.
 *
 *  WHY sin(dAng) and not just dAng: for small angles sin ≈ angle
 *  (within ~1 % out to ±10°), so this approximation is exact at
 *  the limit. At larger per-frame angles (high yaw rate × big
 *  dt) sin gives the geometrically correct chord, which is
 *  always smaller than the linear projection — pivot swing
 *  doesn't over-shoot in unusual conditions.
 *
 *  THREE GATES (all required):
 *  - |pivotShift| > 0.1   — pivot magnitude must be meaningful
 *  - |pAngVel|    > 0.01  — must be rotating perceptibly
 *  - absSpd       > 2     — must be moving (the pivot-around-
 *                            axle geometry assumes forward motion)
 *
 *  Below any gate, returns position unchanged. This is the
 *  monolith's explicit no-op pattern — keeping the gates
 *  visible in the function body (rather than letting the swing
 *  formula collapse to ~0 naturally) is intentional, so future
 *  readers can see the conditions and so the dot product cost
 *  is avoided.
 *
 *  LEGACY-ONLY: caller is responsible for ALSO gating on
 *  NOT bicycle-model-active (else `pivotShift = 0` will already
 *  have been passed in via [[computeDrivetrainPivotShift]]'s
 *  caller-side gate) AND not a bike. The function itself does
 *  not enforce these — but with pivotShift = 0 from those gates,
 *  the |pivotShift| > 0.1 check trivially excludes the swing.
 *
 *  Ported 1:1 from monolith L25019-L25025 (the pivot-swing
 *  application block immediately following the drivetrain
 *  lookup). */
export function applyPivotSwing(
  px: number,
  py: number,
  pAngle: number,
  pAngVel: number,
  dt: number,
  pivotShift: number,
  absSpd: number,
): PivotSwingResult {
  if (Math.abs(pivotShift) <= PIVOT_SHIFT_GATE) return { px, py };
  if (Math.abs(pAngVel) <= PIVOT_ANG_VEL_GATE) return { px, py };
  if (absSpd <= PIVOT_SPEED_GATE) return { px, py };
  const dAng = pAngVel * dt;
  const swing = pivotShift * Math.sin(dAng);
  const perpAngle = pAngle + Math.PI / 2;
  return {
    px: px + Math.cos(perpAngle) * swing,
    py: py + Math.sin(perpAngle) * swing,
  };
}
