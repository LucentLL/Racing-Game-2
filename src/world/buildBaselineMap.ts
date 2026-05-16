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

/** Bresenham line walker that paints a square brush at every step. */
function stampLine(map: TileMap, x0: number, y0: number, x1: number, y1: number, brushR: number): void {
  let cx = x0;
  let cy = y0;
  const dx = Math.abs(x1 - cx);
  const dy = Math.abs(y1 - cy);
  const sx = cx < x1 ? 1 : -1;
  const sy = cy < y1 ? 1 : -1;
  let err = dx - dy;
  while (true) {
    for (let by = -brushR; by <= brushR; by++) {
      for (let bx = -brushR; bx <= brushR; bx++) {
        setTile(map, cx + bx, cy + by, TILE_ROAD);
      }
    }
    if (cx === x1 && cy === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; cx += sx; }
    if (e2 < dx) { err += dx; cy += sy; }
  }
}

/** Stamp one flat polyline through the Bresenham brush walker. */
function stampFlatPolyline(map: TileMap, rawPts: readonly number[], w: number): void {
  if (rawPts.length < 4) return;
  const pts = smoothFlatPolyline(rawPts);
  const brushR = Math.max(1, Math.floor(w / 2));
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const x0 = Math.round(pts[i]);
    const y0 = Math.round(pts[i + 1]);
    const x1 = Math.round(pts[i + 2]);
    const y1 = Math.round(pts[i + 3]);
    stampLine(map, x0, y0, x1, y1, brushR);
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
    stampFlatPolyline(map, rawPts, w);
  }

  // H125: stamp user-drawn overlay roads too. Schema is [w, maj,
  // name, z, x1, y1, ...] for legacy 4-meta rows (even length) or
  // [w, maj, name, z, mergeFlag, x1, y1, ...] for merge rows (odd
  // length). Coord start index is row.length parity.
  for (const rowRaw of overlay.roads) {
    const row = rowRaw as readonly (string | number)[];
    if (row.length < 6) continue;
    const w = row[0] as number;
    const xStart = row.length % 2 === 0 ? 4 : 5;
    const flat: number[] = [];
    for (let i = xStart; i + 1 < row.length; i += 2) {
      flat.push(row[i] as number, row[i + 1] as number);
    }
    stampFlatPolyline(map, flat, w);
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
