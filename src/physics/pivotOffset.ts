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
