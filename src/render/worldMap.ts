/**
 * H8/H11 world-map render — strokes baseline road polylines onto the
 * main canvas. Caller must have applied the camera translate first.
 *
 * Three-pass render per major road (single-pass for minors):
 *   1. ASPHALT BAND — full-width stroke, dark gray.
 *   2. INNER BAND — narrower stroke (asphalt width minus stripe inset
 *      on each side) in a slightly lighter shade. The visible boundary
 *      between passes 1 and 2 reads as the white edge stripe at the
 *      shoulder. Majors only.
 *   3. CENTERLINE — dashed yellow lane divider down the middle of the
 *      polyline. Majors only.
 *
 * Cheaper than computing perpendicular-offset polylines per segment
 * (which would be the geometrically correct edge-stripe approach), and
 * indistinguishable at game scale because the band-on-band strokes
 * produce parallel pseudo-stripes naturally.
 *
 * INTENTIONALLY simpler than the monolith's render() roads pass
 * (L30577-30738, ~160 lines including intersection geometry + skid
 * marks + speed trail). H11 keeps it to a three-pass band; real port
 * lands when the src/render/roads body ports.
 *
 * Viewport culling skipped — 130 polylines × ~200 points × 3 passes
 * still hits desktop budget. Real per-segment bbox cull comes with
 * the proper render port.
 */

import { BASELINE_ROADS, type BaselineRoadRow } from '@/config/world/baselineRoads';
import { TILE } from '@/config/world/tiles';
import { getAsphaltPattern, getRoadBaseColor } from './roadTextures';

/** Inner band — a 1-tile-inset stroke that paints over the asphalt
 *  edges to expose a hint of contrast at the shoulder line. */
const MAJOR_INNER_BAND = '#363640';
/** Yellow lane-divider centerline color. Dashed. */
const CENTERLINE_COLOR = '#d4b438';
/** Dash pattern (canvas px): each pair is dash-on, dash-off. */
const CENTERLINE_DASH: [number, number] = [14, 10];
/** Centerline lineWidth — stays narrow so a freeway with 4 lanes still
 *  has the centerline visibly within its asphalt. */
const CENTERLINE_WIDTH = 1.5;

function tracePath(ctx: CanvasRenderingContext2D, pts: readonly number[]): void {
  ctx.beginPath();
  ctx.moveTo(pts[0] * TILE, pts[1] * TILE);
  for (let i = 2; i + 1 < pts.length; i += 2) {
    ctx.lineTo(pts[i] * TILE, pts[i + 1] * TILE);
  }
}

function strokeRoad(ctx: CanvasRenderingContext2D, row: BaselineRoadRow): void {
  // row = [w, maj, name, z, x1, y1, x2, y2, ...]
  const w = row[0];
  const maj = row[1];
  const pts = row.slice(4) as readonly number[];
  if (pts.length < 4) return;

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Pass 1: asphalt band — textured pattern from roadTextures.
  // Falls back to the flat base color if createPattern returned null
  // (can't happen on a real ctx, but the type allows it).
  const pattern = getAsphaltPattern(ctx, row);
  ctx.strokeStyle = pattern ?? getRoadBaseColor(row);
  ctx.lineWidth = w * TILE;
  tracePath(ctx, pts);
  ctx.stroke();

  if (maj === 1) {
    // Pass 2: inner band, inset by 1 tile on each side so the asphalt
    // edges remain visible as a thin contrast border (acts as the
    // shoulder/edge stripe at game scale).
    const innerWidth = Math.max(2, w * TILE - 2 * TILE);
    ctx.strokeStyle = MAJOR_INNER_BAND;
    ctx.lineWidth = innerWidth;
    tracePath(ctx, pts);
    ctx.stroke();

    // Pass 3: dashed yellow centerline. setLineDash applies until
    // explicitly cleared, so reset after.
    ctx.setLineDash(CENTERLINE_DASH);
    ctx.strokeStyle = CENTERLINE_COLOR;
    ctx.lineWidth = CENTERLINE_WIDTH;
    tracePath(ctx, pts);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

/** Draws every baseline road in world coords. Caller has already
 *  applied the camera translate. */
export function drawBaselineRoads(ctx: CanvasRenderingContext2D): void {
  for (const row of BASELINE_ROADS) {
    strokeRoad(ctx, row);
  }
}
