/**
 * Water tile pass — paints tile=9 cells with the GBC pixel-art water
 * visual the monolith ships (base dither + 3 scrolling scanline ripples).
 *
 * Mirrors the tile=9 branch from `render/ground.ts` so editor-drawn
 * rivers / lakes (stamped as tile=9 in `world/buildBaselineMap` after
 * the H746 editor-overlay-water fix) show up in the game world.
 * Parallels `drawGrass` / `drawBuildings` — tile-pass module, cull-radius
 * driven, no allocations per frame.
 *
 * Placed in the render order BEFORE the road overlay so a road crossing
 * a river covers the water at the crossing footprint (the soft water
 * stamp already preserves road tiles, but the per-pixel paint order
 * still matters at tile boundaries).
 */

import { TILE } from '@/config/world/tiles';
import { getTile, type TileMap } from '@/world/tileMap';

const TILE_WATER = 9;

export function drawWater(
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

  // Per-frame ripple phase. 220 ms per step matches the ground.ts pass.
  const wFrame = Math.floor(Date.now() / 220);

  const smPrev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  for (let ty = minTY; ty <= maxTY; ty++) {
    for (let tx = minTX; tx <= maxTX; tx++) {
      if (getTile(map, tx, ty) !== TILE_WATER) continue;
      const wx = tx * TILE;
      const wy = ty * TILE;
      const alt = ((tx + ty) % 2 === 0) ? 0 : 1;

      ctx.fillStyle = alt ? '#143858' : '#0a2038';
      ctx.fillRect(wx, wy, TILE, TILE);

      const wSeed = (tx * 7 + ty * 11) & 7;
      for (let wr = 0; wr < 3; wr++) {
        const wy2 = wy + ((wSeed + wr * 5 + wFrame) % TILE);
        ctx.fillStyle = (wr === 1) ? '#4088c8' : '#2058a0';
        for (let wxp = 0; wxp < TILE; wxp += 3) {
          if (((wxp + wFrame + wSeed) & 3) !== 0) {
            ctx.fillRect(wx + wxp, wy2, 2, 1);
          }
        }
      }
    }
  }
  ctx.imageSmoothingEnabled = smPrev;
}
