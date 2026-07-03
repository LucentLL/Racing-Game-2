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

/** Ramp shape — explicit foot and top midpoints plus a polygon for
 *  point-in-test. All three fields must be in the SAME coordinate
 *  system (the climb-fraction test is unit-agnostic, but callers
 *  that mix tile coords and pixels will misbehave). The monolith's
 *  bridge structures store ramps in TILE COORDS — the renderer /
 *  collision callers convert at use time. The `poly` ring describes
 *  the ramp's footprint (typically 4 vertices, but the test
 *  tolerates any non-self-intersecting ring). */
export interface BridgeRamp {
  foot: Point2;
  top: Point2;
  poly: ReadonlyArray<Point2>;
}

/** A single barrier segment on a bridge structure. x1/y1/x2/y2 in
 *  TILE COORDS (not pixels — converted at collision-test time).
 *  `l1only` gates the barrier to layer 1 (upper road); `l0only`
 *  (H800) gates it to layer 0 (ground — the under-deck abutment
 *  walls). When neither is set the barrier applies to every layer. */
export interface BridgeBarrier {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  l1only?: boolean;
  l0only?: boolean;
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
  /** H839: player OBB half-extents (world px). Default to the legacy
   *  fixed 17×10, but callers now pass the ACTUAL car half-size so the
   *  rail-collision box matches the visible sprite — the fixed 10px
   *  half-width was ~1.8× a real car (≈5.6px), so the car "hit" the
   *  barrier ~4-5px before the body ever reached it (user: "colliding
   *  with the bridge barricade from this far away"). */
  halfL: number = BRIDGE_PLAYER_HALF_L,
  halfW: number = BRIDGE_PLAYER_HALF_W,
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
      if (b.l0only && layer !== 0) continue;
      const bx1 = b.x1 * TILE;
      const by1 = b.y1 * TILE;
      const bx2 = b.x2 * TILE;
      const by2 = b.y2 * TILE;
      if (
        bridgeObbIntersectsSegment(
          nx, ny, ang,
          halfL, halfW,
          bx1, by1, bx2, by2,
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

/** H800: min distance (world px) from a point to any barrier applicable
 *  on `layer`. Used by the anti-wedge escape logic: when the car's OBB
 *  already overlaps a rail (the nose rotated in — yaw is never
 *  collision-checked), plain re-blocking wedges it forever and a blanket
 *  "stop blocking" hatch let the player ram THROUGH the parapet. The
 *  clearance rule instead permits only moves that don't bring the car
 *  CLOSER to the rail: backing out and sliding along stay possible,
 *  punching through stays blocked. Center distance (not OBB distance)
 *  is enough — the rule only compares two evaluations a tick apart.
 *  Returns Infinity when no applicable barrier is in bbox range. */
export function bridgeMinBarrierDist(
  px: number,
  py: number,
  layer: number,
  structures: ReadonlyArray<BridgeStructure>,
  TILE: number,
): number {
  let best = Infinity;
  for (const bs of structures) {
    if (bs.barriers.length === 0) continue;
    if (!bs._bbox) {
      const computed = bridgeComputeBbox(bs, TILE);
      if (!computed) continue;
      (bs as { _bbox?: typeof computed })._bbox = computed;
    }
    const bbox = bs._bbox;
    if (!bbox) continue;
    if (
      px < bbox.minX - BRIDGE_CULL_PAD || px > bbox.maxX + BRIDGE_CULL_PAD ||
      py < bbox.minY - BRIDGE_CULL_PAD || py > bbox.maxY + BRIDGE_CULL_PAD
    ) continue;
    for (const b of bs.barriers) {
      if (b.l1only && layer !== 1) continue;
      if (b.l0only && layer !== 0) continue;
      const ax = b.x1 * TILE;
      const ay = b.y1 * TILE;
      const bx = b.x2 * TILE;
      const by = b.y2 * TILE;
      const dx = bx - ax;
      const dy = by - ay;
      const L2 = dx * dx + dy * dy;
      let t = L2 < 0.01 ? 0 : ((px - ax) * dx + (py - ay) * dy) / L2;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const qx = ax + t * dx;
      const qy = ay + t * dy;
      const d2 = (px - qx) * (px - qx) + (py - qy) * (py - qy);
      if (d2 < best) best = d2;
    }
  }
  return best === Infinity ? Infinity : Math.sqrt(best);
}

/** A bridge trigger segment — when the player crosses it, the layer
 *  flips. Endpoints arranged so that "left of direction" = "inside
 *  the bridge's upper-road footprint" (use bridgeIsLeftOfLine). */
export interface BridgeTrigger {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Extended bridge structure for the layer-transition logic. Adds
 *  `triggers`, `deck` (the polygon defining the upper-road footprint
 *  for sanity-check membership), and `upperRoadName` (the name to
 *  look up in majorRoads for the heading-alignment check). */
export interface BridgeStructureForLayer extends BridgeStructure {
  triggers: ReadonlyArray<BridgeTrigger>;
  /** Deck polygon vertices in TILE COORDS — the upper-road footprint.
   *  Vertices >= 3 (caller skips degenerate decks). */
  deck: ReadonlyArray<Point2>;
  /** Name of the upper road (e.g. 'I-485'). Resolved against the
   *  caller's majorRoads list by the heading-alignment check. */
  upperRoadName?: string;
}

/** Structure shape used by the z-sort elevation test. Extends the
 *  layer-transition structure with `ramps`. Decks and ramps both
 *  carry the player into "elevated" territory for render z-ordering;
 *  ramps additionally have a climb fraction so the elevation kicks
 *  in only past a threshold (the foot of a ramp is still ground
 *  level). */
export interface BridgeStructureForElevation extends BridgeStructureForLayer {
  ramps: ReadonlyArray<BridgeRamp>;
}

/** Subset of a major-road row the heading-alignment check reads.
 *  Just name + pts; layer logic doesn't care about w / maj / z. */
export interface BridgeUpperRoad {
  name?: string;
  pts: ReadonlyArray<Point2>;
}

/** Heading-alignment threshold for the deck-membership sanity check.
 *  |dot(heading, upper-road tangent)| > 0.5 means the player is
 *  within 60° of the upper-road direction → on the bridge.
 *  Otherwise (perpendicular crossing) → on the lower road, under
 *  the bridge. Matches monolith L28472-L28473. */
export const BRIDGE_HEADING_ALIGN_THRESHOLD = 0.5;

/** Look up an upper road by name in the caller's majorRoads list.
 *  Returns null when the name is missing or no match exists.
 *
 *  Ported 1:1 from monolith L29005-L29009 _bridgeFindUpperRoad. */
export function bridgeFindUpperRoad(
  name: string | undefined,
  majorRoads: ReadonlyArray<BridgeUpperRoad>,
): BridgeUpperRoad | null {
  if (!name) return null;
  for (const r of majorRoads) {
    if (r.name === name) return r;
  }
  return null;
}

/** Mutable layer state — caller wraps the player layer in this so
 *  bridgeUpdateLayer can mutate it. The monolith uses a single
 *  global `_bridgePlayerLayer`; the TS port keeps the same mutation
 *  semantics via a wrapper to keep the function pure-ish (no DOM /
 *  canvas / global access). */
export interface PlayerLayerState {
  layer: number;
  /** H994: the ACTIVE deck's upper-road z while layer===1 (undefined at
   *  ground). The render interleave draws the player in the slot for
   *  this level even when the ground-proximity test would claim a
   *  nearer surface street — the one-frame slot mismatch at transition
   *  triggers was the "car disappears for a moment" flicker. */
  z?: number;
}

/** H799/H800: margin (tiles) added to a lower road's half-width when
 *  testing whether a position sits on that road. Sized to cover the
 *  full ground-reachable CORRIDOR under a bridge, not just the asphalt:
 *  the H800 abutment cross-walls sit at halfW + 1.5 from the lower
 *  road's centerline, and a car pressed against one stands up to ~1.2
 *  tiles (OBB half-diagonal) beyond its contact edge. A ground car
 *  anywhere it can physically BE under the deck must keep failing the
 *  pass-2 promotion (drive-test: a car turning lengthwise under the
 *  deck got promoted in the asphalt-to-wall margin strip and popped
 *  "onto" the bridge). Beyond this reach the under-deck space is
 *  walled off, so promotion can't misfire there. H801: 2.7 → 3.5
 *  tracking the corridor margin bump (2.0) + OBB standoff + slack. */
export const BRIDGE_LOWER_ROAD_MARGIN_TILES = 3.5;

/** H799: true when (px, py) [WORLD PIXELS] lies within the asphalt
 *  footprint of any road whose z is BELOW `upperZ`. Used by
 *  bridgeUpdateLayer's pass-2 sanity check to suppress the heading-
 *  alignment promotion for cars that are demonstrably driving a
 *  ground-level road under the bridge.
 *
 *  Distance test is point-vs-polyline-segment against each road's
 *  centerline, with the road's lane-standardized half-width
 *  (_prof.totalW / 2) + a small shoulder margin. Roads without a
 *  memoized profile assume 4 tiles total (defensive — callers
 *  pre-populate _prof).
 *
 *  Cost: O(total vertices of lower-z roads), but it only runs while
 *  the player is inside a bridge deck on layer 0 — a few frames per
 *  under-crossing. */
export function bridgeOnLowerRoadAt(
  px: number,
  py: number,
  upperZ: number,
  roads: ReadonlyArray<BridgeRoadFull>,
  TILE: number,
): boolean {
  for (const ro of roads) {
    if ((ro.z || 0) >= upperZ) continue;
    if (!ro.pts || ro.pts.length < 2) continue;
    const halfW =
      ((ro._prof?.totalW ?? 4) / 2 + BRIDGE_LOWER_ROAD_MARGIN_TILES) * TILE;
    const hw2 = halfW * halfW;
    for (let i = 0; i < ro.pts.length - 1; i++) {
      const ax = ro.pts[i][0] * TILE;
      const ay = ro.pts[i][1] * TILE;
      const bx = ro.pts[i + 1][0] * TILE;
      const by = ro.pts[i + 1][1] * TILE;
      const dx = bx - ax;
      const dy = by - ay;
      const L2 = dx * dx + dy * dy;
      let t = L2 < 0.01 ? 0 : ((px - ax) * dx + (py - ay) * dy) / L2;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const qx = ax + t * dx;
      const qy = ay + t * dy;
      const d2 = (px - qx) * (px - qx) + (py - qy) * (py - qy);
      if (d2 <= hw2) return true;
    }
  }
  return false;
}

/** Process player layer transitions between two consecutive
 *  positions (one tick of movement). Mutates `state.layer` in
 *  place.
 *
 *  TWO PASSES:
 *
 *    1. TRIGGER CROSSINGS (precise transitions). For each bridge
 *       trigger segment, check if the movement segment (old → new)
 *       crosses it. On cross, set layer to 1 if "inside" (left of
 *       trigger direction), else 0.
 *
 *    2. SANITY CHECK (deck-membership + heading alignment). Catches
 *       three edge cases the trigger system alone misses:
 *
 *       a. Spawn / respawn inside a deck without ever crossing a
 *          trigger → layer stuck at 0 even though player is on the
 *          upper road.
 *       b. Curved-road numerical edge: per-frame movement segment
 *          grazes the trigger line tangentially, segs-cross returns
 *          false due to its strict (>) inequality, layer never
 *          flips.
 *       c. Player on layer 1 stays at 1 after exiting through a
 *          side route that doesn't cross the front trigger.
 *
 *       Algorithm:
 *         - Outside ALL deck polygons → force layer = 0 (player is
 *           definitely on ground level).
 *         - Inside a deck, layer is 0, AND heading aligned with
 *           upper road tangent (|cos θ| > 0.5) → promote to layer 1.
 *         - Inside a deck, layer is 0, NOT aligned → keep layer 0
 *           (player is on lower road, going perpendicular under).
 *         - Inside a deck, layer is 1 → leave alone (trigger system
 *           handles this; don't second-guess on drift heading).
 *
 *  Uses pAngle (heading) rather than velocity direction to avoid
 *  spurious flips when stationary or during heavy braking slip.
 *  |cos θ| absolute value handles forward + reverse on the upper
 *  road symmetrically (both align ≈ ±1).
 *
 *  Ported 1:1 from monolith L28413-L28484 _bridgeUpdateLayer. */
export function bridgeUpdateLayer(
  oldX: number,
  oldY: number,
  newX: number,
  newY: number,
  pAngle: number,
  state: PlayerLayerState,
  structures: ReadonlyArray<BridgeStructureForLayer>,
  majorRoads: ReadonlyArray<BridgeRoadFull>,
  TILE: number,
): void {
  if (structures.length === 0) return;

  // PASS 1 — trigger crossings.
  for (const bs of structures) {
    for (const t of bs.triggers) {
      const tx1 = t.x1 * TILE;
      const ty1 = t.y1 * TILE;
      const tx2 = t.x2 * TILE;
      const ty2 = t.y2 * TILE;
      if (bridgeSegsCross(oldX, oldY, newX, newY, tx1, ty1, tx2, ty2)) {
        const inside = bridgeIsLeftOfLine(newX, newY, tx1, ty1, tx2, ty2);
        state.layer = inside ? 1 : 0;
      }
    }
  }

  // PASS 2 — deck-membership + heading-alignment sanity check.
  let activeBridge: BridgeStructureForLayer | null = null;
  for (const bs of structures) {
    if (!bs.deck || bs.deck.length < 3) continue;
    const deckPx: Point2[] = bs.deck.map((p) => [p[0] * TILE, p[1] * TILE]);
    if (bridgePointInPoly(newX, newY, deckPx)) {
      activeBridge = bs;
      break;
    }
  }
  if (!activeBridge) {
    state.layer = 0;
    state.z = undefined;
    return;
  }
  // H994: resolve the deck's upper road once — the layer-0 promotion
  // branch needs its tangent, and the layer-1 exit below records its z
  // so the render interleave knows WHICH elevated slot owns the player.
  const r = bridgeFindUpperRoad(activeBridge.upperRoadName, majorRoads);
  if (state.layer === 0) {
    if (r && r.pts && r.pts.length >= 2) {
      // Find the upper road's pts segment whose closest point is
      // nearest to the player. Gives the local tangent direction.
      let bestI = 0;
      let bestD2 = Infinity;
      for (let i = 0; i < r.pts.length - 1; i++) {
        const ax = r.pts[i][0] * TILE;
        const ay = r.pts[i][1] * TILE;
        const bx = r.pts[i + 1][0] * TILE;
        const by = r.pts[i + 1][1] * TILE;
        const ddx = bx - ax;
        const ddy = by - ay;
        const L2 = ddx * ddx + ddy * ddy;
        let t = L2 < 0.01 ? 0 : ((newX - ax) * ddx + (newY - ay) * ddy) / L2;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
        const qx = ax + t * ddx;
        const qy = ay + t * ddy;
        const d = (newX - qx) * (newX - qx) + (newY - qy) * (newY - qy);
        if (d < bestD2) {
          bestD2 = d;
          bestI = i;
        }
      }
      const tx = r.pts[bestI + 1][0] * TILE - r.pts[bestI][0] * TILE;
      const ty = r.pts[bestI + 1][1] * TILE - r.pts[bestI][1] * TILE;
      const tlen = Math.sqrt(tx * tx + ty * ty) || 1;
      const tnx = tx / tlen;
      const tny = ty / tlen;
      const hx = Math.cos(pAngle);
      const hy = Math.sin(pAngle);
      const align = Math.abs(tnx * hx + tny * hy);
      // H799 DEVIATION from the monolith: heading alignment alone is
      // not enough. The monolith's hardcoded bridges cross their lower
      // roads near-perpendicular, so |cos θ| > 0.5 cleanly separated
      // "on the bridge" from "driving under it". Editor-drawn bridges
      // can cross at any angle; at < 60° obliquity a ground car passing
      // UNDER the bridge is heading-aligned, got promoted to layer 1,
      // and slammed into the (l1only) parapet barriers mid-road — the
      // user-reported invisible wall. Guard: never promote while the
      // position sits on a road BELOW the bridge's z; a car genuinely
      // on the deck at the crossing box is the only case suppressed,
      // and the trigger system already owns that transition.
      if (align > BRIDGE_HEADING_ALIGN_THRESHOLD) {
        const upperZ = (r as BridgeRoadFull).z ?? 2;
        if (!bridgeOnLowerRoadAt(newX, newY, upperZ, majorRoads, TILE)) {
          state.layer = 1;
        }
      }
      // else: heading perpendicular to upper road → on lower road,
      // keep layer 0.
    }
  }
  // If layer is already 1, trust the trigger system. The "force 0
  // when outside deck" branch above handled the side-route exit
  // case already.
  // H994: record the active deck's z while elevated (render draw-slot).
  state.z = state.layer === 1 ? ((r as BridgeRoadFull | null)?.z ?? 2) : undefined;
}

/** Punch every bridge deck region out of an off-screen LIGHT MASK
 *  canvas. Used by the player headlight Pass A, Pass B, and taillight-
 *  halo paths to prevent their cones/halos from painting onto bridge
 *  decks while the player is driving UNDER a bridge (layer 0).
 *
 *  `mctx` must already be in the same WORLD-SPACE transform as the
 *  cone-drawing block that came just before it (translate → scale →
 *  rotate → translate). Caller invokes this AFTER the per-frame cone
 *  fills and vehicle-occluder destination-out punches but BEFORE the
 *  transform reset and final composite back to the main canvas.
 *
 *  Why punch ALL decks rather than just the active one: off-screen
 *  decks cost almost nothing (the path is clipped to canvas extents
 *  on rasterize), and this avoids a double-radius lookup. Layer-1
 *  case (player on the bridge): caller bails early via the
 *  `playerLayer !== 0` check, lights paint normally onto the deck
 *  the player is actually driving on.
 *
 *  Opaque fill color is hard-coded: destination-out's "erase
 *  strength" comes from the fillStyle alpha, NOT from globalAlpha.
 *  If the caller's fillStyle was rgba(...,0.5) (e.g. a yellow cone
 *  color), the punch would only erase 50% of the destination. Using
 *  '#000' guarantees the deck is FULLY punched out regardless of
 *  prior caller state.
 *
 *  Ported 1:1 from monolith L28502-L28524 _bridgePunchDeckFromMask. */
export function bridgePunchDeckFromMask(
  mctx: CanvasRenderingContext2D,
  playerLayer: number,
  structures: ReadonlyArray<BridgeStructureForLayer>,
  TILE: number,
): void {
  if (structures.length === 0) return;
  if (playerLayer !== 0) return;
  for (const bs of structures) {
    if (!bs.deck || bs.deck.length < 3) continue;
    const deckPx: Point2[] = bs.deck.map((p) => [p[0] * TILE, p[1] * TILE]);
    mctx.save();
    mctx.globalCompositeOperation = 'destination-out';
    mctx.globalAlpha = 1;
    mctx.fillStyle = '#000';
    mctx.beginPath();
    mctx.moveTo(deckPx[0][0], deckPx[0][1]);
    for (let i = 1; i < deckPx.length; i++) mctx.lineTo(deckPx[i][0], deckPx[i][1]);
    mctx.closePath();
    mctx.fill();
    mctx.restore();
  }
}

/** Apply a clip on the MAIN ctx (or any active ctx) that EXCLUDES
 *  every bridge deck region — drawing operations after this call
 *  paint everywhere EXCEPT the deck polygons. Used to keep directly-
 *  painted lights (traffic headlight cones, rim-light face
 *  highlights) from landing on bridge decks when the player is on
 *  layer 0. Caller is responsible for ctx.save() / ctx.restore()
 *  around the lit drawing block.
 *
 *  IMPLEMENTATION: an outer "huge" rect plus each deck polygon as a
 *  hole, combined via the evenodd fill rule. The rect is huge enough
 *  to contain the visible world at any reasonable zoom; under any
 *  transform the unclipped area resolves to "everywhere except the
 *  decks." Bails early when the player is on the bridge
 *  (playerLayer !== 0) — clipping decks then would create black
 *  holes under the player.
 *
 *  Ported 1:1 from monolith L28538-L28557 _bridgeApplyDeckExclusionClip. */
export function bridgeApplyDeckExclusionClip(
  ctx: CanvasRenderingContext2D,
  playerLayer: number,
  structures: ReadonlyArray<BridgeStructureForLayer>,
  TILE: number,
): void {
  if (structures.length === 0) return;
  if (playerLayer !== 0) return;
  let anyDeck = false;
  for (const bs of structures) {
    if (bs.deck && bs.deck.length >= 3) { anyDeck = true; break; }
  }
  if (!anyDeck) return;
  ctx.beginPath();
  const HUGE = 1e6;
  ctx.rect(-HUGE, -HUGE, HUGE * 2, HUGE * 2);
  for (const bs of structures) {
    if (!bs.deck || bs.deck.length < 3) continue;
    const deckPx: Point2[] = bs.deck.map((p) => [p[0] * TILE, p[1] * TILE]);
    ctx.moveTo(deckPx[0][0], deckPx[0][1]);
    for (let i = 1; i < deckPx.length; i++) ctx.lineTo(deckPx[i][0], deckPx[i][1]);
    ctx.closePath();
  }
  ctx.clip('evenodd');
}

/** Minimal road shape consumed by bridgeBuildSpineForRoad — just a
 *  pts polyline. BridgeUpperRoad satisfies this structurally (and
 *  lower roads pass through the same function for trim purposes,
 *  per v8.99.123.18). */
export interface BridgeRoadForSpine {
  pts: ReadonlyArray<Point2>;
}

/** Quadratic-bezier-sampled spine for any major road in TILE coords.
 *  Mirrors the same construction the renderer's lane-divider sampler
 *  uses (`_makeDividerSamples` in `preprocessRoadsForRender`) so the
 *  output spine matches the rendered asphalt curve EXACTLY. Used
 *  by the bridge edge-trim pass to walk both the upper-road spine
 *  (for deck barriers) and the lower-road spine (for trim crossings)
 *  with one uniform sampler.
 *
 *  CONSTRUCTION:
 *    - 0 or 1 pts → empty spine.
 *    - 2 pts → 12-step linear interpolation (no curve to bezier).
 *    - ≥ 3 pts → segment-midpoint quadratic beziers between
 *      consecutive midpoints, with the original interior pts as
 *      control points. First segment starts at pts[0] and goes to
 *      midpoint(0,1); last segment ends at pts[last]. Each interior
 *      hop is sampled at 12 steps.
 *
 *  Sampling density (12 STEPS / segment) matches the renderer —
 *  caller should not adjust this independently or the spine will
 *  desync from the painted asphalt.
 *
 *  Returns an empty array for null/undefined/short-pts roads — the
 *  caller's downstream loops degenerate to zero-iterations on empty.
 *
 *  Ported 1:1 from monolith L28682-L28718 _bridgeBuildSpineForRoad. */
export function bridgeBuildSpineForRoad(
  road: BridgeRoadForSpine | null | undefined,
): Point2[] {
  if (!road || !road.pts || road.pts.length < 2) return [];
  const pts = road.pts;
  const ax = (i: number): number => pts[i][0];
  const ay = (i: number): number => pts[i][1];
  const spine: Point2[] = [];
  if (pts.length === 2) {
    const STEPS = 12;
    for (let s = 0; s <= STEPS; s++) {
      const t = s / STEPS;
      spine.push([ax(0) + t * (ax(1) - ax(0)), ay(0) + t * (ay(1) - ay(0))]);
    }
    return spine;
  }
  const STEPS = 12;
  spine.push([ax(0), ay(0)]);
  spine.push([(ax(0) + ax(1)) / 2, (ay(0) + ay(1)) / 2]);
  for (let i = 1; i < pts.length - 2; i++) {
    const p0x = (ax(i - 1) + ax(i)) / 2;
    const p0y = (ay(i - 1) + ay(i)) / 2;
    const cpx = ax(i);
    const cpy = ay(i);
    const p1x = (ax(i) + ax(i + 1)) / 2;
    const p1y = (ay(i) + ay(i + 1)) / 2;
    for (let s = 1; s <= STEPS; s++) {
      const t = s / STEPS;
      const u = 1 - t;
      spine.push([
        u * u * p0x + 2 * u * t * cpx + t * t * p1x,
        u * u * p0y + 2 * u * t * cpy + t * t * p1y,
      ]);
    }
  }
  const li = pts.length - 2;
  if (li >= 1) {
    const p0x = (ax(li - 1) + ax(li)) / 2;
    const p0y = (ay(li - 1) + ay(li)) / 2;
    const cpx = ax(li);
    const cpy = ay(li);
    const p1x = ax(li + 1);
    const p1y = ay(li + 1);
    for (let s = 1; s <= STEPS; s++) {
      const t = s / STEPS;
      const u = 1 - t;
      spine.push([
        u * u * p0x + 2 * u * t * cpx + t * t * p1x,
        u * u * p0y + 2 * u * t * cpy + t * t * p1y,
      ]);
    }
  }
  return spine;
}

/** Result of a single segment-segment intersection: world-space hit
 *  point plus the parameter `t` along the FIRST segment. Used by the
 *  bridge edge-trim pass to walk the upper barrier polyline in order
 *  of crossings against a lower-road edge polyline. */
export interface BridgeSegHit {
  x: number;
  y: number;
  t: number;
}

/** 2D segment-segment intersection. Returns null when the segments
 *  are disjoint OR collinear (including the parallel-but-not-touching
 *  and exactly-parallel-overlapping cases — collinear hits are
 *  rejected because there's no single intersection point to report).
 *
 *  Otherwise returns { x, y, t } where (x, y) is the intersection
 *  point in the input coordinate system and `t` is the parameter
 *  along the FIRST segment (0 at (ax, ay), 1 at (bx, by)). The trim
 *  pass uses (segmentIndex + t) as a sort key to walk the upper
 *  barrier polyline's crossings in order.
 *
 *  Endpoint inclusivity: this implementation uses inclusive
 *  inequalities (t ∈ [0, 1], u ∈ [0, 1]) so segments that meet
 *  exactly at an endpoint count as a hit. Differs from
 *  bridgeSegsCross, which is strict — they're tuned for different
 *  callers (the trim wants endpoint hits; the layer-flip wants only
 *  proper crossings).
 *
 *  Degeneracy: |denom| < 1e-9 → null. This catches both truly
 *  parallel segments and the numerical edge where the two
 *  directions are within ~6e-5 radians of parallel — the resulting
 *  intersection point would be wildly far off and confuse the
 *  caller's polyline walk.
 *
 *  Ported 1:1 from monolith L28725-L28734 _bridgeSegSegIntersect. */
export function bridgeSegSegIntersect(
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number,
  dx: number, dy: number,
): BridgeSegHit | null {
  const rx = bx - ax;
  const ry = by - ay;
  const sx = dx - cx;
  const sy = dy - cy;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((cx - ax) * sy - (cy - ay) * sx) / denom;
  const u = ((cx - ax) * ry - (cy - ay) * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: ax + t * rx, y: ay + t * ry, t };
}

/** Major-road row shape consumed by bridgeMakeStructure's lower-road
 *  auto-detect. Adds `maj` (only major roads participate as bridge
 *  upper/lower roads) and a lazily-memoized `_prof` (road profile
 *  with at least `totalW`). The caller (boot init) populates `_prof`
 *  via getRoadProfile; if absent at call time, bridgeMakeStructure
 *  invokes the injected profile-lookup itself. */
export interface BridgeRoadFull {
  name?: string;
  pts: ReadonlyArray<Point2>;
  maj?: boolean;
  _prof?: { totalW: number };
  /** Elevation level — 0 = ground, 2+ = elevated. Used by the v126.22
   *  synthetic-bridge builder to identify elevated roads and detect
   *  transitions at endpoints shared with roads of different z. */
  z?: number;
}

/** Minimal road profile shape — bridgeMakeStructure only reads
 *  totalW to compute half-width offsets. Full profile (lane spacing,
 *  shoulder widths, etc.) lives elsewhere; the bridge subsystem is
 *  intentionally narrow about its dependency on road-profile data. */
export interface BridgeRoadProfile {
  totalW: number;
}

/** Result of bridgeMakeStructure — the fully-built bridge structure
 *  ready to drop into BRIDGE_STRUCTURES. Layered on top of
 *  BridgeStructureForElevation:
 *    - `id` and `upperRoadName` become required (constructor always
 *      sets them).
 *    - `barrierPolylines` stores one polyline per side (right, left)
 *      for efficient stroke rendering — one stroke per side instead
 *      of one per segment. Optional from the renderer's perspective;
 *      _bridgeRender falls back to per-segment iteration if absent. */
export interface BridgeStructureMade extends BridgeStructureForElevation {
  id: string;
  upperRoadName: string;
  barrierPolylines: ReadonlyArray<ReadonlyArray<Point2>>;
  /** v126.22 diagnostics marker — true on synthetic per-road bridges
   *  built by bridgeBuildSyntheticForRoad, absent on the hardcoded
   *  highway-on-highway bridges from bridgeMakeStructure. */
  _synthetic?: boolean;
}

/** Build a full bridge structure — deck polygon, barriers, triggers,
 *  ramps, and per-side barrier polylines — for a single upper-road /
 *  lower-road crossing.
 *
 *  All output geometry is in TILE COORDS (matches the rest of the
 *  bridge data pipeline; collision-test code converts to pixels at
 *  use time).
 *
 *  PIPELINE:
 *
 *    1. SAMPLE upper road's bezier spine via bridgeBuildSpineForRoad
 *       so the deck + barriers follow the painted asphalt curve
 *       exactly, instead of cutting a chord across it.
 *
 *    2. FALLBACK (spine.length < 2) — upper road missing or too
 *       short. Build the original straight-rectangle deck centered
 *       at (cx, cy), axis-aligned (dirRad = 0). This branch is only
 *       hit during rare init ordering issues.
 *
 *    3. CENTER + WALK — find the spine sample closest to (cx, cy),
 *       walk outward accumulating arc length until both sides reach
 *       deckHalfL.
 *
 *    4. v123.19 TANGENT EXTRAPOLATE — when the walk hits a spine
 *       endpoint before reaching deckHalfL, extrapolate along the
 *       last tangent to make the deck symmetric. Without this,
 *       bridges whose center is exactly at the first / last spine
 *       sample (e.g. i77_over_i85: I-77 N ends at the bridge center)
 *       end up asymmetric and the trim later fails because the
 *       barrier never reaches the far lower-road edge.
 *
 *    5. OFFSET POLYLINES — at each span sample, take the local
 *       tangent (next - prev, matching _makeDividerSamples), build
 *       perpendicular (nx, ny) = (-tdy, tdx) / |tan|, offset
 *       ±upperHalfW to get right and left edge polylines.
 *
 *    6. v123.18 TRIM TO LOWER ROAD — if a lower road can be located
 *       (explicit lowerRoadName preferred, closest-pts-vertex auto-
 *       detect as fallback), build its bezier-offset edge polylines
 *       and trim each upper barrier to the segment between its first
 *       and last crossings of those edges. Result: barriers attach
 *       exactly at the lower road's asphalt edges, stay parallel to
 *       the upper road through curves.
 *
 *       Silent-fallback: <2 crossings on either side, or no lower
 *       road found → use untrimmed polylines.
 *
 *    7. FLATTEN — turn each polyline into a list of {x1,y1,x2,y2,
 *       l1only:true} barrier segments (matches the collision loop's
 *       iteration shape).
 *
 *    8. DECK POLYGON — concatenate right polyline forward + left
 *       polyline backward → CCW closed loop along the curved asphalt.
 *
 *    9. TRIGGERS — back R→L and front L→R, with endpoints at the
 *       trimmed barrier termini. Orientation chosen so
 *       bridgeIsLeftOfLine returns true for the "inside deck" half.
 *
 *  Dependencies are injected (no module-scoped globals):
 *    - `majorRoads` — pass empty array if not yet initialized; the
 *      fallback straight-rect path triggers naturally on spine < 2.
 *    - `getRoadProfile` — only called when the lower road has no
 *      memoized `_prof`. Caller can pass a stub that throws if they
 *      know all roads have pre-populated profiles.
 *
 *  Ported 1:1 from monolith L28736-L29000 _bridgeMakeStructure. */
export function bridgeMakeStructure(
  id: string,
  upperRoadName: string,
  cx: number,
  cy: number,
  upperHalfW: number,
  deckHalfL: number,
  lowerRoadName: string | undefined,
  majorRoads: ReadonlyArray<BridgeRoadFull>,
  getRoadProfile: (road: BridgeRoadFull) => BridgeRoadProfile,
): BridgeStructureMade {
  const r = bridgeFindUpperRoad(upperRoadName, majorRoads) as BridgeRoadFull | null;
  const spine = bridgeBuildSpineForRoad(r);

  // FALLBACK — straight-rectangle deck.
  if (spine.length < 2) {
    const dirRad = 0;
    const dx = Math.cos(dirRad);
    const dy = Math.sin(dirRad);
    const px = -dy;
    const py = dx;
    const pt = (sl: number, sw: number): Point2 => [
      cx + sl * deckHalfL * dx + sw * upperHalfW * px,
      cy + sl * deckHalfL * dy + sw * upperHalfW * py,
    ];
    const back_L = pt(-1, -1);
    const back_R = pt(-1, +1);
    const front_R = pt(+1, +1);
    const front_L = pt(+1, -1);
    return {
      id,
      upperRoadName,
      deck: [back_L, back_R, front_R, front_L],
      ramps: [],
      triggers: [
        { x1: back_R[0], y1: back_R[1], x2: back_L[0], y2: back_L[1] },
        { x1: front_L[0], y1: front_L[1], x2: front_R[0], y2: front_R[1] },
      ],
      barriers: [
        { x1: back_R[0], y1: back_R[1], x2: front_R[0], y2: front_R[1], l1only: true },
        { x1: back_L[0], y1: back_L[1], x2: front_L[0], y2: front_L[1], l1only: true },
      ],
      barrierPolylines: [[back_R, front_R], [back_L, front_L]],
    };
  }

  // CENTER — closest spine sample to (cx, cy).
  let bestI = 0;
  let bestD2 = Infinity;
  for (let i = 0; i < spine.length; i++) {
    const ddx = spine[i][0] - cx;
    const ddy = spine[i][1] - cy;
    const d2 = ddx * ddx + ddy * ddy;
    if (d2 < bestD2) { bestD2 = d2; bestI = i; }
  }

  // WALK outward, accumulating arc length until deckHalfL on each side.
  let lo = bestI;
  let hi = bestI;
  let lenLo = 0;
  let lenHi = 0;
  while (lo > 0 && lenLo < deckHalfL) {
    const ddx = spine[lo][0] - spine[lo - 1][0];
    const ddy = spine[lo][1] - spine[lo - 1][1];
    lenLo += Math.sqrt(ddx * ddx + ddy * ddy);
    lo--;
  }
  while (hi < spine.length - 1 && lenHi < deckHalfL) {
    const ddx = spine[hi + 1][0] - spine[hi][0];
    const ddy = spine[hi + 1][1] - spine[hi][1];
    lenHi += Math.sqrt(ddx * ddx + ddy * ddy);
    hi++;
  }
  const span: Point2[] = spine.slice(lo, hi + 1);

  // v123.19 — tangent-extrapolate when the walk hit a spine endpoint
  // before reaching deckHalfL.
  if (lenLo < deckHalfL && span.length >= 2) {
    const dxv = span[0][0] - span[1][0];
    const dyv = span[0][1] - span[1][1];
    const slen = Math.sqrt(dxv * dxv + dyv * dyv) || 1;
    const need = deckHalfL - lenLo;
    span.unshift([span[0][0] + (dxv / slen) * need, span[0][1] + (dyv / slen) * need]);
  }
  if (lenHi < deckHalfL && span.length >= 2) {
    const li = span.length - 1;
    const dxv = span[li][0] - span[li - 1][0];
    const dyv = span[li][1] - span[li - 1][1];
    const slen = Math.sqrt(dxv * dxv + dyv * dyv) || 1;
    const need = deckHalfL - lenHi;
    span.push([span[li][0] + (dxv / slen) * need, span[li][1] + (dyv / slen) * need]);
  }

  // OFFSET — perpendicular ±upperHalfW polylines along the span.
  const rightPts: Point2[] = [];
  const leftPts: Point2[] = [];
  for (let i = 0; i < span.length; i++) {
    const prev = span[Math.max(0, i - 1)];
    const next = span[Math.min(span.length - 1, i + 1)];
    const tdx = next[0] - prev[0];
    const tdy = next[1] - prev[1];
    const tlen = Math.sqrt(tdx * tdx + tdy * tdy) || 1;
    const nx = -tdy / tlen;
    const ny = tdx / tlen;
    rightPts.push([span[i][0] + nx * upperHalfW, span[i][1] + ny * upperHalfW]);
    leftPts.push([span[i][0] - nx * upperHalfW, span[i][1] - ny * upperHalfW]);
  }

  // v123.18 TRIM — clip each barrier to the lower road's asphalt edges.
  let finalRight: Point2[] = rightPts;
  let finalLeft: Point2[] = leftPts;
  let lowerRoad: BridgeRoadFull | null =
    lowerRoadName ? (bridgeFindUpperRoad(lowerRoadName, majorRoads) as BridgeRoadFull | null) : null;
  let lowerD2 = lowerRoad ? 0 : Infinity;
  if (!lowerRoad) {
    for (const ro of majorRoads) {
      if (!ro.maj || !ro.pts || ro.pts.length < 2) continue;
      if (ro.name === upperRoadName) continue;
      for (const p of ro.pts) {
        const ddx = p[0] - cx;
        const ddy = p[1] - cy;
        const d2 = ddx * ddx + ddy * ddy;
        if (d2 < lowerD2) { lowerD2 = d2; lowerRoad = ro; }
      }
    }
  }
  if (lowerRoad && lowerD2 < 100) {
    const lowerSpine = bridgeBuildSpineForRoad(lowerRoad);
    if (lowerSpine.length >= 2) {
      const lowerProf = lowerRoad._prof || getRoadProfile(lowerRoad);
      const lowerHalfW = lowerProf.totalW / 2;
      const lowerR: Point2[] = [];
      const lowerL: Point2[] = [];
      for (let i = 0; i < lowerSpine.length; i++) {
        const prv = lowerSpine[Math.max(0, i - 1)];
        const nxt = lowerSpine[Math.min(lowerSpine.length - 1, i + 1)];
        const tdx = nxt[0] - prv[0];
        const tdy = nxt[1] - prv[1];
        const tlen = Math.sqrt(tdx * tdx + tdy * tdy) || 1;
        const nx = -tdy / tlen;
        const ny = tdx / tlen;
        lowerR.push([lowerSpine[i][0] + nx * lowerHalfW, lowerSpine[i][1] + ny * lowerHalfW]);
        lowerL.push([lowerSpine[i][0] - nx * lowerHalfW, lowerSpine[i][1] - ny * lowerHalfW]);
      }
      const trim = (barrier: ReadonlyArray<Point2>): Point2[] | null => {
        const isects: { idx: number; t: number; x: number; y: number }[] = [];
        for (let i = 0; i < barrier.length - 1; i++) {
          const ax = barrier[i][0];
          const ay = barrier[i][1];
          const bx = barrier[i + 1][0];
          const by = barrier[i + 1][1];
          const checkPoly = (poly: ReadonlyArray<Point2>): void => {
            for (let j = 0; j < poly.length - 1; j++) {
              const ipt = bridgeSegSegIntersect(
                ax, ay, bx, by,
                poly[j][0], poly[j][1], poly[j + 1][0], poly[j + 1][1],
              );
              if (ipt) isects.push({ idx: i, t: ipt.t, x: ipt.x, y: ipt.y });
            }
          };
          checkPoly(lowerR);
          checkPoly(lowerL);
        }
        if (isects.length < 2) return null;
        isects.sort((a, b) => (a.idx + a.t) - (b.idx + b.t));
        const first = isects[0];
        const last = isects[isects.length - 1];
        const out: Point2[] = [[first.x, first.y]];
        for (let i = first.idx + 1; i <= last.idx; i++) {
          out.push([barrier[i][0], barrier[i][1]]);
        }
        out.push([last.x, last.y]);
        return out;
      };
      const tR = trim(rightPts);
      const tL = trim(leftPts);
      if (tR && tL) {
        finalRight = tR;
        finalLeft = tL;
      }
    }
  }

  // FLATTEN — polylines → segment list with l1only barriers.
  const barriers: BridgeBarrier[] = [];
  for (let i = 0; i < finalRight.length - 1; i++) {
    barriers.push({
      x1: finalRight[i][0], y1: finalRight[i][1],
      x2: finalRight[i + 1][0], y2: finalRight[i + 1][1],
      l1only: true,
    });
  }
  for (let i = 0; i < finalLeft.length - 1; i++) {
    barriers.push({
      x1: finalLeft[i][0], y1: finalLeft[i][1],
      x2: finalLeft[i + 1][0], y2: finalLeft[i + 1][1],
      l1only: true,
    });
  }

  // DECK — right forward, left backward → closed CCW loop.
  const deck: Point2[] = [];
  for (let i = 0; i < finalRight.length; i++) deck.push(finalRight[i]);
  for (let i = finalLeft.length - 1; i >= 0; i--) deck.push(finalLeft[i]);

  const back_R = finalRight[0];
  const back_L = finalLeft[0];
  const front_R = finalRight[finalRight.length - 1];
  const front_L = finalLeft[finalLeft.length - 1];

  return {
    id,
    upperRoadName,
    deck,
    ramps: [],
    triggers: [
      { x1: back_R[0], y1: back_R[1], x2: back_L[0], y2: back_L[1] },
      { x1: front_L[0], y1: front_L[1], x2: front_R[0], y2: front_R[1] },
    ],
    barriers,
    barrierPolylines: [finalRight.slice(), finalLeft.slice()],
  };
}

/** Endpoint-sharing tolerance for synthetic-bridge transition detection
 *  (in tiles). Two endpoints are "connected" if they're within this
 *  distance — accommodates slight authoring offset between roads that
 *  are meant to meet at the same point. Matches monolith
 *  `_SHARE_TOL = 1.5`. */
export const BRIDGE_SYNTHETIC_SHARE_TOL = 1.5;

/** H799: arc length (tiles) the side barriers are pulled back from each
 *  deck end. The synthetic builder used to start the rails EXACTLY on
 *  the trigger line, so a car entering the bridge slightly off-center
 *  (totalW for an editor minor road is ~2.5 tiles — rails sit ±1.3
 *  tiles off the centerline) clipped the rail flank in the same tick
 *  it crossed the trigger and wedged dead at the mouth. Insetting the
 *  rails gives an entry/exit funnel about one car length deep; the
 *  deck, triggers, and layer logic keep their full extent. Clamped to
 *  a quarter of the bridge length so short bridges keep most of their
 *  rails. */
export const BRIDGE_BARRIER_MOUTH_INSET_TILES = 1.5;

/** H801/H838: ratio of the bridge collision-rail half-width to the road's
 *  lane-standardized width. Must stay in lockstep with drawBridgeOverlay
 *  (render/worldMap.ts). H838 widened the painted DRIVE SURFACE to the
 *  FULL road width (fullRW = asphaltW × TILE) so the bridge no longer
 *  necks down 15% narrower than the roads it connects (the user's gap /
 *  "doesn't merge"); asphaltW == totalW for these roads, so the rails go
 *  to the full half-width too — factor 1.0. The painted parapet sits just
 *  outside this (at the barrier line), matching the rail. */
export const BRIDGE_DECK_WIDTH_FACTOR = 1.0;

/** H799: clip `inset` arc-length (same unit as pts) off BOTH ends of a
 *  polyline. Returns the clipped polyline (always ≥ 2 pts on success)
 *  or null when the polyline is degenerate / shorter than 2×inset.
 *  Interpolated cut points land exactly on the original segments. */
export function bridgeInsetPolylineEnds(
  pts: ReadonlyArray<Point2>,
  inset: number,
): Point2[] | null {
  if (pts.length < 2) return null;
  if (inset <= 0) return pts.slice();
  const segLen: number[] = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const dx = pts[i + 1][0] - pts[i][0];
    const dy = pts[i + 1][1] - pts[i][1];
    const L = Math.sqrt(dx * dx + dy * dy);
    segLen.push(L);
    total += L;
  }
  if (total <= inset * 2 + 0.01) return null;
  const lerp = (i: number, t: number): Point2 => [
    pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t,
    pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t,
  ];
  const out: Point2[] = [];
  // Walk to the start cut.
  let acc = 0;
  let i = 0;
  while (i < segLen.length && acc + segLen[i] < inset) { acc += segLen[i]; i++; }
  out.push(lerp(i, segLen[i] < 1e-9 ? 0 : (inset - acc) / segLen[i]));
  // Interior vertices up to the end cut.
  const endS = total - inset;
  let accEnd = 0;
  let j = 0;
  while (j < segLen.length && accEnd + segLen[j] < endS) { accEnd += segLen[j]; j++; }
  for (let k = i + 1; k <= j; k++) out.push([pts[k][0], pts[k][1]]);
  out.push(lerp(j, segLen[j] < 1e-9 ? 0 : (endS - accEnd) / segLen[j]));
  return out.length >= 2 ? out : null;
}

/** Build a synthetic per-road bridge structure for an elevated road
 *  (z >= 2). Implements the v8.99.126.22 principle: "if two roads are
 *  connected at a point, they must not allow vehicle to drive under
 *  [a bridge]. Once transitioned to a bridge, the barriers need to
 *  be active on the exact outside edges of the bridge until vehicle
 *  drives off either end of the bridge over a transition point."
 *
 *  WHY PER-ROAD AND NOT PER-SEGMENT: pre-drawn road data carries `z`
 *  as a road-level field, not per-segment. So an entire elevated
 *  road (e.g. a flyover ramp) gets one synthetic structure spanning
 *  its full length. True per-segment elevation would need a data-
 *  model upgrade — scoped for the v126.23+ "editable pre-drawn roads"
 *  track.
 *
 *  PIPELINE:
 *
 *    1. EARLY-OUT — fewer than 2 pts OR z < 2 → null. Ground roads
 *       and degenerate stubs don't participate.
 *    2. PROFILE — read the road's totalW (lazy-memoized _prof or
 *       compute via injected getRoadProfile). Halve it to get the
 *       perpendicular barrier offset.
 *    3. RIGHT + LEFT EDGE POLYLINES — at each vertex i, take the
 *       local tangent (next - prev), perpendicular (nx, ny) =
 *       (-tdy, tdx) / |tan|, offset ±halfW. Same convention as
 *       bridgeMakeStructure's upper-road offset construction.
 *    4. BARRIERS — every segment of right + left polylines becomes
 *       an l1only=true barrier. Layer-0 traffic on the lower road
 *       passes through; layer-1 traffic on the bridge is blocked.
 *    5. DECK POLYGON — right forward + left backward → CCW loop,
 *       matches bridgePointInPoly's orientation convention.
 *    6. TRIGGER DETECTION — for each endpoint (start, end), check
 *       every OTHER road for a "connection". Two roads connect at
 *       this endpoint when their z differs AND:
 *         (a) the other road's start or end is within SHARE_TOL
 *             (endpoint-to-endpoint), OR
 *         (b) this endpoint lies on a segment of the other road
 *             within SHARE_TOL (endpoint-on-segment — catches the
 *             on-ramp case where a ramp ends mid-highway, not at
 *             the highway's vertex).
 *    7. TRIGGER GEOMETRY — back trigger R→L (left-of-line points
 *       forward into the deck), front trigger L→R (left-of-line
 *       points backward into the deck). Same convention as
 *       bridgeMakeStructure's hardcoded triggers.
 *    8. SKIP ISOLATED — if neither endpoint connects to a different-
 *       z road, no transition exists → barriers would never apply
 *       (player can't get on the bridge layer here) → return null
 *       to keep BRIDGE_STRUCTURES uncluttered.
 *
 *  Returns null for: short roads, ground-level roads, or elevated
 *  roads with no transition endpoints. Otherwise returns a
 *  BridgeStructureMade with `_synthetic: true` for diagnostics.
 *
 *  Ported 1:1 from monolith L29057-L29175 _buildSyntheticBridgeForRoad. */
export function bridgeBuildSyntheticForRoad(
  road: BridgeRoadFull,
  allRoads: ReadonlyArray<BridgeRoadFull>,
  shareTol: number,
  getRoadProfile: (road: BridgeRoadFull) => BridgeRoadProfile,
): BridgeStructureMade | null {
  if (!road.pts || road.pts.length < 2) return null;
  if ((road.z || 0) < 2) return null;
  const pts = road.pts;
  const N = pts.length;
  const prof = road._prof || getRoadProfile(road);
  if (!prof) return null;
  // H801: the WHOLE synthetic structure (rails, abutment walls, deck
  // polygon, triggers) sits at the PAINTED deck width — drawBridgeOverlay
  // strokes the concrete at asphaltW × 0.85 (H677), and structures at
  // the full asphalt width left a visible strip between the painted
  // deck edge and the collision rail where the car and the (lighter)
  // lower road showed through. Physics now matches what the player sees.
  const halfW = prof.totalW * 0.5 * BRIDGE_DECK_WIDTH_FACTOR;

  const rightPts: Point2[] = [];
  const leftPts: Point2[] = [];
  for (let i = 0; i < N; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(N - 1, i + 1)];
    const tdx = next[0] - prev[0];
    const tdy = next[1] - prev[1];
    const tlen = Math.sqrt(tdx * tdx + tdy * tdy) || 1;
    const nx = -tdy / tlen;
    const ny = tdx / tlen;
    rightPts.push([pts[i][0] + nx * halfW, pts[i][1] + ny * halfW]);
    leftPts.push([pts[i][0] - nx * halfW, pts[i][1] - ny * halfW]);
  }

  // H799: pull the collision rails back from both deck ends (entry/exit
  // funnel — see BRIDGE_BARRIER_MOUTH_INSET_TILES). Deck polygon and
  // triggers below keep the FULL un-inset extent so layer transitions
  // and render occlusion are unchanged. Falls back to the un-inset
  // polylines on very short bridges (inset would consume them).
  let roadLen = 0;
  for (let i = 0; i < N - 1; i++) {
    const dx = pts[i + 1][0] - pts[i][0];
    const dy = pts[i + 1][1] - pts[i][1];
    roadLen += Math.sqrt(dx * dx + dy * dy);
  }
  const mouthInset = Math.min(BRIDGE_BARRIER_MOUTH_INSET_TILES, roadLen * 0.25);
  const railRight = bridgeInsetPolylineEnds(rightPts, mouthInset) ?? rightPts;
  const railLeft = bridgeInsetPolylineEnds(leftPts, mouthInset) ?? leftPts;

  const barriers: BridgeBarrier[] = [];
  for (let i = 0; i < railRight.length - 1; i++) {
    barriers.push({
      x1: railRight[i][0], y1: railRight[i][1],
      x2: railRight[i + 1][0], y2: railRight[i + 1][1],
      l1only: true,
    });
  }
  for (let i = 0; i < railLeft.length - 1; i++) {
    barriers.push({
      x1: railLeft[i][0], y1: railLeft[i][1],
      x2: railLeft[i + 1][0], y2: railLeft[i + 1][1],
      l1only: true,
    });
  }

  const deck: Point2[] = [];
  for (let i = 0; i < N; i++) deck.push(rightPts[i]);
  for (let i = N - 1; i >= 0; i--) deck.push(leftPts[i]);

  const triggers: BridgeTrigger[] = [];
  const startEpt = pts[0];
  const endEpt = pts[N - 1];
  const tol2 = shareTol * shareTol;
  const ownZ = road.z || 0;

  const isConnectedToOther = (epx: number, epy: number, other: BridgeRoadFull): boolean => {
    if ((other.z || 0) === ownZ) return false;
    if (!other.pts || other.pts.length < 2) return false;
    const oS = other.pts[0];
    const oE = other.pts[other.pts.length - 1];
    if ((epx - oS[0]) * (epx - oS[0]) + (epy - oS[1]) * (epy - oS[1]) < tol2) return true;
    if ((epx - oE[0]) * (epx - oE[0]) + (epy - oE[1]) * (epy - oE[1]) < tol2) return true;
    for (let i = 0; i < other.pts.length - 1; i++) {
      const ax = other.pts[i][0];
      const ay = other.pts[i][1];
      const bx = other.pts[i + 1][0];
      const by = other.pts[i + 1][1];
      const dx = bx - ax;
      const dy = by - ay;
      const lenSq = dx * dx + dy * dy;
      if (lenSq < 0.0001) continue;
      let t = ((epx - ax) * dx + (epy - ay) * dy) / lenSq;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const px2 = ax + t * dx;
      const py2 = ay + t * dy;
      const dd2 = (epx - px2) * (epx - px2) + (epy - py2) * (epy - py2);
      if (dd2 < tol2) return true;
    }
    return false;
  };

  // H800: connection scan also accumulates the widest connected road's
  // half-width per end — the ground-level end walls below leave an
  // opening exactly that wide for the approach road's mouth.
  let startConnects = false;
  let endConnects = false;
  let startConnHalfW = 0;
  let endConnHalfW = 0;
  for (const other of allRoads) {
    if (other === road) continue;
    if (isConnectedToOther(startEpt[0], startEpt[1], other)) {
      startConnects = true;
      const op = other._prof || getRoadProfile(other);
      startConnHalfW = Math.max(startConnHalfW, (op?.totalW ?? 4) / 2);
    }
    if (isConnectedToOther(endEpt[0], endEpt[1], other)) {
      endConnects = true;
      const op = other._prof || getRoadProfile(other);
      endConnHalfW = Math.max(endConnHalfW, (op?.totalW ?? 4) / 2);
    }
  }
  // H844: push the layer-flip triggers OUTWARD from the deck end by ~half
  // a car length. The trigger flips the player's render layer when their
  // CENTRE crosses it; with the trigger right on the deck-end edge, the
  // car's NOSE was already half a length onto the deck (drawn UNDER it,
  // since the layer hadn't flipped) — the user's "cars clip under bridges
  // at the beginning/end when transitioning layers". Crossing the trigger
  // a half-car before the deck means the body is drawn ON the deck the
  // instant it touches it. Outward = direction from the 2nd vertex to the
  // end vertex. Helps entry AND exit (the flip-back also moves out).
  const TRIGGER_OUT_TILES = 1.0; // ≈ half a car length
  const outVec = (a: Point2, b: Point2): [number, number] => {
    const dx = a[0] - b[0], dy = a[1] - b[1];
    const m = Math.hypot(dx, dy) || 1;
    return [dx / m * TRIGGER_OUT_TILES, dy / m * TRIGGER_OUT_TILES];
  };
  if (startConnects) {
    const [ox, oy] = outVec(pts[0], pts[1]);
    triggers.push({
      x1: rightPts[0][0] + ox, y1: rightPts[0][1] + oy,
      x2: leftPts[0][0] + ox,  y2: leftPts[0][1] + oy,
    });
  }
  if (endConnects) {
    const [ox, oy] = outVec(pts[N - 1], pts[N - 2]);
    triggers.push({
      x1: leftPts[N - 1][0] + ox,  y1: leftPts[N - 1][1] + oy,
      x2: rightPts[N - 1][0] + ox, y2: rightPts[N - 1][1] + oy,
    });
  }
  if (!startConnects && !endConnects) return null;

  // ---- H800: ground-layer (l0only) abutment structure ----------------
  // User-reported holes in the layer model: a layer-0 car could wander
  // the full under-deck strip, reach a deck END from below, cross the
  // end trigger, and pop "onto" the bridge. Physically the space under
  // a bridge is solid abutment/embankment EXCEPT where the lower road
  // passes. Model that with layer-0-only walls:
  //   1. SIDE walls along both deck edges, with openings where a lower
  //      (z < ownZ) crossing road's corridor passes through.
  //   2. CORRIDOR cross-walls flanking each lower road's right-of-way
  //      under the deck, so the corridor can't be used to drive
  //      lengthwise under the bridge.
  //   3. END walls across each deck end, with an opening the width of
  //      the connected approach road (full wall at unconnected ends).
  // Layer-1 cars (on the deck) skip every l0only wall; the lower road
  // itself stays fully drivable through its corridor.
  // H801: 1.5 → 2.0 — the user clipped a corridor cross-wall at low
  // speed while passing under slightly off the lower road's centerline;
  // 2 tiles beyond the asphalt gives a comfortable car-width of slack.
  // H842: 2.0 → 3.5 — wider under-bridge corridor so a car passing under
  // an overpass slightly off the lower road's centerline doesn't clip an
  // abutment side/cross-wall (the H838 full-width deck made the under-deck
  // solid region wider, leaving less drift slack). Mirrors the user's
  // "stuck under the bridge" repro.
  const L0_CORRIDOR_MARGIN = 3.5; // tiles beyond the lower road's asphalt
  const L0_STEP = 1.0;            // side-wall resample step (tiles)

  // Lower-z roads that actually cross this bridge's centerline, with
  // their first crossing point + the local bridge tangent there.
  const lowerXs: Array<{
    halfW: number;
    pts: ReadonlyArray<Point2>;
    hitX: number; hitY: number;
    bdX: number; bdY: number;     // bridge unit tangent at the hit
    sinTheta: number;             // |sin| of the crossing angle
  }> = [];
  for (const other of allRoads) {
    if (other === road) continue;
    if ((other.z || 0) >= ownZ) continue;
    if (!other.pts || other.pts.length < 2) continue;
    let found: { hitX: number; hitY: number; bdX: number; bdY: number; sinTheta: number } | null = null;
    for (let i = 0; i < N - 1 && !found; i++) {
      for (let j = 0; j < other.pts.length - 1; j++) {
        const hit = bridgeSegSegIntersect(
          pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1],
          other.pts[j][0], other.pts[j][1], other.pts[j + 1][0], other.pts[j + 1][1],
        );
        if (!hit) continue;
        const bdx = pts[i + 1][0] - pts[i][0];
        const bdy = pts[i + 1][1] - pts[i][1];
        const bl = Math.sqrt(bdx * bdx + bdy * bdy) || 1;
        const ldx = other.pts[j + 1][0] - other.pts[j][0];
        const ldy = other.pts[j + 1][1] - other.pts[j][1];
        const ll = Math.sqrt(ldx * ldx + ldy * ldy) || 1;
        const dot = (bdx * ldx + bdy * ldy) / (bl * ll);
        found = {
          hitX: hit.x, hitY: hit.y,
          bdX: bdx / bl, bdY: bdy / bl,
          sinTheta: Math.max(0.3, Math.sqrt(Math.max(0, 1 - dot * dot))),
        };
        break;
      }
    }
    if (found) {
      const op = other._prof || getRoadProfile(other);
      lowerXs.push({ halfW: (op?.totalW ?? 4) / 2, pts: other.pts, ...found });
    }
  }

  // True when (x, y) [tiles] sits inside ONE crossing road's corridor
  // (asphalt + margin). Wall emitters carve openings where this holds.
  const inCorridorOf = (
    x: number, y: number, lo: { halfW: number; pts: ReadonlyArray<Point2> },
  ): boolean => {
    const reach = lo.halfW + L0_CORRIDOR_MARGIN;
    const reach2 = reach * reach;
    for (let i = 0; i < lo.pts.length - 1; i++) {
      const ax = lo.pts[i][0];
      const ay = lo.pts[i][1];
      const bx = lo.pts[i + 1][0];
      const by = lo.pts[i + 1][1];
      const dx = bx - ax;
      const dy = by - ay;
      const L2 = dx * dx + dy * dy;
      let t = L2 < 0.0001 ? 0 : ((x - ax) * dx + (y - ay) * dy) / L2;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const qx = ax + t * dx;
      const qy = ay + t * dy;
      if ((x - qx) * (x - qx) + (y - qy) * (y - qy) <= reach2) return true;
    }
    return false;
  };
  const inCorridor = (x: number, y: number): boolean => {
    for (const lo of lowerXs) if (inCorridorOf(x, y, lo)) return true;
    return false;
  };

  // Shared wall emitter: resample a polyline at L0_STEP, emit merged
  // runs of steps whose midpoint the `isOpen` predicate rejects. Every
  // wall kind funnels through this so corridor openings are carved
  // identically everywhere.
  const emitWallRuns = (
    poly: ReadonlyArray<Point2>,
    isOpen: (x: number, y: number) => boolean,
  ): void => {
    const samples: Point2[] = [poly[0]];
    for (let i = 0; i < poly.length - 1; i++) {
      const ax = poly[i][0];
      const ay = poly[i][1];
      const bx = poly[i + 1][0];
      const by = poly[i + 1][1];
      const segL = Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay));
      const steps = Math.max(1, Math.ceil(segL / L0_STEP));
      for (let s = 1; s <= steps; s++) {
        samples.push([ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps]);
      }
    }
    let runStart: Point2 | null = null;
    for (let k = 0; k < samples.length - 1; k++) {
      const open = isOpen(
        (samples[k][0] + samples[k + 1][0]) / 2,
        (samples[k][1] + samples[k + 1][1]) / 2,
      );
      if (!open && runStart === null) runStart = samples[k];
      const atEnd = k === samples.length - 2;
      if (runStart !== null && (open || atEnd)) {
        const endPt = open ? samples[k] : samples[k + 1];
        if (endPt[0] !== runStart[0] || endPt[1] !== runStart[1]) {
          barriers.push({
            x1: runStart[0], y1: runStart[1],
            x2: endPt[0], y2: endPt[1],
            l0only: true,
          });
        }
        runStart = null;
      }
    }
  };

  // H847: SIDE walls + CORRIDOR cross-walls REMOVED. They ran along the
  // entire deck edge (opening only where a crossing road passed), so the
  // whole space under a long elevated highway was solid at ground level
  // EXCEPT at road corridors. User repro (screenshot, mid-pursuit): pinned
  // on the grass beside an overpass against an invisible side wall —
  // "I can't drive under bridges on lower layers." The under-deck space is
  // now freely drivable at layer 0 (overpasses sit on columns, not solid
  // embankment). The pop-onto-deck-from-below exploit that the side walls
  // also guarded (H800) stays covered by the END walls below: a layer-0
  // car under the deck is H785-demoted (drawn under) and can only reach a
  // layer-flip trigger by driving out a deck END, which the end walls
  // block down to the approach opening. lowerXs/inCorridor are still
  // computed — the end walls use inCorridor to carve openings for a road
  // that crosses near a deck end (inCorridor → lowerXs, still computed).

  // END walls — two stubs per end from the approach opening out to
  // the deck edge. Opening = widest connected road + 0.5 tile margin;
  // unconnected ends close fully (stubs meet at the centerline). Stubs
  // also carve openings for any corridor passing near a deck end.
  const emitEndWalls = (
    ept: Point2, toward: Point2, connHalfW: number,
  ): void => {
    const dx = toward[0] - ept[0];
    const dy = toward[1] - ept[1];
    const dl = Math.sqrt(dx * dx + dy * dy) || 1;
    const pxn = -dy / dl;
    const pyn = dx / dl;
    // H842: ALWAYS leave a drivable opening at a deck end. Pre-H842 an end
    // whose connection wasn't detected (connHalfW === 0 — common on a
    // freshly re-drawn editor bridge whose endpoint sits a hair off the
    // approach road) got a FULL l0only wall, trapping the player at the
    // bridge entrance/exit ("stuck as if a barrier was there"). Floor the
    // opening at 80% of the deck half-width so the car can always drive on
    // and off; the outer 20% stub keeps most of the H800 dead-end guard.
    const minOpen = halfW * 0.8;
    const oh = connHalfW > 0 ? Math.min(halfW, Math.max(connHalfW + 0.5, minOpen)) : minOpen;
    if (oh >= halfW) return;
    for (const side of [1, -1]) {
      emitWallRuns(
        [
          [ept[0] + pxn * oh * side, ept[1] + pyn * oh * side],
          [ept[0] + pxn * halfW * side, ept[1] + pyn * halfW * side],
        ],
        inCorridor,
      );
    }
  };
  emitEndWalls(startEpt, pts[1], startConnects ? startConnHalfW : 0);
  emitEndWalls(endEpt, pts[N - 2], endConnects ? endConnHalfW : 0);

  return {
    // H991: the id also encodes the first deck point — span-split can
    // legitimately produce TWO elevated pieces with the same name+z (two
    // overpasses cut from one road), and the rebuild dedupe would silently
    // drop the second structure (no parapets/triggers) on a name+z-only id.
    // Same road re-processed still dedupes (same first point).
    id: 'syn_' + (road.name || 'road') + '_' + (road.z || 0)
      + '_' + Math.round(pts[0][0]) + '_' + Math.round(pts[0][1]),
    upperRoadName: road.name || '',
    deck,
    ramps: [],
    triggers,
    barriers,
    // H799: render cue mirrors the inset collision rails so the painted
    // jersey walls match where the car actually collides.
    barrierPolylines: [railRight.slice(), railLeft.slice()],
    _synthetic: true,
  };
}

