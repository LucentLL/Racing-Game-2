/**
 * H41/H47 building + sidewalk tile render pass.
 *
 * Walks the visible viewport in tile coords, classifies each tile via
 * the lazy tileClassify cache, and paints two tile types:
 *   - tile=4 buildings — palette fill from getBldg() + top hilite +
 *     optional roof accent on the top row of each 4×4 block.
 *   - tile=5 sidewalks — concrete-gray base + darker curb strips on
 *     edges that touch a road tile (matches monolith L30349-30356).
 *
 * Caller has already applied the camera translate.
 *
 * Ported from monolith render() ground-tile loop L30020-30040 (buildings)
 * and L30344-30356 (sidewalk base + curbs).
 *
 * INTENTIONALLY simpler than the full monolith pass:
 *   - Windows are NOT drawn yet (monolith uses winSeed to scatter
 *     bright window pixels across each block; we draw flat fills).
 *   - Multi-storey shadow casts are NOT drawn (those use the b.h height
 *     in a parallax pass that comes after roads — deferred).
 *   - The user-placed tile=17 path is NOT supported (World Editor
 *     stamps haven't moved into the H build).
 *
 * Performance budget: at a 1280×720 canvas with TILE=18 the viewport
 * holds ~72 × 40 ≈ 2,900 tiles. classifyTile is O(1) after first read.
 */

import { TILE } from '@/config/world/tiles';
import { getTile, TILE_ROAD, type TileMap } from '@/world/tileMap';
import { classifyTile, TILE_BUILDING, TILE_SIDEWALK } from '@/world/buildings';

const SIDEWALK_A = '#3a3a3a';
const SIDEWALK_B = '#383838';
const SIDEWALK_CURB = '#555';

// H1004: user buildings (tile=17) + concrete driveways (tile=19) no longer
// self-paint per-TILE here — that produced a staircased blob. They now
// render as clean footprint POLYGONS (per-type roofs / concrete strips) in
// src/render/placedStructures.ts (drawPlacedBuildings / drawDriveways),
// reading the same worldEditor rows. The tile=17/19 STAMPS stay for physics
// (solid buildings H998 + drivable concrete). This pass keeps only the
// sidewalk render (procedural city furniture).

/** Draws all visible building + sidewalk tiles. centerX/centerY is
 *  the world-coord visual center (player), radius the half-side of
 *  the tile-culling square. */
export function drawBuildings(
  ctx: CanvasRenderingContext2D,
  map: TileMap,
  centerX: number,
  centerY: number,
  radius: number,
): void {
  const minTX = Math.floor((centerX - radius) / TILE) - 1;
  const maxTX = Math.ceil((centerX + radius) / TILE) + 1;
  const minTY = Math.floor((centerY - radius) / TILE) - 1;
  const maxTY = Math.ceil((centerY + radius) / TILE) + 1;

  for (let ty = minTY; ty <= maxTY; ty++) {
    for (let tx = minTX; tx <= maxTX; tx++) {
      const cls = classifyTile(map, tx, ty);
      const wx = tx * TILE;
      const wy = ty * TILE;

      if (cls === TILE_BUILDING) {
        // H279: building tiles intentionally NOT rendered — the monolith
        // map doesn't show building blocks at the player's view zoom.
        // classifyTile still returns TILE_BUILDING (so tile-aware code
        // can distinguish "would-be city block" from grass), but the
        // visible paint is grass-equivalent (which drawGrass already
        // covered before this pass runs, so the tile stays as that
        // grass paint).
      } else if (cls === TILE_SIDEWALK) {
        // Concrete base — alternating per tile parity for subtle
        // texture variation. Matches monolith L30344.
        ctx.fillStyle = ((tx + ty) & 1) ? SIDEWALK_A : SIDEWALK_B;
        ctx.fillRect(wx, wy, TILE, TILE);
        // Curb edges — 1px strip on any edge that touches a road tile.
        // The neighbor lookup uses getTile (raw), not classify, so we
        // don't trigger classification of road-adjacent grass.
        ctx.fillStyle = SIDEWALK_CURB;
        if (getTile(map, tx - 1, ty) === TILE_ROAD) ctx.fillRect(wx, wy, 1, TILE);
        if (getTile(map, tx + 1, ty) === TILE_ROAD) ctx.fillRect(wx + TILE - 1, wy, 1, TILE);
        if (getTile(map, tx, ty - 1) === TILE_ROAD) ctx.fillRect(wx, wy, TILE, 1);
        if (getTile(map, tx, ty + 1) === TILE_ROAD) ctx.fillRect(wx, wy + TILE - 1, TILE, 1);
      }
    }
  }
}
