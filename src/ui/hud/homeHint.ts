/**
 * Home-entry hint — pulsing cyan "🏠 ENTER HOME" button.
 *
 * Appears when the player drives within ~44px of the home pin and no
 * modal is up. Tapping it opens the home overlay (same as pressing H).
 *
 * Ported from monolith L42228-42234 (tick: distance gate + _homeHint
 * set/clear) and L34482-34495 (draw: pulsing button) and L20994-20999
 * (click: open home overlay).
 *
 * Visual: cyan 120×24 button centered horizontally at GH*0.12. Blinks
 * on/off with `Math.sin(Date.now()*0.005)>0` — period ~0.4s on / 0.4s
 * off.
 */
import { TILE } from '@/config/world/tiles';

/** Tick-shaped LIFE slot. Caller passes LIFE directly. */
export interface HomeHintLife {
  homeX: number;
  homeY: number;
  _homeHint?: boolean;
}

/** Distance-squared threshold the monolith uses: `TILE*TILE*6` = 1944
 *  game-pixel² at TILE=18, so a ~44px radius around the home tile
 *  center. */
const HINT_RADIUS_PX2 = TILE * TILE * 6;

/** Hit-test box for the on-screen button (HUD canvas coords). The
 *  click router and the renderer must agree on this rect — exported
 *  so the click handler can read it without recomputing. */
export function homeHintRect(GW: number, GH: number): {
  x: number; y: number; w: number; h: number;
} {
  return { x: GW / 2 - 60, y: GH * 0.12, w: 120, h: 24 };
}

/** Per-frame _homeHint update. Sets life._homeHint when the player is
 *  within range and no blocking modal is open; clears otherwise.
 *
 *  Monolith also gates on `LIFE.dayPhase==='home'||'driving'`, but the
 *  modular port hasn't wired dayPhase as a real state machine yet —
 *  during 'playing' the player is always effectively driving, so we
 *  drop that gate. The other modal gates (home overlay open, full
 *  map open) are honored. */
export function tickHomeHint(
  life: HomeHintLife,
  playerPx: number,
  playerPy: number,
  homeOpen: boolean,
  fullMapOpen: boolean,
): void {
  if (homeOpen || fullMapOpen) {
    life._homeHint = false;
    return;
  }
  const hx = life.homeX * TILE + TILE / 2;
  const hy = life.homeY * TILE + TILE / 2;
  const dx = playerPx - hx;
  const dy = playerPy - hy;
  life._homeHint = dx * dx + dy * dy < HINT_RADIUS_PX2;
}

/** Draws the pulsing button when _homeHint is set and no modal is up.
 *  No-op otherwise. 1:1 port of monolith L34482-34495. */
export function drawHomeHint(
  ctx: CanvasRenderingContext2D,
  life: HomeHintLife,
  GW: number,
  GH: number,
  homeOpen: boolean,
  fullMapOpen: boolean,
): void {
  if (!life._homeHint || homeOpen || fullMapOpen) return;
  const hb = Math.sin(Date.now() * 0.005) > 0;
  if (!hb) return;
  const { x: bx, y: by, w: bw, h: bh } = homeHintRect(GW, GH);
  ctx.fillStyle = 'rgba(0, 200, 255, 0.25)';
  ctx.fillRect(bx, by, bw, bh);
  ctx.strokeStyle = '#0ff';
  ctx.lineWidth = 2;
  ctx.strokeRect(bx, by, bw, bh);
  ctx.fillStyle = 'rgba(0, 255, 255, 0.95)';
  ctx.font = 'bold 11px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('🏠 ENTER HOME', GW / 2, by + 16);
  ctx.textAlign = 'left';
  ctx.lineWidth = 1;
}

/** Hit-test helper for the click router. Returns true when the cursor
 *  is over the visible hint button. The caller still owns the
 *  "did _homeHint get set this frame?" check — same separation
 *  the monolith uses at L20994. */
export function isHomeHintHit(
  tx: number,
  ty: number,
  GW: number,
  GH: number,
): boolean {
  const { x, y, w, h } = homeHintRect(GW, GH);
  return tx >= x && tx <= x + w && ty >= y && ty <= y + h;
}
