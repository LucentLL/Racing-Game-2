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

/** Tile-type bytes the monolith treats as DIRT surfaces — used by
 *  the Phase 0B integrator's tire-coefficient block (mu_base ×0.75
 *  at L25254) and wheelspin-yaw boost surface cap (0.6× at L25902).
 *  Dirt tiles are ALSO classified as road (they're driveable
 *  surfaces at the canyon trails, mining roads, off-road parks),
 *  so [[isOnDirt]] and [[isOnRoad]] both fire on the same byte.
 *
 *  Indexed list rather than three named constants so the classifier
 *  can iterate without three separate equality branches. The names
 *  for each variant aren't documented in the monolith — they're
 *  just `onTile===12||onTile===14||onTile===16` checks everywhere
 *  they appear.
 *
 *  Matches monolith `onTile===12||onTile===14||onTile===16` at
 *  L24119, L24243, L24396, L24418, L25254, L25902, L26452. */
export const TILE_DIRT_VARIANTS: readonly number[] = [12, 14, 16];

/** Tile-type bytes the monolith treats as GRASS — used by the
 *  surface classifier when the tile isn't road. The 255 value is
 *  the "unset" sentinel for out-of-tilemap regions (treated as
 *  grass by default — a car driving past the populated map edge
 *  rolls onto grass, not into a void).
 *
 *  Matches monolith `onTile===6||onTile===255||onTile===11||
 *  onTile===9||onTile===13||onTile===0` at L23953. */
export const TILE_GRASS_VARIANTS: readonly number[] = [0, 6, 9, 11, 13, 255];

/** True when the world-coord point (px, py) lies on a tile the
 *  monolith classifies as DIRT (tile types 12 / 14 / 16). The
 *  Phase 0B integrator uses this to:
 *
 *    - Reduce μ_base by ×0.75 in the tire-coefficient block
 *      ([[computeMuBase]] consumer at monolith L25254)
 *    - Cap the wheelspin-yaw boost to 0.6× via the surface
 *      multiplier ([[applyWheelspinYawBoost]] consumer at L25902)
 *
 *  CURRENTLY A STUB (returns false for every input): the modular
 *  tilemap only populates TILE_ROAD=1 today. World-gen ports that
 *  paint the richer tile types haven't landed yet. The function
 *  is wired into the Phase 0B runtime cutover (H502) so future
 *  world-gen ports light it up automatically — no integrator code
 *  needs to change. */
export function isOnDirt(map: TileMap, px: number, py: number): boolean {
  const tx = Math.floor(px / TILE);
  const ty = Math.floor(py / TILE);
  const t = getTile(map, tx, ty);
  for (const variant of TILE_DIRT_VARIANTS) {
    if (t === variant) return true;
  }
  return false;
}

/** True when the world-coord point (px, py) lies on a tile the
 *  monolith classifies as GRASS (tile types 0 / 6 / 9 / 11 / 13 /
 *  255). The Phase 0B integrator uses this to:
 *
 *    - Reduce baseSteer by ×0.5 in [[computeGripBaseSteer]] (the
 *      grass-front-tire-grip-loss effect at monolith L24716)
 *    - Reduce μ_base by ×0.55 via [[computeMuBase]] (monolith
 *      L25252)
 *    - Cap the wheelspin-yaw boost to 0.4× ([[applyWheelspinYawBoost]]
 *      surface multiplier at L25901)
 *
 *  CURRENTLY MOSTLY A STUB: the modular tilemap only populates
 *  TILE_ROAD=1; everything else reads as the default 0 (grass).
 *  So isOnGrass effectively returns `!isOnRoad` until world-gen
 *  ports populate non-grass non-road tiles (buildings, dirt,
 *  water, etc.). That's the correct stub behavior — the default
 *  surface IS grass, so reading the unset-tile bytes as grass
 *  matches the monolith's `onTile===0` branch directly.
 *
 *  Note the monolith's full classifier ALSO predicates on
 *  `!onRoad` (L23953). This stub doesn't, because in the current
 *  tile data isOnRoad is a strict TILE_ROAD-only check and
 *  isOnGrass's "tile is in the grass variant set" is mutually
 *  exclusive with TILE_ROAD=1 anyway. Once world-gen lands tiles
 *  that overlap (e.g. an off-tile road overlay), the !onRoad
 *  predicate will need to be added — flagged as a TODO for that
 *  future port. */
export function isOnGrass(map: TileMap, px: number, py: number): boolean {
  const tx = Math.floor(px / TILE);
  const ty = Math.floor(py / TILE);
  const t = getTile(map, tx, ty);
  for (const variant of TILE_GRASS_VARIANTS) {
    if (t === variant) return true;
  }
  return false;
}

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
  // H998: USER-placed buildings (tile=17) are SOLID — the player can't
  // drive through them (the auto-driveway, tile=1/19, is the intended gap
  // up to the garage). Scoped to tile=17 ONLY: procedural downtown blocks
  // (TILE_BUILDING=4) stay passable — the v7.70 disable existed because
  // roads thread through those dense blocks and solidifying them would
  // wall the city out (tile=4 isn't even rendered at play zoom). This
  // lights up the fully-wired collide()/integrator three-tier response
  // with no other change.
  if (t === 17) return true;
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
