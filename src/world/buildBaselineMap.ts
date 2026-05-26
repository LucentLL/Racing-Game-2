/**
 * World-gen pass — stamps every baseline road polyline into the tile
 * bitmap as TILE_ROAD. Called once at boot, before the first frame.
 *
 * Algorithm:
 *  1. For each row in BASELINE_ROADS, treat coords as tile centers.
 *  2. For each segment, Bresenham-walk the line from (x_i, y_i) to
 *     (x_i+1, y_i+1).
 *  3. At every step, paint a (2*brushR+1)² square brush around the
 *     cursor where brushR = floor(w/2). Square (not round) is
 *     deliberate — at game scale the GBC pixel-art renders the road
 *     tile solidly enough that a square brush looks identical to a
 *     circle, and it's faster.
 *
 * Doesn't preserve major-vs-minor — both stamp TILE_ROAD. The road-
 * subtype (lane count, etc.) lives in BASELINE_ROADS rows; the tile
 * bitmap is just a "drivable surface" flag.
 *
 * Approximates but doesn't exactly reproduce the monolith's world-gen
 * stamping (the monolith _rp loader caps brush width at 2 for overlay
 * roads but uses full width for baseline highways; we use full width
 * everywhere here). The difference is invisible at H9's resolution —
 * either way, the player's "on road or not" answer matches the visible
 * road bands.
 */

import { BASELINE_ROADS } from '@/config/world/baselineRoads';
import { setTile, TILE_ROAD, type TileMap } from './tileMap';
import { smoothFlatPolyline } from '@/render/pathSmoothing';
import { _weLoadBaselineEdits, _weLoadOverlayFromStorage } from '@/editor/storage';

/** H682: lane-standardized asphalt width (matches src/render/worldMap.ts
 *  laneStandardizedWidth — same formula, replicated to avoid a worldMap
 *  → world cycle). Used to size the tile-stamp brush so the drivable
 *  TILE_ROAD footprint matches the visible asphalt stroke. Pre-H682 we
 *  used the raw row `w` (e.g. 5 tiles for a minor) but the render had
 *  already narrowed to lane-standardized width (~2.55 tiles for w=5),
 *  leaving 1.2-tile collars of TILE_ROAD past the visible asphalt edge
 *  on every minor — visible in-game as the asphalt-colored zigzag
 *  squares the user reported. */
const LANE_W_STD = 1.275;
function asphaltWidthTiles(name: string, w: number): number {
  let lps: number;
  let medFrac: number;
  let isDivided: boolean;
  if (name === 'I-485') { lps = 3; medFrac = 0.25; isDivided = true; }
  else if (w >= 12)     { lps = 4; medFrac = 0.02; isDivided = true; }
  else if (w >= 8)      { lps = 3; medFrac = 0.02; isDivided = false; }
  else if (w >= 6)      { lps = 2; medFrac = 0;    isDivided = false; }
  else                  { lps = 1; medFrac = 0;    isDivided = false; }
  const carriageW = lps * 2 * LANE_W_STD;
  const medHalf = (medFrac > 0) ? carriageW * medFrac * 0.5 : 0;
  const totalW = carriageW + medHalf * 2;
  const shoulderW = isDivided ? 0.5 * LANE_W_STD : 0;
  return totalW + 2 * shoulderW;
}

/** Bresenham line walker that paints a CIRCULAR brush at every step.
 *  H682: was a square brush — the axis-aligned (2R+1)² stamp left a
 *  visible staircase past the smoothed visual asphalt on diagonal
 *  segments. Round brush stamps the disk |(bx,by)| ≤ radius so the
 *  per-step footprint matches the canvas-stroke's perpendicular band
 *  at any orientation, and the bitmap edge sits flush against the
 *  rendered asphalt at every segment angle. */
function stampLine(
  map: TileMap, x0: number, y0: number, x1: number, y1: number,
  radius: number,
): void {
  let cx = x0;
  let cy = y0;
  const dx = Math.abs(x1 - cx);
  const dy = Math.abs(y1 - cy);
  const sx = cx < x1 ? 1 : -1;
  const sy = cy < y1 ? 1 : -1;
  let err = dx - dy;
  const iR = Math.max(0, Math.ceil(radius));
  const r2 = radius * radius;
  while (true) {
    for (let by = -iR; by <= iR; by++) {
      for (let bx = -iR; bx <= iR; bx++) {
        if (bx * bx + by * by <= r2) {
          setTile(map, cx + bx, cy + by, TILE_ROAD);
        }
      }
    }
    if (cx === x1 && cy === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; cx += sx; }
    if (e2 < dx) { err += dx; cy += sy; }
  }
}

