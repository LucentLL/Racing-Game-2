/**
 * H8 world-map render — strokes baseline road polylines onto the main
 * canvas. Caller must have applied the camera translate first (so the
 * road coords here are world-space; camera moves the viewport).
 *
 * INTENTIONALLY simpler than the monolith's render() roads pass
 * (L30577-30738, ~160 lines: asphalt fill + edge stripes + lane
 * dividers + intersections + skid marks + speed trail). For H8 we
 * stroke each road's centerline as a wide colored band — same data,
 * minimum drawing. Real lane-aware render lands when the
 * src/render/roads body ports.
 *
 * Viewport culling skipped for H8 — 130 polylines × ~200 points each
 * is fast enough on desktop, marginal on mobile. Real per-segment
 * bbox cull comes with the proper render port.
 */

import { BASELINE_ROADS, type BaselineRoadRow } from '@/config/world/baselineRoads';
import { TILE } from '@/config/world/tiles';

/** Asphalt fill color for major roads (highways / arterials). */
const MAJOR_COLOR = '#3a3a40';
/** Asphalt fill color for minor roads (residential / streets). */
const MINOR_COLOR = '#2a2a30';
/** Edge-stripe color, used as a thin contrasting border on majors. */
const STRIPE_COLOR = '#5a5a60';

function strokeRoad(ctx: CanvasRenderingContext2D, row: BaselineRoadRow): void {
  // row = [w, maj, name, z, x1, y1, x2, y2, ...]
  const w = row[0];
  const maj = row[1];
  const pts = row.slice(4) as readonly number[];
  if (pts.length < 4) return;

  // Asphalt band (centerline stroke at full width).
  ctx.strokeStyle = maj === 1 ? MAJOR_COLOR : MINOR_COLOR;
  ctx.lineWidth = w * TILE;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(pts[0] * TILE, pts[1] * TILE);
  for (let i = 2; i + 1 < pts.length; i += 2) {
    ctx.lineTo(pts[i] * TILE, pts[i + 1] * TILE);
  }
  ctx.stroke();

  // Thin edge stripe on majors for visual differentiation.
  if (maj === 1) {
    ctx.strokeStyle = STRIPE_COLOR;
    ctx.lineWidth = Math.max(1, w * TILE * 0.06);
    ctx.stroke();
  }
}

/** Draws every baseline road in world coords. Caller has already
 *  applied the camera translate. */
export function drawBaselineRoads(ctx: CanvasRenderingContext2D): void {
  for (const row of BASELINE_ROADS) {
    strokeRoad(ctx, row);
  }
}
