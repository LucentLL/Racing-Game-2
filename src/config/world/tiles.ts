/**
 * Tile / map foundational constants.
 *
 * The world is a fixed-size square measured in TILES (2500 × 2500).
 * Each tile renders as TILE canvas pixels. World coordinates (the
 * units used for player position, camera position, traffic AI) are
 * canvas pixels — so 1 world unit = 1 px, and tile coord → world =
 * tileCoord * TILE.
 *
 * Ported from monolith L9197-9198.
 */

export const TILE = 18;
export const MAP_W = 2500;
export const MAP_H = 2500;

/** World-coord width / height (canvas px). */
export const WORLD_W = MAP_W * TILE;
export const WORLD_H = MAP_H * TILE;

/** Convert tile coord → world coord. */
export function tileToWorld(t: number): number {
  return t * TILE;
}
