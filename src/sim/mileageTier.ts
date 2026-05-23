/**
 * Mileage-tier classifier — buckets a car's odometer into
 * 'new' / 'mid' / 'high' based on real-world miles. Drives the
 * pause-menu STATUS tab tier label AND the diagnoseFault path's
 * minTier eligibility filter (the latter still deferred —
 * FAULT_POOLS port pending).
 *
 * H530: 1:1 port of monolith getMileageTier at L42862-L42867.
 * Pure function; reads only the supplied odometer reading.
 *
 * Mileage cutoffs:
 *   0     - 59999 mi  → 'new'   (LOW MILES label)
 *   60000 - 149999 mi → 'mid'   (MID MILES label)
 *   150000+      mi  → 'high'  (HIGH MILES label)
 *
 * The 60k / 150k boundaries are calibrated against the monolith's
 * fault-pool minTier gating — 'new' cars can never roll mid-tier
 * faults (timing-belt etc.), 'mid' cars can roll mid-but-not-high,
 * 'high' cars roll everything. The pause-menu label is the
 * player-facing surface of the same classification.
 */

import { MILES_PER_GAME_UNIT } from '@/physics/physicsUnits';

/** Game-units-to-miles conversion factor. Re-exported from the
 *  canonical [[physicsUnits]] module — kept on this surface for
 *  callers that already imported it from here before the H531
 *  canonicalization. New callers should import directly from
 *  `@/physics/physicsUnits`. */
export { MILES_PER_GAME_UNIT };

/** Discriminated tier identifier. 'new'/'mid'/'high' strings
 *  match the monolith literally so the diagnoseFault FAULT_POOLS
 *  minTier filter (when ported) can string-equal against this
 *  helper's output directly. */
export type MileageTier = 'new' | 'mid' | 'high';

/** Mileage threshold (miles) for the 'mid' tier — at or above
 *  this, a car has accumulated meaningful wear and starts
 *  eligible for the mid-tier fault pool. Matches monolith
 *  `if (mi < 60000) return 'new'` at L42866. */
export const MILEAGE_TIER_MID_THRESHOLD_MI = 60000;

/** Mileage threshold (miles) for the 'high' tier — heavily worn
 *  vehicles eligible for all fault categories including the
 *  expensive overhauls. Matches monolith `if (mi < 150000) return
 *  'mid'` at L42866. */
export const MILEAGE_TIER_HIGH_THRESHOLD_MI = 150000;

/** Display label for each tier — the strings the pause-menu
 *  STATUS tab paints alongside the odometer. Stored as a Record
 *  so callers don't string-switch (and so the labels stay
 *  centralized for any localization pass). */
export const MILEAGE_TIER_LABELS: Readonly<Record<MileageTier, string>> = {
  new: 'LOW MILES',
  mid: 'MID MILES',
  high: 'HIGH MILES',
};

/** Classify the given odometer reading into one of the three
 *  mileage tiers. Takes raw game-units (the storage format
 *  carOdometers uses); converts internally to miles before
 *  bucketing.
 *
 *  Ported 1:1 from monolith L42862-L42867. */
export function getMileageTier(rawOdoUnits: number): MileageTier {
  const mi = rawOdoUnits * MILES_PER_GAME_UNIT;
  if (mi < MILEAGE_TIER_MID_THRESHOLD_MI) return 'new';
  if (mi < MILEAGE_TIER_HIGH_THRESHOLD_MI) return 'mid';
  return 'high';
}

/** Convenience: classify + look up the display label in one call.
 *  Equivalent to MILEAGE_TIER_LABELS[getMileageTier(units)]. */
export function getMileageTierLabel(rawOdoUnits: number): string {
  return MILEAGE_TIER_LABELS[getMileageTier(rawOdoUnits)];
}
