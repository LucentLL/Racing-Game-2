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
 *  pixels; we floor-divide by TILE to land in the tile grid.
 *
 *  CURRENTLY A STUB compared to the monolith's full road
 *  classifier (monolith L23928 admits tile types
 *  `1..3, 5, 7, 8, 10, 12, 14, 15, 16` as road). The modular
 *  tilemap only populates TILE_ROAD=1 today (the richer types
 *  come from world-gen passes that haven't been ported), so this
 *  matches the data that exists rather than the data we will have
 *  once the world-gen ports land. */
export function isOnRoad(map: TileMap, px: number, py: number): boolean {
  const tx = Math.floor(px / TILE);
  const ty = Math.floor(py / TILE);
  return getTile(map, tx, ty) === TILE_ROAD;
}

/** Monolith tile-type byte for buildings. The only tile type
 *  `isSolid` consults; documented here as the "what collision
 *  would consider solid IF building collision were enabled" hook.
 *
 *  Matches monolith inline `t!==4` check at L23745. */
export const TILE_BUILDING = 4;

/** Single-point solidity query — returns true when the world-coord
 *  point (wx, wy) lies on a tile that would block movement.
 *
 *  WORLD-WRAPS COORDS: the monolith wraps tx/ty to [0, MAP_W) ×
 *  [0, MAP_H) before the getTile read (torus topology). Out-of-
 *  bounds positions therefore wrap back into the world rather
 *  than reading grass at the edge. Matches monolith L23743
 *  `getTile(((tx%MAP_W)+MAP_W)%MAP_W, ((ty%MAP_H)+MAP_H)%MAP_H)`.
 *
 *  COLLISION CURRENTLY DISABLED — v7.70 explicitly disabled
 *  building collision ("[DISABLED v7.70] Building collision
 *  removed — player drives through buildings"). The monolith
 *  reaches the inline `return false` after the tile-type check
 *  for every input, so the function effectively always returns
 *  false. Ported 1:1 — re-enabling collision is a downstream
 *  decision tracked in the v7.70 line comment, not in this port.
 *
 *  Ported 1:1 from monolith L23741-L23746. */
export function isSolid(map: TileMap, wx: number, wy: number): boolean {
  const tx = Math.floor(wx / TILE);
  const ty = Math.floor(wy / TILE);
  const wrappedX = ((tx % map.width) + map.width) % map.width;
  const wrappedY = ((ty % map.height) + map.height) % map.height;
  const t = getTile(map, wrappedX, wrappedY);
  if (t !== TILE_BUILDING) return false;
  // [DISABLED v7.70] Building collision removed — player drives
  // through buildings. Kept as a structural placeholder so a
  // future re-enable is a one-line change rather than a rewrite.
  return false;
}

/** Number of radial sample points the [[collide]] query checks
 *  around the chassis center. 8 samples at 45° spacing match the
 *  monolith's `for(let a=0; a<2π; a+=π/4)` loop at L23749.
 *
 *  WHY 8 (NOT 4 / 16): empirically tuned. 4 samples leave
 *  noticeable diagonal gaps where the chassis can clip a building
 *  corner unnoticed; 16 doubles the per-query cost without
 *  reducing perceived clipping at typical chassis sizes (player
 *  AABB half-size ~5 gu). 8 is the sweet spot — front, back,
 *  sides, and four diagonals all sampled.
 *
 *  Matches monolith `Math.PI/4` step at L23749. */
export const COLLIDE_SAMPLE_STEP = Math.PI / 4;

/** Multi-point collision query — true when ANY of the 8 radial
 *  sample points (at radius r around the world-coord center
 *  (x, y)) hits a solid tile. The standard collision check the
 *  position integrator uses in its three-tier collision response.
 *
 *  SAMPLE PATTERN (1:1 with monolith):
 *    for a = 0, π/4, π/2, 3π/4, π, 5π/4, 3π/2, 7π/4:
 *      if isSolid(x + cos(a)·r, y + sin(a)·r): return true
 *    return false
 *
 *  RADIUS r IS HALF THE CHASSIS AABB: the position integrator
 *  passes the player half-size constant (typically 5 gu); traffic
 *  callers pass their own per-vehicle half-size. The result is
 *  conservative — a chassis touching a wall at any radial angle
 *  blocks the proposed move.
 *
 *  STILL RETURNS FALSE FOR PLAYER COLLISIONS — because isSolid
 *  always returns false (collision disabled in v7.70). The
 *  collide() invocation path is structurally complete and ready
 *  for the re-enable; it just won't fire any positive results
 *  until isSolid's inline `return false` is replaced.
 *
 *  Ported 1:1 from monolith L23748-L23754. */
export function collide(
  map: TileMap,
  x: number,
  y: number,
  r: number,
): boolean {
  for (let a = 0; a < Math.PI * 2; a += COLLIDE_SAMPLE_STEP) {
    if (isSolid(map, x + Math.cos(a) * r, y + Math.sin(a) * r)) return true;
  }
  return false;
}
