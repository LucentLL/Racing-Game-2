/**
 * Per-tick player surface classification — is the player on a road,
 * on grass, or somewhere else, and what z-elevation is the road?
 *
 * Composes three independent sources of "on road":
 *
 *   1. TILE-BASED — read the tile-type at the player's position. The
 *      expanded set (1-3, 5, 7, 8, 10, 12, 14, 15, 16) covers every
 *      paved-surface variant the world-gen stamps (roads, ramps,
 *      crosswalks, shoulders, intersections, etc.).
 *
 *   2. v8.66 MAJOR-ROAD CACHE OVERRIDE — if the tile check failed,
 *      look at `neMaj` (highways + ramps). When the player sits
 *      within `halfW + 1` tiles of the cached major road, treat as
 *      on-road and adopt its z elevation. The +1 tile tolerance
 *      covers the discrepancy between the linear polyline (what the
 *      cache measures) and the bezier curve (what the renderer
 *      draws) — at the inside of a turn the linear distance can
 *      exceed halfW slightly while the player is visually well
 *      inside the painted asphalt.
 *
 *   3. v8.98.57 ANY-ROAD CACHE OVERRIDE — if the major-road check
 *      also failed, try `ne` (any road including arterials). The
 *      monolith added this when v8.66 missed minor streets that
 *      render on top of grass tiles — players on those arterials
 *      saw brown skid marks and grass-grip handling without the
 *      fallback.
 *
 * Grass detection is the negative of all three: when none of the
 * road sources fire AND the tile is one of the grass-family types
 * (6, 9, 11, 13, 0, 255). Water / dirt / curb tiles will fall into
 * the "neither road nor grass" gap intentionally — downstream
 * physics treats those distinctly when those tile types are
 * eventually stamped by world-gen.
 *
 * Output `playerZ` carries the elevation of the matched road
 * (0 = ground, 2+ = elevated bridge / flyover). When neither cache
 * hit, playerZ stays 0 — caller's bridge-layer logic uses its own
 * elevated-deck detection, this is just the road-level hint.
 *
 * Monolith source: update() at L23924-L23953.
 */

import type { NearestRoadCachePair } from './nearestRoadCache';
import type { Road, RoadProfile } from '@/render/roads/types';

/** Surface classification for one frame. */
export interface PlayerSurfaceState {
  /** True iff player is on any road surface — tile-based OR cache
   *  fallback. Drives traction, fuel burn, off-road grip
   *  modulation. */
  onRoad: boolean;
  /** True iff !onRoad AND tile is in the grass-family set. */
  onGrass: boolean;
  /** Road elevation level when on a road (0 ground, 2+ elevated).
   *  Set by whichever cache fallback fired; 0 when neither did
   *  (player is on grass, off road, or on a tile-detected road
   *  whose elevation isn't tracked in the tile data). */
  playerZ: number;
  /** Raw tile-type byte (0..255) under the player. Passed through so
   *  downstream consumers can branch on specific surfaces (dirt vs
   *  grass vs water for tire-grain audio, mud spray FX, etc.). */
  onTile: number;
}

/** Tile-type set treated as paved / road by the tile-based check.
 *  Range 1-3 covers the canonical road tile; 5/7/8/10/12/14/15/16
 *  cover crosswalk + shoulder + intersection + ramp + bridge-deck
 *  variants the world-gen passes stamp. Matches monolith
 *  `(onTile>=1&&onTile<=3)||onTile===5||onTile===7||...`. */
const PAVED_TILE_TYPES = new Set([1, 2, 3, 5, 7, 8, 10, 12, 14, 15, 16]);

/** Tile-type set treated as grass. Captures unset (0, 255), the
 *  canonical grass tile (6), and the other off-road variants the
 *  world-gen stamps (9 / 11 / 13 — dirt / shoulder-grass /
 *  fill-in). Matches monolith
 *  `onTile===6||onTile===255||onTile===11||onTile===9||onTile===13||onTile===0`. */
const GRASS_TILE_TYPES = new Set([0, 6, 9, 11, 13, 255]);

/** Classify the player's current surface. Pure function — takes the
 *  cache produced by computeNearestRoadCache plus the tile lookup,
 *  returns a fresh state struct.
 *
 *  `tileLookup` is the bounds-checked tile reader. Caller wraps the
 *  modular TileMap (or whatever underlying byte source) with the
 *  same wraparound math the monolith does:
 *      const wtx = ((tx % MAP_W) + MAP_W) % MAP_W
 *      const wty = ((ty % MAP_H) + MAP_H) % MAP_H
 *  In practice the player is always within bounds so the modulo is
 *  defensive, but preserving it matches the monolith 1:1.
 *
 *  `getRoadProfile` is the per-road profile resolver, invoked when
 *  the cache road has no memoized `_prof`. Caller threads through
 *  the same dep that's used for speed-limit / bridge-trim code.
 *
 *  Ported 1:1 from monolith L23924-L23953 (the surface-check block
 *  near the top of update()). */
export function computePlayerSurface(
  px: number,
  py: number,
  neCache: NearestRoadCachePair,
  getRoadProfile: (road: Road) => RoadProfile,
  tileLookup: (tx: number, ty: number) => number,
  TILE: number,
  MAP_W: number,
  MAP_H: number,
): PlayerSurfaceState {
  const tx = Math.floor(px / TILE);
  const ty = Math.floor(py / TILE);
  const wtx = ((tx % MAP_W) + MAP_W) % MAP_W;
  const wty = ((ty % MAP_H) + MAP_H) % MAP_H;
  const onTile = tileLookup(wtx, wty);
  let onRoad = PAVED_TILE_TYPES.has(onTile);
  let playerZ = 0;

  if (!onRoad && neCache.neMaj.road) {
    const r = neCache.neMaj.road;
    const prof = r._prof || getRoadProfile(r);
    const hw = prof.totalW / 2 + 1;
    if (neCache.neMaj.dist2 < hw * hw) {
      onRoad = true;
      playerZ = r.z || 0;
    }
  }
  if (!onRoad && neCache.ne.road) {
    const r = neCache.ne.road;
    const prof = r._prof || getRoadProfile(r);
    const hw = prof.totalW / 2 + 1;
    if (neCache.ne.dist2 < hw * hw) {
      onRoad = true;
      playerZ = r.z || 0;
    }
  }
  const onGrass = !onRoad && GRASS_TILE_TYPES.has(onTile);

  return { onRoad, onGrass, playerZ, onTile };
}