/** Boot orchestrator — walk `majorRoads`, build a synthetic bridge
 *  for every elevated road, append it to `structures` if its id isn't
 *  already present. Mutates `structures` in place so the caller can
 *  use a single canonical BRIDGE_STRUCTURES array (matches monolith
 *  init-time push pattern).
 *
 *  RUN ORDER: caller invokes AFTER the hardcoded highway-on-highway
 *  bridges have been pushed (via bridgeMakeStructure). Pre-drawn
 *  roads must be fully populated in `majorRoads` by this point.
 *
 *  DUPLICATE GUARD: synthetic ids encode (road name, z) — if the
 *  caller already pushed a hardcoded structure with the same id
 *  (e.g. via explicit id collision), the synthetic version is
 *  silently skipped. Hardcoded ids in practice are crossing-named
 *  (`i77_over_i85`, etc.) and synthetic ids prefix with `syn_`, so
 *  collisions don't happen in normal data — the guard exists for
 *  defensive idempotence (re-running this function is safe).
 *
 *  Ported 1:1 from monolith L29179-L29189 (the top-level boot block
 *  that drives _buildSyntheticBridgeForRoad in a loop). */
export function bridgeAddAllSynthetic(
  structures: BridgeStructureMade[],
  majorRoads: ReadonlyArray<BridgeRoadFull>,
  getRoadProfile: (road: BridgeRoadFull) => BridgeRoadProfile,
  shareTol: number = BRIDGE_SYNTHETIC_SHARE_TOL,
): void {
  const seenIds = new Set(structures.map((b) => b.id));
  for (const r of majorRoads) {
    const synth = bridgeBuildSyntheticForRoad(r, majorRoads, shareTol, getRoadProfile);
    if (synth && !seenIds.has(synth.id)) {
      structures.push(synth);
      seenIds.add(synth.id);
    }
  }
}

