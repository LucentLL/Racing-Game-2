/**
 * Top-left minimap overlay — bakes the full Charlotte road network
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

import { TILE, MAP_W, MAP_H } from '@/config/world/tiles';
import type { PlayerState } from '@/state/player';
import type { LifeState } from '@/state/life';
import { drawGasStationsOnMinimap } from './gasStations';
import { RENDER_ENTRIES } from './worldMap';

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

/** H176: per-road color palette — 1:1 port of monolith L33763-33768.
 *  Distinguishes the major interstate ring (I-485 = light blue),
 *  primary radials (I-77 / I-85 / US-74 / Brookshire Fwy = orange),
 *  the inner loop (I-277 = yellow-orange), other arterials (gray),
 *  ramps + exits (green), and minor streets (dark gray). Makes the
 *  minimap road network read as a navigable mental map rather than
 *  a uniform spider-web. */
function colorForRoad(name: string, isMajor: boolean): string {
  if (name.includes('I-485')) return '#0af';
  if (
    name.includes('I-77') ||
    name.includes('I-85') ||
    name.includes('US-74') ||
    name.includes('Brookshire')
  ) return '#f80';
  if (name.includes('I-277')) return '#fa0';
  if (name.includes('Exit') || name.includes('Ramp')) return '#0f0';
  if (isMajor) return '#888';
  return '#444';
}

/** H176: per-road line-width — same monolith L33769 lookup. Major
 *  roads pop with 1.5px, ramps with 1.2px (still visible at the
 *  minimap's 0.052 scale despite being narrower in tile-width), and
 *  minor streets fade to 0.6 so they read as the background grid. */
function widthForRoad(name: string, isMajor: boolean): number {
  if (isMajor) return 1.5;
  if (name.includes('Exit') || name.includes('Ramp')) return 1.2;
  return 0.6;
}

/** Paints the minimap road network onto `bake.canvas` using the
 *  current contents of RENDER_ENTRIES (which already carries editor
 *  edits, deletes, overlay roads, and Catmull-Rom-smoothed pts). */
function paintMinimap(bake: MinimapBake): void {
  const c = bake.canvas.getContext('2d');
  if (!c) return;
  // Translucent dark backdrop so the minimap reads against any HUD.
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.fillStyle = 'rgba(10, 10, 18, 0.85)';
  c.fillRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);

  c.lineCap = 'round';
  c.lineJoin = 'round';
  // H176: paint in two passes so high-priority roads (interstates,
  // ramps) sit on top of minor streets regardless of source order.
  // Minor first, major second. Within each pass entries draw in
  // RENDER_ENTRIES order — z-sort (H141) keeps elevated highways
  // above ground siblings if they share a name prefix.
  const passes: ReadonlyArray<(maj: number) => boolean> = [
    (maj) => maj !== 1,
    (maj) => maj === 1,
  ];
  for (const pred of passes) {
    for (const entry of RENDER_ENTRIES) {
      const w = entry.row[0] as number;
      const maj = entry.row[1] as number;
      const name = String(entry.row[2] ?? '');
      if (!pred(maj)) continue;
      const pts = entry.smoothed;
      if (pts.length < 4) continue;
      // Honor the actual road-width when it's wider than the per-class
      // floor, so I-485's 10-tile carriageway visibly thickens vs a
      // 4-tile US route at the same color.
      const scaledW = w * TILE * SCALE;
      c.lineWidth = Math.max(widthForRoad(name, maj === 1), scaledW);
      c.strokeStyle = colorForRoad(name, maj === 1);
      c.beginPath();
      c.moveTo(pts[0] * TILE * SCALE, pts[1] * TILE * SCALE);
      for (let i = 2; i + 1 < pts.length; i += 2) {
        c.lineTo(pts[i] * TILE * SCALE, pts[i + 1] * TILE * SCALE);
      }
      c.stroke();
    }
  }
}

/** Bakes the road network to an offscreen canvas. Call once at boot.
 *  The returned canvas is reused every frame via drawImage. */
export function createMinimap(): MinimapBake {
  const canvas = document.createElement('canvas');
  canvas.width = MINIMAP_SIZE;
  canvas.height = MINIMAP_SIZE;
  const bake: MinimapBake = { canvas, scale: SCALE, size: MINIMAP_SIZE };
  paintMinimap(bake);
  return bake;
}

/** H128: repaint the minimap onto the existing bake.canvas. Called
 *  from the editor's Ctrl+S handler so a save → exit-editor flow
 *  shows the new road network on the minimap without a page reload.
 *  Idempotent — clears the canvas via the backdrop fill and re-strokes
 *  every entry. The bake reference + .canvas pointer stay stable so
 *  the HUD's drawImage call keeps pointing at the right surface. */
export function rebuildMinimap(bake: MinimapBake): void {
  paintMinimap(bake);
}

/** Per-frame draw — blit the baked canvas at the top-right of `hctx`
 *  and overlay the player dot + heading indicator at the player's
 *  world position. */
