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
  majorRoads: ReadonlyArray<BridgeUpperRoad>,
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
    return;
  }
  if (state.layer === 0) {
    const r = bridgeFindUpperRoad(activeBridge.upperRoadName, majorRoads);
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
      if (align > BRIDGE_HEADING_ALIGN_THRESHOLD) {
        state.layer = 1;
      }
      // else: heading perpendicular to upper road → on lower road,
      // keep layer 0.
    }
  }
  // If layer is already 1, trust the trigger system. The "force 0
  // when outside deck" branch above handled the side-route exit
  // case already.
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
