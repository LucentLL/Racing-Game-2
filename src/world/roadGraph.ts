/**
 * Road-graph traversal helpers consumed by the traffic AI.
 *
 * findConnectingRoad answers "given that a traffic car has just reached
 * point `pt` on its current road, which OTHER road (if any) is close
 * enough to count as connected here, and where does the car re-enter
 * that road?"
 *
 * Determinism note: the inner intermediate-vertex branch picks a random
 * forward direction (Math.random() > 0.5). The monolith comment at
 * L5283 / L26691 emphasizes findConnectingRoad is "deterministic — every
 * car reaching the same point at the same time would get the same
 * answer" because Math.random() is shared global state and every call
 * advances it together. Don't replace with a seeded RNG without
 * also accounting for that shared advancement.
 *
 * Monolith source: L28148-L28168.
 */

import type { Road } from '@/render/roads/types';

/** Result of a successful connection lookup. */
export interface RoadConnection {
  /** The road the traffic car should re-enter. */
  road: Road;
  /** Segment index along `road.pts` to start from (the index of the
   *  first vertex of the segment, NOT necessarily the closest vertex). */
  segIdx: number;
  /** Parameter along that segment in [0, 1]. 0 means "at vertex segIdx";
   *  1 means "at vertex segIdx + 1". The intermediate-vertex branch
   *  always sets segT = 0 (re-enter exactly at the matched vertex). */
  segT: number;
  /** Direction along `road.pts` after entry: 1 = ascending index,
   *  -1 = descending. */
  forward: 1 | -1;
}

/** Connection threshold (tiles). v8.90 bumped from 3 → 5 — at 5 tiles
 *  the matcher reliably picks up shared-endpoint highway interchanges
 *  whose endpoints don't sit exactly on the same vertex (pre-baked
 *  road data has some rounding). */
const CONNECTION_THRESHOLD = 5;

/** Find a road in `roads` (other than `currentRoad`) whose nearest
 *  vertex to `pt` is within CONNECTION_THRESHOLD tiles. Returns
 *  metadata for re-entry: which road, which segment, and which
 *  direction to travel.
 *
 *  Scan order: for each candidate road, check its start endpoint
 *  first (segIdx 0, segT 0, forward +1), then its end endpoint
 *  (segIdx last-1, segT 1, forward -1), then each intermediate vertex
 *  (segIdx i, segT 0, forward random ±1). The strict `<` comparison
 *  on bestDist means earlier candidates win ties — start over end
 *  over intermediate.
 *
 *  v8.90: all road types participate. Previously the matcher filtered
 *  to I-/US-/Ramp/Exit highways only; now traffic can transition
 *  between highways and surface streets at any shared endpoint or
 *  near-endpoint junction.
 *
 *  Returns null when no road is within threshold.
 *
 *  Ported 1:1 from monolith L28148-L28168 findConnectingRoad. */
export function findConnectingRoad(
  currentRoad: Road,
  pt: readonly [number, number],
  roads: ReadonlyArray<Road>,
): RoadConnection | null {
  const cityRoads = roads.filter((r) => r !== currentRoad && r.pts.length >= 2);
  let best: RoadConnection | null = null;
  let bestDist = CONNECTION_THRESHOLD;
  for (const r of cityRoads) {
    const last = r.pts.length - 1;
    const d0 = Math.sqrt(
      (r.pts[0][0] - pt[0]) ** 2 + (r.pts[0][1] - pt[1]) ** 2,
    );
    if (d0 < bestDist) {
      bestDist = d0;
      best = { road: r, segIdx: 0, segT: 0, forward: 1 };
    }
    const dN = Math.sqrt(
      (r.pts[last][0] - pt[0]) ** 2 + (r.pts[last][1] - pt[1]) ** 2,
    );
    if (dN < bestDist) {
      bestDist = dN;
      best = { road: r, segIdx: last - 1, segT: 1, forward: -1 };
    }
    for (let i = 1; i < last; i++) {
      const d = Math.sqrt(
        (r.pts[i][0] - pt[0]) ** 2 + (r.pts[i][1] - pt[1]) ** 2,
      );
      if (d < bestDist) {
        bestDist = d;
        best = {
          road: r,
          segIdx: i,
          segT: 0,
          forward: Math.random() > 0.5 ? 1 : -1,
        };
      }
    }
  }
  return best;
}
