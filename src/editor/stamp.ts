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
 *  - tile=18 parking lot (asphalt) — drivable asphalt with stall-stripe
 *                              pixel-art. Not in the off-grass
 *                              classifier (6/255/11/9/13/0), so physics
 *                              treats it as drivable (same as tile=1).
 *                              NEW feature hop H693, not in the monolith.
 *  - tile=19 parking lot (concrete) — same physics + stamp/render shape
 *                              as tile=18 but lighter base color and
 *                              darker stripes. H695.
 *
 * Water tile=9 is stamped SOFT (only if the existing tile is "natural"
 * — grass/forest/water/empty). This preserves roads (1,2,3,15),
 * highways (7,8), bridges (10), and structures (4,5,17) so a user-drawn
 * river crossing an existing road doesn't break the road.
 *
 * Ported 1:1 from monolith L10022-10200 (H290-H297). All 7 functions
 * (scan-fill leaf + 5 stamps + driveway constructor) are full ports;
 * the original module-globals closure over MAP_W/MAP_H/getTile/setTile/
 * majorRoads is replaced by an explicit StampDeps binding.
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

/** Parking-lot row — drivable lot with painted stalls.
 *  H693 introduced the kind with tile=18 fixed. H695 adds material:
 *  'asphalt' (tile=18) vs 'concrete' (tile=19). H699 adds per-lot
 *  stall+aisle dimensions so each lot keeps its own geometry. */
export interface ParkingLotRow {
  pts: TilePolygon;
  material?: 'asphalt' | 'concrete';
  stallW?: number;
  stallL?: number;
  aisleW?: number;
  [k: string]: unknown;
}

/** Parsed parking-lot row metadata. xStart is where polygon coords begin
 *  (1 in legacy H693, 2 in H695, 5 in H699). H699 dimensions default to
 *  the constants in parkingLayout.ts when reading older rows. */
export interface ParsedParkingLot {
  name: string;
  material: 'asphalt' | 'concrete';
  stallW: number;
  stallL: number;
  aisleW: number;
  xStart: 1 | 2 | 5;
}

/** Defaults for missing H699 fields — mirror parkingLayout's DEFAULT_*. */
const DEFAULT_STALL_W = 1.0;
const DEFAULT_STALL_L = 2.0;
const DEFAULT_AISLE_W = 2.0;

/** Decode a parking-lot row's meta block. Handles three schemas:
 *    - H693 legacy: [name, x1, y1, ...]                          (odd, row[1] number)
 *    - H695:        [name, material, x1, y1, ...]                (even)
 *    - H699:        [name, material, stallW, stallL, aisleW, x1, y1, ...] (odd, row[1] string)
 *  Disambiguation:
 *    - Even length → H695 (xStart=2).
 *    - Odd length + row[1] is string → H699 (xStart=5).
 *    - Odd length + row[1] is number → H693 (xStart=1).
 *  Storage layer also migrates old rows to H699 on load (storage.ts).
 *  Used by every consumer that reads `state.parkingLots` so the schema
 *  check lives in one place. */
