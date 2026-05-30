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
import { isGt2Night, GT2_COLORS } from '@/ui/gt2Chrome';

export const MINIMAP_SIZE = 140;
const MINIMAP_PADDING = 8;
/** H741: speedometer SVG anchors at 4px from the top + right edges
 *  on mobile (see syncSpeedoSvgPosition). Mobile minimap matches
 *  that margin so the two round HUD widgets sit symmetrically. */
const MINIMAP_PADDING_MOBILE = 4;

/** Detect mobile via the body class the rest of the modular code
 *  reads (`document.body.classList.contains('mob')`). Returns false
 *  in headless / pre-DOM contexts. */
function isMobModeForMinimap(): boolean {
  if (typeof document === 'undefined') return false;
  return document.body.classList.contains('mob');
}
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
  /** H607: optional traffic array. When supplied, pursuing cops
   *  render as blinking blue dots so the player can see chase
   *  pressure on the minimap, not just the pursuit HUD bar.
   *  Backwards-compatible: callers that don't supply it (tests,
   *  preview paths) get the un-coppered minimap. */
  traffic: ReadonlyArray<{ px: number; py: number; isPursuing?: boolean }> | null = null,
  /** H742: on-screen display diameter (CSS px). When supplied, the
   *  bake canvas is drawImage-scaled to this size and ALL marker
   *  coordinates multiply by displaySize/bake.size so pins land at
   *  the same relative positions on the scaled disc. Defaults to
   *  bake.size (PC behavior — 140 px). Mobile passes the wheel-inner
   *  diameter so the map matches the speedometer's footprint. */
  displaySize?: number,
): void {
  // H79: anchor TOP-LEFT. H741: on mobile, margin shrinks to 4px to
  // match the speedometer SVG's 4px top/right margin so the two
  // round HUD widgets sit symmetrically at equal distance from
  // their respective edges.
  const _padding = isMobModeForMinimap() ? MINIMAP_PADDING_MOBILE : MINIMAP_PADDING;
  const x0 = _padding;
  const y0 = _padding;
  const _night = isGt2Night();

  // H742: visual scale factor — bake is fixed at MINIMAP_SIZE, but
  // mobile draws it larger to match the speedometer diameter. All
  // marker coords below multiply by `_markerScale` so home/A/B/F/
  // opponent/pins stay at their correct relative positions on the
  // scaled disc.
  const _displaySize = displaySize ?? bake.size;
  const _markerScale = _displaySize / bake.size;
  const _sc = bake.scale * _markerScale;

  hctx.drawImage(bake.canvas, x0, y0, _displaySize, _displaySize);

  // H742: at night, paint a translucent cluster-glow tint over the
  // baked roads so the whole minimap reads as backlit (the H741
  // rim-only glow was too subtle). 28% alpha lands the road colors
  // hue-shifted toward the active palette (green / amber / orange)
  // without obliterating the route distinctions baked into the bg.
  // Painted before the markers so home/player dots stay vivid on top.
  if (_night) {
    hctx.save();
    hctx.beginPath();
    hctx.arc(x0 + _displaySize / 2, y0 + _displaySize / 2, _displaySize / 2, 0, Math.PI * 2);
    hctx.clip();
    hctx.fillStyle = GT2_COLORS.amber;
    hctx.globalAlpha = 0.28;
    hctx.fillRect(x0, y0, _displaySize, _displaySize);
    hctx.globalAlpha = 1;
    hctx.restore();
  }

  // Gas station dots over the baked image (not baked because they may
  // grow per-session in future H commits when traffic-aware placement
  // ports).
  drawGasStationsOnMinimap(hctx, _sc, x0, y0);

  // H177: home marker — cyan dot + 'H' label at the player's
  // LIFE.homeX/homeY tile coord. 1:1 port of monolith L33807-33816.
  // Home blinks when dayPhase === 'returning' (the monolith's "head
  // home now" cue), matching the sin(Date.now() * 0.004) pulse.
  if (life) {
    const hsx = x0 + life.homeX * TILE * _sc;
    const hsy = y0 + life.homeY * TILE * _sc;
    const blink = Math.sin(Date.now() * 0.004) > 0;
    const returning = (life.dayPhase as string | undefined) === 'returning';
    hctx.fillStyle = returning && blink ? '#0ff' : 'rgba(0, 255, 255, 0.6)';
    // H741/H742: marker glow at night — the canvas shadowBlur paints
    // the dot's halo in its own color, so home/A/B/F/pin markers read
    // as lit pinpricks on the dark map (matches the H740 SVG-gauge
    // bloom). H742 boosted from 6 -> 10 since the rim tint absorbs
    // some of the contrast.
    if (_night) {
      hctx.shadowColor = '#0ff';
      hctx.shadowBlur = 10;
    }
    hctx.beginPath();
    hctx.arc(hsx, hsy, 3 * _markerScale, 0, Math.PI * 2);
    hctx.fill();
    if (_night) hctx.shadowBlur = 0;
    hctx.fillStyle = '#000';
    hctx.font = 'bold ' + Math.round(4 * _markerScale) + 'px monospace';
    hctx.textAlign = 'center';
    hctx.fillText('H', hsx, hsy + 1.5 * _markerScale);
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
        const ax = x0 + job.fromX * _sc;
        const ay = y0 + job.fromY * _sc;
        hctx.fillStyle = '#0f0';
        hctx.beginPath();
        hctx.arc(ax, ay, 3 * _markerScale, 0, Math.PI * 2);
        hctx.fill();
        hctx.fillStyle = '#000';
        hctx.font = 'bold ' + Math.round(4 * _markerScale) + 'px monospace';
        hctx.textAlign = 'center';
        hctx.fillText('A', ax, ay + 1.5 * _markerScale);
        hctx.textAlign = 'left';
      }
      if (jobBlink && job.pickedUp && job.toX != null && job.toY != null) {
        const bx = x0 + job.toX * _sc;
        const by = y0 + job.toY * _sc;
        hctx.fillStyle = '#ff0';
        hctx.beginPath();
        hctx.arc(bx, by, 3 * _markerScale, 0, Math.PI * 2);
        hctx.fill();
        hctx.fillStyle = '#000';
        hctx.font = 'bold ' + Math.round(4 * _markerScale) + 'px monospace';
        hctx.textAlign = 'center';
        hctx.fillText('B', bx, by + 1.5 * _markerScale);
        hctx.textAlign = 'left';
      }
    }
  }

  // H587: race finish (F) + opponent (red dot) markers when a race
  // is active in ready / countdown / racing phase. Result phase
  // hides them so the dismiss modal doesn't share the screen with
  // a now-meaningless F. finishX/Y and oppX/Y are world-pixels
  // (the same coord space used by player.px/py), so x0 + wx*scale
  // maps them onto the static city minimap.
  // 1:1 with monolith L33843-33855.
  if (life?.race?.active) {
    const phase = life.race.phase;
    if (phase === 'ready' || phase === 'countdown' || phase === 'racing') {
      const blink = Math.sin(Date.now() * 0.008) > 0;
      // F (finish) marker — blinking orange when active.
      const fx = x0 + life.race.finishX * _sc;
      const fy = y0 + life.race.finishY * _sc;
      hctx.fillStyle = blink ? '#f80' : '#a50';
      hctx.beginPath();
      hctx.arc(fx, fy, 3 * _markerScale, 0, Math.PI * 2);
      hctx.fill();
      hctx.fillStyle = '#000';
      hctx.font = 'bold ' + Math.round(4 * _markerScale) + 'px monospace';
      hctx.textAlign = 'center';
      hctx.fillText('F', fx, fy + 1.5 * _markerScale);
      hctx.textAlign = 'left';
      // Opponent dot — solid red, no label.
      const ox = x0 + life.race.oppX * _sc;
      const oy = y0 + life.race.oppY * _sc;
      hctx.fillStyle = '#f44';
      hctx.beginPath();
      hctx.arc(ox, oy, 2 * _markerScale, 0, Math.PI * 2);
      hctx.fill();
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
      const sx = x0 + pin.worldX * _sc;
      const sy = y0 + pin.worldY * _sc;
      hctx.fillStyle = blink ? pin.color : 'rgba(255, 255, 255, 0.3)';
      hctx.beginPath();
      hctx.arc(sx, sy, 3 * _markerScale, 0, Math.PI * 2);
      hctx.fill();
      hctx.fillStyle = '#000';
      hctx.font = 'bold ' + Math.round(4 * _markerScale) + 'px monospace';
      hctx.textAlign = 'center';
      hctx.fillText(pin.label, sx, sy + 1.5 * _markerScale);
      hctx.textAlign = 'left';
    }
  }

  // H607: pursuing-cop dots. Painted BEFORE the border + player
  // dot so the white border still reads on top and the player
  // dot is drawn last (most prominent). Blue blink (~2.5 Hz) so
  // multiple chasing cops draw the eye and the player can plan
  // an escape route. No-op when traffic isn't supplied or no
  // cops are pursuing.
  if (traffic && traffic.length > 0) {
    const blueBlink = Math.floor(Date.now() / 200) % 2 === 0;
    hctx.fillStyle = blueBlink ? '#08f' : '#04a';
    for (const t of traffic) {
      if (!t.isPursuing) continue;
      const cx = x0 + t.px * _sc;
      const cy = y0 + t.py * _sc;
      hctx.beginPath();
      hctx.arc(cx, cy, 2.5 * _markerScale, 0, Math.PI * 2);
      hctx.fill();
    }
  }

  // H741: rim color tracks the night cluster glow — at night the
  // grey #888 rim swaps to the active GT2 palette amber (green /
  // amber / orange depending on getGt2NightPalette), matching the
  // mood of the SVG gauges around it. Day stays #888.
  hctx.strokeStyle = _night ? GT2_COLORS.amber : '#888';
  hctx.lineWidth = 1;
  if (_night) {
    hctx.shadowColor = GT2_COLORS.amber;
    hctx.shadowBlur = 12;
  }
  hctx.strokeRect(x0 + 0.5, y0 + 0.5, _displaySize - 1, _displaySize - 1);
  if (_night) {
    // Second pass adds an even stronger bloom by re-stroking with a
    // bigger blur — same trick the SVG filters use with feMerge.
    hctx.shadowBlur = 6;
    hctx.strokeRect(x0 + 0.5, y0 + 0.5, _displaySize - 1, _displaySize - 1);
    hctx.shadowBlur = 0;
  }

  // Player dot — red, with a short forward-pointing heading line.
  // H741: at night, a soft red halo paints behind the dot so it
  // reads as a lit pinprick (same canvas-shadow trick as the home
  // marker above).
  const px = x0 + player.px * _sc;
  const py = y0 + player.py * _sc;
  if (_night) {
    hctx.shadowColor = '#f44';
    hctx.shadowBlur = 10;
  }
  hctx.fillStyle = '#f44';
  hctx.beginPath();
  hctx.arc(px, py, PLAYER_DOT_R * _markerScale, 0, Math.PI * 2);
  hctx.fill();
  hctx.strokeStyle = '#f44';
  hctx.lineWidth = 1.5 * _markerScale;
  hctx.beginPath();
  hctx.moveTo(px, py);
  hctx.lineTo(
    px + Math.cos(player.pAngle) * PLAYER_HEADING_LEN * _markerScale,
    py + Math.sin(player.pAngle) * PLAYER_HEADING_LEN * _markerScale,
  );
  hctx.stroke();
  if (_night) hctx.shadowBlur = 0;
}
