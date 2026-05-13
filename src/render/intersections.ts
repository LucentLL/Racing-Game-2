/**
 * Intersection markings — stop bars on minor-road approaches + zebra-stripe
 * crosswalks perpendicular to each road approach.
 *
 * Ported from render() L31683–31759. The center-line "junction masking dot"
 * (former v8.99.126.18 behavior) has been REMOVED per user request — those
 * masked dots read as deliberate placed markers rather than fixing the
 * underlying X-crossing artifact. The v126.19 fix simply stops drawing them.
 *
 * Bridge crossings (c.r1z>1 || c.r2z>1) are skipped — no surface stop-bar
 * or crosswalk is appropriate when one road is elevated over the other.
 */

import type { FrameView } from './types';

/** A road crossing record. Built once during world preprocessing. */
export interface RoadCrossing {
  /** World-pixel position. */
  x: number;
  y: number;
  /** Tangent angle of each road at the crossing (radians). */
  ang1: number;
  ang2: number;
  /** Road widths in tiles. */
  r1w: number;
  r2w: number;
  /** Major-road flags. */
  r1maj?: boolean;
  r2maj?: boolean;
  /** z-levels of each road at the crossing. */
  r1z: number;
  r2z: number;
}

export interface IntersectionsDeps {
  TILE: number;
  crossings: ReadonlyArray<RoadCrossing>;
  /** Player position — used by the cull rect. */
  px: number;
  py: number;
  /** Diag gate. */
  diagOffIsect?: boolean;
}

export function drawIntersections(
  ctx: CanvasRenderingContext2D,
  view: FrameView,
  deps: IntersectionsDeps,
): void {
  if (deps.diagOffIsect) return;
  const { TILE, crossings, px, py } = deps;
  // v8.78: tightened cull from 2.5x to 1.3x viewR — was drawing detail
  // for intersections up to 2.5 screen-widths off-camera.
  const cullR = view.viewR * 1.3;

  for (const c of crossings) {
    if (Math.abs(c.x - px) > cullR || Math.abs(c.y - py) > cullR) continue;
    if (c.r1z > 1 || c.r2z > 1) continue; // skip bridge crossings

    // ---- Stop bars on minor approaches --------------------------------
    const isR1Minor = c.r1w <= c.r2w && !c.r1maj;
    const isR2Minor = c.r2w <= c.r1w && !c.r2maj;
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1.5;

    if (isR1Minor || (!c.r1maj && !c.r2maj)) {
      const hw = c.r1w * TILE * 0.35;
      const off = c.r2w * TILE * 0.45 + 1;
      const nx1 = Math.cos(c.ang1);
      const ny1 = Math.sin(c.ang1);
      const ppx = -ny1;
      const ppy =  nx1;
      for (const s of [-1, 1]) {
        const bx = c.x + nx1 * off * s;
        const by = c.y + ny1 * off * s;
        ctx.beginPath();
        ctx.moveTo(bx - ppx * hw, by - ppy * hw);
        ctx.lineTo(bx + ppx * hw, by + ppy * hw);
        ctx.stroke();
      }
    }
    if (isR2Minor || (!c.r1maj && !c.r2maj)) {
      const hw = c.r2w * TILE * 0.35;
      const off = c.r1w * TILE * 0.45 + 1;
      const nx2 = Math.cos(c.ang2);
      const ny2 = Math.sin(c.ang2);
      const ppx = -ny2;
      const ppy =  nx2;
      for (const s of [-1, 1]) {
        const bx = c.x + nx2 * off * s;
        const by = c.y + ny2 * off * s;
        ctx.beginPath();
        ctx.moveTo(bx - ppx * hw, by - ppy * hw);
        ctx.lineTo(bx + ppx * hw, by + ppy * hw);
        ctx.stroke();
      }
    }

    // ---- Crosswalks (zebra stripes) ------------------------------------
    const drawCrosswalk = (ang: number, roadW: number, _crossW: number, offDist: number): void => {
      const nx = Math.cos(ang);
      const ny = Math.sin(ang);
      const ppx = -ny;
      const ppy =  nx;
      const hw = roadW * TILE * 0.38;
      const stripeCount = Math.max(3, Math.round(hw * 2 / 3));
      ctx.fillStyle = 'rgba(255,255,255,0.2)';
      for (let s = -1; s <= 1; s += 2) {
        const baseX = c.x + nx * offDist * s;
        const baseY = c.y + ny * offDist * s;
        for (let si = 0; si < stripeCount; si++) {
          const frac = (si / (stripeCount - 1)) * 2 - 1;
          const sx = baseX + ppx * hw * frac;
          const sy = baseY + ppy * hw * frac;
          ctx.fillRect(sx - 1, sy - 0.5, 2, 1);
        }
      }
    };

    if (c.r1w >= 3 || c.r2w >= 3) {
      drawCrosswalk(c.ang1, c.r1w, c.r2w, c.r2w * TILE * 0.42);
      drawCrosswalk(c.ang2, c.r2w, c.r1w, c.r1w * TILE * 0.42);
    }
  }
}
