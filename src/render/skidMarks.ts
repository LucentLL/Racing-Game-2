/**
 * Skid-mark rendering. Walks the persistent `skidMarks` ring buffer
 * (capped at ~800 in the monolith) and paints each within the traffic
 * render radius. On-road marks render as dark soot; off-road marks as
 * a brown dirt tone.
 *
 * Ported from render() L31776–31783. Skid marks are emitted by the
 * physics update during heavy braking, drift, and trailer-jackknife —
 * see physics/movement.ts (C22) for the emit side.
 */

import type { FrameView } from './types';

/** One persistent skid-mark dab. */
export interface SkidMark {
  x: number;
  y: number;
  r: number;
  /** True if the mark was emitted while at least one tire was on a road tile. */
  onRoad: boolean;
}

export interface SkidMarksDeps {
  TILE: number;
  skidMarks: ReadonlyArray<SkidMark>;
  px: number;
  py: number;
  /** Traffic-render cull radius squared. Matches the monolith's
   *  `(TILE*25)*(TILE*25)`. */
  trafRenderR2: number;
  diagOffTraffic?: boolean;
}

export function drawSkidMarks(
  ctx: CanvasRenderingContext2D,
  _view: FrameView,
  deps: SkidMarksDeps,
): void {
  if (deps.diagOffTraffic) return;
  if (deps.skidMarks.length === 0) return;
  const { skidMarks, px, py, trafRenderR2 } = deps;
  for (const sm of skidMarks) {
    const sdx = sm.x - px;
    const sdy = sm.y - py;
    if (sdx * sdx + sdy * sdy > trafRenderR2) continue;
    ctx.fillStyle = sm.onRoad ? 'rgba(15,15,15,0.55)' : 'rgba(80,50,20,0.5)';
    ctx.fillRect(sm.x - sm.r, sm.y - sm.r, sm.r * 2, sm.r * 2);
  }
}
