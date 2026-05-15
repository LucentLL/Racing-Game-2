/**
 * H41 building tile render pass.
 *
 * Walks the visible viewport in tile coords, classifies each tile via
 * the lazy tileClassify cache, and paints building tiles as the
 * deterministic palette fill from getBldg(). Roof accents render as a
 * 1-tile-tall band at the top of the building's 4×4 block.
 *
 * Caller has already applied the camera translate.
 *
 * Ported from monolith render() ground-tile loop L30020-30040.
 *
 * INTENTIONALLY simpler than the full monolith pass:
 *   - Windows are NOT drawn yet (monolith uses winSeed to scatter
 *     bright window pixels across each block; we draw flat fills).
 *   - Multi-storey shadow casts are NOT drawn (those use the b.h height
 *     in a parallax pass that comes after roads — deferred).
 *   - Sidewalk tiles (tile=5) are NOT emitted yet — buildings and
 *     sidewalks both render as tile=4 here.
 *   - The user-placed tile=17 path is NOT supported (World Editor
 *     stamps haven't moved into the H build).
 *
 * Performance budget: at a 1280×720 canvas with TILE=18 the viewport
 * holds ~72 × 40 ≈ 2,900 tiles. classifyTile is O(1) after first read.
 */

import { TILE } from '@/config/world/tiles';
import type { TileMap } from '@/world/tileMap';
import { classifyTile, getBldg, TILE_BUILDING } from '@/world/buildings';

/** Draws all visible building tiles. camX/camY are the world-coord
 *  upper-left of the screen. */
export function drawBuildings(
  ctx: CanvasRenderingContext2D,
  map: TileMap,
  camX: number,
  camY: number,
  canvasW: number,
  canvasH: number,
): void {
  const minTX = Math.floor(camX / TILE) - 1;
  const maxTX = Math.ceil((camX + canvasW) / TILE) + 1;
  const minTY = Math.floor(camY / TILE) - 1;
  const maxTY = Math.ceil((camY + canvasH) / TILE) + 1;

  for (let ty = minTY; ty <= maxTY; ty++) {
    for (let tx = minTX; tx <= maxTX; tx++) {
      const cls = classifyTile(map, tx, ty);
      if (cls !== TILE_BUILDING) continue;
      const b = getBldg(tx, ty);
      const wx = tx * TILE;
      const wy = ty * TILE;
      ctx.fillStyle = b.pal[0];
      ctx.fillRect(wx, wy, TILE, TILE);
      // Subtle 1-px highlight at the top edge of each tile for a
      // pseudo-depth read at GBC scale.
      ctx.fillStyle = b.pal[2];
      ctx.fillRect(wx, wy, TILE, 1);
      // Roof accent on the top row of each 4-tile block.
      if (b.hasRoof && (ty & 3) === 0) {
        ctx.fillStyle = b.roofColor;
        ctx.fillRect(wx, wy, TILE, 2);
      }
    }
  }
}
