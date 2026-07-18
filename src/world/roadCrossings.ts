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
import { parseIntersectionRow, type IntersectionControl } from '@/editor/intersectionSchema';
// H1178: leg existence is judged against where the PAINTER actually
// puts the decals, so the threshold must ride the same lane-
// standardized width model crosswalks.ts + the worldMap box quad use
// (crossingGeom is a leaf module — no render-side state).
import { crossingDecalOffset, crossingSinTheta } from '@/render/roads/crossingGeom';

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
  /** H1178: road names (row[2]) — laneStandardizedWidth needs them
   *  (I-485 has a bespoke profile), so the decal painter can compute
   *  the same lane-standardized asphalt widths the junction box uses
   *  instead of sizing from raw row tiles. */
  name1: string;
  name2: string;
  /** H1178: baked decal offsets (world px), measured ALONG each road
   *  from the crossing point to where that road's crosswalk band
   *  paints — the PEER road's lane-standardized asphalt half stretched
   *  by obliquity plus the junction-box margin (crossingGeom.
   *  crossingDecalOffset). The stop bar paints 3 px past the band.
   *  Baked once here so the painter AND the traffic AI's stop/brake
   *  distances read the same number — cars halt at the painted bar,
   *  not at a constant tuned to a dead formula. */
  decalOff1: number;
  decalOff2: number;
  /** Road 1 is a major (highway / arterial). */
  maj1: boolean;
  /** Road 2 is a major. */
  maj2: boolean;
  /** True if either road is a major. Convenience flag. */
  anyMajor: boolean;
  /** H288: z-level of each road at the crossing. When either > 1 the
   *  crossing is a BRIDGE OVERLAP — one road is elevated above the
   *  other, there's no surface intersection, and crosswalks / stop
   *  bars / traffic signals must NOT paint here. Mirrors monolith
   *  c.r1z / c.r2z used by the L31624 bridge-crossing skip. */
  z1: number;
  z2: number;
  /** H1042: authored intersection control (0 uncontrolled .. 4 signal),
   *  overlaid by applyAuthoredIntersections. `undefined` = no authored
   *  intersection here → today's default (a synced signal), so every existing
   *  reader is untouched. */
  control?: IntersectionControl;
  /** H1042: authored per-approach through-lane counts [+ang1,-ang1,+ang2,-ang2]. */
  laneCounts?: [number, number, number, number];
  /** H1042: authored turn-lane bitfield (2 bits/leg). */
  turnMask?: number;
  /** H1042: signal phase offset (ms, 0..cycle) so authored signals desync
   *  instead of all blinking in lockstep. Derived from the crossing position
   *  (the v1 row carries no phase). Consumed by getSignalStatesFor (H1043). */
  phaseOff?: number;
  /** H1177: which of the four approach LEGS physically exist —
   *  [road1 forward (+ang1), road1 back, road2 forward (+ang2), road2
   *  back]. A leg exists when its road's polyline CONTINUES past the
   *  crossing point far enough to carry the decals (H1178: the same
   *  lane-standardized crossingDecalOffset the painter uses — see
   *  decalOff1/decalOff2 — plus a bar margin). Fixes crosswalks/stop
   *  bars floating on grass at L-corners and T-junctions, where the
   *  painter assumed four legs everywhere. */
  legs?: [boolean, boolean, boolean, boolean];
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

/** Build the intersection list from the supplied rows. Pure function —
 *  the public entry points (initial build + rebuildRoadCrossings) wrap
 *  this with the actual data source. */
/** H965: continuation-seam rejection. Two rows that meet END-to-END
 *  while near-collinear are ONE road continuing (an unfused straight
 *  join, a material-change split, a welded bridge approach) — not an
 *  intersection. intersectSegments still "hits" at the shared point
 *  (t=1,u=0), which grew a phantom mid-road traffic signal at every
 *  such seam (user report: signal where the road material changes —
 *  and with ang1≈ang2 the axis assignment is a coin flip, so cars
 *  matched the OTHER axis and drove through the rendered red).
 *  T-junctions (one terminal, one interior) and X crossings (both
 *  interior) keep their crossings unchanged; so do perpendicular
 *  end-to-end corners (axis diff ≥ 30°). */
