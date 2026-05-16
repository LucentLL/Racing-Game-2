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
