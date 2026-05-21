/**
 * Pure geometric helpers for the bridge collision / layer-transition
 * system. Six stateless functions — OBB corners, segment-vs-segment,
 * point-vs-line side, segment-vs-AABB, OBB-vs-segment, point-in-poly,
 * ramp climb fraction. Underpin the per-tick bridge collision tests
 * and the elevation-layer transition logic.
 *
 * All inputs / outputs are in WORLD PIXELS (tile × TILE), matching
 * the monolith's bridge subsystem convention. Caller is responsible
 * for any tile↔pixel conversion.
 *
 * Monolith source: L28215-L28290.
 */

/** A single 2D point as a [x, y] tuple. Bridge geometry uses tuple
 *  form throughout to match the monolith's `poly[i]` indexing. */
export type Point2 = readonly [number, number];

/** 4 corners of a car OBB given center + heading + half-extents.
 *  Returns in order [FL, FR, BR, BL] — front-left, front-right,
 *  back-right, back-left when viewed in the car's local frame.
 *
 *  halfL is forward extent (toward the nose); halfW is right
 *  extent (toward the passenger door in a US RHD car). All inputs
 *  + outputs in world pixels.
 *
 *  Ported 1:1 from monolith L28215-L28223 _bridgeGetCorners. */
export function bridgeGetCorners(
  cx: number,
  cy: number,
  angle: number,
  halfL: number,
  halfW: number,
): readonly [Point2, Point2, Point2, Point2] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [
    [cx + halfL * c - halfW * s, cy + halfL * s + halfW * c],
    [cx + halfL * c + halfW * s, cy + halfL * s - halfW * c],
    [cx - halfL * c + halfW * s, cy - halfL * s - halfW * c],
    [cx - halfL * c - halfW * s, cy - halfL * s + halfW * c],
  ];
}

/** Two line segments intersect (proper intersection — colinear /
 *  endpoint-touching cases return false). Uses the CCW orientation
 *  test on each pair of triples.
 *
 *  Returns true iff segment A=(ax,ay)→(bx,by) properly crosses
 *  segment B=(cx,cy)→(dx,dy).
 *
 *  Ported 1:1 from monolith L28226-L28232 _bridgeSegsCross. */
export function bridgeSegsCross(
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number,
  dx: number, dy: number,
): boolean {
  const ccw = (px: number, py: number, qx: number, qy: number, rx: number, ry: number): boolean =>
    (ry - py) * (qx - px) > (qy - py) * (rx - px);
  return (
    ccw(ax, ay, cx, cy, dx, dy) !== ccw(bx, by, cx, cy, dx, dy) &&
    ccw(ax, ay, bx, by, cx, cy) !== ccw(ax, ay, bx, by, dx, dy)
  );
}

/** Is point P strictly left of the directed segment from (x1,y1)
 *  to (x2,y2)? Used by ramp triggers — endpoints are arranged so
 *  "left of direction" = "inside the ramp's entry zone".
 *
 *  Returns true on the strictly-left side; false on the line or
 *  to the right.
 *
 *  Ported 1:1 from monolith L28236-L28238 _bridgeIsLeftOfLine. */
export function bridgeIsLeftOfLine(
  px: number, py: number,
  x1: number, y1: number,
  x2: number, y2: number,
): boolean {
  return (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1) > 0;
}

/** Segment vs axis-aligned bounding box. Fires true when either
 *  endpoint sits inside the AABB OR the segment crosses any of
 *  the four box edges. Used as the inner test for OBB-vs-segment
 *  (rotate segment into OBB local frame → AABB test).
 *
 *  Ported 1:1 from monolith L28241-L28249 _bridgeSegIntersectsAABB. */
export function bridgeSegIntersectsAABB(
  x1: number, y1: number,
  x2: number, y2: number,
  minX: number, minY: number,
  maxX: number, maxY: number,
): boolean {
  if (x1 >= minX && x1 <= maxX && y1 >= minY && y1 <= maxY) return true;
  if (x2 >= minX && x2 <= maxX && y2 >= minY && y2 <= maxY) return true;
  if (bridgeSegsCross(x1, y1, x2, y2, minX, minY, maxX, minY)) return true;
  if (bridgeSegsCross(x1, y1, x2, y2, maxX, minY, maxX, maxY)) return true;
  if (bridgeSegsCross(x1, y1, x2, y2, maxX, maxY, minX, maxY)) return true;
  if (bridgeSegsCross(x1, y1, x2, y2, minX, maxY, minX, minY)) return true;
  return false;
}

