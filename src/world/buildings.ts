/**
 * H41 — procedural building palette + tile classifier.
 *
 * In the monolith the city has no explicit building geometry: any tile
 * inside I-277 that's within ~3 tiles of a road becomes a "building"
 * tile, and the visible 4×4 block of building tiles shares one palette
 * via a deterministic hash. That keeps the city dense without storing
 * megabytes of per-tile data.
 *
 * Port of monolith L17388-17402 (getBldg + buildings registry) and the
 * resolvedTile() classification at L17350-17386 — simplified to just
 * "building or grass" for H41. Sidewalks (tile=5), grass-with-noise
 * (tile=6/11), and the "convert-to-grass-outside-277" rule for stamped
 * tile=4 user buildings are deferred.
 */

import type { TileMap } from './tileMap';

/** Tile type codes — match the monolith's resolvedTile() output where
 *  meaningful. */
export const TILE_UNRESOLVED = 0; // initial bitmap default
export const TILE_BUILDING = 4;
export const TILE_SIDEWALK = 5;
export const TILE_GRASS_RESOLVED = 255; // monolith uses 255 as "resolved empty"

/** Per-4×4-block palette + roof/seed data. Allocated lazily on first
 *  read and cached in the registry below. */
export interface BuildingTile {
  /** [floor, dark-shadow, hilite]. pal[0] is the body fill the tile
   *  renderer paints. */
  pal: readonly [string, string, string];
  /** True if this block has a colored roof accent. */
  hasRoof: boolean;
  /** Roof color when hasRoof is true. */
  roofColor: string;
  /** Storey count — 6..17. Drives the eventual shadow + windows pass. */
  h: number;
  /** Stable hash seed for window patterns. */
  winSeed: number;
}

/** Block-level palettes. Indexed by `bx,by` string keys (block = 4×4
 *  tiles). Lazy — populated on first read of a fresh block. */
const buildingRegistry = new Map<string, BuildingTile>();

const BLOCK_PALETTES: readonly (readonly [string, string, string])[] = [
  ['#2a2a3a', '#1a1a2a', '#3a3a4a'],
  ['#3a2a2a', '#2a1a1a', '#4a3a3a'],
  ['#2a3a2a', '#1a2a1a', '#3a4a3a'],
  ['#3a3a2a', '#2a2a1a', '#4a4a3a'],
  ['#2a2a2a', '#1a1a1a', '#3a3a3a'],
];

const ROOF_COLORS: readonly string[] = ['#822', '#228', '#282', '#828'];

/** Returns the building palette for the 4×4 block containing
 *  (wtx, wty). Deterministic — same input always returns the same
 *  block entry. Ported from monolith L17389-17402. */
export function getBldg(wtx: number, wty: number): BuildingTile {
  const bx = Math.floor(wtx / 4);
  const by = Math.floor(wty / 4);
  const key = `${bx},${by}`;
  const cached = buildingRegistry.get(key);
  if (cached) return cached;
  const hash = (bx * 31 + by * 17) & 0xff;
  const entry: BuildingTile = {
    pal: BLOCK_PALETTES[hash % BLOCK_PALETTES.length],
    hasRoof: hash % 3 === 0,
    roofColor: ROOF_COLORS[hash % ROOF_COLORS.length],
    h: 6 + ((hash * 7) % 12),
    winSeed: hash,
  };
  buildingRegistry.set(key, entry);
  return entry;
}

/** Classifies (and caches) the tile at (tx, ty). Returns one of:
 *    TILE_ROAD (1)            — already stamped by buildBaselineMap
 *    TILE_GRASS_RESOLVED (255) — every non-road tile
 *
 *  Caches the result back into the map so subsequent reads are O(1).
 *  Originally ported from monolith resolvedTile L17350-17386 with the
 *  TILE_SIDEWALK / TILE_BUILDING split inside I-277.
 *
 *  H690: collapsed to grass-everywhere. The sidewalk branch produced
 *  the diamond-pattern gray squares lining I-277 the user reported as
 *  "jagged asphalt tiles that aren't the road" (the I-277 polygon is
 *  expanded 16 tiles outward, so BOTH sides of the highway classify
 *  as "inside downtown" and get sidewalk paint for every cell within
 *  1 tile of the road — a 16-tile-wide gray ribbon either side of
 *  the loop). Building tiles haven't been rendered since H279 ("the
 *  monolith map doesn't show building blocks at the player's view
 *  zoom"), so they were already invisible — now they classify as
 *  grass too so the drawGrass pass paints them with the 8 GBC variant
 *  textures (standard, dry, lush, dirt, clay, rocks, flowers, tall)
 *  instead of leaving the dark body-bg #0a0a12 showing through.
 *
 *  TILE_SIDEWALK / TILE_BUILDING constants stay exported because
 *  downstream code (highway-sign placement, building lookups) still
 *  references them — they're just never assigned by this classifier
 *  anymore. */
export function classifyTile(map: TileMap, tx: number, ty: number): number {
  if (tx < 0 || tx >= map.width || ty < 0 || ty >= map.height) {
    return TILE_GRASS_RESOLVED;
  }
  const v = map.bytes[ty * map.width + tx];
  if (v === TILE_GRASS_RESOLVED) return TILE_GRASS_RESOLVED;
  if (v !== TILE_UNRESOLVED) return v;
  map.bytes[ty * map.width + tx] = TILE_GRASS_RESOLVED;
  return TILE_GRASS_RESOLVED;
}
