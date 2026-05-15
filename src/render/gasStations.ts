/**
 * Gas station markers — small yellow squares on the world canvas,
 * yellow dots on the minimap. Doubles as the refuel trigger: when the
 * player is stopped within REFUEL_RADIUS_TILES of a station's center,
 * fuel ticks back up.
 *
 * Per-frame cost: 4 fillRect + 4 stroke on the world canvas, plus 4
 * arcs on the minimap. Negligible.
 */

import { GAS_STATIONS, REFUEL_RADIUS_TILES, type GasStation } from '@/config/world/gasStations';
import { TILE } from '@/config/world/tiles';
import type { PlayerState } from '@/state/player';

const MARKER_SIZE = TILE * 5;        // 5×5 tile pad to match monolith
const MARKER_FILL = '#d4b438';       // matches lane-stripe yellow
const MARKER_STROKE = '#2a1a00';
const PUMP_SYMBOL = '⛽';

/** Refuel rate when stopped at a station, in fuel-fraction per second. */
export const REFUEL_RATE_PER_SEC = 0.35;
/** Speed under which the player counts as "stopped at the pump". */
export const REFUEL_STOPPED_SPEED = 5;

/** Draws each station as a square + glyph on the world canvas. Caller
 *  has already applied the camera translate. */
export function drawGasStations(ctx: CanvasRenderingContext2D): void {
  ctx.lineWidth = 2;
  for (const gs of GAS_STATIONS) {
    const wx = gs.tx * TILE;
    const wy = gs.ty * TILE;
    ctx.fillStyle = MARKER_FILL;
    ctx.fillRect(wx - MARKER_SIZE / 2, wy - MARKER_SIZE / 2, MARKER_SIZE, MARKER_SIZE);
    ctx.strokeStyle = MARKER_STROKE;
    ctx.strokeRect(wx - MARKER_SIZE / 2, wy - MARKER_SIZE / 2, MARKER_SIZE, MARKER_SIZE);
    // Pump glyph, large enough to read from a distance.
    ctx.fillStyle = MARKER_STROKE;
    ctx.font = `bold ${MARKER_SIZE * 0.6}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(PUMP_SYMBOL, wx, wy);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
  }
}

/** Draws each station as a small dot on the minimap. Caller has
 *  already translated origin to the minimap's top-left. */
export function drawGasStationsOnMinimap(
  ctx: CanvasRenderingContext2D,
  minimapScale: number,
  minimapOriginX: number,
  minimapOriginY: number,
): void {
  ctx.fillStyle = MARKER_FILL;
  for (const gs of GAS_STATIONS) {
    const x = minimapOriginX + gs.tx * TILE * minimapScale;
    const y = minimapOriginY + gs.ty * TILE * minimapScale;
    ctx.beginPath();
    ctx.arc(x, y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Returns the nearest station within REFUEL_RADIUS_TILES of the
 *  player's center, or null if none in range. */
export function nearestStationInRange(player: PlayerState): GasStation | null {
  const radSq = (REFUEL_RADIUS_TILES * TILE) ** 2;
  let best: GasStation | null = null;
  let bestD = radSq;
  for (const gs of GAS_STATIONS) {
    const dx = player.px - gs.tx * TILE;
    const dy = player.py - gs.ty * TILE;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = gs;
    }
  }
  return best;
}

/** Per-frame refuel tick. Auto-refuels when the player is stopped at a
 *  station; no button or hold required. Returns the station the player
 *  is refueling at (for HUD display), or null. */
export function tickRefuel(player: PlayerState, dt: number): GasStation | null {
  if (player.pSpeed > REFUEL_STOPPED_SPEED) return null;
  const gs = nearestStationInRange(player);
  if (!gs) return null;
  if (player.fuel < 1) {
    player.fuel = Math.min(1, player.fuel + REFUEL_RATE_PER_SEC * dt);
  }
  return gs;
}