/** OBB vs line segment (state intersection — true even when the OBB
 *  is partially across the segment, not just when corners are on
 *  opposite sides). Rotates segment endpoints into OBB local frame
 *  via inverse rotation matrix, then runs the AABB intersection
 *  test against the OBB's local extents.
 *
 *  This is what prevents the "ratcheting through a wall" bug from
 *  the earlier corner-path collision approach — corner-path checks
 *  miss the case where a barrier passes through the OBB without
 *  any corner crossing it (e.g. centered impact).
 *
 *  Ported 1:1 from monolith L28255-L28262 _bridgeObbIntersectsSegment. */
export function bridgeObbIntersectsSegment(
  cx: number, cy: number,
  angle: number,
  halfL: number, halfW: number,
  x1: number, y1: number,
  x2: number, y2: number,
): boolean {
  const c = Math.cos(-angle);
  const s = Math.sin(-angle);
  const dx1 = x1 - cx;
  const dy1 = y1 - cy;
  const dx2 = x2 - cx;
  const dy2 = y2 - cy;
  const lx1 = dx1 * c - dy1 * s;
  const ly1 = dx1 * s + dy1 * c;
  const lx2 = dx2 * c - dy2 * s;
  const ly2 = dx2 * s + dy2 * c;
  return bridgeSegIntersectsAABB(lx1, ly1, lx2, ly2, -halfL, -halfW, halfL, halfW);
}

/** Even-odd point-in-polygon test for an arbitrary ring of [x, y]
 *  vertices. Edge-ray-crossing count: odd = inside, even = outside.
 *  Polygons may be convex or concave; the ring must not self-
 *  intersect (otherwise the parity test gives undefined results
 *  in the self-overlap zones).
 *
 *  Caller orders vertices CW or CCW — the test is orientation-
 *  insensitive.
 *
 *  Ported 1:1 from monolith L28265-L28276 _bridgePointInPoly. */
