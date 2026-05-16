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

/** Mutates `map` in place. Idempotent — re-running just re-paints
 *  the same cells.
 *
 *  H124: stamps the SMOOTHED polyline (Catmull-Rom samples) instead
 *  of the raw source vertices, so the drivable tile coverage matches
 *  the curves that worldMap.ts renders. Without this, sharp source-
 *  vertex joints visually round to a curve while the underlying
 *  tiles stay kinked — driving the rendered curve would clip
 *  briefly off-road on tight turns. Uses the same smoothFlatPolyline
 *  helper the render pass caches so the geometries are guaranteed
 *  to agree. */
export function buildBaselineMap(map: TileMap): void {
  for (const row of BASELINE_ROADS) {
    const w = row[0];
    const rawPts = row.slice(4) as readonly number[];
    if (rawPts.length < 4) continue;
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
}
