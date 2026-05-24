/**
 * H178: full-screen city-map overlay — F key toggle.
 *
 * Port of monolith L33927-34086. When ctx.fullMapOpen is true, draws
 * the entire Charlotte road network at city-centered zoom on top of
 * the HUD canvas. Map is centered on (MAP_W/2, MAP_H/2) — NOT on the
 * player — so the city stays visible regardless of where you stand
 * (the player dot moves around within the static map). A legend
 * strip anchors to the bottom with the marker key.
 *
 * Click anywhere closes (routed via gameLoop's tap handler). F key
 * also toggles. Game world keeps running underneath; the car keeps
 * driving in place even with the map up.
 *
 * Pins implemented:
 *   - H (Home), W (Work / office)
 *   - A/B (Job pickup/dropoff) — H205 wired against life.job
 *   - F (Race finish) + opponent dot — H588 wired against
 *     life.race.{finishX/Y,oppX/Y} during ready/countdown/racing
 *     phases (result phase hides them so the dismiss modal doesn't
 *     compete with a now-meaningless F).
 */

import { TILE, MAP_W, MAP_H } from '@/config/world/tiles';
import { GAS_STATIONS } from '@/config/world/gasStations';
import type { PlayerState } from '@/state/player';
import type { LifeState } from '@/state/life';
import { RENDER_ENTRIES } from './worldMap';

/** Same per-road palette as the minimap (H176) — kept inline so the
 *  full-map can pick slightly different shades (darker minors on the
 *  larger surface for legibility). 1:1 port of monolith L33964-33969. */
function colorForRoad(name: string, isMajor: boolean): string {
  if (name.includes('I-485')) return '#0af';
  if (
    name.includes('I-77') ||
    name.includes('I-85') ||
    name.includes('US-74') ||
    name.includes('Brookshire')
  ) return '#f80';
  if (name.includes('I-277')) return '#fa0';
  if (name.includes('Exit') || name.includes('Ramp')) return '#0b0';
  if (isMajor) return '#666';
  return '#333';
}

function widthForRoad(name: string, isMajor: boolean): number {
  if (isMajor) return 2;
  if (name.includes('Ramp')) return 1;
  return 0.8;
}