export function bridgePointInPoly(
  px: number, py: number,
  poly: ReadonlyArray<Point2>,
): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0];
    const yi = poly[i][1];
    const xj = poly[j][0];
    const yj = poly[j][1];
    if (
      yi > py !== yj > py &&
      px < ((xj - xi) * (py - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/** Ramp shape — explicit foot and top midpoints (in world pixels).
 *  The climb-fraction test projects an arbitrary point onto the
 *  foot→top centerline. */
export interface BridgeRamp {
  foot: Point2;
  top: Point2;
}

/** A single barrier segment on a bridge structure. x1/y1/x2/y2 in
 *  TILE COORDS (not pixels — converted at collision-test time).
 *  `l1only` gates the barrier to layer 1 (upper road); when false
 *  / undefined the barrier applies to every layer. */
export interface BridgeBarrier {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  l1only?: boolean;
}

/** A single bridge structure — a collection of barriers + triggers +
 *  deck polygons. _bbox is lazily memoized by the collision dispatcher
 *  for bbox-culling; collision-test reads but doesn't compute it on
 *  the hot path. Caller may pre-populate from structure-creation time. */
export interface BridgeStructure {
  barriers: ReadonlyArray<BridgeBarrier>;
  /** Lazily-memoized bbox in WORLD PIXELS. The collision dispatcher
   *  populates this on first use; passing it in pre-computed
   *  (catalog.ts / boot) lets the dispatcher skip the loop entirely.
   *  Caller-side mutation of the wrapper object is intentional —
   *  matches the monolith's `bs._bbox = {...}` memoization. */
  _bbox?: { minX: number; minY: number; maxX: number; maxY: number };
}

/** Bbox cull padding (world pixels). Generous so OBB extent + tile→
 *  pixel-scaled barrier endpoints all fit inside the buffer. Matches
 *  monolith L28347 `_CULL_PAD = 30`. */
export const BRIDGE_CULL_PAD = 30;

/** Compute the bbox of a bridge structure's barriers (world pixels).
 *  Caller assigns the result to `bs._bbox` for memoization. Pulled
 *  out as a named helper so structure-creation code can pre-compute
 *  bboxes at boot time, avoiding the lazy-compute branch in the
 *  hot collision loop.
 *
 *  Returns null when the structure has zero barriers — caller's
 *  early-out handles this case.
 *
 *  Ported 1:1 from monolith L28351-L28360 (the lazy-compute branch
 *  inside _bridgeBlocked). */
export function bridgeComputeBbox(
  structure: BridgeStructure,
  TILE: number,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const barriers = structure.barriers;
  if (barriers.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of barriers) {
    const bx1 = b.x1 * TILE;
    const by1 = b.y1 * TILE;
    const bx2 = b.x2 * TILE;
    const by2 = b.y2 * TILE;
    if (bx1 < minX) minX = bx1;
    if (bx2 < minX) minX = bx2;
    if (bx1 > maxX) maxX = bx1;
    if (bx2 > maxX) maxX = bx2;
    if (by1 < minY) minY = by1;
    if (by2 < minY) minY = by2;
    if (by1 > maxY) maxY = by1;
    if (by2 > maxY) maxY = by2;
  }
  return { minX, minY, maxX, maxY };
}

/** Player OBB half-extents for bridge collision (WORLD PIXELS).
 *  Tuned to give visible body clearance from rendered barrier
 *  strokes (1px car stroke + 1px barrier stroke margin). Matches
 *  monolith L28295-L28296. */
export const BRIDGE_PLAYER_HALF_L = 17;
export const BRIDGE_PLAYER_HALF_W = 10;

/** Returns true when the proposed car center (nx, ny) at heading
 *  `ang` on layer `layer` has its OBB intersecting any bridge
 *  barrier applicable to that layer. Caller rejects the move when
 *  true.
 *
 *  PIPELINE:
 *
 *    1. Empty BRIDGE_STRUCTURES → false (no barriers exist).
 *    2. For each structure:
 *       a. Skip empty (no barriers).
 *       b. Lazily compute + memoize _bbox if absent.
 *       c. Bbox cull — if (nx, ny) is outside (bbox ± BRIDGE_CULL_PAD)
 *          → skip the structure entirely.
 *       d. For each barrier:
 *          - Skip when l1only and layer !== 1.
 *          - Convert barrier endpoints tile→pixel.
 *          - Run bridgeObbIntersectsSegment. First hit → return true.
 *    3. Fall through → return false.
 *
 *  v8.99.126.21 history: REVERTED the v126.19/.20 generic z>=2
 *  fallback. Pre-drawn roads predate the World Editor's per-segment
 *  z system, so road-level z is unreliable for collision. Only the
 *  hardcoded BRIDGE_STRUCTURES list (real interchanges with
 *  explicit barriers) participates here.
 *
 *  Ported 1:1 from monolith L28307-L28378 _bridgeBlocked. */
export function bridgeBlocked(
  nx: number,
  ny: number,
  ang: number,
  layer: number,
  structures: ReadonlyArray<BridgeStructure>,
  TILE: number,
): boolean {
  if (structures.length === 0) return false;
  for (const bs of structures) {
    if (bs.barriers.length === 0) continue;
    if (!bs._bbox) {
      const computed = bridgeComputeBbox(bs, TILE);
      if (!computed) continue;
      // Memoize on the caller's object so subsequent ticks skip the
      // re-compute. Matches monolith's `bs._bbox = {...}` mutation
      // pattern.
      (bs as { _bbox?: typeof computed })._bbox = computed;
    }
    const bbox = bs._bbox;
    if (!bbox) continue;
    if (
      nx < bbox.minX - BRIDGE_CULL_PAD ||
      nx > bbox.maxX + BRIDGE_CULL_PAD ||
      ny < bbox.minY - BRIDGE_CULL_PAD ||
      ny > bbox.maxY + BRIDGE_CULL_PAD
    ) {
      continue;
    }
    for (const b of bs.barriers) {
      if (b.l1only && layer !== 1) continue;
      const bx1 = b.x1 * TILE;
      const by1 = b.y1 * TILE;
      const bx2 = b.x2 * TILE;
      const by2 = b.y2 * TILE;
      if (
        bridgeObbIntersectsSegment(
          nx, ny, ang,
          BRIDGE_PLAYER_HALF_L, BRIDGE_PLAYER_HALF_W,
          bx1, by1, bx2, by2,
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Climb fraction along a ramp's foot→top axis. Returns 0 at the
 *  foot midpoint, 1 at the top midpoint, with linear interpolation
 *  between. Projects (px, py) onto the foot→top centerline and
 *  clamps the result to [0, 1] so off-end positions don't extrapolate.
 *
 *  Used by the elevation-layer transition logic to interpolate
 *  player Z height across the ramp. Foot and top must be in world
 *  pixels (tile coords × TILE) — same convention as the rest of
 *  this module.
 *
 *  Degenerate ramps (foot ≈ top) return 0 to avoid divide-by-zero.
 *
 *  Ported 1:1 from monolith L28281-L28290 _bridgeRampClimbT. */
export function bridgeRampClimbT(
  ramp: BridgeRamp,
  px: number,
  py: number,
): number {
  const fx = ramp.foot[0];
  const fy = ramp.foot[1];
  const tx = ramp.top[0];
  const ty = ramp.top[1];
  const dx = tx - fx;
  const dy = ty - fy;
  const L2 = dx * dx + dy * dy;
  if (L2 < 0.01) return 0;
  let t = ((px - fx) * dx + (py - fy) * dy) / L2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return t;
}
