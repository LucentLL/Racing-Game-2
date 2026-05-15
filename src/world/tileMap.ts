/**
 * Tile bitmap — a 2500×2500 Uint8Array indexed by `y * MAP_W + x`.
 *
 * Each cell holds a tile-type byte (1 = road, 0 = unset/grass; full
 * tile-type set lands when the monolith's water/building/bridge stamp
 * logic ports). Allocated once at boot, mutated by the world-gen pass
 * (src/world/buildBaselineMap), read by physics for off-road detection,
 * and by future traffic AI, fuel placement, building lookup, etc.
 *
 * Memory: 2500*2500 bytes = 6.25 MB. Acceptable on PC, marginal on
 * older phones — still well under typical web heap budgets.
 */

import { MAP_W, MAP_H, TILE } from '@/config/world/tiles';

export const TILE_ROAD = 1;

/** Built at boot by src/world/buildBaselineMap. */
export interface TileMap {
  /** MAP_W × MAP_H bytes; row-major (`y*MAP_W + x`). */
  bytes: Uint8Array;
  width: number;
  height: number;
}

export function createTileMap(): TileMap {
  return {
    bytes: new Uint8Array(MAP_W * MAP_H),
    width: MAP_W,
    height: MAP_H,
  };
}

/** Bounds-checked read. Returns 0 (grass) for out-of-bounds coords. */
export function getTile(map: TileMap, tx: number, ty: number): number {
  if (tx < 0 || tx >= map.width || ty < 0 || ty >= map.height) return 0;
  return map.bytes[ty * map.width + tx];
}

/** Bounds-checked write. Silently ignored for out-of-bounds coords. */
export function setTile(map: TileMap, tx: number, ty: number, v: number): void {
  if (tx < 0 || tx >= map.width || ty < 0 || ty >= map.height) return;
  map.bytes[ty * map.width + tx] = v;
}

/** True when the world-coord point (px, py) lies on a tile flagged as
 *  road. Used by physics for off-road slowdown. Caller passes world
 *  pixels; we floor-divide by TILE to land in the tile grid. */
export function isOnRoad(map: TileMap, px: number, py: number): boolean {
  const tx = Math.floor(px / TILE);
  const ty = Math.floor(py / TILE);
  return getTile(map, tx, ty) === TILE_ROAD;
}