export function drawMinimap(
  hctx: CanvasRenderingContext2D,
  bake: MinimapBake,
  player: PlayerState,
  _hudWidth: number,
  life: LifeState | null = null,
): void {
  // H79: anchor TOP-LEFT (monolith _syncPcMinimapPosition at L22690
  // uses mmX=2, mmY=2 — minimap lives at the canvas's top-left corner
  // and the gauge cluster takes the top-right).
  const x0 = MINIMAP_PADDING;
  const y0 = MINIMAP_PADDING;

  hctx.drawImage(bake.canvas, x0, y0);

  // Gas station dots over the baked image (not baked because they may
  // grow per-session in future H commits when traffic-aware placement
  // ports).
  drawGasStationsOnMinimap(hctx, bake.scale, x0, y0);

  // H177: home marker — cyan dot + 'H' label at the player's
  // LIFE.homeX/homeY tile coord. 1:1 port of monolith L33807-33816.
  // Job A/B and Race F markers from the same monolith block port
  // when LIFE.job + RACE state land in our build. Home blinks when
  // dayPhase === 'returning' (the monolith's "head home now" cue),
  // matching the sin(Date.now() * 0.004) pulse the monolith uses.
  if (life) {
    const hsx = x0 + life.homeX * TILE * bake.scale;
    const hsy = y0 + life.homeY * TILE * bake.scale;
    const blink = Math.sin(Date.now() * 0.004) > 0;
    const returning = (life.dayPhase as string | undefined) === 'returning';
    hctx.fillStyle = returning && blink ? '#0ff' : 'rgba(0, 255, 255, 0.6)';
    hctx.beginPath();
    hctx.arc(hsx, hsy, 3, 0, Math.PI * 2);
    hctx.fill();
    hctx.fillStyle = '#000';
    hctx.font = 'bold 4px monospace';
    hctx.textAlign = 'center';
    hctx.fillText('H', hsx, hsy + 1.5);
    hctx.textAlign = 'left';
  }

  // H205: active job A/B markers. Green 'A' at the pickup point
  // before pickedUp, yellow 'B' at the delivery point after.
  // Blinks faster than the home pin (sin(t*0.008) vs sin(t*0.004))
  // so the active-job target draws the eye. 1:1 port of monolith
  // L33817-33839 minus the towJob branch (not ported — same scope
  // gate as H203's drawJobMarkers). Coords are world-pixels;
  // minimap is a static city-wide square anchored at (x0, y0)
  // with `scale` pixels per world-pixel.
  if (life?.job) {
    const job = life.job;
    const isMainline = job.type !== 'TOW TRUCK'
      && job.type !== 'TRUCK DRIVER'
      && job.type !== 'FUEL TANKER';
    if (isMainline) {
      const jobBlink = Math.sin(Date.now() * 0.008) > 0;
      if (jobBlink && !job.pickedUp && job.fromX != null && job.fromY != null) {
        const ax = x0 + job.fromX * bake.scale;
        const ay = y0 + job.fromY * bake.scale;
        hctx.fillStyle = '#0f0';
        hctx.beginPath();
        hctx.arc(ax, ay, 3, 0, Math.PI * 2);
        hctx.fill();
        hctx.fillStyle = '#000';
        hctx.font = 'bold 4px monospace';
        hctx.textAlign = 'center';
        hctx.fillText('A', ax, ay + 1.5);
        hctx.textAlign = 'left';
      }
      if (jobBlink && job.pickedUp && job.toX != null && job.toY != null) {
        const bx = x0 + job.toX * bake.scale;
        const by = y0 + job.toY * bake.scale;
        hctx.fillStyle = '#ff0';
        hctx.beginPath();
        hctx.arc(bx, by, 3, 0, Math.PI * 2);
        hctx.fill();
        hctx.fillStyle = '#000';
        hctx.font = 'bold 4px monospace';
        hctx.textAlign = 'center';
        hctx.fillText('B', bx, by + 1.5);
        hctx.textAlign = 'left';
      }
    }
  }

  // H180: car pin markers — colored dot + label, blinking opacity.
  // 1:1 port of monolith drawCarPinsMinimap (L50347-50358). The
  // monolith uses a player-centered disk transform; our minimap is
  // a static, top-left-anchored, city-wide square, so the screen
  // conversion is `x0 + worldX * scale` (pin.worldX is already in
  // world-px, not tiles). Drawn AFTER the player dot would be ideal
  // (so the player stays visible over a coincident pin), but drawing
  // before the border + player keeps the layering consistent with
  // the home marker. Pins blink at sin(t*0.006) to draw the eye.
  if (life && life.carPins.length > 0) {
    const blink = Math.sin(Date.now() * 0.006) > 0;
    for (const pin of life.carPins) {
      const sx = x0 + pin.worldX * bake.scale;
      const sy = y0 + pin.worldY * bake.scale;
      hctx.fillStyle = blink ? pin.color : 'rgba(255, 255, 255, 0.3)';
      hctx.beginPath();
      hctx.arc(sx, sy, 3, 0, Math.PI * 2);
      hctx.fill();
      hctx.fillStyle = '#000';
      hctx.font = 'bold 4px monospace';
      hctx.textAlign = 'center';
      hctx.fillText(pin.label, sx, sy + 1.5);
      hctx.textAlign = 'left';
    }
  }

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
