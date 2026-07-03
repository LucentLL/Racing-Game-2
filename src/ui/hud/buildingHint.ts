/**
 * H997: placed-building entry hint — "ENTER <building>" HUD button.
 *
 * Mirrors homeHint.ts, but targets the H997 placed-building registry
 * instead of the single LIFE.homeX/homeY home pin. When the player drives
 * within range of a placed RESIDENCE (trailer / house / apartment), a
 * pulsing button appears; tapping it opens the home overlay (the garage /
 * car-management screen) — the "cars drive into garages" primitive for
 * editor-placed houses.
 *
 * Dealer / mechanic buildings are registered too but not garage-enterable
 * yet; they surface as a labeled prompt with a "coming soon" toast so the
 * feature reads as intentional rather than broken.
 */
import { TILE } from '@/config/world/tiles';
import {
  nearestPlacedBuilding,
  placedBuildingLabel,
  type PlacedBuilding,
} from '@/world/placedBuildings';

/** Proximity radius in tiles — a little wider than homeHint's ~2.5 tiles
 *  so bigger footprints (apartment/dealer) still trigger from their edge. */
const ENTER_RADIUS_TILES = 4;

/** Module-level cache of the building the player is currently able to
 *  enter (null when out of range / a modal is up). Set by tick, read by
 *  draw + the click router — same separation homeHint uses. */
let _nearBuilding: PlacedBuilding | null = null;

export function nearBuilding(): PlacedBuilding | null {
  return _nearBuilding;
}

/** HUD button rect (canvas coords). Sits just below the ENTER HOME button
 *  (GH*0.12) so the two never overlap when both are eligible. */
export function buildingHintRect(GW: number, GH: number): {
  x: number; y: number; w: number; h: number;
} {
  return { x: GW / 2 - 70, y: GH * 0.12 + 30, w: 140, h: 24 };
}

/** Per-frame proximity update. Clears while any blocking modal is open. */
export function tickBuildingHint(
  playerPx: number,
  playerPy: number,
  blocked: boolean,
): void {
  if (blocked) { _nearBuilding = null; return; }
  _nearBuilding = nearestPlacedBuilding(
    playerPx, playerPy, TILE, ENTER_RADIUS_TILES, false,
  );
}

/** Draws the pulsing button when a building is in range. */
export function drawBuildingHint(
  ctx: CanvasRenderingContext2D,
  GW: number,
  GH: number,
): void {
  const b = _nearBuilding;
  if (!b) return;
  const hb = Math.sin(Date.now() * 0.005) > 0;
  if (!hb) return;
  const { x, y, w, h } = buildingHintRect(GW, GH);
  // Residences read cyan (garage); dealer/mechanic read amber (service).
  const accent = b.residence ? '0, 200, 255' : '255, 180, 60';
  ctx.fillStyle = `rgba(${accent}, 0.22)`;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = `rgba(${accent}, 1)`;
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = `rgba(${accent}, 0.97)`;
  ctx.font = 'bold 11px monospace';
  ctx.textAlign = 'center';
  const icon = b.residence ? '🏠' : (b.type === 'mechanic' ? '🔧' : '🏬');
  ctx.fillText(`${icon} ENTER ${placedBuildingLabel(b)}`, GW / 2, y + 16);
  ctx.textAlign = 'left';
  ctx.lineWidth = 1;
}

/** Hit-test for the click router. */
export function isBuildingHintHit(
  tx: number, ty: number, GW: number, GH: number,
): boolean {
  if (!_nearBuilding) return false;
  const { x, y, w, h } = buildingHintRect(GW, GH);
  return tx >= x && tx <= x + w && ty >= y && ty <= y + h;
}
