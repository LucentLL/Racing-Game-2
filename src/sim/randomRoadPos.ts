/**
 * Random-road-tile sampler — picks a tile coord that's on the
 * road network, then returns its world-center as canvas pixels.
 * Surfaces parked-car / newspaper-listing positions, lot pin
 * coords, and any other "spawn this thing somewhere sensible on
 * the map" use case.
 *
 * H541: 1:1 port of monolith _randomRoadPos at L45285-L45293.
 *
 * THE ALGORITHM:
 *   1. Rejection-sample tile coords uniformly in [0, MAP_W)×[0, MAP_H)
 *      until the tile bitmap reports a road tile. Max 500 attempts
 *      so a malformed bitmap (no road tiles at all) doesn't spin
 *      forever — the last sampled coord falls through verbatim.
 *   2. If the resulting tile is too close to the player's home
 *      (Manhattan distance < 20 tiles), shift it +25 tiles on
 *      both axes (clamped 5 tiles inside the map edge). Keeps
 *      newspaper listings from spawning literally on top of the
 *      home pin, which would defeat the "drive somewhere to see
 *      the listing" gameplay loop.
 *   3. Return world coords at the tile center (tx*TILE + TILE/2).
 *
 * MONOLITH-VS-MODULAR DIVERGENCE: the monolith filters with
 * `getTile(sx,sy) >= 1 && <= 3` to accept the three road
 * categories (primary / secondary / dirt). The modular tilemap
 * only populates [[TILE_ROAD]]=1 today; richer categories land
 * with the world-gen port. The accept predicate is structurally
 * the same — strict-equals TILE_ROAD now, will broaden
 * automatically to the [1, ROAD_TYPE_MAX] range when those
 * additional types ship.
 */

import { MAP_W, MAP_H, TILE } from '@/config/world/tiles';
import { getTile, TILE_ROAD, type TileMap } from '@/world/tileMap';

/** Max rejection-sample attempts before falling through with the
 *  last-tried tile. Mirrors monolith's `att<500` guard at L45288. */
export const MAX_SAMPLE_ATTEMPTS = 500;

/** Manhattan-distance threshold (tiles) below which a sampled
 *  tile is considered "too close to home" and gets shifted. */
export const HOME_REPULSION_TILES = 20;

/** Tile-offset applied to both axes when the sample lands in the
 *  home-repulsion zone. Clamped to keep the result inside the map. */
export const HOME_REPULSION_SHIFT = 25;

/** Edge margin (tiles) the shifted coord is clamped to. Keeps the
 *  result from landing on the map's last column / row where downstream
 *  rendering may misbehave. Matches monolith `MAP_W-5` / `MAP_H-5`. */
export const MAP_EDGE_MARGIN = 5;

/** A world-coordinate point in canvas pixels — tile-center result
 *  of [[randomRoadPos]]. */
export interface RoadPoint {
  x: number;
  y: number;
}

/** Options accepted by [[randomRoadPos]]. The home-repulsion fires
 *  only when both `homeXTile` and `homeYTile` are supplied — pass
 *  undefined to skip the shift (useful for tests / non-newspaper
 *  consumers that don't care about home proximity). */
export interface RandomRoadPosOpts {
  /** Player's home tile-X coord. Skip the repulsion if absent. */
  homeXTile?: number;
  /** Player's home tile-Y coord. Skip the repulsion if absent. */
  homeYTile?: number;
  /** RNG injection point — defaults to Math.random. Tests pass a
   *  deterministic stream so the sampled tile is reproducible. */
  random?: () => number;
}

/** Sample a random road tile and return its world-pixel center.
 *
 *  Rejection-sampling with a 500-attempt cap; when the cap hits,
 *  returns whatever the last sample landed on (matches monolith
 *  fall-through behavior — the sample loop exits but the result
 *  is still used). Home-repulsion applies only when both
 *  homeXTile + homeYTile are supplied.
 *
 *  Ported 1:1 from monolith _randomRoadPos at L45285-L45293. */
export function randomRoadPos(map: TileMap, opts: RandomRoadPosOpts = {}): RoadPoint {
  const rng = opts.random ?? Math.random;
  let sx = 0;
  let sy = 0;
  for (let att = 0; att < MAX_SAMPLE_ATTEMPTS; att++) {
    sx = Math.floor(rng() * MAP_W);
    sy = Math.floor(rng() * MAP_H);
    // See module docstring on the strict-equals vs range divergence
    // from monolith — TILE_ROAD is the only road type the modular
    // bitmap populates today.
    if (getTile(map, sx, sy) === TILE_ROAD) break;
  }
  // Home repulsion. Both axes must be supplied; partial home info
  // skips the shift rather than re-deriving (caller knows whether
  // home exists for this gameplay path).
  if (opts.homeXTile !== undefined && opts.homeYTile !== undefined) {
    const dist = Math.abs(sx - opts.homeXTile) + Math.abs(sy - opts.homeYTile);
    if (dist < HOME_REPULSION_TILES) {
      sx = Math.min(MAP_W - MAP_EDGE_MARGIN, sx + HOME_REPULSION_SHIFT);
      sy = Math.min(MAP_H - MAP_EDGE_MARGIN, sy + HOME_REPULSION_SHIFT);
    }
  }
  return { x: sx * TILE + TILE / 2, y: sy * TILE + TILE / 2 };
}
