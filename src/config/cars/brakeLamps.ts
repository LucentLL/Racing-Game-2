/**
 * H1158: per-car brake-lamp lateral positions for the Akira speed trail.
 *
 * Each entry is a list of lateral offsets as FRACTIONS of the car's
 * half-width (negative = left of centerline, positive = right). The
 * trail renderer emits one streak per lamp, so a quad-tail car leaves
 * four streaks instead of the generic two.
 *
 * Default (two corner lamps at ±0.72) matches the rear-lamp halo
 * anchor gameLoop uses (`_tlOff = _carHalfW * 0.72`), which is where
 * most production cars carry their brake lights.
 *
 * QUAD_ROUND values are derived from the R34 genData taillight
 * geometry (gtrR34.ts: tw = hw·0.82, lamp centers at ±(tw−0.6) and
 * ±(tw−2.5) with W = 1785 mm): outer pair ≈ ±0.71·hw, inner pair
 * ≈ ±0.37·hw.
 *
 * Matching is by car NAME substring (same convention as
 * resolveLegacyBodyType in drawTopCar.ts) so one entry covers every
 * catalog variant of a chassis. Extend the ladder as more references
 * are confirmed — keep entries to real, verifiable lamp layouts.
 */

export const DEFAULT_BRAKE_LAMP_FRACS: readonly number[] = [-0.72, 0.72];

/** 2×2 quad round tails — outer + inner lamp per side. */
const QUAD_ROUND: readonly number[] = [-0.71, -0.37, 0.37, 0.71];

/** Resolve a car's brake-lamp layout from its display name. */
export function brakeLampFracsFor(carName: string | undefined): readonly number[] {
  if (!carName) return DEFAULT_BRAKE_LAMP_FRACS;
  // Nissan Skyline — quad round tails are the brand signature (R30
  // through R34, GT-R and GTS alike).
  if (carName.includes('Skyline')) return QUAD_ROUND;
  // Chevrolet Corvette — quad round tails from C2 through C5.
  if (carName.includes('Corvette')) return QUAD_ROUND;
  return DEFAULT_BRAKE_LAMP_FRACS;
}