/** Two-phase bridge render. Called from the host game's render() at
 *  two distinct points:
 *
 *    - `'before'` — draw the thin jersey-wall side barriers as a
 *      subtle bridge-edge cue. Stroke is `#bbbbb4` (light grey), 2
 *      lineWidth, butt caps, round joins. The full deck-obscure
 *      pass (clip + redraw the upper road on top of the player when
 *      under-driving) is INLINE at the call site in render(), where
 *      drawRoadOverlay is in scope — not handled here.
 *
 *    - `'after'` — currently a no-op for the same reason; the
 *      inline obscure is at the call site. The phase argument is
 *      retained for forward-compatibility if a future render needs
 *      to do something on the second pass.
 *
 *  Prefers `barrierPolylines` (one stroke per side — segments form
 *  a smooth polyline along the curved road edge) over the flat
 *  `barriers` segment list. The polyline path makes joins look
 *  continuous on curved bridges; the per-segment fallback exists
 *  so any future bridge built without polyline data still renders.
 *
 *  All input geometry is read in TILE coords and multiplied by
 *  TILE at draw time (matches the bridge data convention).
 *
 *  Ported 1:1 from monolith L29197-L29239 _bridgeRender. */
export function bridgeRender(
  rctx: CanvasRenderingContext2D,
  phase: 'before' | 'after',
  structures: ReadonlyArray<BridgeStructureMade>,
  TILE: number,
): void {
  if (structures.length === 0) return;
  for (const bs of structures) {
    if (!bs.deck || bs.deck.length < 3) continue;
    if (phase === 'before') {
      rctx.save();
      rctx.strokeStyle = '#bbbbb4';
      rctx.lineWidth = 2;
      rctx.lineCap = 'butt';
      rctx.lineJoin = 'round';
      if (bs.barrierPolylines && bs.barrierPolylines.length > 0) {
        for (const poly of bs.barrierPolylines) {
          if (!poly || poly.length < 2) continue;
          rctx.beginPath();
          rctx.moveTo(poly[0][0] * TILE, poly[0][1] * TILE);
          for (let i = 1; i < poly.length; i++) {
            rctx.lineTo(poly[i][0] * TILE, poly[i][1] * TILE);
          }
          rctx.stroke();
        }
      } else {
        for (const b of bs.barriers) {
          rctx.beginPath();
          rctx.moveTo(b.x1 * TILE, b.y1 * TILE);
          rctx.lineTo(b.x2 * TILE, b.y2 * TILE);
          rctx.stroke();
        }
      }
      rctx.restore();
    }
  }
}