export function _weParseParkingLotMeta(row: unknown[]): ParsedParkingLot {
  const name = (typeof row[0] === 'string' ? row[0] : 'Parking Lot') as string;
  const isEven = (row.length & 1) === 0;
  if (isEven) {
    // H695 — material only.
    const m = row[1];
    const material: 'asphalt' | 'concrete' = m === 'concrete' ? 'concrete' : 'asphalt';
    return {
      name,
      material,
      stallW: DEFAULT_STALL_W,
      stallL: DEFAULT_STALL_L,
      aisleW: DEFAULT_AISLE_W,
      xStart: 2,
    };
  }
  if (typeof row[1] === 'string') {
    // H699 — material + dimensions.
    const m = row[1];
    const material: 'asphalt' | 'concrete' = m === 'concrete' ? 'concrete' : 'asphalt';
    const stallW = typeof row[2] === 'number' && row[2] > 0 ? row[2] : DEFAULT_STALL_W;
    const stallL = typeof row[3] === 'number' && row[3] > 0 ? row[3] : DEFAULT_STALL_L;
    const aisleW = typeof row[4] === 'number' && row[4] > 0 ? row[4] : DEFAULT_AISLE_W;
    return { name, material, stallW, stallL, aisleW, xStart: 5 };
  }
  // H693 legacy — coords start at row[1].
  return {
    name,
    material: 'asphalt',
    stallW: DEFAULT_STALL_W,
    stallL: DEFAULT_STALL_L,
    aisleW: DEFAULT_AISLE_W,
    xStart: 1,
  };
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
 *  double-counting at vertices shared by two edges. Ported 1:1 from
 *  monolith L10022-10044. */
export function _weScanFillPolygon(pts: TilePolygon, fillFn: (x: number, y: number) => void): void {
  if (!pts || pts.length < 3) return;
  let minY = Infinity, maxY = -Infinity;
  for (const p of pts) { if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
  minY = Math.floor(minY); maxY = Math.ceil(maxY);
  for (let y = minY; y <= maxY; y++) {
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const ay = a[1], by = b[1];
      if ((ay <= y && by > y) || (by <= y && ay > y)) {
        const t = (y - ay) / (by - ay);
        xs.push(a[0] + t * (b[0] - a[0]));
      }
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const x0 = Math.floor(xs[i]), x1 = Math.ceil(xs[i + 1]);
      for (let x = x0; x <= x1; x++) fillFn(x, y);
    }
  }
}

/** Stamp a surface polygon. Default tile=1 (drivable asphalt); H999
 *  driveways pass tile=19 (concrete). Ported 1:1 from monolith
 *  L10046-10051 (H999 parameterized tile). */
export function _weStampSurface(surface: SurfaceRow, deps: StampDeps, tileId = 1): void {
  if (!surface || !surface.pts || surface.pts.length < 3) return;
  _weScanFillPolygon(surface.pts, (x, y) => {
    if (x >= 0 && x < deps.MAP_W && y >= 0 && y < deps.MAP_H) deps.setTile(x, y, tileId);
  });
}

/** H999: a surface row is a concrete DRIVEWAY when its name ends in
 *  "driveway" (both auto-driveway emit sites name it "<building> driveway").
 *  Drives concrete tile=19 stamping + concrete render. */
export function _weIsDrivewayName(name: unknown): boolean {
  return typeof name === 'string' && /driveway\s*$/i.test(name);
}

/** H1006: garage-opening geometry (tile coords) at a building's FRONT edge.
 *  Preset footprints are ordered [back-L, back-R, front-R, front-L], so the
 *  FRONT (road/driveway-facing) edge is corners[2]→corners[3] — no road data
 *  needed, and rotation preserves the index order. The garage is a rect
 *  centered on the front-edge midpoint, `garageLanes` lanes wide along the
 *  front, extending GARAGE_DEPTH tiles INTO the building. Returns null for
 *  freeform (non-4-corner) footprints. Shared by the stamp carve, the
 *  drive-in zone test, and the door render so all three align. */
export interface GarageRect {
  fcx: number; fcy: number;   // front-edge center (tile)
  lax: number; lay: number;   // unit length axis (along the front edge)
  dax: number; day: number;   // unit depth axis (INTO the building)
  halfW: number;              // half garage width (tiles, along the front)
  depth: number;              // garage depth into the building (tiles)
}
const GARAGE_DEPTH_TILES = 3;
export function _weGarageRect(
  corners: ReadonlyArray<readonly [number, number]>,
  garageLanes: number,
): GarageRect | null {
  if (!corners || corners.length < 4) return null;
  const c2 = corners[2], c3 = corners[3];
  const fcx = (c2[0] + c3[0]) / 2, fcy = (c2[1] + c3[1]) / 2;
  let lx = c3[0] - c2[0], ly = c3[1] - c2[1];
  const lLen = Math.hypot(lx, ly) || 1; lx /= lLen; ly /= lLen;
  let cx = 0, cy = 0;
  for (const c of corners) { cx += c[0]; cy += c[1]; }
  cx /= corners.length; cy /= corners.length;
  let dx = cx - fcx, dy = cy - fcy;
  const dLen = Math.hypot(dx, dy) || 1; dx /= dLen; dy /= dLen;
  const halfW = Math.max(0.9, Math.max(1, garageLanes) * DRIVEWAY_LANE_W * 0.6);
  return { fcx, fcy, lax: lx, lay: ly, dax: dx, day: dy, halfW, depth: GARAGE_DEPTH_TILES };
}
/** True when tile-coord (tx,ty) is inside the garage opening. */
export function _weInGarage(g: GarageRect, tx: number, ty: number): boolean {
  const along = (tx - g.fcx) * g.lax + (ty - g.fcy) * g.lay;
  const into = (tx - g.fcx) * g.dax + (ty - g.fcy) * g.day;
  return Math.abs(along) <= g.halfW && into >= -0.6 && into <= g.depth;
}

/** Stamp a user-placed building footprint as tile=17 (SOLID). When
 *  `garageLanes > 0` a drivable GARAGE notch is carved at the FRONT edge —
 *  those tiles stamp tile=19 (concrete, non-solid) so the player can drive
 *  in (H1006). Tile=17 uses the getBldg() palette + bypasses the I-277
 *  grass-conversion check so user buildings survive outside downtown. */
export function _weStampBuilding(building: BuildingRow, deps: StampDeps, garageLanes = 0): void {
  if (!building || !building.pts || building.pts.length < 3) return;
  const garage = garageLanes > 0
    ? _weGarageRect(building.pts as ReadonlyArray<readonly [number, number]>, garageLanes)
    : null;
  _weScanFillPolygon(building.pts, (x, y) => {
    if (x < 0 || x >= deps.MAP_W || y < 0 || y >= deps.MAP_H) return;
    // +0.5 → tile CENTER for the garage membership test.
    deps.setTile(x, y, garage && _weInGarage(garage, x + 0.5, y + 0.5) ? 19 : 17);
  });
}

/** Stamp a parking-lot polygon as tile=18 (asphalt) or tile=19 (concrete).
 *  Hard write — overwrites whatever is inside the polygon (including
 *  road tile=1), since the user explicitly drew the polygon to mark this
 *  area as a lot. The pixel-art stall stripes are baked into the tile
 *  renderer (src/render/ground.ts), so all this stamp does is write the
 *  tile id. H693 added the asphalt path; H695 added concrete. */
export function _weStampParkingLot(lot: ParkingLotRow, deps: StampDeps): void {
  if (!lot || !lot.pts || lot.pts.length < 3) return;
  const tileId = lot.material === 'concrete' ? 19 : 18;
  _weScanFillPolygon(lot.pts, (x, y) => {
    if (x >= 0 && x < deps.MAP_W && y >= 0 && y < deps.MAP_H) deps.setTile(x, y, tileId);
  });
}

/** Soft water stamp — only writes tile=9 if the existing tile is
 *  "natural" (one of {0, 6, 9, 11, 13, 255}). Preserves all road,
 *  highway, bridge, and structure tiles. The natural-tile set matches
 *  the physics off-grass check at monolith ~L16144
 *  (`onGrass=onTile===6||255||11||9||13||0`). Ported 1:1 from
 *  monolith L10070-10076. */
export function _weStampWaterIfNatural(x: number, y: number, deps: StampDeps): void {
  if (x < 0 || x >= deps.MAP_W || y < 0 || y >= deps.MAP_H) return;
  const v = deps.getTile(x, y);
  if (v === 0 || v === 6 || v === 9 || v === 11 || v === 13 || v === 255) {
    deps.setTile(x, y, 9);
  }
}

/** Stamp a river polyline as tile=9. Bresenham walk + perpendicular
 *  width brush (square — sub-tile circle vs square is invisible at
 *  GBC scale). Width is in tiles; brush radius = max(1, floor(w/2)).
 *  Goes through _weStampWaterIfNatural so existing structures survive.
 *  Ported 1:1 from monolith L10080-10103. */
export function _weStampRiverTiles(w: number, pts: TilePolygon, deps: StampDeps): void {
  const rad = Math.max(1, Math.floor(w / 2));
  for (let i = 0; i < pts.length - 1; i++) {
    let cx = Math.round(pts[i][0]), cy = Math.round(pts[i][1]);
    const ex = Math.round(pts[i + 1][0]), ey = Math.round(pts[i + 1][1]);
    const dx = Math.abs(ex - cx), dy = Math.abs(ey - cy);
    const sx = cx < ex ? 1 : -1, sy = cy < ey ? 1 : -1;
    let err = dx - dy;
    while (true) {
      for (let by = -rad; by <= rad; by++) {
        for (let bx = -rad; bx <= rad; bx++) {
          _weStampWaterIfNatural(cx + bx, cy + by, deps);
        }
      }
      if (cx === ex && cy === ey) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; cx += sx; }
      if (e2 < dx) { err += dx; cy += sy; }
    }
  }
}

