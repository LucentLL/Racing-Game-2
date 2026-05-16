/**
 * H57 — crosswalk zebra stripes at road intersections.
 *
 * For each intersection (computed at module init by roadCrossings),
 * paint a band of white stripes perpendicular to each approaching
 * road. Stripes sit just past the OTHER road's edge so they form the
 * pedestrian crossing at the curb line, like real signalized
 * intersections.
 *
 * Only renders at intersections where at least one road is width >= 3
 * (skip narrow alley joins) and dist²-cull around the player so we
 * only pay for visible intersections.
 *
 * Ported from monolith L31655-31676 (drawCrosswalk helper + the
 * intersection iteration above it).
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

/** Paint every visible intersection's pair of crosswalks. Caller has
 *  applied the camera transform. */
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
    drawCrosswalkBand(ctx, c.x, c.y, c.ang1, c.w1, c.w2 * TILE * 0.42);
    drawCrosswalkBand(ctx, c.x, c.y, c.ang2, c.w2, c.w1 * TILE * 0.42);
  }
}
