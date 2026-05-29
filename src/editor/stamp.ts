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

/** Stamp a surface (drivable asphalt) polygon as tile=1. Ported 1:1 from
 *  monolith L10046-10051. */
export function _weStampSurface(surface: SurfaceRow, deps: StampDeps): void {
  if (!surface || !surface.pts || surface.pts.length < 3) return;
  _weScanFillPolygon(surface.pts, (x, y) => {
    if (x >= 0 && x < deps.MAP_W && y >= 0 && y < deps.MAP_H) deps.setTile(x, y, 1);
  });
}

/** Stamp a user-placed building footprint as tile=17. Tile=17 uses the
 *  same getBldg() palette as procedural buildings but is NOT in the
 *  I-277 grass-conversion check (which only matches tile===4||tile===5),
 *  so user buildings survive outside downtown. Ported 1:1 from
 *  monolith L10058-10063. */
export function _weStampBuilding(building: BuildingRow, deps: StampDeps): void {
  if (!building || !building.pts || building.pts.length < 3) return;
  _weScanFillPolygon(building.pts, (x, y) => {
    if (x >= 0 && x < deps.MAP_W && y >= 0 && y < deps.MAP_H) deps.setTile(x, y, 17);
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
 *  Ported 1:1 from monolith L10120-10178. */
export function _weMakeDriveway(buildingPts: TilePolygon, deps: StampDeps): TilePolygon | null {
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
  const halfW = 2;
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