/** Stamp a lake polygon's interior as tile=9 via _weStampWaterIfNatural.
 *  Same scan-fill pipeline as surfaces but soft-writes so roads /
 *  structures inside the polygon remain intact. Ported 1:1 from
 *  monolith L10108-10113. */
export function _weStampLake(lake: LakeRow, deps: StampDeps): void {
  if (!lake || !lake.pts || lake.pts.length < 3) return;
  _weScanFillPolygon(lake.pts, (x, y) => {
    _weStampWaterIfNatural(x, y, deps);
  });
}

/** H999: standard traffic-lane width in tiles (mirrors LANE_W_STD). A
 *  driveway is `garageLanes` lanes wide — 1-car garage = 1 lane, 2-car =
 *  2 lanes — matching the user ask "only as wide as one or two lanes". */
const DRIVEWAY_LANE_W = 1.275;

/** Compute an auto-driveway connecting a building to the nearest road.
 *  Returns a 4-vertex rectangular polygon (drivable CONCRETE) or null if
 *  no road is in range. Driveway endpoints: nearest point on the
 *  building edge + nearest point on the nearest road centerline. Width =
 *  `garageLanes` traffic lanes (H999; was a fixed 4 tiles); max bridging
 *  distance 50 tiles.
 *
 *  The road end extends slightly INTO the road (1 tile past
 *  bestRoadPt) so the driveway polygon overlaps the road bitmap and
 *  the merge is visually seamless.
 *
 *  Ported 1:1 from monolith L10120-10178 (H999 parameterized width). */