/** Render-z elevation threshold for ramps. Climb fraction must
 *  exceed this for the ramp to count as "elevated" for car-under
 *  testing. Below this, the player is still essentially at ground
 *  level on the ramp foot and should not be sorted behind the
 *  bridge structure. Matches monolith L28572 RAMP_CLIMB_THRESHOLD. */
export const BRIDGE_RAMP_CLIMB_THRESHOLD = 0.15;

/** True iff the player is on layer 0 AND any corner of the OBB is
 *  under an elevated portion of a bridge (highway deck) or far
 *  enough up a ramp (climb > BRIDGE_RAMP_CLIMB_THRESHOLD). Used by
 *  the renderer to z-sort the player car: under elevated → draw
 *  early so the bridge structure obscures it; otherwise draw on top.
 *
 *  Returns false trivially when:
 *    - No bridge structures exist.
 *    - Player is on layer 1 (driving on the upper road — never
 *      "under" anything in that case).
 *
 *  Otherwise: build the OBB corners in world pixels, convert each
 *  corner to TILE coords (deck / ramp polys are in tile coords),
 *  and run point-in-poly against each structure's deck + ramps.
 *  Decks count as elevated everywhere (no climb interpolation);
 *  ramps count only when the corner's climb fraction exceeds the
 *  threshold.
 *
 *  Ported 1:1 from monolith L28565-L28591 _bridgeCarUnderElevated. */
export function bridgeCarUnderElevated(
  cx: number,
  cy: number,
  ang: number,
  layer: number,
  structures: ReadonlyArray<BridgeStructureForElevation>,
  TILE: number,
): boolean {
  if (structures.length === 0) return false;
  if (layer !== 0) return false;
  const corners = bridgeGetCorners(
    cx, cy, ang,
    BRIDGE_PLAYER_HALF_L, BRIDGE_PLAYER_HALF_W,
  );
  for (const c of corners) {
    const ctx_ = c[0];
    const cty_ = c[1];
    for (const bs of structures) {
      const ctileX = ctx_ / TILE;
      const ctileY = cty_ / TILE;
      if (bs.deck && bs.deck.length >= 3) {
        if (bridgePointInPoly(ctileX, ctileY, bs.deck)) return true;
      }
      for (const r of bs.ramps) {
        if (!bridgePointInPoly(ctileX, ctileY, r.poly)) continue;
        const climb = bridgeRampClimbT(r, ctileX, ctileY);
        if (climb > BRIDGE_RAMP_CLIMB_THRESHOLD) return true;
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
