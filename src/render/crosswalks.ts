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

/** H1044: small STOP octagon decal (world space) — red with a white rim. */
function drawStopOctagon(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = Math.PI / 8 + i * (Math.PI / 4);
    const px = cx + Math.cos(a) * r;
    const py = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = 'rgba(196, 40, 34, 0.92)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.lineWidth = 0.5;
  ctx.stroke();
}

/** H1044: small YIELD triangle decal — inverted, white with a red border. */
function drawYieldTriangle(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(cx - r, cy - r * 0.72);
  ctx.lineTo(cx + r, cy - r * 0.72);
  ctx.lineTo(cx, cy + r * 0.86);
  ctx.closePath();
  ctx.fillStyle = 'rgba(245, 245, 245, 0.92)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(196, 40, 34, 0.95)';
  ctx.lineWidth = 0.8;
  ctx.stroke();
}

/** H1044: a STOP-controlled approach — the solid stop-bar pair plus a roadside
 *  STOP octagon at each of the road's two approach directions (driver's right). */
function drawStopApproach(
  ctx: CanvasRenderingContext2D, x: number, y: number, ang: number, roadW: number, offDist: number,
): void {
  drawStopBarPair(ctx, x, y, ang, roadW, offDist);
  const nx = Math.cos(ang), ny = Math.sin(ang);
  const ppx = -ny, ppy = nx;
  const hw = roadW * TILE * 0.38;
  // Sign size is roughly fixed (a real STOP sign is ~30 in, not road-scaled),
  // so cap it to keep glyphs sensible on wide arterials.
  const r = Math.max(2.5, Math.min(6, roadW * TILE * 0.08));
  for (const sign of [-1, 1] as const) {
    const bx = x + nx * offDist * sign;
    const by = y + ny * offDist * sign;
    // Roadside = driver's right for this direction → +perp for sign +1, −perp
    // for sign −1 (i.e. perp × sign), just beyond the bar's end.
    const gx = bx + ppx * (hw + r + 1) * sign;
    const gy = by + ppy * (hw + r + 1) * sign;
    drawStopOctagon(ctx, gx, gy, r);
  }
}

/** H1044: a YIELD-controlled approach — a shark-teeth line (triangles pointing
 *  at oncoming traffic) plus a roadside YIELD triangle at each direction. No
 *  solid stop bar. */
