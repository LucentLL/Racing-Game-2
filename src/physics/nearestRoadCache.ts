/**
 * Per-frame nearest-road cache producer (the v8.66 perf refactor).
 *
 * Originally update() at L23764-L23798 in the monolith ran the same
 * "what's the nearest road to (px, py)?" scan THREE times per frame —
 * once for the speed-limit lookup, once for surface-overlay detection,
 * and once for the HUD's "current road name" badge. With ~329 road
 * segments to project against, that's ~990 redundant per-frame math
 * iterations. v8.66 collapsed all three into a single scan that
 * populates two slots:
 *
 *   - `ne`     — nearest road of ANY kind (arterial, ramp, residential).
 *                Read by: speed-limit lookup, HUD road-name badge, the
 *                v8.98.57 onRoad fallback for non-highway roads.
 *   - `neMaj`  — nearest road with `maj=true` OR a `Ramp*` name.
 *                Read by: the primary onRoad detection that drives
 *                surface-vs-grass physics.
 *
 * Same per-segment math runs once per road, both caches updated in
 * lockstep — `ne` always tracks the closest, `neMaj` tracks the
 * closest among the major / ramp subset.
 *
 * BBOX CULL: each road carries a precomputed bbox (`road._bbox`) in
 * world pixels. The cache loop bails on roads whose bbox doesn't sit
 * within `(road.w + 2 + 3*road.w) * TILE` of (px, py) — a generous
 * reach buffer matching the monolith's `(_nr.w || 1) * TILE * 3 +
 * TILE * 2`. Roads without a memoized bbox fall through to the full
 * per-segment scan; bbox memoization is a render-pipeline product
 * and may not be populated during early-init frames.
 *
 * Includes `seg` (the closest segment index) for parity with the
 * monolith; no current consumer reads it, but the field is preserved
 * so downstream ports can pick it up without re-touching the
 * producer.
 */

import type { Road } from '@/render/roads/types';

/** Single cache entry — the nearest road of a particular kind. */
export interface NearestRoadEntry {
  /** The road, or null when no road is in range / majorRoads is empty. */
  road: Road | null;
  /** Squared perpendicular distance from the player to the road's
   *  closest segment, in TILE² units. Compare against (radius)² to
   *  avoid sqrt. Infinity when road is null. */
  dist2: number;
  /** Index of the closest segment (0..N-2) within the road's pts.
   *  0 when road is null. Currently no consumer reads this; preserved
   *  for parity with the monolith. */
  seg: number;
}

/** Two-slot cache produced once per frame. */
export interface NearestRoadCachePair {
  /** Nearest road of any kind. */
  ne: NearestRoadEntry;
  /** Nearest road in the major / ramp subset. */
  neMaj: NearestRoadEntry;
}

/** Compute both caches for the player's current world-pixel position.
 *
 *  Iterates `majorRoads` once. For each road that passes the bbox
 *  cull and has a non-empty name and w >= 1, projects (px, py) onto
 *  every segment of its polyline. Tracks the minimum squared distance
 *  in `ne`; if the road also satisfies the major / Ramp* gate, tracks
 *  it in `neMaj` too.
 *
 *  Inputs are world pixels — same convention as the player position.
 *  Internal math runs in tile coords (px/TILE, py/TILE), matching the
 *  monolith's per-vertex tile coordinate space.
 *
 *  Returns a fresh cache pair each call. Caller stashes the result
 *  somewhere physics consumers can read on the same frame (the
 *  monolith uses globals; the modular tree threads through state /
 *  injection).
 *
 *  Ported 1:1 from monolith L23770-L23799 (the per-frame populator
 *  block at the top of update()). */
export function computeNearestRoadCache(
  px: number,
  py: number,
  majorRoads: ReadonlyArray<Road>,
  TILE: number,
): NearestRoadCachePair {
  const ne: NearestRoadEntry = { road: null, dist2: Infinity, seg: 0 };
  const neMaj: NearestRoadEntry = { road: null, dist2: Infinity, seg: 0 };
  if (majorRoads.length === 0) return { ne, neMaj };

  const ptx = px / TILE;
  const pty = py / TILE;

  for (const r of majorRoads) {
    if (!r.name || r.w < 1) continue;
    const bb = r._bbox;
    if (bb) {
      const reach = (r.w || 1) * TILE * 3 + TILE * 2;
      if (bb.maxX < px - reach || bb.minX > px + reach
        || bb.maxY < py - reach || bb.minY > py + reach) {
        continue;
      }
    }
    const isMaj = !!(r.maj || (r.name && r.name.startsWith('Ramp')));
    const pts = r.pts;
    for (let i = 0; i < pts.length - 1; i++) {
      const ax = pts[i][0];
      const ay = pts[i][1];
      const bx = pts[i + 1][0];
      const by = pts[i + 1][1];
      const rdx = bx - ax;
      const rdy = by - ay;
      const len2 = rdx * rdx + rdy * rdy;
      if (len2 < 0.01) continue;
      let t = ((ptx - ax) * rdx + (pty - ay) * rdy) / len2;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const cx = ax + t * rdx;
      const cy = ay + t * rdy;
      const d2 = (ptx - cx) ** 2 + (pty - cy) ** 2;
      if (d2 < ne.dist2) {
        ne.dist2 = d2;
        ne.road = r;
        ne.seg = i;
      }
      if (isMaj && d2 < neMaj.dist2) {
        neMaj.dist2 = d2;
        neMaj.road = r;
        neMaj.seg = i;
      }
    }
  }

  return { ne, neMaj };
}
