/**
 * H46 — PSX-tier grass variants.
 *
 * The non-city portion of the map (everything outside I-277 + downtown
 * roads) used to render as a single flat #1a2818 fill. The monolith
 * pre-bakes 8 TILE×TILE canvases for grass — standard / dry / lush /
 * dirt / clay / rocks / flowers / tall — and picks one per tile via a
 * deterministic hash so the off-road area has visible variety without
 * runtime cost.
 *
 * Port of monolith _buildGrassVariantCanvases / _paintGrassVariant
 * L2867-2986 in simplified form.
 *
 * Variant distribution (hash & 0xF, 16 buckets):
 *   0..3   (25%) — V0: standard grass
 *   4..6   (19%) — V1: dry grass (yellow-green, straw flecks)
 *   7..10  (25%) — V2: lush grass (deeper green, fresh-leaf hilites)
 *   11     ( 6%) — V3: dirt patch
 *   12     ( 6%) — V4: clay patch (Carolina red clay, NC-correct)
 *   13     ( 6%) — V5: rock cluster
 *   14     ( 6%) — V6: small flowers
 *   15     ( 6%) — V7: tall grass clump
 *
 * Memory budget: 8 × 18² × 4 bytes ≈ 5 KB. Trivial.
 *
 * Deferred:
 *   - Bush overlay (monolith's (wtx + wty*3) % 5 === 0 additive layer
 *     on top of the variant) — separate render pass
 *   - Forest tile (tile=11) with multiple trees per cell — H41's
 *     classifier doesn't emit forest yet
 *   - Per-region grass tinting (suburb vs rural)
 */

import { TILE } from '@/config/world/tiles';
import type { TileMap } from '@/world/tileMap';
import { classifyTile, TILE_GRASS_RESOLVED } from '@/world/buildings';

/** H1114: wind-sway phase count. The cycle is [0, +1, 0, -1] px — the
 *  classic 3-frame plant sway (neutral shared by phases 0 and 2, so only
 *  3 distinct canvases bake per variant). Inspired by the Dynamic 2D
 *  Grass Godot plugin's "stepped framerate animation with per-blade
 *  phase offset": animation happens by SELECTING a pre-baked frame per
 *  tile, never by per-frame repainting — per-tile cost stays exactly one
 *  drawImage, identical to the static path. */
const WIND_PHASES = 4;
/** Sway px per phase index (0..3). */
const PHASE_SWAY: readonly number[] = [0, 1, 0, -1];
/** Wind pacing: phase-steps per second. ~1.3 = a calm 3-frame plant
 *  cycle every ~3 s, matching the plugin's default gentle breeze rather
 *  than a flicker. */
const WIND_STEP_HZ = 1.3;

/** H1115: [tint][sway+1][v] canvases. tint ∈ 0 shaded / 1 base / 2 sunny
 *  — the plugin's "noise-based colour patches": large soft meadow regions
 *  share a tint, picked per tile from a static low-frequency wave field
 *  in drawGrass. sway ∈ -1/0/+1 (H1114 wind lean). 3×3×8 = 72 tiny
 *  canvases ≈ 90 KB, baked once at first paint. */
let variantCache: HTMLCanvasElement[][][] | null = null;
/** Bush overlay canvases by sway+1 (H63 cross-plus, crown sways). */
let bushCache: HTMLCanvasElement[] | null = null;

/** H1115: shift a #rrggbb toward shade (tint 0) or sun (tint 2) at bake
 *  time. Shade cools (drops red, keeps blue); sun warms (lifts red+green,
 *  drops blue) — the classic meadow-patch read without hand-authoring
 *  three palettes per family. */