function drawYieldApproach(
  ctx: CanvasRenderingContext2D, x: number, y: number, ang: number, roadW: number, offDist: number,
): void {
  const nx = Math.cos(ang), ny = Math.sin(ang);
  const ppx = -ny, ppy = nx;
  const hw = roadW * TILE * 0.38;
  // Sign size is roughly fixed (a real STOP sign is ~30 in, not road-scaled),
  // so cap it to keep glyphs sensible on wide arterials.
  const r = Math.max(2.5, Math.min(6, roadW * TILE * 0.08));
  const th = 1.7;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
  for (const sign of [-1, 1] as const) {
    const bx = x + nx * offDist * sign;
    const by = y + ny * offDist * sign;
    const teeth = Math.max(4, Math.round(hw / 1.6));
    for (let t = 0; t < teeth; t++) {
      const frac = teeth === 1 ? 0 : (t / (teeth - 1)) * 2 - 1;
      const tx = bx + ppx * hw * frac;
      const ty = by + ppy * hw * frac;
      // Tooth tip points toward oncoming traffic (outward from the box).
      const tipx = tx + nx * sign * th;
      const tipy = ty + ny * sign * th;
      ctx.beginPath();
      ctx.moveTo(tipx, tipy);
      ctx.lineTo(tx - ppx * th * 0.55, ty - ppy * th * 0.55);
      ctx.lineTo(tx + ppx * th * 0.55, ty + ppy * th * 0.55);
      ctx.closePath();
      ctx.fill();
    }
    const gx = bx + ppx * (hw + r + 1) * sign;
    const gy = by + ppy * (hw + r + 1) * sign;
    drawYieldTriangle(ctx, gx, gy, r);
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
  /** H792: viewport-derived cull radius (world px); defaults to the
   *  600-px module constant. */
  cullR?: number,
): void {
  const _r2 = cullR !== undefined ? cullR * cullR : CULL_R2;
  for (const c of ROAD_CROSSINGS) {
    const dx = c.x - centerX;
    const dy = c.y - centerY;
    if (dx * dx + dy * dy > _r2) continue;
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
  /** H792: viewport-derived cull radius (world px); defaults to the
   *  600-px module constant. */
  cullR?: number,
): void {
  const _r2 = cullR !== undefined ? cullR * cullR : CULL_R2;
  for (const c of ROAD_CROSSINGS) {
    const dx = c.x - centerX;
    const dy = c.y - centerY;
    if (dx * dx + dy * dy > _r2) continue;
    // Skip tiny alley joins — only render at meaningful intersections.
    if (c.w1 < 3 && c.w2 < 3) continue;
    // H288: skip BRIDGE OVERLAPS — when either road is elevated (z > 1)
    // the crossing is a bridge-over-road, not a surface intersection.
    // No crosswalk / stop bar / signal is appropriate when one road is
    // physically above the other. Mirrors monolith L31624 bridge skip.
    // (The visible "crossing" the player sees is the bridge concrete
    // deck, drawn separately by drawBridgeOverlays.)
    if (c.z1 > 1 || c.z2 > 1) continue;
    // Crosswalk perpendicular to road 1 sits at road 2's edge. H1047: the curb
    // distance measured ALONG road 1 grows as the crossing gets oblique — road
    // 2's half-width projects to w2/(2·sinθ) along road 1, where θ is the angle
    // between the two roads. Without the 1/sinθ the bands (and the stop bars /
    // octagons that ride the same offset) land short of the real curb, so the
    // two roads' bands scissor and the stop line sits inside the box at sharp
    // angles — the oblique-intersection breakage. Clamp sinθ ≥ 0.4 so a very
    // acute (<~24°) crossing can't blow the offset to infinity. At 90° sinθ = 1,
    // so this is byte-identical to pre-H1047 for the common square crossing.
    const sinT = Math.max(0.4, Math.abs(Math.sin(c.ang1 - c.ang2)));
    const off1 = (c.w2 * TILE * 0.42) / sinT;
    const off2 = (c.w1 * TILE * 0.42) / sinT;
    drawCrosswalkBand(ctx, c.x, c.y, c.ang1, c.w1, off1);
    drawCrosswalkBand(ctx, c.x, c.y, c.ang2, c.w2, off2);
    // Stop bars / control glyphs — the MINOR approach is the one that yields
    // (lower-width / non-major, or both when neither is major). Bars sit just
    // outside the crosswalk (offset +3) so the order to an oncoming driver is
    // bar → crosswalk → intersection.
    const bothMinor = !c.maj1 && !c.maj2;
    const isR1Minor = !c.maj1 && (c.w1 <= c.w2 || bothMinor);
    const isR2Minor = !c.maj2 && (c.w2 <= c.w1 || bothMinor);
    // H1044: branch on the authored control type. undefined = the legacy auto
    // default (plain stop bars on minor, unchanged), 4 = signal (same). 0-3 get
    // the authored treatment.
    const ctrl = c.control;
    if (ctrl === 0) {
      // Uncontrolled — crosswalks only, no bars or glyphs.
    } else if (ctrl === 1) {
      // Yield — shark-teeth line + triangle on the yielding (minor) legs.
      if (isR1Minor) drawYieldApproach(ctx, c.x, c.y, c.ang1, c.w1, off1 + 3);
      if (isR2Minor) drawYieldApproach(ctx, c.x, c.y, c.ang2, c.w2, off2 + 3);
    } else if (ctrl === 2) {
      // Two-way stop — bars + STOP octagons on the minor legs only.
      if (isR1Minor) drawStopApproach(ctx, c.x, c.y, c.ang1, c.w1, off1 + 3);
      if (isR2Minor) drawStopApproach(ctx, c.x, c.y, c.ang2, c.w2, off2 + 3);
    } else if (ctrl === 3) {
      // All-way stop — bars + STOP octagons on EVERY leg.
      drawStopApproach(ctx, c.x, c.y, c.ang1, c.w1, off1 + 3);
      drawStopApproach(ctx, c.x, c.y, c.ang2, c.w2, off2 + 3);
    } else {
      // Signal (4) or undefined (legacy auto): plain stop bars on the minor legs.
      if (isR1Minor) drawStopBarPair(ctx, c.x, c.y, c.ang1, c.w1, off1 + 3);
      if (isR2Minor) drawStopBarPair(ctx, c.x, c.y, c.ang2, c.w2, off2 + 3);
    }
  }
}
