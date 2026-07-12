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
import { sunAt } from '@/render/cloudShadows';

const TILE_WATER = 9;

export function drawWater(
  ctx: CanvasRenderingContext2D,
  map: TileMap,
  centerX: number,
  centerY: number,
  radius: number,
  /** H1134: sun-glitter inputs — tiles in a cloud GAP get extra warm
   *  sparkle (sun glitter on the surface); tiles under a cloud keep
   *  only the base twinkle. Null/omitted (editor previews, cloud
   *  system killed) = pre-H1134 look. */
  sunLight: { tMs: number; night: number } | null = null,
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

      const landL = getTile(map, tx - 1, ty) !== TILE_WATER;
      const landR = getTile(map, tx + 1, ty) !== TILE_WATER;
      const landU = getTile(map, tx, ty - 1) !== TILE_WATER;
      const landD = getTile(map, tx, ty + 1) !== TILE_WATER;

      // H1120: ToonWater rework (user-provided Unity ToonWater reference:
      // one flat bright cartoon blue + sparse drifting WHITE sparkles and
      // gull-wing foam marks — no gradients, no dark navy dither).
      // H1121: ONE flat blue — even the subtle parity checker read as a
      // tile grid at play zoom (user screenshot).
      // H1139: base fill OVERSPILLS 1px onto water neighbours to the
      // right/below (they repaint it, row-major) — per-tile fillRects
      // under the rotated/zoomed camera left AA hairline gaps that read
      // as GRID LINES across every lake (user screenshot). Land-adjacent
      // edges stay exact so the shoreline doesn't fatten.
      ctx.fillStyle = '#2c74b8';
      ctx.fillRect(wx, wy, TILE + (landR ? 0 : 1), TILE + (landD ? 0 : 1));

      // H1121: SHORELINE blending — the water/land boundary was a hard
      // tile staircase. Any edge touching land gets a pale foam line plus
      // seeded green "bites" that let the meadow eat into the water
      // corner, so the coast reads organic instead of square.
      if (landL || landR || landU || landD) {
        const eSeed = ((tx * 73856093) ^ (ty * 19349663)) >>> 0;
        const foam = '#bfe0f2';
        const shoreGrass = '#3d611f';
        const bite = (ex: number, ey: number, horiz: boolean, k: number): void => {
          const o = (eSeed >> (k * 3)) & 7;
          if (horiz) {
            ctx.fillStyle = shoreGrass;
            ctx.fillRect(ex + 1 + o, ey, 4 + (o & 3), 2);
            ctx.fillRect(ex + 9 + (o & 3), ey, 3, 1);
          } else {
            ctx.fillStyle = shoreGrass;
            ctx.fillRect(ex, ey + 1 + o, 2, 4 + (o & 3));
            ctx.fillRect(ex, ey + 9 + (o & 3), 1, 3);
          }
        };
        ctx.fillStyle = foam;
        if (landU) { ctx.fillRect(wx, wy, TILE, 1); bite(wx, wy, true, 0); ctx.fillStyle = foam; ctx.fillRect(wx + ((eSeed >> 2) & 7), wy + 2, 3, 1); }
        if (landD) { ctx.fillRect(wx, wy + TILE - 1, TILE, 1); bite(wx, wy + TILE - 2, true, 1); ctx.fillStyle = foam; ctx.fillRect(wx + ((eSeed >> 5) & 7), wy + TILE - 4, 3, 1); }
        if (landL) { ctx.fillRect(wx, wy, 1, TILE); bite(wx, wy, false, 2); ctx.fillStyle = foam; ctx.fillRect(wx + 2, wy + ((eSeed >> 8) & 7), 1, 3); }
        if (landR) { ctx.fillRect(wx + TILE - 1, wy, 1, TILE); bite(wx + TILE - 2, wy, false, 3); ctx.fillStyle = foam; ctx.fillRect(wx + TILE - 4, wy + ((eSeed >> 11) & 7), 1, 3); }
      }

      const wSeed = (tx * 7 + ty * 11) & 15;
      // Sparkles: 2 seeded flecks per tile, each visible only during its
      // own window of the 16-step cycle so the surface twinkles as the
      // window drifts. H1139: positions now TRAVEL along the cloud-wind
      // vector (2,1 — the H1116 drift diagonal) instead of wobbling in
      // place, so the surface visibly flows the way the wind blows
      // (user: "the water white marks would move the direction of wind").
      for (let sp = 0; sp < 2; sp++) {
        const phase = (wSeed + sp * 7 + wFrame) & 15;
        if (phase < 5) {
          const sx = (wSeed * 5 + sp * 9 + wFrame * 2) % (TILE - 2);
          const sy = (wSeed * 3 + sp * 13 + wFrame) % (TILE - 1);
          ctx.fillStyle = phase < 2 ? '#e8f4ff' : '#8ec4ea';
          ctx.fillRect(wx + sx, wy + sy, phase < 2 ? 2 : 1, 1);
        }
      }
      // Gull-wing foam mark on ~1 in 5 tiles — two angled 2px dashes,
      // fading in/out on the same cycle. H1139: they ride the wind too.
      if (wSeed % 5 === 0 && ((wFrame >> 2) & 3) !== 0) {
        const fx = wx + (4 + (wSeed & 7) + ((wFrame >> 1) * 2) % (TILE - 6)) % (TILE - 5);
        const fy = wy + (5 + ((wSeed * 3) & 7) + (wFrame >> 1) % (TILE - 6)) % (TILE - 5);
        ctx.fillStyle = '#d8ecfa';
        ctx.fillRect(fx, fy, 2, 1);
        ctx.fillRect(fx + 3, fy + 1, 2, 1);
      }
      // H1134: SUN GLITTER — where daylight breaks through the cloud
      // gap over this tile, the surface throws hard warm glints: up to
      // 3 extra flecks (one gold, two white) twinkling on a faster
      // window than the base sparkle. Under a cloud (or at night)
      // sun≈0 and the water goes back to the muted base twinkle —
      // the same "catch the sunrays" behavior the cars got in H1133.
      if (sunLight) {
        const sun = sunAt(wx + TILE / 2, wy + TILE / 2, sunLight.tMs, sunLight.night);
        if (sun > 0.25) {
          const gN = sun > 0.75 ? 3 : sun > 0.45 ? 2 : 1;
          for (let gi = 0; gi < gN; gi++) {
            const gPhase = (wSeed * 3 + gi * 5 + wFrame) & 7;
            if (gPhase < 3) {
              // H1139: glitter rides the wind vector like the sparkles.
              const gx = (wSeed * 7 + gi * 11 + wFrame * 2) % (TILE - 2);
              const gy = (wSeed * 5 + gi * 3 + wFrame) % (TILE - 1);
              ctx.fillStyle = gi === 0 ? '#fff3c0' : '#ffffff';
              ctx.fillRect(wx + gx, wy + gy, gPhase === 0 ? 2 : 1, 1);
            }
          }
        }
      }
    }
  }
  ctx.imageSmoothingEnabled = smPrev;
}
