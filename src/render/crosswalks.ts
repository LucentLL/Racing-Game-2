/**
 * H57/H58 — crosswalk zebra stripes + stop bars at road intersections.
 *
 * For each intersection (computed at module init by roadCrossings):
 *   - One pair of white zebra-stripe crosswalk bands, perpendicular
 *     to each approaching road, offset to sit at the OTHER road's
 *     curb line.
 *   - H58: One pair of solid white stop bars per MINOR approach,
 *     placed just outside the crosswalk band. Majors don't get stop
 *     bars — they have right of way at unsignalized intersections.
 *
 * Only renders where at least one road is width >= 3 (skip narrow
 * alley joins) and dist²-cull around the player.
 *
 * Ported from monolith L31630-31676 (stop bars + crosswalk helper +
 * intersection iteration).
 */

import { TILE } from '@/config/world/tiles';
import { ROAD_CROSSINGS } from '@/world/roadCrossings';

const CULL_R2 = 600 * 600;
/** H277: asphalt fallback color used to paint over markings inside an
 *  intersection. Matches the modular's old-asphalt #43403e fallback so
 *  the patch blends with surrounding road texture instead of jumping
 *  in tone. */
const INTERSECTION_FILL = '#43403e';

function drawCrosswalkBand(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  ang: number,
  roadW: number,
  offDist: number,
): void {
  const nx = Math.cos(ang);
  const ny = Math.sin(ang);
  // Perpendicular (90° CCW).
  const ppx = -ny;
  const ppy =  nx;
  const hw = roadW * TILE * 0.38;
  const stripeCount = Math.max(3, Math.round((hw * 2) / 3));
  ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
  for (const sign of [-1, 1] as const) {
    const baseX = x + nx * offDist * sign;
    const baseY = y + ny * offDist * sign;
    for (let si = 0; si < stripeCount; si++) {
      const frac = (si / (stripeCount - 1)) * 2 - 1; // -1..1
      const sx = baseX + ppx * hw * frac;
      const sy = baseY + ppy * hw * frac;
      ctx.fillRect(sx - 1, sy - 0.5, 2, 1);
    }
  }
}

/** H58 — paint a pair of stop bars perpendicular to one road's
 *  approach, placed just outside the crosswalk so the visual reads
 *  as STOP-then-CROSSWALK-then-intersection. */
function drawStopBarPair(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  ang: number,
  roadW: number,
  offDist: number,
): void {
  const nx = Math.cos(ang);
  const ny = Math.sin(ang);
  const ppx = -ny;
  const ppy =  nx;
  const hw = roadW * TILE * 0.38;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.65)';
  ctx.lineWidth = 1.4;
  for (const sign of [-1, 1] as const) {
    const baseX = x + nx * offDist * sign;
    const baseY = y + ny * offDist * sign;
    ctx.beginPath();
    ctx.moveTo(baseX - ppx * hw, baseY - ppy * hw);
    ctx.lineTo(baseX + ppx * hw, baseY + ppy * hw);
    ctx.stroke();
  }
}

/** H277: paint an asphalt-colored rotated rectangle covering the
 *  intersection's full marking footprint so edge stripes / lane
 *  dividers / wear bands stop at the cross-street rather than running
 *  continuously through it. Rectangle is sized to the smaller of the
 *  two roads' widths in EACH road's tangent direction, so the patch
 *  exactly fits inside both roads' carriageway. Mirrors monolith's
 *  surgical pass 16 edge break (L31378-L31402) — modular paints the
 *  full rect instead of stripe-specific erase paths since the runtime
 *  RoadCrossing record doesn't carry per-stripe geometry. */
function drawMarkingBreak(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  ang1: number,
  ang2: number,
  w1: number,
  w2: number,
): void {
  // Rect is aligned to road 1's tangent, extends ±w2*0.5 along road 1
  // (matching road 2's width crossing road 1) and ±w1*0.5 perpendicular
  // (matching road 1's carriageway). The two roads' tangents may not be
  // perpendicular (e.g. an oblique intersection), but covering the
  // larger of the two perpendicular extents handles that case too.
  const lenHalf = w2 * 0.5 * TILE;
  const widHalf = w1 * 0.5 * TILE;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(ang1);
  ctx.fillStyle = INTERSECTION_FILL;
  ctx.fillRect(-lenHalf, -widHalf, lenHalf * 2, widHalf * 2);
  ctx.restore();
  // Second rect aligned to road 2's tangent — covers the orthogonal
  // overshoot for oblique intersections. For 90° crossings this paints
  // the same area twice (cheap, no visual seam).
  const lenHalf2 = w1 * 0.5 * TILE;
  const widHalf2 = w2 * 0.5 * TILE;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(ang2);
  ctx.fillStyle = INTERSECTION_FILL;
  ctx.fillRect(-lenHalf2, -widHalf2, lenHalf2 * 2, widHalf2 * 2);
  ctx.restore();
}

/** Public entry: paint marking breaks for every visible intersection.
 *  Must run AFTER drawBaselineRoads (so it covers all markings) and
 *  BEFORE drawCrosswalks (so the zebra stripes paint on top of the
 *  break). */
export function drawIntersectionMarkingBreaks(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
): void {
  for (const c of ROAD_CROSSINGS) {
    const dx = c.x - centerX;
    const dy = c.y - centerY;
    if (dx * dx + dy * dy > CULL_R2) continue;
    if (c.w1 < 3 && c.w2 < 3) continue;
    drawMarkingBreak(ctx, c.x, c.y, c.ang1, c.ang2, c.w1, c.w2);
  }
}

/** Paint every visible intersection's pair of crosswalks + stop bars.
 *  Caller has applied the camera transform. */
export function drawCrosswalks(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
): void {
  for (const c of ROAD_CROSSINGS) {
    const dx = c.x - centerX;
    const dy = c.y - centerY;
    if (dx * dx + dy * dy > CULL_R2) continue;
    // Skip tiny alley joins — only render at meaningful intersections.
    if (c.w1 < 3 && c.w2 < 3) continue;
    // Crosswalk perpendicular to road 1 sits at road 2's edge:
    const off1 = c.w2 * TILE * 0.42;
    const off2 = c.w1 * TILE * 0.42;
    drawCrosswalkBand(ctx, c.x, c.y, c.ang1, c.w1, off1);
    drawCrosswalkBand(ctx, c.x, c.y, c.ang2, c.w2, off2);
    // H58 stop bars — paint on the MINOR road's approach (or both
    // when neither is a major). Bars sit just outside the crosswalk
    // band so the order from oncoming driver is bar → crosswalk →
    // intersection.
    const bothMinor = !c.maj1 && !c.maj2;
    const isR1Minor = !c.maj1 && (c.w1 <= c.w2 || bothMinor);
    const isR2Minor = !c.maj2 && (c.w2 <= c.w1 || bothMinor);
    // Stop-bar offset: crosswalk centerline + half its band width
    // (~3 px) further out, so the bar reads as 1 line BEFORE the
    // zebra stripes.
    if (isR1Minor) drawStopBarPair(ctx, c.x, c.y, c.ang1, c.w1, off1 + 3);
    if (isR2Minor) drawStopBarPair(ctx, c.x, c.y, c.ang2, c.w2, off2 + 3);
  }
}