export function _weMakeDriveway(
  buildingPts: TilePolygon,
  deps: StampDeps,
  garageLanes = 1,
): TilePolygon | null {
  if (!buildingPts || buildingPts.length < 3) return null;
  let cx = 0, cy = 0;
  for (const p of buildingPts) { cx += p[0]; cy += p[1]; }
  cx /= buildingPts.length; cy /= buildingPts.length;
  let bestRoadDist = Infinity;
  let bestRoadPt: TilePoint | null = null;
  const MAX_DRIVEWAY_TILES = 50;
  const majorRoads = deps.getMajorRoads();
  for (const r of majorRoads) {
    if (!r.pts || r.pts.length < 2) continue;
    for (let s = 0; s < r.pts.length - 1; s++) {
      const ax = r.pts[s][0], ay = r.pts[s][1];
      const bx = r.pts[s + 1][0], by = r.pts[s + 1][1];
      const vx = bx - ax, vy = by - ay;
      const len2 = vx * vx + vy * vy;
      if (len2 < 0.0001) continue;
      let t = ((cx - ax) * vx + (cy - ay) * vy) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = ax + t * vx, py = ay + t * vy;
      const d = Math.hypot(px - cx, py - cy);
      if (d < bestRoadDist) { bestRoadDist = d; bestRoadPt = [px, py]; }
    }
  }
  if (!bestRoadPt || bestRoadDist > MAX_DRIVEWAY_TILES) return null;
  let bestBldgDist = Infinity;
  let bestBldgPt: TilePoint | null = null;
  for (let i = 0; i < buildingPts.length; i++) {
    const a = buildingPts[i], b = buildingPts[(i + 1) % buildingPts.length];
    const ax = a[0], ay = a[1], bx = b[0], by = b[1];
    const vx = bx - ax, vy = by - ay;
    const len2 = vx * vx + vy * vy;
    if (len2 < 0.0001) continue;
    let t = ((bestRoadPt[0] - ax) * vx + (bestRoadPt[1] - ay) * vy) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = ax + t * vx, py = ay + t * vy;
    const d = Math.hypot(px - bestRoadPt[0], py - bestRoadPt[1]);
    if (d < bestBldgDist) { bestBldgDist = d; bestBldgPt = [px, py]; }
  }
  if (!bestBldgPt) return null;
  const dvx = bestRoadPt[0] - bestBldgPt[0];
  const dvy = bestRoadPt[1] - bestBldgPt[1];
  const len = Math.hypot(dvx, dvy);
  if (len < 0.5) return null;
  // H1006: concrete driveway width = garage size (1-car ≈ 1.5 tiles, 2-car
  // ≈ 3 tiles). The earlier "too wide/jagged" complaint was the per-tile
  // staircase render (fixed by the H1004 clean polygon pass), not the
  // width — so a 2-car driveway is a clean wider strip. lane ≈ 1.5 tiles.
  const lanes = Math.max(1, Math.min(2, garageLanes));
  const halfW = DRIVEWAY_LANE_W * 0.6 * lanes; // 1-car ~1.5, 2-car ~3 tiles
  const nx = -dvy / len * halfW;
  const ny = dvx / len * halfW;
  const ex = bestRoadPt[0] + dvx / len * 1;
  const ey = bestRoadPt[1] + dvy / len * 1;
  return [
    [bestBldgPt[0] + nx, bestBldgPt[1] + ny],
    [ex + nx, ey + ny],
    [ex - nx, ey - ny],
    [bestBldgPt[0] - nx, bestBldgPt[1] - ny]
  ];
}

