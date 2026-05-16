/**
 * H57 — detect road intersections from BASELINE_ROADS at module init.
 *
 * Walks every (road-i, road-j) pair (i < j) and finds any
 * segment-segment intersections, storing world-coord position + the
 * tangent angle of each approach for the renderer. With ~130 roads
 * the brute force is bounded — each road has a precomputed bbox, so
 * pairs whose bboxes don't overlap are skipped in O(1).
 *
 * Output is a frozen array consumed by the crosswalk + stop-bar
 * render passes. Matches the monolith's roadCrossings data shape
 * (L9624-9728-equivalent — minus the bridge / z-level metadata that
 * ports with the bridge subsystem).
 */

import { BASELINE_ROADS, type BaselineRoadRow } from '@/config/world/baselineRoads';
import { TILE } from '@/config/world/tiles';

export interface RoadCrossing {
  /** World-coord intersection point (canvas px). */
  x: number;
  y: number;
  /** Tangent angle of road 1 at the crossing (radians). */
  ang1: number;
  /** Tangent angle of road 2 at the crossing (radians). */
  ang2: number;
  /** Road 1 width (tiles). */
  w1: number;
  /** Road 2 width (tiles). */
  w2: number;
  /** True if either road is a major (highway / arterial). */
  anyMajor: boolean;
}

interface RoadCache {
  row: BaselineRoadRow;
  /** Vertices as (worldX, worldY) tuples. */
  verts: { x: number; y: number }[];
  /** Bounding box in world coords. */
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Convert a baseline-roads row into the cache format used by the
 *  intersection sweep. Vertex coords baked to world px so the inner
 *  loop avoids the TILE multiplication. */
function cacheRoad(row: BaselineRoadRow): RoadCache {
  const ptsFlat = row.slice(4) as readonly number[];
  const verts: { x: number; y: number }[] = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < ptsFlat.length; i += 2) {
    const x = (ptsFlat[i]     as number) * TILE;
    const y = (ptsFlat[i + 1] as number) * TILE;
    verts.push({ x, y });
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { row, verts, minX, maxX, minY, maxY };
}

/** Segment-segment intersection. Returns {x, y, ang1, ang2} on a hit,
 *  null on parallel / non-overlapping segments. */
function intersectSegments(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): { x: number; y: number; ang1: number; ang2: number } | null {
  const r = { x: bx - ax, y: by - ay };
  const s = { x: dx - cx, y: dy - cy };
  const det = r.x * s.y - r.y * s.x;
  if (Math.abs(det) < 1e-6) return null;
  const qpx = cx - ax;
  const qpy = cy - ay;
  const t = (qpx * s.y - qpy * s.x) / det;
  const u = (qpx * r.y - qpy * r.x) / det;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return {
    x: ax + r.x * t,
    y: ay + r.y * t,
    ang1: Math.atan2(r.y, r.x),
    ang2: Math.atan2(s.y, s.x),
  };
}

function bboxOverlap(a: RoadCache, b: RoadCache): boolean {
  return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
}

/** Build the intersection list. Called once at module init. */
function buildCrossings(): RoadCrossing[] {
  const out: RoadCrossing[] = [];
  const caches: RoadCache[] = BASELINE_ROADS.map(cacheRoad);
  // Dedup: a single physical intersection may show up multiple times
  // when two roads share several near-coincident segments. Cluster by
  // 6-tile snap so we keep one crossing per location.
  const seen = new Set<string>();
  const SNAP = TILE * 6;
  for (let i = 0; i < caches.length; i++) {
    for (let j = i + 1; j < caches.length; j++) {
      const ci = caches[i];
      const cj = caches[j];
      if (!bboxOverlap(ci, cj)) continue;
      const vi = ci.verts;
      const vj = cj.verts;
      for (let p = 0; p + 1 < vi.length; p++) {
        const a = vi[p];
        const b = vi[p + 1];
        // Per-segment bbox cull against road j's overall bbox.
        const sMinX = Math.min(a.x, b.x);
        const sMaxX = Math.max(a.x, b.x);
        const sMinY = Math.min(a.y, b.y);
        const sMaxY = Math.max(a.y, b.y);
        if (sMaxX < cj.minX || sMinX > cj.maxX) continue;
        if (sMaxY < cj.minY || sMinY > cj.maxY) continue;
        for (let q = 0; q + 1 < vj.length; q++) {
          const c = vj[q];
          const d = vj[q + 1];
          const hit = intersectSegments(a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y);
          if (!hit) continue;
          const key = `${Math.round(hit.x / SNAP)},${Math.round(hit.y / SNAP)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            x: hit.x,
            y: hit.y,
            ang1: hit.ang1,
            ang2: hit.ang2,
            w1: ci.row[0],
            w2: cj.row[0],
            anyMajor: ci.row[1] === 1 || cj.row[1] === 1,
          });
        }
      }
    }
  }
  return out;
}

export const ROAD_CROSSINGS: readonly RoadCrossing[] = buildCrossings();
