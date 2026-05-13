/**
 * Catmull-Rom-style fallback road tracer. Used only when a road has neither
 * `_mainPath` (Path2D) nor `_chunks` — that is, very short roads that don't
 * cross the chunking threshold. The fast path runs the cached Path2D.
 *
 * Ported from render() L30579–30597.
 *
 * Anchors are midpoints between consecutive control points; the actual
 * polyline points are used as quadratic-Bézier control points. This gives
 * a smooth curve that always passes through the first and last point and
 * tracks through the intermediates without overshoot.
 */

import type { RoadPts } from './types';

export function traceRoadPath(
  ctx: CanvasRenderingContext2D,
  pts: RoadPts,
  TILE: number,
): void {
  const tx = (i: number): number => pts[i][0] * TILE + TILE / 2;
  const ty = (i: number): number => pts[i][1] * TILE + TILE / 2;
  ctx.moveTo(tx(0), ty(0));
  if (pts.length === 2) {
    ctx.lineTo(tx(1), ty(1));
    return;
  }
  for (let i = 0; i < pts.length - 1; i++) {
    if (i === 0) {
      const mx = (tx(0) + tx(1)) / 2;
      const my = (ty(0) + ty(1)) / 2;
      ctx.lineTo(mx, my);
    } else if (i === pts.length - 2) {
      ctx.quadraticCurveTo(tx(i), ty(i), tx(i + 1), ty(i + 1));
    } else {
      const mx = (tx(i) + tx(i + 1)) / 2;
      const my = (ty(i) + ty(i + 1)) / 2;
      ctx.quadraticCurveTo(tx(i), ty(i), mx, my);
    }
  }
}