/** Paint a labeled pin marker. Helper used for H / W / A / B / F. */
function drawPin(
  ctx: CanvasRenderingContext2D,
  sx: number, sy: number,
  bg: string, letter: string, outline: string | null = null,
): void {
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.arc(sx, sy, 5, 0, Math.PI * 2);
  ctx.fill();
  if (outline) {
    ctx.strokeStyle = outline;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.fillStyle = '#000';
  ctx.font = 'bold 7px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(letter, sx, sy + 2.5);
  ctx.textAlign = 'left';
}

/** Paint the full-map overlay onto hctx covering the full HUD canvas.
 *  Caller decides whether to call — gated on ctx.fullMapOpen in
 *  drawPlaying's HUD pass. */
export function drawFullMap(
  hctx: CanvasRenderingContext2D,
  hudWidth: number,
  hudHeight: number,
  player: PlayerState,
  life: LifeState | null,
): void {
  // Black backdrop covering entire HUD canvas.
  hctx.fillStyle = '#000';
  hctx.fillRect(0, 0, hudWidth, hudHeight);

  // Layout: legend at the bottom, map fills the rest.
  const legendH = 76;
  const mapTop = 4;
  const mapBot = hudHeight - legendH - 4;
  const mapH = mapBot - mapTop;
  const mapW = hudWidth - 8;
  const mapCX = hudWidth / 2;
  const mapCY = mapTop + mapH / 2;
  // Auto-fit: pad 5% so labels at the world edges don't get cropped.
  const fmScale = Math.min(mapW / (MAP_W * 1.05), mapH / (MAP_H * 1.05));
  // City-centered transform — fixed regardless of player position.
  const cityCXtile = MAP_W / 2;
  const cityCYtile = MAP_H / 2;
  const tileToX = (tx: number): number => mapCX + (tx - cityCXtile) * fmScale;
  const tileToY = (ty: number): number => mapCY + (ty - cityCYtile) * fmScale;
  const wxToX = (wx: number): number => tileToX(wx / TILE);
  const wyToY = (wy: number): number => tileToY(wy / TILE);

  // === Roads ===
  // Two-pass so major roads sit on top of minors regardless of
  // RENDER_ENTRIES source order. Mirrors the H176 minimap approach.
  hctx.lineCap = 'round';
  hctx.lineJoin = 'round';
  const passes: ReadonlyArray<(maj: number) => boolean> = [
    (maj) => maj !== 1,
    (maj) => maj === 1,
  ];
  for (const pred of passes) {
    for (const entry of RENDER_ENTRIES) {
      const maj = entry.row[1] as number;
      if (!pred(maj)) continue;
      const name = String(entry.row[2] ?? '');
      const pts = entry.smoothed;
      if (pts.length < 4) continue;
      hctx.lineWidth = widthForRoad(name, maj === 1);
      hctx.strokeStyle = colorForRoad(name, maj === 1);
      hctx.beginPath();
      hctx.moveTo(tileToX(pts[0]), tileToY(pts[1]));
      for (let i = 2; i + 1 < pts.length; i += 2) {
        hctx.lineTo(tileToX(pts[i]), tileToY(pts[i + 1]));
      }
      hctx.stroke();
    }
  }

  // === Gas stations === (drawn first so H sits on top if they overlap)
  // Our build's GasStation uses tile coords directly (tx/ty), so go
  // through tileToX/tileToY instead of the monolith's world-coord
  // wxToX/wyToY. Same final pixel placement either way.
  for (const gs of GAS_STATIONS) {
    const sx = tileToX(gs.tx);
    const sy = tileToY(gs.ty);
    if (sx < -10 || sx > hudWidth + 10 || sy < mapTop - 10 || sy > mapBot + 10) continue;
    hctx.fillStyle = '#0f0';
    hctx.beginPath();
    hctx.arc(sx, sy, 3, 0, Math.PI * 2);
    hctx.fill();
    hctx.fillStyle = '#000';
    hctx.font = 'bold 6px monospace';
    hctx.textAlign = 'center';
    hctx.fillText('G', sx, sy + 2);
    hctx.textAlign = 'left';
  }

  // === Car pins === (H180: player-placed map markers from the
  // newspaper pin-picker. Draws before Home/Work so labeled location
  // pins sit on top of any coincident newspaper-car pin. 1:1 port of
  // monolith L33996-34006 — colored dot, white outline, white label
  // offset to the right of the dot. No distance culling on the full
  // map; the whole city is visible by design.)
  if (life && life.carPins.length > 0) {
    for (const pin of life.carPins) {
      const sx = wxToX(pin.worldX);
      const sy = wyToY(pin.worldY);
      hctx.fillStyle = pin.color || '#f44';
      hctx.beginPath();
      hctx.arc(sx, sy, 5, 0, Math.PI * 2);
      hctx.fill();
      hctx.strokeStyle = '#fff';
      hctx.lineWidth = 0.8;
      hctx.stroke();
      hctx.fillStyle = '#fff';
      hctx.font = 'bold 7px monospace';
      hctx.textAlign = 'left';
      hctx.fillText(pin.label || '?', sx + 7, sy + 3);
    }
  }

  // === Work pin === (H179: only when player has the OFFICE JOB)
  // 1:1 port of monolith L34007-34012 — blue 'W' at office tile coord
  // with 'WORK' label. Other jobs (delivery, parts, tow, etc.) don't
  // have a fixed office; their target is encoded on LIFE.job.fromX/Y.
  // Draws before Home so a same-tile home/office (rare) keeps H on top.
  if (life && life.officeX > 0 && life.officeY > 0 && life.playerJob === 'OFFICE JOB') {
    const wx = tileToX(life.officeX);
    const wy = tileToY(life.officeY);
    drawPin(hctx, wx, wy, '#08f', 'W');
    hctx.fillStyle = '#08f';
    hctx.font = '7px monospace';
    hctx.textAlign = 'left';
    hctx.fillText('WORK', wx + 7, wy + 3);
  }

  // === Job A/B pins === (H205: only when life.job is active and
  // it's a mainline job type; tow / truck / tanker special-case
  // pins port when those branches do). No blink on the full map
  // since the player is intentionally surveying — solid colors
  // read better than a strobe.
  if (life?.job) {
    const job = life.job;
    const isMainline = job.type !== 'TOW TRUCK'
      && job.type !== 'TRUCK DRIVER'
      && job.type !== 'FUEL TANKER';
    if (isMainline) {
      if (!job.pickedUp && job.fromX != null && job.fromY != null) {
        const ax = wxToX(job.fromX);
        const ay = wyToY(job.fromY);
        drawPin(hctx, ax, ay, '#0f0', 'A');
        hctx.fillStyle = '#0f0';
        hctx.font = '7px monospace';
        hctx.textAlign = 'left';
        hctx.fillText('PICKUP', ax + 7, ay + 3);
      }
      if (job.pickedUp && job.toX != null && job.toY != null) {
        const bx = wxToX(job.toX);
        const by = wyToY(job.toY);
        drawPin(hctx, bx, by, '#ff0', 'B');
        hctx.fillStyle = '#ff0';
        hctx.font = '7px monospace';
        hctx.textAlign = 'left';
        hctx.fillText('DELIVER', bx + 7, by + 3);
      }
    }
  }

  // === Home pin === (only when LIFE exists)
  if (life) {
    const hx = tileToX(life.homeX);
    const hy = tileToY(life.homeY);
    drawPin(hctx, hx, hy, '#0ff', 'H');
    hctx.fillStyle = '#0ff';
    hctx.font = '7px monospace';
    hctx.textAlign = 'left';
    hctx.fillText('HOME', hx + 7, hy + 3);
  }

  // === Race finish (F) + opponent dot === (H587 minimap parity).
  // Renders during ready / countdown / racing phases. Result phase
  // hides them so the dismiss modal doesn't compete with a now-
  // meaningless F. 1:1 with monolith full-map race pins.
  if (life?.race?.active) {
    const phase = life.race.phase;
    if (phase === 'ready' || phase === 'countdown' || phase === 'racing') {
      const fx = wxToX(life.race.finishX);
      const fy = wyToY(life.race.finishY);
      drawPin(hctx, fx, fy, '#f80', 'F');
      hctx.fillStyle = '#f80';
      hctx.font = '7px monospace';
      hctx.textAlign = 'left';
      hctx.fillText('FINISH', fx + 7, fy + 3);
      // Opponent dot — red, no label (smaller surface than F).
      const ox = wxToX(life.race.oppX);
      const oy = wyToY(life.race.oppY);
      hctx.fillStyle = '#f44';
      hctx.beginPath();
      hctx.arc(ox, oy, 3, 0, Math.PI * 2);
      hctx.fill();
    }
  }

  // === Player dot ===
  const pxS = wxToX(player.px);
  const pyS = wyToY(player.py);
  hctx.fillStyle = '#f00';
  hctx.beginPath();
  hctx.arc(pxS, pyS, 4, 0, Math.PI * 2);
  hctx.fill();
  hctx.strokeStyle = '#fff';
  hctx.lineWidth = 1;
  hctx.stroke();

  // === Legend strip ===
  const legY = mapBot + 6;
  hctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
  hctx.fillRect(4, legY, hudWidth - 8, legendH - 10);
  hctx.strokeStyle = '#444';
  hctx.lineWidth = 1;
  hctx.strokeRect(4, legY, hudWidth - 8, legendH - 10);
  hctx.fillStyle = '#aaa';
  hctx.font = 'bold 8px monospace';
  hctx.textAlign = 'left';
  hctx.fillText('MAP KEY', 10, legY + 10);

  type LegendEntry = { bg: string; letter: string; text: string };
  const entries: ReadonlyArray<LegendEntry> = [
    { bg: '#f00', letter: '●', text: 'You' },
    { bg: '#0ff', letter: 'H', text: 'Home' },
    { bg: '#08f', letter: 'W', text: 'Work (office)' },
    { bg: '#0f0', letter: 'G', text: 'Gas station' },
    { bg: '#f44', letter: '●', text: 'Car pin (label=listing)' },
    { bg: '#0af', letter: '─', text: 'I-485 (ring)' },
    { bg: '#f80', letter: '─', text: 'I-77 / I-85 / Brookshire' },
    { bg: '#fa0', letter: '─', text: 'I-277 (inner loop)' },
  ];
  const cols = 2;
  const colW = (hudWidth - 20) / cols;
  const entryH = 12;
  entries.forEach((e, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const ex = 10 + col * colW;
    const ey = legY + 18 + row * entryH;
    hctx.fillStyle = e.bg;
    hctx.beginPath();
    hctx.arc(ex + 5, ey - 3, 4, 0, Math.PI * 2);
    hctx.fill();
    if (e.letter !== '●' && e.letter !== '─') {
      hctx.fillStyle = '#000';
      hctx.font = 'bold 6px monospace';
      hctx.textAlign = 'center';
      hctx.fillText(e.letter, ex + 5, ey - 1);
    }
    hctx.fillStyle = '#ccc';
    hctx.font = '8px monospace';
    hctx.textAlign = 'left';
    hctx.fillText(e.text, ex + 13, ey);
  });

  // Close hint
  hctx.fillStyle = '#888';
  hctx.font = 'bold 8px monospace';
  hctx.textAlign = 'right';
  hctx.fillText('F or TAP MAP TO CLOSE', hudWidth - 10, legY + 10);
  hctx.textAlign = 'left';
}