/** Stamp one flat polyline through the Bresenham brush walker. */
function stampFlatPolyline(map: TileMap, rawPts: readonly number[], w: number, name: string): void {
  if (rawPts.length < 4) return;
  const pts = smoothFlatPolyline(rawPts);
  // H682: brush radius tracks the lane-standardized asphalt half-width
  // (was floor(w/2) — see asphaltWidthTiles header). Floor (not ceil)
  // to keep the stamp ≤ visible asphalt; the round-brush mask handles
  // sub-tile fractional widths smoothly. min 1 ensures even the
  // narrowest minor stays at least 3 tiles wide drivable so the player
  // doesn't fall off-grass on a perfectly-on-center drive.
  const radius = Math.max(1, asphaltWidthTiles(name, w) * 0.5);
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const x0 = Math.round(pts[i]);
    const y0 = Math.round(pts[i + 1]);
    const x1 = Math.round(pts[i + 2]);
    const y1 = Math.round(pts[i + 3]);
    stampLine(map, x0, y0, x1, y1, radius);
  }
}

/** Mutates `map` in place. Idempotent — re-running just re-paints
 *  the same cells.
 *
 *  H124: stamps the SMOOTHED polyline (Catmull-Rom samples) so the
 *  drivable tile coverage matches the rendered curves at vertex
 *  joints.
 *
 *  H125: applies editor saves at boot — baseline-road vertex edits,
 *  baseline-road deletes, and user-drawn overlay roads. All three
 *  come from the same localStorage keys the editor's Ctrl+S writes,
 *  so a road authored / edited / deleted in the dev editor (H115-
 *  H122) becomes drivable / undrivable on the next page reload. */
export function buildBaselineMap(map: TileMap): void {
  // H125: read editor persistence at boot. Both helpers swallow
  // missing-key / parse-fail into empty payloads, so the no-saves
  // case stamps the source-defined network verbatim.
  const baselineEdits = _weLoadBaselineEdits();
  const overlay = _weLoadOverlayFromStorage();
  const deletedSet = new Set(baselineEdits.deletes);

  for (let rIdx = 0; rIdx < BASELINE_ROADS.length; rIdx++) {
    // H125: skip user-deleted baseline roads. Their slot remains in
    // BASELINE_ROADS but the tile map gets no stamps for them.
    if (deletedSet.has(rIdx)) continue;
    const row = BASELINE_ROADS[rIdx];
    const w = row[0];
    const name = row[2];
    // H125: prefer edited pts when the user has dragged vertices on
    // this baseline road. Else use the source-defined coords.
    const edited = baselineEdits.edits[String(rIdx)];
    let rawPts: readonly number[];
    if (edited && edited.length >= 2) {
      const flat: number[] = [];
      for (const p of edited) flat.push(p[0], p[1]);
      rawPts = flat;
    } else {
      rawPts = row.slice(4) as readonly number[];
    }
    stampFlatPolyline(map, rawPts, w, name);
  }

  // H125: stamp user-drawn overlay roads too. Schema is [w, maj,
  // name, z, x1, y1, ...] for legacy 4-meta rows (even length) or
  // [w, maj, name, z, mergeFlag, x1, y1, ...] for merge rows (odd
  // length). Coord start index is row.length parity.
  for (const rowRaw of overlay.roads) {
    const row = rowRaw as readonly (string | number)[];
    if (row.length < 6) continue;
    const w = row[0] as number;
    const name = String(row[2] ?? '');
    const xStart = row.length % 2 === 0 ? 4 : 5;
    const flat: number[] = [];
    for (let i = xStart; i + 1 < row.length; i += 2) {
      flat.push(row[i] as number, row[i + 1] as number);
    }
    stampFlatPolyline(map, flat, w, name);
  }
}

/** H127: rebuild the tile bitmap from scratch using current
 *  localStorage contents. Used by the editor's Ctrl+S handler to
 *  refresh `isOnRoad` without a page reload. Clearing the bytes back
 *  to 0 (grass) before re-stamping is necessary because edits +
 *  deletes change WHICH tiles should be TILE_ROAD — an additive
 *  re-stamp would leave the old straight-line coverage drivable.
 *
 *  Only safe to call as long as `buildBaselineMap` is the SOLE writer
 *  to the tile bitmap (which is currently true in modular — buildings,
 *  grass variants, etc. all READ but don't WRITE to map.bytes).
 *  Future stampers would need their own re-run hook composed alongside. */
export function rebuildBaselineMap(map: TileMap): void {
  map.bytes.fill(0);
  buildBaselineMap(map);
}