const END_TOUCH_EPS2 = (TILE * 1.5) * (TILE * 1.5);
const CONTINUATION_AXIS_TOL = Math.PI / 6;
function nearTerminal(c: RoadCache, x: number, y: number): boolean {
  const v0 = c.verts[0];
  const vN = c.verts[c.verts.length - 1];
  const d0 = (v0.x - x) * (v0.x - x) + (v0.y - y) * (v0.y - y);
  if (d0 <= END_TOUCH_EPS2) return true;
  const dN = (vN.x - x) * (vN.x - x) + (vN.y - y) * (vN.y - y);
  return dN <= END_TOUCH_EPS2;
}

/** H1177: arc distance from the hit point to each end of a road's
 *  polyline — forward = toward the LAST vertex (the +tangent direction
 *  intersectSegments' ang encodes), back = toward the first. */
function legReach(
  c: RoadCache,
  segIdx: number,
  hx: number,
  hy: number,
): { fwd: number; back: number } {
  const v = c.verts;
  const b = v[segIdx + 1];
  let fwd = Math.hypot(b.x - hx, b.y - hy);
  for (let k = segIdx + 1; k + 1 < v.length; k++) {
    fwd += Math.hypot(v[k + 1].x - v[k].x, v[k + 1].y - v[k].y);
  }
  const a = v[segIdx];
  let back = Math.hypot(hx - a.x, hy - a.y);
  for (let k = 0; k < segIdx; k++) {
    back += Math.hypot(v[k + 1].x - v[k].x, v[k + 1].y - v[k].y);
  }
  return { fwd, back };
}

function buildCrossings(rows: ReadonlyArray<BaselineRoadRow>): RoadCrossing[] {
  const out: RoadCrossing[] = [];
  const caches: RoadCache[] = rows.map(cacheRoad);
  // Dedup: a single physical intersection may show up multiple times
  // when two roads share several near-coincident segments. Cluster by
  // 6-tile snap so we keep one crossing per location.
  // H1177: value = the kept crossing, so a SECOND pair-hit snapping to
  // the same junction can mark it COMPOSITE (a 4-way built from a
  // through road + stub rows). Composite junctions keep all four legs
  // — the pair-based leg walk only sees one pair and would wrongly
  // strip a real leg's decals.
  const seen = new Map<string, RoadCrossing>();
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
          // H965: continuation seam — end-to-end touch of two near-
          // collinear rows is one road continuing, not an intersection.
          const rawDiff = Math.abs(hit.ang1 - hit.ang2) % Math.PI;
          const axisDiff = Math.min(rawDiff, Math.PI - rawDiff);
          if (
            axisDiff < CONTINUATION_AXIS_TOL
            && nearTerminal(ci, hit.x, hit.y)
            && nearTerminal(cj, hit.x, hit.y)
          ) continue;
          const key = `${Math.round(hit.x / SNAP)},${Math.round(hit.y / SNAP)}`;
          const prior = seen.get(key);
          if (prior) {
            // H1177: composite junction — restore all legs (see Map note).
            prior.legs = [true, true, true, true];
            continue;
          }
          const maj1 = ci.row[1] === 1;
          const maj2 = cj.row[1] === 1;
          const name1 = String(ci.row[2] ?? '');
          const name2 = String(cj.row[2] ?? '');
          // H1177: leg existence — how far each road CONTINUES past the
          // hit in each direction vs where that road's decals would sit
          // (H1178: the shared lane-standardized offset formula the
          // painter uses, + bar margin). Short reach = the leg doesn't
          // exist (corner/tee).
          const _r1 = legReach(ci, p, hit.x, hit.y);
          const _r2 = legReach(cj, q, hit.x, hit.y);
          const _sinT = crossingSinTheta(hit.ang1, hit.ang2);
          const _off1 = crossingDecalOffset(name2, cj.row[0] as number, _sinT);
          const _off2 = crossingDecalOffset(name1, ci.row[0] as number, _sinT);
          const _need1 = _off1 + 10;
          const _need2 = _off2 + 10;
          const _crossing: RoadCrossing = {
            x: hit.x,
            y: hit.y,
            ang1: hit.ang1,
            ang2: hit.ang2,
            legs: [
              _r1.fwd >= _need1, _r1.back >= _need1,
              _r2.fwd >= _need2, _r2.back >= _need2,
            ],
            w1: ci.row[0],
            w2: cj.row[0],
            name1,
            name2,
            decalOff1: _off1,
            decalOff2: _off2,
            maj1,
            maj2,
            anyMajor: maj1 || maj2,
            // H288: z-level from row[3]. Consumers check `z1 > 1 || z2 > 1`
            // to identify bridge-over-road overlaps (e.g. I-485 z=3
            // crossing I-77 z=2, or any highway crossing a ground road).
            z1: ci.row[3] as number,
            z2: cj.row[3] as number,
          };
          seen.set(key, _crossing);
          out.push(_crossing);
        }
      }
    }
  }
  return out;
}

