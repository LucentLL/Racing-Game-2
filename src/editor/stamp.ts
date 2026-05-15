/**
 * World Editor — tile-stamping helpers for overlay content.
 *
 * Each stamp function takes one drawn polygon/polyline and writes its
 * interior tiles to the world tile array. The stamp values match the
 * tile constants the game-side render and physics already recognize:
 *
 *  - tile=1  road             — drivable, full road rendering
 *  - tile=9  water            — off-road, 50% top speed; already pixel-art
 *  - tile=17 user building    — same palette as procedural buildings,
 *                              but NOT subject to the I-277 grass-
 *                              conversion check (so user buildings
 *                              survive outside downtown — v8.99.124.x)
 *
 * Water tile=9 is stamped SOFT (only if the existing tile is "natural"
 * — grass/forest/water/empty). This preserves roads (1,2,3,15),
 * highways (7,8), bridges (10), and structures (4,5,17) so a user-drawn
 * river crossing an existing road doesn't break the road.
 *
 * Ported from monolith L10022-10200.
 *
 * SCAFFOLD status: type contract + entry points stubbed with TODO line refs.
 */

/** A polygon in tile coordinates. */
export type TilePoint = [number, number];
export type TilePolygon = TilePoint[];

/** Host bindings for tile read/write. */
export interface StampDeps {
  MAP_W: number;
  MAP_H: number;
  getTile(x: number, y: number): number;
  setTile(x: number, y: number, v: number): void;
  /** The source-defined majorRoads array — needed by _weMakeDriveway
   *  for nearest-road resolution. */
  getMajorRoads(): Array<{ pts: number[][] }>;
}

/** Surface row — drivable asphalt polygon. */
export interface SurfaceRow {
  pts: TilePolygon;
  [k: string]: unknown;
}

/** Building row — user-placed building footprint. */
export interface BuildingRow {
  pts: TilePolygon;
  [k: string]: unknown;
}

/** River row — water polyline. v8.99.124.28 schema. */
export interface RiverRow {
  pts: TilePolygon;
  w: number;
  [k: string]: unknown;
}

/** Lake row — water polygon. v8.99.124.28 schema. */
export interface LakeRow {
  pts: TilePolygon;
  [k: string]: unknown;
}

/** Even-odd scan-fill driver. Calls fillFn(x, y) for each interior tile.
 *  The half-open edge test ((ay<=y && by>y) || (by<=y && ay>y)) prevents
 *  double-counting at vertices shared by two edges. TODO(E33-followup):
 *  port from L10022-10044. */
export function _weScanFillPolygon(_pts: TilePolygon, _fillFn: (x: number, y: number) => void): void {
  // TODO: L10022-10044. Bounded by min/max Y across vertices. Horizontal
  // scanlines, sort x-crossings, fill in pairs.
}

/** Stamp a surface (drivable asphalt) polygon as tile=1.
 *  TODO(E33-followup): port from L10046-10051. */
export function _weStampSurface(_surface: SurfaceRow, _deps: StampDeps): void {
  // TODO: L10046-10051. _weScanFillPolygon → setTile(x,y,1) with bounds guard.
}

/** Stamp a user-placed building footprint as tile=17. Tile=17 uses the
 *  same getBldg() palette as procedural buildings but is NOT in the
 *  I-277 grass-conversion check (which only matches tile===4||tile===5),
 *  so user buildings survive outside downtown.
 *  TODO(E33-followup): port from L10058-10063. */
export function _weStampBuilding(_building: BuildingRow, _deps: StampDeps): void {
  // TODO: L10058-10063. _weScanFillPolygon → setTile(x,y,17) with bounds guard.
}

/** Soft water stamp — only writes tile=9 if the existing tile is
 *  "natural" (one of {0, 6, 9, 11, 13, 255}). Preserves all road,
 *  highway, bridge, and structure tiles. TODO(E33-followup): port from
 *  L10070-10076. */
export function _weStampWaterIfNatural(_x: number, _y: number, _deps: StampDeps): void {
  // TODO: L10070-10076. Bounds guard, getTile, set only if in natural set.
}

/** Stamp a river polyline as tile=9. Bresenham walk + perpendicular
 *  width brush (square — sub-tile circle vs square is invisible at
 *  GBC scale). Width is in tiles; brush radius = max(1, floor(w/2)).
 *  Goes through _weStampWaterIfNatural so existing structures survive.
 *  TODO(E33-followup): port from L10080-10103. */
export function _weStampRiverTiles(_w: number, _pts: TilePolygon, _deps: StampDeps): void {
  // TODO: L10080-10103. Per-segment Bresenham; at each step stamp a
  // (2*rad+1)² square brush around (cx,cy) via _weStampWaterIfNatural.
}

/** Stamp a lake polygon's interior as tile=9 via _weStampWaterIfNatural.
 *  Same scan-fill pipeline as surfaces but soft-writes. TODO(E33-followup):
 *  port from L10108-10113. */
export function _weStampLake(_lake: LakeRow, _deps: StampDeps): void {
  // TODO: L10108-10113. _weScanFillPolygon → _weStampWaterIfNatural.
}

/** Compute an auto-driveway connecting a building to the nearest road.
 *  Returns a 4-vertex rectangular polygon (drivable asphalt) or null if
 *  no road is in range. Driveway endpoints: nearest point on the
 *  building edge + nearest point on the nearest road centerline. Width
 *  fixed at 4 tiles; max bridging distance 50 tiles.
 *
 *  The road end extends slightly INTO the road (1 tile past
 *  bestRoadPt) so the driveway polygon overlaps the road bitmap and
 *  the merge is visually seamless.
 *
 *  TODO(E33-followup): port from L10120-10178. */
export function _weMakeDriveway(_buildingPts: TilePolygon, _deps: StampDeps): TilePolygon | null {
  // TODO: L10120-10178. Building centroid → nearest road point across all
  // majorRoads segments → nearest building-edge point to that road point
  // → perpendicular 2-tile-halfwidth rectangle.
  return null;
}

/** Stamp an overlay road's tiles as tile=1. Mirrors the source-side _rp
 *  Bresenham stamp logic so overlay roads are drivable identically to
 *  baseline roads. Width is capped at 2 (matches the source behavior).
 *  TODO(E33-followup): port from L10179-10199. */
export function _weStampRoadTiles(_w: number, _pts: TilePolygon, _deps: StampDeps): void {
  // TODO: L10179-10199. const tw = Math.min(w, 2). Per-segment Bresenham;
  // at each step stamp a tw-wide line via setTile(x,y+wi,1) [vertical
  // strip] and conditionally setTile(x+wi,y,1) [horizontal strip when tw>1].
}