/** H996: preset building footprints — one-click placement of a sized,
 *  road-facing rectangle instead of hand-drawing a polygon vertex by
 *  vertex (the parking-lot/lake flow the user found "very bad" for
 *  buildings). Dimensions are in tiles: `len` runs PARALLEL to the road
 *  (the frontage), `depth` runs toward/away from it. `type` is stored on
 *  the building row (row[1]) so later gameplay (purchase / enter /
 *  garage) can bind without a schema change. Additive — freeform polygon
 *  drawing still works when no preset is selected. */
export interface BuildingPreset {
  id: string;
  label: string;
  type: string;
  len: number;
  depth: number;
  /** H999: garage size — drives the auto-driveway width (1 lane vs 2). */
  garageLanes: 1 | 2;
}

export const BUILDING_PRESETS: readonly BuildingPreset[] = [
  { id: 'trailer',    label: 'Trailer',       type: 'trailer',    len: 6,  depth: 3,  garageLanes: 1 },
  { id: 'house2',     label: '2-Bed House',   type: 'house2',     len: 8,  depth: 6,  garageLanes: 1 },
  { id: 'house3',     label: '3-Bed House',   type: 'house3',     len: 10, depth: 7,  garageLanes: 2 },
  { id: 'house4',     label: '4-Bed House',   type: 'house4',     len: 12, depth: 8,  garageLanes: 2 },
  { id: 'apartment',  label: 'Apartment',     type: 'apartment',  len: 16, depth: 12, garageLanes: 2 },
  { id: 'dealership', label: 'Car Dealer',    type: 'dealership', len: 20, depth: 14, garageLanes: 2 },
  { id: 'mechanic',   label: 'Mechanic',      type: 'mechanic',   len: 12, depth: 10, garageLanes: 2 },
  { id: 'junkyard',   label: 'Junkyard',      type: 'junkyard',   len: 18, depth: 14, garageLanes: 2 },
  { id: 'autoparts',  label: 'Auto Parts',    type: 'autoparts',  len: 14, depth: 10, garageLanes: 2 },
];

/** H1000: garage lane count for a building type (drives driveway width on
 *  both placement and rotate re-emit). Defaults to 1 for unknown/freeform. */
export function _weGarageLanesForType(type: string): 1 | 2 {
  const p = BUILDING_PRESETS.find((b) => b.type === type);
  return p ? p.garageLanes : 1;
}

/** H1006: residence building types — these get a drivable garage (enter
 *  Home by driving in). Commercial types (dealer/mechanic/junkyard/
 *  autoparts) stay fully solid + use the tap-to-enter prompt. */
const RESIDENCE_TYPES = new Set(['trailer', 'house', 'house2', 'house3', 'house4', 'apartment']);
export function _weIsResidenceType(type: string): boolean {
  return RESIDENCE_TYPES.has(type);
}
/** Garage lane count for a building type, or 0 for non-residences (no
 *  carved garage). */
export function _weGarageLanesForBuilding(type: string): number {
  return _weIsResidenceType(type) ? _weGarageLanesForType(type) : 0;
}

