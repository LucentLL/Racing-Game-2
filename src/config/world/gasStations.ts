/**
 * Gas station placements.
 *
 * The monolith places stations procedurally at major-highway crossings
 * (L17437-17478, scoring 8 candidate offsets per crossing and picking
 * the least-contaminated pad). H13 hardcodes four sensible spots near
 * known Charlotte landmarks so we don't need to port the road-crossings
 * detection pass yet. The real procedural placer ports along with
 * traffic + intersection detection.
 *
 * Coords are in TILE units (multiply by TILE for world coords). Each
 * station occupies roughly a 5×4 tile pad in the monolith; H13 just
 * tracks the center point and renders a small marker — pump positions
 * + tile=7/tile=8 stamping come later.
 */

export interface GasStation {
  /** Display name shown in HUD when player is in range. */
  name: string;
  /** Center coords in TILE units (multiply by TILE for world). */
  tx: number;
  ty: number;
}

export const GAS_STATIONS: readonly GasStation[] = [
  // Downtown-ish, near the I-277 inner loop (player spawns near here).
  { name: 'Uptown Sunoco',     tx: 1010, ty: 1085 },
  // South Park / east side, off I-485 east arc.
  { name: 'Pineville BP',      tx: 1750, ty: 1450 },
  // West Boulevard area, between I-77 and I-485 west.
  { name: 'Westside Citgo',    tx: 720,  ty: 1400 },
  // University area, north on I-77 N.
  { name: 'University Shell',  tx: 960,  ty: 480  },
];

/** Distance (in TILE-units, NOT world units) within which the player
 *  is considered "at" the station and refueling pumps run. ~5 tiles =
 *  90 world-px ≈ 1.5 car lengths. */
export const REFUEL_RADIUS_TILES = 5;
