/**
 * H8/H11/H52 world-map render — strokes baseline road polylines onto
 * the main canvas. Caller must have applied the camera translate.
 *
 * Per-major-road render passes:
 *   1. ASPHALT BAND — textured pattern (H43), full width.
 *   2. INNER BAND — narrower stroke (width - 2 tiles total) in a
 *      slightly lighter shade so the visible boundary reads as the
 *      shoulder edge stripe.
 *   3. LANE DIVIDERS (H52) — for majors with width >= 6 tiles, stroke
 *      one or two pairs of WHITE DASHED offset polylines at quarter
 *      and three-quarter widths. Real 4-6 lane highways get visible
 *      lane separators instead of one big gray ribbon.
 *   4. CENTERLINE — dashed yellow down the middle.
 *
 * Path offsetting is per-segment perpendicular (no bisector smoothing
 * at vertex joins) — at game zoom the small kinks at vertices are
 * invisible, and the simpler math means no degenerate cases at sharp
 * turns.
 *
 * Minors get pass 1 only (just the textured asphalt — residential
 * streets aren't striped in the monolith either).
 *
 * INTENTIONALLY simpler than the monolith's render() roads pass
 * (L30577-30738) — lane-aware wear paths (prof.wearOffsets,
 * prof.oilOffsets), auto-taper merges, and per-segment material
 * overrides all port later.
 */

import { BASELINE_ROADS, type BaselineRoadRow } from '@/config/world/baselineRoads';
import { TILE } from '@/config/world/tiles';
import { getAsphaltPattern, getRoadBaseColor } from './roadTextures';

/** Inner band — a 1-tile-inset stroke that paints over the asphalt
 *  edges to expose a hint of contrast at the shoulder line. */
const MAJOR_INNER_BAND = '#363640';
/** Yellow lane-divider centerline color. Dashed. */
const CENTERLINE_COLOR = '#d4b438';
const CENTERLINE_DASH: [number, number] = [14, 10];
const CENTERLINE_WIDTH = 1.5;
/** White dashed lane divider — same color as edge stripes but dashed. */
const LANE_DIVIDER_COLOR = 'rgba(220, 220, 220, 0.85)';
const LANE_DIVIDER_DASH: [number, number] = [12, 12];
const LANE_DIVIDER_WIDTH = 1.2;

function tracePath(ctx: CanvasRenderingContext2D, pts: readonly number[]): void {
  ctx.beginPath();
  ctx.moveTo(pts[0] * TILE, pts[1] * TILE);
  for (let i = 2; i + 1 < pts.length; i += 2) {
    ctx.lineTo(pts[i] * TILE, pts[i + 1] * TILE);
  }
}

/** H52 — Per-segment perpendicular offset trace. Strokes the polyline
 *  shifted perpendicular by `tileOffset` tile-units. Small kinks at
 *  interior vertex joins are invisible at zoom 2.2× — the simpler
 *  math beats bisector geometry for 130 mostly-straight roads. */
function tracePathOffset(
  ctx: CanvasRenderingContext2D,
  pts: readonly number[],
  tileOffset: number,
): void {
  const n = pts.length / 2;
  if (n < 2) return;
  ctx.beginPath();
  let moved = false;
  for (let i = 0; i < n - 1; i++) {
    const ax = pts[i * 2] as number;
    const ay = pts[i * 2 + 1] as number;
    const bx = pts[(i + 1) * 2] as number;
    const by = pts[(i + 1) * 2 + 1] as number;
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.01) continue;
    const ox = (-dy / len) * tileOffset;
    const oy = ( dx / len) * tileOffset;
    if (!moved) {
      ctx.moveTo((ax + ox) * TILE, (ay + oy) * TILE);
      moved = true;
    }
    ctx.lineTo((bx + ox) * TILE, (by + oy) * TILE);
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

  // Pass 1: asphalt band — textured pattern.
  const pattern = getAsphaltPattern(ctx, row);
  ctx.strokeStyle = pattern ?? getRoadBaseColor(row);
  ctx.lineWidth = w * TILE;
  tracePath(ctx, pts);
  ctx.stroke();

  if (maj === 1) {
    // Pass 2: inner band — 1-tile inset, creates shoulder edge stripe.
    const innerWidth = Math.max(2, w * TILE - 2 * TILE);
    ctx.strokeStyle = MAJOR_INNER_BAND;
    ctx.lineWidth = innerWidth;
    tracePath(ctx, pts);
    ctx.stroke();

    // Pass 3: white dashed lane dividers on multi-lane highways.
    // 6-tile roads: 1 pair (±halfW * 0.5).
    // 10+ tile roads: 2 pairs (±halfW * 0.33 and ±halfW * 0.67).
    if (w >= 6) {
      const halfW = w * 0.5;
      ctx.setLineDash(LANE_DIVIDER_DASH);
      ctx.strokeStyle = LANE_DIVIDER_COLOR;
      ctx.lineWidth = LANE_DIVIDER_WIDTH;
      const offsets = w >= 10
        ? [halfW * 0.33, halfW * 0.67]
        : [halfW * 0.5];
      for (const off of offsets) {
        for (const sign of [-1, 1]) {
          tracePathOffset(ctx, pts, off * sign);
          ctx.stroke();
        }
      }
      ctx.setLineDash([]);
    }

    // Pass 4: dashed yellow centerline.
    ctx.setLineDash(CENTERLINE_DASH);
    ctx.strokeStyle = CENTERLINE_COLOR;
    ctx.lineWidth = CENTERLINE_WIDTH;
    tracePath(ctx, pts);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

/** Draws every baseline road in world coords. */
export function drawBaselineRoads(ctx: CanvasRenderingContext2D): void {
  for (const row of BASELINE_ROADS) {
    strokeRoad(ctx, row);
  }
}