/** Build a preset building footprint centered at (cx, cy), oriented so its
 *  FRONT (the `len` edge) faces the nearest road within range; falls back
 *  to axis-aligned when no road is near. Returns 4 corners (CCW). Reuses
 *  the same nearest-road segment scan _weMakeDriveway uses so the driveway
 *  and the building face the same road. */
export function _weBuildingPresetFootprint(
  cx: number,
  cy: number,
  lenTiles: number,
  depthTiles: number,
  deps: StampDeps,
  facingDeg = 0,
): TilePolygon {
  const SEARCH_TILES = 80;
  let bestD = Infinity;
  let rpx: number | null = null;
  let rpy: number | null = null;
  for (const r of deps.getMajorRoads()) {
    if (!r.pts || r.pts.length < 2) continue;
    for (let s = 0; s < r.pts.length - 1; s++) {
      const ax = r.pts[s][0], ay = r.pts[s][1];
      const bx = r.pts[s + 1][0], by = r.pts[s + 1][1];
      const vx = bx - ax, vy = by - ay;
      const len2 = vx * vx + vy * vy;
      if (len2 < 0.0001) continue;
      let t = ((cx - ax) * vx + (cy - ay) * vy) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = ax + t * vx, py = ay + t * vy;
      const d = Math.hypot(px - cx, py - cy);
      if (d < bestD) { bestD = d; rpx = px; rpy = py; }
    }
  }
  // Depth axis points toward the road (front faces it); default +y.
  let dx = 0, dy = 1;
  if (rpx !== null && rpy !== null && bestD < SEARCH_TILES && bestD > 0.001) {
    const vx = rpx - cx, vy = rpy - cy;
    const L = Math.hypot(vx, vy) || 1;
    dx = vx / L; dy = vy / L;
  }
  // H1000: user facing override — rotate the (auto road-facing) depth axis
  // by facingDeg so the user can turn the house to face a different way.
  // 0 = auto (face nearest road).
  if (facingDeg) {
    const a = facingDeg * Math.PI / 180;
    const ca = Math.cos(a), sa = Math.sin(a);
    const rdx = dx * ca - dy * sa;
    const rdy = dx * sa + dy * ca;
    dx = rdx; dy = rdy;
  }
  const lx = -dy, ly = dx;           // length axis ⟂ depth axis (road frontage)
  const hd = depthTiles / 2, hl = lenTiles / 2;
  return [
    [cx - lx * hl - dx * hd, cy - ly * hl - dy * hd],
    [cx + lx * hl - dx * hd, cy + ly * hl - dy * hd],
    [cx + lx * hl + dx * hd, cy + ly * hl + dy * hd],
    [cx - lx * hl + dx * hd, cy - ly * hl + dy * hd],
  ];
}

/** Stamp an overlay road's tiles as tile=1. Mirrors the source-side _rp
 *  Bresenham stamp logic so overlay roads are drivable identically to
 *  baseline roads. Width is capped at 2 (matches the source behavior).
 *  Ported 1:1 from monolith L10179-10199. */
export function _weStampRoadTiles(w: number, pts: TilePolygon, deps: StampDeps): void {
  const tw = Math.min(w, 2);
  for (let i = 0; i < pts.length - 1; i++) {
    let cx = Math.round(pts[i][0]), cy = Math.round(pts[i][1]);
    const ex = Math.round(pts[i + 1][0]), ey = Math.round(pts[i + 1][1]);
    const dx = Math.abs(ex - cx), dy = Math.abs(ey - cy);
    const sx = cx < ex ? 1 : -1, sy = cy < ey ? 1 : -1;
    let err = dx - dy;
    while (true) {
      for (let wi = 0; wi < tw; wi++) {
        if (cx >= 0 && cx < deps.MAP_W && cy + wi >= 0 && cy + wi < deps.MAP_H) deps.setTile(cx, cy + wi, 1);
        if (tw > 1 && cx + wi >= 0 && cx + wi < deps.MAP_W && cy >= 0 && cy < deps.MAP_H) deps.setTile(cx + wi, cy, 1);
      }
      if (cx === ex && cy === ey) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; cx += sx; }
      if (e2 < dx) { err += dx; cy += sy; }
    }
  }
}