/** The intersection list consumed by traffic AI (H113 signal phase
 *  check) + the H114 signal-cone render. Mutable so the H129 rebuild
 *  hook can refresh it in place without breaking import references.
 *  Consumers iterate; they do not mutate. */
export const ROAD_CROSSINGS: RoadCrossing[] = buildCrossings(BASELINE_ROADS);

/** H129: rebuild the intersection list from the supplied row list.
 *  Called from the editor's Ctrl+S handler with the freshly-rebuilt
 *  RENDER_ENTRIES so a newly-drawn road that crosses an existing
 *  highway grows a traffic signal in-session, without a page reload.
 *  Mutates ROAD_CROSSINGS in place — preserves the const-reference
 *  contract callers depend on. */
export function rebuildRoadCrossings(rows: ReadonlyArray<BaselineRoadRow>): void {
  const fresh = buildCrossings(rows);
  ROAD_CROSSINGS.length = 0;
  for (const c of fresh) ROAD_CROSSINGS.push(c);
}

/** Stable pseudo-random signal phase offset (ms, 0..15999) from a crossing's
 *  world position — deterministic so a given intersection always lands on the
 *  same phase across reloads. */
function phaseOffsetFor(x: number, y: number): number {
  const h = ((Math.round(x) * 73856093) ^ (Math.round(y) * 19349663)) >>> 0;
  return h % 16000;
}

/** H1042: overlay authored intersection rows (the ACTIVE map's
 *  overlay.intersections — ['isect', control, la0..3, turnMask, x, y]) onto the
 *  nearest detected ROAD_CROSSINGS entry, so authored control types reach the
 *  in-game render. IDEMPOTENT: clears the authored fields on every crossing
 *  first, so re-applying after a rebuild never leaves stale data. Call it after
 *  every rebuildRoadCrossings AND once at boot; the CALLER passes the rows
 *  (roadCrossings must not import mapRuntime — it would cycle via editor/render).
 *  Row x/y are tile coords; crossing x/y are world px (tile*TILE), snap ~6t. */
export function applyAuthoredIntersections(rows: readonly unknown[]): void {
  for (const c of ROAD_CROSSINGS) {
    c.control = undefined;
    c.laneCounts = undefined;
    c.turnMask = undefined;
    c.phaseOff = undefined;
  }
  if (!rows || rows.length === 0) return;
  const snap2 = (TILE * 6) * (TILE * 6);
  for (const raw of rows) {
    const it = parseIntersectionRow(raw);
    if (!it) continue;
    const wx = it.x * TILE, wy = it.y * TILE;
    let best: RoadCrossing | null = null;
    let bestD2 = snap2;
    for (const c of ROAD_CROSSINGS) {
      const dx = c.x - wx, dy = c.y - wy;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; best = c; }
    }
    if (!best) continue;
    best.control = it.control;
    best.laneCounts = it.laneCounts;
    best.turnMask = it.turnMask;
    best.phaseOff = phaseOffsetFor(best.x, best.y);
  }
}
