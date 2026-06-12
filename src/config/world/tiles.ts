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

/** H805: REAL-WORLD DISTANCE SCALE of the road network. The road
 *  geometry anchors it: a standard painted lane is LANE_W_STD = 1.275
 *  tiles and represents a US 12-ft (3.6576 m) lane, so one tile is
 *  3.6576 / 1.275 = 2.8687 m and one world px is TILE/2.8687 m.
 *
 *  Car bodies were historically sized at the monolith's ~4.5 gu/m
 *  convention — only 72% of the road's scale — so every car drew
 *  ~28% smaller than the world around it (a 1.92 m-wide Viper filled
 *  38% of a lane where the real ratio is ~52%; user-reported). All
 *  car sizing now derives from this constant so vehicles and roads
 *  share one scale. NOTE: the SPEED scale (SCALE_MS = 4.864 wpx per
 *  m/s) is a separate, deliberately arcade-tuned convention — do not
 *  conflate the two. */
export const METERS_PER_TILE = 3.6576 / 1.275;
export const WPX_PER_M = TILE / METERS_PER_TILE; // ≈ 6.2746
/** Car-spec helper: GT4 mm → world px. */
export const WPX_PER_MM = WPX_PER_M / 1000;

/** Convert tile coord → world coord. */
export function tileToWorld(t: number): number {
  return t * TILE;
}