function tintColor(hex: string, tint: number): string {
  if (tint === 1) return hex;
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
  if (tint === 0) { r *= 0.72; g *= 0.84; b *= 0.94; }
  else { r *= 1.24; g *= 1.14; b *= 0.92; }
  const c = (x: number): string => Math.max(0, Math.min(232, Math.round(x))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Per-family base ramps (tint 1). Slots: bg / mottle / shadow blob /
 *  clump base / clump leaf / clump lit tip. DRY reads straw-warm, LUSH
 *  deep and cool; everything else uses GRASS. */
const FAMILY_RAMPS: Readonly<Record<string, readonly string[]>> = {
  grass: ['#1a2c12', '#20351a', '#11200c', '#27431a', '#315423', '#416b2c'],
  // Dry ground stays near the grass value (a bright ground plane made the
  // variant grid read as columns); the straw comes from clumps + flecks.
  dry:   ['#1e2e13', '#25371a', '#141f0d', '#3d4a1e', '#4d5824', '#666e2e'],
  lush:  ['#13260f', '#182f14', '#0b1a08', '#1f4016', '#28531d', '#356a26'],
};

/** H1115: PSX clump-grass painter — the look the user picked from the
 *  Dynamic 2D Grass demo, translated to 18px: an organic mottled base
 *  (the old GBC 2×2 checker is retired) covered in small 3-tip LEAF
 *  CLUMPS (the plugin's leaves.png is exactly such ~18px grayscale
 *  clumps, tinted by world-space noise — our tint param is that noise,
 *  applied at bake). Clump tips lean with the wind (sway); ground
 *  features (dirt, clay, rocks) never move.
 *
 *  RNG CALL ORDER is identical for every (sway, tint) so all phases of
 *  a variant draw the same features at the same rolled positions. */
function paintGrassVariant(cx: CanvasRenderingContext2D, v: number, sway = 0, tint = 1): void {
  let s = ((v + 1) * 0x9e3779b1) | 0;
  const r = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    return (s >>> 0) / 4294967296;
  };
  const T = TILE;
  const fam = v === 1 ? 'dry' : v === 2 ? 'lush' : 'grass';
  const ramp = FAMILY_RAMPS[fam].map((c) => tintColor(c, tint));
  const [bg, mott, shade, leafD, leafM, leafT] = ramp;

  // Organic base: flat fill + irregular mottling + shadow blobs.
  cx.fillStyle = bg;
  cx.fillRect(0, 0, T, T);
  cx.fillStyle = mott;
  for (let i = 0; i < 9; i++) {
    const mx = Math.floor(r() * (T - 2));
    const my = Math.floor(r() * (T - 1));
    cx.fillRect(mx, my, r() < 0.5 ? 2 : 1, r() < 0.4 ? 2 : 1);
  }
  cx.fillStyle = shade;
  for (let i = 0; i < 5; i++) {
    const sx2 = Math.floor(r() * (T - 3));
    const sy2 = Math.floor(r() * (T - 2));
    cx.fillRect(sx2, sy2, r() < 0.5 ? 3 : 2, r() < 0.5 ? 1 : 2);
  }

  // Leaf clumps — a 3-tip sprig: rooted base row + two side leaves + a
  // taller center tip. Tips take the sway; the base row never moves.
  const clump = (x: number, y: number, tall: boolean): void => {
    cx.fillStyle = leafD;
    cx.fillRect(x - 1, y + 1, 3, 1);
    cx.fillStyle = leafM;
    cx.fillRect(x - 1 + sway, y, 1, 1);
    cx.fillRect(x + 1 + sway, y, 1, 1);
    cx.fillStyle = leafT;
    if (tall) {
      cx.fillRect(x, y, 1, 1);              // stem joint (rooted)
      cx.fillRect(x + sway, y - 1, 1, 1);   // high tip
      cx.fillRect(x + sway * 2, y - 2, 1, 1); // tall variants bend harder
    } else {
      cx.fillRect(x + sway, y - 1, 1, 1);
    }
  };
  const CLUMPS: Readonly<Record<number, number>> = { 0: 4, 1: 4, 2: 5, 3: 2, 4: 2, 5: 3, 6: 4, 7: 6 };
  const nClumps = CLUMPS[v] ?? 4;
  const tall = v === 7;
  const clumpPos: Array<[number, number]> = [];
  for (let i = 0; i < nClumps; i++) {
    clumpPos.push([2 + Math.floor(r() * (T - 5)), 3 + Math.floor(r() * (T - 6))]);
  }
  // Ground features paint UNDER the clumps, but the RNG rolls above stay
  // order-stable, so roll positions first, features next, clumps last.

  if (v === 1) {
    // Dry: straw flecks between clumps (sway — they're standing stalks).
    cx.fillStyle = tintColor('#767434', tint);
    for (let i = 0; i < 3; i++) {
      cx.fillRect(Math.floor(r() * (T - 2)) + 1 + sway, Math.floor(r() * (T - 2)) + 1, 1, 1);
    }
  } else if (v === 3) {
    // Dirt patch — worn earth, greener-edged than the old version so it
    // reads as meadow wear, not stray asphalt.
    cx.fillStyle = tintColor('#33291a', tint);
    cx.fillRect(4, 6, 10, 6);
    cx.fillStyle = tintColor('#41341f', tint);
    cx.fillRect(5, 7, 8, 4);
    cx.fillStyle = tintColor('#241c10', tint);
    cx.fillRect(4, 11, 1, 1);
    cx.fillRect(13, 6, 1, 1);
  } else if (v === 4) {
    // Carolina red clay — kept, slightly softened.
    cx.fillStyle = tintColor('#41231a', tint);
    cx.fillRect(5, 5, 8, 7);
    cx.fillStyle = tintColor('#5d3122', tint);
    cx.fillRect(6, 6, 6, 5);
    cx.fillStyle = tintColor('#6d3f2a', tint);
    cx.fillRect(8, 7, 2, 2);
  } else if (v === 5) {
    // Rock cluster — lit top face + grounded dark underside.
    const rocks: ReadonlyArray<readonly [number, number, number, number]> = [
      [5, 7, 3, 2], [10, 5, 2, 2], [11, 11, 3, 2],
    ];
    for (const [kx, ky, kw, kh] of rocks) {
      cx.fillStyle = '#20241e';
      cx.fillRect(kx, ky + kh - 1, kw, 1);
      cx.fillStyle = tintColor('#3a3d38', tint);
      cx.fillRect(kx, ky, kw, kh - 1);
      cx.fillStyle = tintColor('#565a52', tint);
      cx.fillRect(kx, ky, kw - 1, 1);
    }
  }

  for (const [cxp, cyp] of clumpPos) clump(cxp, cyp, tall);

  if (v === 6) {
    // Flowers — 2×2 blooms on rooted stems, big enough to actually SEE
    // (the old 1px blooms were invisible at play zoom; user asked for
    // flowers like the plugin demo's).
    const BLOOMS = ['#d8d8d0', '#d06a78', '#d8c04a', '#9a6fc8'];
    for (let i = 0; i < 3; i++) {
      const fx = 3 + Math.floor(r() * (T - 7));
      const fy = 4 + Math.floor(r() * (T - 8));
      const c = BLOOMS[Math.floor(r() * BLOOMS.length)];
      cx.fillStyle = leafD;
      cx.fillRect(fx + 1, fy + 2, 1, 1);            // stem (rooted)
      cx.fillStyle = c;
      cx.fillRect(fx + sway, fy, 2, 2);             // bloom head (sways)
      cx.fillStyle = tintColor('#8a8430', tint);
      cx.fillRect(fx + sway, fy + 1, 1, 1);         // center dot
    }
  }
}

function ensureVariants(): HTMLCanvasElement[][][] {
  if (variantCache) return variantCache;
  const out: HTMLCanvasElement[][][] = [];
  for (let tint = 0; tint < 3; tint++) {
    const tintRow: HTMLCanvasElement[][] = [];
    for (let sway = -1; sway <= 1; sway++) {
      const row: HTMLCanvasElement[] = [];
      for (let v = 0; v < 8; v++) {
        const c = document.createElement('canvas');
        c.width = TILE;
        c.height = TILE;
        const cx = c.getContext('2d');
        if (!cx) continue;
        cx.imageSmoothingEnabled = false;
        paintGrassVariant(cx, v, sway, tint);
        row.push(c);
      }
      tintRow.push(row);
    }
    out.push(tintRow);
  }
  variantCache = out;
  return out;
}

/** H1114: bake the H63 bush overlay (cross-plus + hilite) per sway into
 *  a 6×6 canvas (art at +1 so a ±1 lean stays inside). Replaces the
 *  three per-tile fillRects with one drawImage — a wash-or-better on
 *  draw cost, and it lets the bush crown lean with the wind while its
 *  base row stays rooted. */
function ensureBushes(): HTMLCanvasElement[] {
  if (bushCache) return bushCache;
  const out: HTMLCanvasElement[] = [];
  for (let sway = -1; sway <= 1; sway++) {
    const c = document.createElement('canvas');
    c.width = 6;
    c.height = 6;
    const cx = c.getContext('2d');
    if (!cx) { out.push(c); continue; }
    cx.imageSmoothingEnabled = false;
    // Art origin (1,1); shapes mirror the pre-H1114 inline rects.
    // Crown (top row of the vertical bar + hilite) leans; the rest roots.
    cx.fillStyle = '#0a3a0a';
    cx.fillRect(1, 2, 4, 2);            // horizontal bar
    cx.fillRect(2, 2, 2, 3);            // vertical bar, rooted part
    cx.fillRect(2 + sway, 1, 2, 1);     // vertical bar, crown row — leans
    cx.fillStyle = '#1a5a1a';
    cx.fillRect(2, 2, 1, 1);            // hilite sits in the rooted row
    out.push(c);
  }
  bushCache = out;
  return out;
}

/** Distribute the 16-bucket hash → variants. H1115: dirt (11) and clay
 *  (12) are OUT of the meadow rotation — the plugin-demo look the user
 *  picked is unbroken grass, and the earthy squares read as litter at
 *  1-in-8 tiles (same "random asphalt" complaint as the old ground
 *  pass). The v3/v4 art stays baked for future use (trails, lots).
 *  Now: 31% standard, 19% dry, 31% lush, 6% each rocks/flowers/tall. */
function variantForHash(hash: number): number {
  const b = hash & 0xf;
  if (b <= 3) return 0;  // standard
  if (b <= 6) return 1;  // dry
  if (b <= 10) return 2; // lush
  if (b === 11) return 0;
  if (b === 12) return 2;
  return b - 8;          // 13→5 rocks, 14→6 flowers, 15→7 tall
}

/** Paints grass tiles in the visible tile range. centerX/Y is the
 *  player world position, radius the half-side of the cull square.
 *  H63 adds a bush overlay (cross-plus shape) on tiles where
 *  (tx + ty*3) % 5 === 0 — same conditional as monolith L30295. */
export function drawGrass(
  ctx: CanvasRenderingContext2D,
  map: TileMap,
  centerX: number,
  centerY: number,
  radius: number,
): void {
  const variants = ensureVariants();
  const bushes = ensureBushes();
  if (variants.length === 0) return;
  const minTX = Math.floor((centerX - radius) / TILE) - 1;
  const maxTX = Math.ceil((centerX + radius) / TILE) + 1;
  const minTY = Math.floor((centerY - radius) / TILE) - 1;
  const maxTY = Math.ceil((centerY + radius) / TILE) + 1;

  // H1114: wind clock + gust field. Per-tile phase = a global step clock
  // + per-tile hash jitter (the plugin's "per-blade phase offset" — tiles
  // cross the step boundary on different frames, no field-wide snap) + a
  // slow traveling gust built from two mismatched sine waves (the cheap
  // cousin of the plugin's dual mismatched-scale noise product; the
  // mismatch keeps gust patches organic instead of a marching diagonal).
  // Phase indexes pre-baked sway canvases — the per-tile draw stays ONE
  // drawImage, identical to the static path.
  const tSec = Date.now() * 0.001;
  const stepClock = tSec * WIND_STEP_HZ;
  const gustA = 0.9, gustB = 0.35; // rad/s — both well under one step/s
  // Wave B is ty-independent — precompute per COLUMN so the inner loop
  // pays one sin per tile, not two (~2900 tiles in view).
  const waveB: number[] = [];
  for (let tx = minTX; tx <= maxTX; tx++) {
    waveB[tx - minTX] = Math.sin(tx * 0.041 - tSec * gustB);
  }

  // Pixel art — disable smoothing so the 1px features stay crisp.
  const smPrev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  for (let ty = minTY; ty <= maxTY; ty++) {
    for (let tx = minTX; tx <= maxTX; tx++) {
      const cls = classifyTile(map, tx, ty);
      if (cls !== TILE_GRASS_RESOLVED) continue;
      const wx = tx * TILE;
      const wy = ty * TILE;
      // H1115: avalanche-mixed hash. The old (tx*K)^(ty*K2) product left
      // low-bit column patterns that were invisible on near-flat GBC art
      // but showed as vertical variant stripes once tile contrast rose.
      // Same finalizer as ground.ts's H46 grass pick.
      let hash = ((tx | 0) * 73856093) ^ ((ty | 0) * 19349663);
      hash = (hash ^ (hash >>> 13)) | 0;
      hash = Math.imul(hash, 1274126177) | 0;
      hash = (hash ^ (hash >>> 16)) >>> 0;
      const v = variantForHash(hash);
      const gust = Math.sin(tx * 0.13 + ty * 0.07 - tSec * gustA)
        + waveB[tx - minTX];
      const jitter = ((hash >>> 8) & 0xf) / 16;
      const phase = Math.floor(stepClock + jitter + gust) & (WIND_PHASES - 1);
      const swayIdx = PHASE_SWAY[phase] + 1;
      // H1115: static meadow tint patches — two mismatched waves (NO time
      // term; the meadow doesn't crawl) banded into shade/base/sun. The
      // plugin's albedo2 noise patches, wave-cheap.
      const meadow = Math.sin(tx * 0.19 + ty * 0.12) + Math.sin(tx * 0.052 - ty * 0.083);
      const tint = meadow > 0.75 ? 2 : meadow < -0.75 ? 0 : 1;
      ctx.drawImage(variants[tint][swayIdx][v], wx, wy);
      // Bush overlay — independent hash from the variant so bushes
      // can land on any variant (a bush on a rock cluster reads as
      // natural undergrowth). H1114: pre-baked per-sway canvas (art
      // origin is inset 1px, hence the -1s).
      if ((tx + ty * 3) % 5 === 0) {
        ctx.drawImage(bushes[swayIdx], wx + TILE / 2 - 3, wy + TILE / 2 - 3);
      }
    }
  }
  ctx.imageSmoothingEnabled = smPrev;
}
