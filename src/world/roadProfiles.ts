/**
 * Road profile — per-road lane geometry derivable from road.w, road.lps,
 * road.medFrac, road.shoulderW. Cached on road._prof at preprocess time;
 * the renderer prefers the cached profile, falls back to a fresh
 * getRoadProfile(road) call.
 *
 * Ported from monolith L18657 (the getRoadProfile function).
 *
 * SCAFFOLD status: typed entry; body stubbed. The RoadProfile shape is
 * already defined in render/roads/types.ts and is re-exported here.
 */

import type { Road, RoadProfile } from '@/render/roads';

export type { RoadProfile };

/**
 * Computes the per-lane geometry (lane divider offsets, edge stripe
 * offsets, asphalt + total widths, median half) for a road. Pure
 * function — caller caches result on road._prof to skip recompute.
 *
 * TODO(C24-followup): port from monolith L18657. Internally:
 *   - lps = road.lps || 1
 *   - laneW = (totalW - 2*shoulderW) / (2*lps)   for divided
 *   - dividers = symmetric ± k*laneW for k in 1..lps-1
 *   - edgeOffsets = ±(halfW - 1.7/TILE) at 1.4px stripe width
 *   - innerEdgeOffsets = ±(medHalf + 1.7/TILE) for divided highways only
 */
export function getRoadProfile(_road: Road, _TILE: number): RoadProfile {
  // TODO: monolith L18657.
  return {
    asphaltW: 1, totalW: 1, laneW: 1, lps: 1, halfW: 0.5,
    effectiveMedHalf: 0, dividers: [], edgeOffsets: [],
  };
}
