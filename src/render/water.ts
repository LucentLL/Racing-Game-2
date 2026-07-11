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

      // H1120: ToonWater rework (user-provided Unity ToonWater reference:
      // one flat bright cartoon blue + sparse drifting WHITE sparkles and
      // gull-wing foam marks — no gradients, no dark navy dither). The
      // old GBC scanline ripples read as murky next to the lush meadow.
      ctx.fillStyle = alt ? '#2e78be' : '#2c74b8';
      ctx.fillRect(wx, wy, TILE, TILE);

      const wSeed = (tx * 7 + ty * 11) & 15;
      // Sparkles: 2 seeded flecks per tile, each visible only during its
      // own window of the 16-step cycle so the surface twinkles as the
      // window drifts (same clock the old ripples used).
      for (let sp = 0; sp < 2; sp++) {
        const phase = (wSeed + sp * 7 + wFrame) & 15;
        if (phase < 5) {
          const sx = (wSeed * 5 + sp * 9 + ((wFrame >> 3) & 3)) % (TILE - 2);
          const sy = (wSeed * 3 + sp * 13) % (TILE - 1);
          ctx.fillStyle = phase < 2 ? '#e8f4ff' : '#8ec4ea';
          ctx.fillRect(wx + sx, wy + sy, phase < 2 ? 2 : 1, 1);
        }
      }
      // Gull-wing foam mark on ~1 in 5 tiles — two angled 2px dashes,
      // fading in/out on the same cycle.
      if (wSeed % 5 === 0 && ((wFrame >> 2) & 3) !== 0) {
        const fx = wx + 4 + (wSeed & 7);
        const fy = wy + 5 + ((wSeed * 3) & 7);
        ctx.fillStyle = '#d8ecfa';
        ctx.fillRect(fx, fy, 2, 1);
        ctx.fillRect(fx + 3, fy + 1, 2, 1);
      }
    }
  }
  ctx.imageSmoothingEnabled = smPrev;
}
