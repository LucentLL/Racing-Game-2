/**
 * Top-right minimap overlay — bakes the full Charlotte road network
 * to a small offscreen canvas at boot, then per-frame the HUD just
 * blits the baked image and draws a player dot on top.
 *
 * Bake cost: ~130 polyline strokes once at boot. Per-frame cost:
 * one drawImage + a small arc + a short line. Negligible.
 *
 * Rendering is INTENTIONALLY simpler than the monolith's
 * _updateMobileMinimapSvg pipeline (L22791-22895, SVG-based with
 * clip-path + heading indicator + H/A/B/F/gas markers). H12 just shows
 * roads + player. Markers + per-frame minimap updates port when the
 * traffic / pin / gas-station systems land.
 */

import { BASELINE_ROADS } from '@/config/world/baselineRoads';
import { TILE, MAP_W, MAP_H } from '@/config/world/tiles';
import type { PlayerState } from '@/state/player';
import { drawGasStationsOnMinimap } from './gasStations';

export const MINIMAP_SIZE = 140;
const MINIMAP_PADDING = 8;
const WORLD_W = MAP_W * TILE;
const WORLD_H = MAP_H * TILE;
const SCALE = MINIMAP_SIZE / Math.max(WORLD_W, WORLD_H);
const PLAYER_DOT_R = 3;
const PLAYER_HEADING_LEN = 8;

/** Cached baked minimap. Returned by createMinimap once at boot. */
export interface MinimapBake {
  canvas: HTMLCanvasElement;
  /** Effective scale factor: world coords × SCALE = minimap px. */
  scale: number;
  /** Dimension constant (square). */
  size: number;
}

/** Bakes the road network to an offscreen canvas. Call once at boot.
 *  The returned canvas is reused every frame via drawImage. */
export function createMinimap(): MinimapBake {
  const canvas = document.createElement('canvas');
  canvas.width = MINIMAP_SIZE;
  canvas.height = MINIMAP_SIZE;
  const c = canvas.getContext('2d');
  if (!c) return { canvas, scale: SCALE, size: MINIMAP_SIZE };

  // Translucent dark backdrop so the minimap reads against any HUD.
  c.fillStyle = 'rgba(10, 10, 18, 0.85)';
  c.fillRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);

  c.lineCap = 'round';
  c.lineJoin = 'round';
  for (const row of BASELINE_ROADS) {
    const w = row[0];
    const maj = row[1];
    const pts = row.slice(4) as readonly number[];
    if (pts.length < 4) continue;
    // Width: scale road's tile-width then clamp to a legible minimum.
    // Major roads pop with a slightly heavier line + lighter color.
    const scaledW = w * TILE * SCALE;
    c.lineWidth = Math.max(maj === 1 ? 1.5 : 1, scaledW);
    c.strokeStyle = maj === 1 ? '#888' : '#555';
    c.beginPath();
    c.moveTo(pts[0] * TILE * SCALE, pts[1] * TILE * SCALE);
    for (let i = 2; i + 1 < pts.length; i += 2) {
      c.lineTo(pts[i] * TILE * SCALE, pts[i + 1] * TILE * SCALE);
    }
    c.stroke();
  }
  return { canvas, scale: SCALE, size: MINIMAP_SIZE };
}

/** Per-frame draw — blit the baked canvas at the top-right of `hctx`
 *  and overlay the player dot + heading indicator at the player's
 *  world position. */
export function drawMinimap(
  hctx: CanvasRenderingContext2D,
  bake: MinimapBake,
  player: PlayerState,
  hudWidth: number,
): void {
  const x0 = hudWidth - bake.size - MINIMAP_PADDING;
  const y0 = MINIMAP_PADDING;

  hctx.drawImage(bake.canvas, x0, y0);

  // Gas station dots over the baked image (not baked because they may
  // grow per-session in future H commits when traffic-aware placement
  // ports).
  drawGasStationsOnMinimap(hctx, bake.scale, x0, y0);

  // 1 px white border so the minimap edge reads on a colored backdrop.
  hctx.strokeStyle = '#888';
  hctx.lineWidth = 1;
  hctx.strokeRect(x0 + 0.5, y0 + 0.5, bake.size - 1, bake.size - 1);

  // Player dot — red, with a short forward-pointing heading line.
  const px = x0 + player.px * bake.scale;
  const py = y0 + player.py * bake.scale;
  hctx.fillStyle = '#f44';
  hctx.beginPath();
  hctx.arc(px, py, PLAYER_DOT_R, 0, Math.PI * 2);
  hctx.fill();
  hctx.strokeStyle = '#f44';
  hctx.lineWidth = 1.5;
  hctx.beginPath();
  hctx.moveTo(px, py);
  hctx.lineTo(px + Math.cos(player.pAngle) * PLAYER_HEADING_LEN, py + Math.sin(player.pAngle) * PLAYER_HEADING_LEN);
  hctx.stroke();
}
