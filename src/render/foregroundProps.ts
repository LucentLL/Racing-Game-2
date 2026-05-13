/**
 * Foreground-props pass. After the ground tiles are stamped, this pass adds:
 *   1. Water-tile shimmer (scrolling sparkle near the player) and canyon
 *      depth-fog overlay — cheap per-frame fx kept after the v7.52
 *      pseudo-3D pass was removed.
 *   2. Highway exit signs — green sign + EXIT number + name, placed at the
 *      world coords stored in EXIT_MARKERS.
 *   3. Interstate shields — small blue/red 'I-N' badge stamped at three
 *      positions along every major road whose name starts with 'I-'.
 *
 * Ported from render() L30447–30529 of the v8.99.126.89 monolith. The
 * commented-out gas-station label block at L30476–30480 is intentionally
 * dropped — the actual gas-station labels are drawn after the two
 * road-overlay passes (handled in render/roads.ts later).
 */

import type { FrameView } from './types';
import type { ExitMarker } from '@/config/world/exitMarkers';

export interface MajorRoad {
  /** Polyline waypoints in tile-coords. */
  pts: ReadonlyArray<readonly [number, number]>;
  /** Width in tiles (used both for collision and for the shield cull). */
  w: number;
  /** Road label. Shields render only when this starts with `I-`. */
  name: string;
  /** Optional elevation level (0 = ground, 2+ = elevated). */
  z?: number;
  /** Precomputed world-pixel bbox — { minX, maxX, minY, maxY }. */
  _bbox?: { minX: number; maxX: number; minY: number; maxY: number };
}

export interface ForegroundPropsDeps {
  TILE: number;
  MAP_W: number;
  MAP_H: number;
  /** Returns the raw map[] tile id at wrapped coords. Used for the water
   *  shimmer + canyon fog tile-type checks. */
  getTile(wtx: number, wty: number): number;
  /** Player world position — defines the small radius around which the
   *  water shimmer and canyon fog are evaluated. */
  px: number;
  py: number;
  /** All major roads, used for the interstate shield placement. */
  majorRoads: ReadonlyArray<MajorRoad>;
  /** All highway exit markers. */
  exitMarkers: ReadonlyArray<ExitMarker>;
}

export function drawForegroundProps(
  ctx: CanvasRenderingContext2D,
  view: FrameView,
  deps: ForegroundPropsDeps,
): void {
  drawWaterShimmerAndCanyonFog(ctx, deps);
  drawHighwayExitSigns(ctx, view, deps);
  drawInterstateShields(ctx, view, deps);
}

function drawWaterShimmerAndCanyonFog(
  ctx: CanvasRenderingContext2D,
  deps: ForegroundPropsDeps,
): void {
  const { TILE, MAP_W, MAP_H, getTile, px, py } = deps;
  const fxR = TILE * 6;
  const fxMinTX = Math.floor((px - fxR) / TILE) - 1;
  const fxMaxTX = Math.ceil((px + fxR) / TILE) + 1;
  const fxMinTY = Math.floor((py - fxR) / TILE) - 1;
  const fxMaxTY = Math.ceil((py + fxR) / TILE) + 1;

  for (let ty = fxMinTY; ty <= fxMaxTY; ty++) {
    for (let tx = fxMinTX; tx <= fxMaxTX; tx++) {
      const wtx = ((tx % MAP_W) + MAP_W) % MAP_W;
      const wty = ((ty % MAP_H) + MAP_H) % MAP_H;
      // Water shimmer — v8.99.56: pixel cluster instead of a ctx.arc blob.
      if (getTile(wtx, wty) === 9 && (wtx + wty + Math.floor(Date.now() / 1200)) % 6 === 0) {
        const wx = tx * TILE;
        const wy = ty * TILE;
        const shF = Math.floor(Date.now() / 400);
        const shX = wx + TILE / 2 - 2 + (shF % 3);
        const shY = wy + TILE / 2 - 1 + ((shF * 3) % 3);
        ctx.fillStyle = 'rgba(180,220,255,0.35)';
        ctx.fillRect(shX, shY, 2, 1);
        ctx.fillRect(shX + 1, shY + 1, 2, 1);
        ctx.fillRect(shX, shY + 2, 1, 1);
      }
      // Canyon depth fog.
      if (getTile(wtx, wty) === 13) {
        const wx = tx * TILE;
        const wy = ty * TILE;
        ctx.fillStyle = 'rgba(20,15,10,0.15)';
        ctx.fillRect(wx, wy, TILE, TILE);
      }
    }
  }
}

function drawHighwayExitSigns(
  ctx: CanvasRenderingContext2D,
  view: FrameView,
  deps: ForegroundPropsDeps,
): void {
  if (deps.exitMarkers.length === 0) return;
  const { px, py } = deps;
  const cullR2 = view.viewR * view.viewR * 6;

  ctx.textAlign = 'center';
  for (const e of deps.exitMarkers) {
    const ddx = e.wx - px;
    const ddy = e.wy - py;
    if (ddx * ddx + ddy * ddy > cullR2) continue;
    const sx = e.wx;
    const sy = e.wy;
    const signW = Math.max(e.name.length * 3.5 + 12, 30);
    ctx.fillStyle = '#060';
    ctx.fillRect(sx - signW / 2, sy - 16, signW, 13);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(sx - signW / 2, sy - 16, signW, 13);
    ctx.fillStyle = '#ff0';
    ctx.font = 'bold 4px monospace';
    ctx.fillText('EXIT ' + e.num, sx, sy - 10);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 5px monospace';
    ctx.fillText(e.name, sx, sy - 5);
    ctx.fillStyle = '#0f0';
    ctx.beginPath();
    ctx.arc(sx, sy, 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.textAlign = 'left';
}

function drawInterstateShields(
  ctx: CanvasRenderingContext2D,
  view: FrameView,
  deps: ForegroundPropsDeps,
): void {
  if (deps.majorRoads.length === 0) return;
  const { TILE, px, py } = deps;
  const cullR2 = view.viewR * view.viewR * 4;

  ctx.textAlign = 'center';
  for (const road of deps.majorRoads) {
    if (!road.name || !road.name.startsWith('I-') || road.pts.length < 3 || road.w < 1) continue;
    // Three positions: quarter, half, three-quarter along the polyline.
    const positions = [
      Math.floor(road.pts.length / 4),
      Math.floor(road.pts.length / 2),
      Math.floor(road.pts.length * 3 / 4),
    ];
    for (const mi of positions) {
      if (mi >= road.pts.length) continue;
      const mx = road.pts[mi][0] * TILE + TILE / 2;
      const my = road.pts[mi][1] * TILE + TILE / 2;
      const ddx = mx - px;
      const ddy = my - py;
      if (ddx * ddx + ddy * ddy > cullR2) continue;
      ctx.fillStyle = '#00c';
      ctx.beginPath();
      ctx.moveTo(mx - 7, my - 5);
      ctx.lineTo(mx + 7, my - 5);
      ctx.lineTo(mx + 8, my - 2);
      ctx.lineTo(mx + 6, my + 4);
      ctx.lineTo(mx, my + 6);
      ctx.lineTo(mx - 6, my + 4);
      ctx.lineTo(mx - 8, my - 2);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 0.5;
      ctx.stroke();
      ctx.fillStyle = '#c00';
      ctx.fillRect(mx - 6, my - 5, 12, 3);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 5px monospace';
      ctx.fillText(road.name.replace('I-', '').split(' ')[0], mx, my + 3);
    }
  }
  ctx.textAlign = 'left';
}
