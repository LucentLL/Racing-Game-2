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

let variantCache: HTMLCanvasElement[] | null = null;

function paintGrassVariant(cx: CanvasRenderingContext2D, v: number): void {
  // Deterministic seeded RNG so each variant is identical every build.
  let s = ((v + 1) * 0x9e3779b1) | 0;
  const r = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    return (s >>> 0) / 4294967296;
  };
  const T = TILE;
  const baseA = v === 1 ? '#28401f' : v === 2 ? '#142e16' : '#1e321e';
  const baseB = v === 1 ? '#1f311a' : v === 2 ? '#0e2410' : '#162a16';

  // 2×2 alt-checker base — preserves the GBC grass character.
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      cx.fillStyle = ((x + y) & 1) ? baseA : baseB;
      cx.fillRect(x, y, 1, 1);
    }
  }

  // Dither speckles (4 hilite + 3 shadow).
  const hi = v === 1 ? '#324a26' : v === 2 ? '#1e4220' : '#26402a';
  const lo = v === 1 ? '#142a14' : v === 2 ? '#061608' : '#0e200e';
  cx.fillStyle = hi;
  for (let i = 0; i < 4; i++) cx.fillRect(Math.floor(r() * T), Math.floor(r() * T), 1, 1);
  cx.fillStyle = lo;
  for (let i = 0; i < 3; i++) cx.fillRect(Math.floor(r() * T), Math.floor(r() * T), 1, 1);

  // Variant-specific decorations.
  if (v === 1) {
    cx.fillStyle = '#5a5a20';
    cx.fillRect(Math.floor(r() * T), Math.floor(r() * T), 1, 1);
    cx.fillRect(Math.floor(r() * T), Math.floor(r() * T), 1, 1);
  } else if (v === 2) {
    cx.fillStyle = '#2a5a2a';
    cx.fillRect(Math.floor(r() * T), Math.floor(r() * T), 1, 1);
    cx.fillRect(Math.floor(r() * T), Math.floor(r() * T), 1, 1);
  } else if (v === 3) {
    // Dirt patch — earthen blob with gravel speck.
    const dx = 4;
    const dy = 6;
    cx.fillStyle = '#3a2a18';
    cx.fillRect(dx, dy, 10, 6);
    cx.fillStyle = '#4a3520';
    cx.fillRect(dx + 1, dy + 1, 8, 4);
    cx.fillStyle = '#2a1f10';
    cx.fillRect(dx, dy + 5, 1, 1);
    cx.fillRect(dx + 9, dy, 1, 1);
    cx.fillStyle = '#5a4838';
    cx.fillRect(dx + 3, dy + 2, 1, 1);
    cx.fillRect(dx + 6, dy + 3, 1, 1);
  } else if (v === 4) {
    // Clay patch — Carolina red clay.
    const dx = 5;
    const dy = 5;
    cx.fillStyle = '#4a2818';
    cx.fillRect(dx, dy, 8, 7);
    cx.fillStyle = '#6a3825';
    cx.fillRect(dx + 1, dy + 1, 6, 5);
    cx.fillStyle = '#3a1f12';
    cx.fillRect(dx, dy + 6, 1, 1);
    cx.fillRect(dx + 7, dy, 1, 1);
    cx.fillStyle = '#7a4530';
    cx.fillRect(dx + 3, dy + 2, 1, 1);
    cx.fillRect(dx + 4, dy + 3, 1, 1);
  } else if (v === 5) {
    // Rock cluster — 4 small gray rocks scattered.
    const rocks: readonly { x: number; y: number; w: number; h: number }[] = [
      { x: 5, y: 7, w: 3, h: 2 },
      { x: 9, y: 5, w: 2, h: 2 },
      { x: 11, y: 10, w: 3, h: 2 },
      { x: 6, y: 11, w: 2, h: 1 },
    ];
    for (const k of rocks) {
      cx.fillStyle = '#3a3a3a';
      cx.fillRect(k.x, k.y, k.w, k.h);
      cx.fillStyle = '#5a5a5a';
      cx.fillRect(k.x, k.y, Math.max(1, k.w - 1), 1);
    }
  } else if (v === 6) {
    // Small flowers — 5 single-pixel blooms with green stems.
    const flowers: readonly { x: number; y: number; c: string }[] = [
      { x: 4, y: 5, c: '#d04040' },
      { x: 8, y: 9, c: '#e8d040' },
      { x: 13, y: 6, c: '#f0f0f0' },
      { x: 6, y: 13, c: '#a06fc8' },
      { x: 11, y: 12, c: '#e8d040' },
    ];
    for (const f of flowers) {
      cx.fillStyle = '#2a4a26';
      cx.fillRect(f.x, f.y + 1, 1, 1);
      cx.fillStyle = f.c;
      cx.fillRect(f.x, f.y, 1, 1);
    }
  } else if (v === 7) {
    // Tall grass clump — 8 vertical 1×2 blades.
    const blades: readonly { x: number; y: number }[] = [
      { x: 5,  y: 6  }, { x: 7,  y: 7  }, { x: 9,  y: 5  },
      { x: 10, y: 8  }, { x: 12, y: 6  }, { x: 6,  y: 10 },
      { x: 11, y: 11 }, { x: 8,  y: 12 },
    ];
    for (const b of blades) {
      cx.fillStyle = '#3a5a32';
      cx.fillRect(b.x, b.y, 1, 2);
      cx.fillStyle = '#4a7042';
      cx.fillRect(b.x, b.y, 1, 1);
    }
  }
}

function ensureVariants(): HTMLCanvasElement[] {
  if (variantCache) return variantCache;
  const out: HTMLCanvasElement[] = [];
  for (let v = 0; v < 8; v++) {
    const c = document.createElement('canvas');
    c.width = TILE;
    c.height = TILE;
    const cx = c.getContext('2d');
    if (!cx) continue;
    cx.imageSmoothingEnabled = false;
    paintGrassVariant(cx, v);
    out.push(c);
  }
  variantCache = out;
  return out;
}

/** Distribute the 16-bucket hash → 8 variants per the monolith's
 *  density curve (25% standard, 19% dry, 25% lush, 6% each of the 5
 *  decoration variants). */
function variantForHash(hash: number): number {
  const b = hash & 0xf;
  if (b <= 3) return 0;  // standard
  if (b <= 6) return 1;  // dry
  if (b <= 10) return 2; // lush
  return b - 8;          // 11→3, 12→4, 13→5, 14→6, 15→7
}

/** Paints grass tiles in the visible tile range. centerX/Y is the
 *  player world position, radius the half-side of the cull square.
 *  H63 adds a bush overlay (cross-plus shape) on tiles where
 *  (tx + ty*3) % 5 === 0 — same conditional as monolith L30295.
 *  H69 adds a rarer tree overlay (8×8 with trunk + canopy + drop
 *  shadow) at (tx*7 + ty*11) % 23 === 0 — ~4% of grass tiles. A
 *  different prime-pair hash than the bush slot so the two overlap
 *  predictably (rare; tree canopy occludes any bush underneath). */
export function drawGrass(
  ctx: CanvasRenderingContext2D,
  map: TileMap,
  centerX: number,
  centerY: number,
  radius: number,
): void {
  const variants = ensureVariants();
  if (variants.length === 0) return;
  const minTX = Math.floor((centerX - radius) / TILE) - 1;
  const maxTX = Math.ceil((centerX + radius) / TILE) + 1;
  const minTY = Math.floor((centerY - radius) / TILE) - 1;
  const maxTY = Math.ceil((centerY + radius) / TILE) + 1;

  // Pixel art — disable smoothing so the 1px features stay crisp.
  const smPrev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  for (let ty = minTY; ty <= maxTY; ty++) {
    for (let tx = minTX; tx <= maxTX; tx++) {
      const cls = classifyTile(map, tx, ty);
      if (cls !== TILE_GRASS_RESOLVED) continue;
      const wx = tx * TILE;
      const wy = ty * TILE;
      const hash = (tx * 0x1f1f1f1f) ^ (ty * 0x12345678);
      const v = variantForHash(hash);
      ctx.drawImage(variants[v], wx, wy);
      // Bush overlay — independent hash from the variant so bushes
      // can land on any variant (a bush on a rock cluster reads as
      // natural undergrowth).
      if ((tx + ty * 3) % 5 === 0) {
        const bx = wx + TILE / 2 - 2;
        const by = wy + TILE / 2 - 2;
        ctx.fillStyle = '#0a3a0a';
        // Cross-plus shape: horizontal bar + vertical bar.
        ctx.fillRect(bx,     by + 1, 4, 2);
        ctx.fillRect(bx + 1, by,     2, 4);
        // Single hilite pixel for shape definition.
        ctx.fillStyle = '#1a5a1a';
        ctx.fillRect(bx + 1, by + 1, 1, 1);
      }
      // H69 tree overlay — bigger than bushes, rarer. Drop shadow
      // first (offset down-right so the light reads as top-left
      // overhead — matches H47 sidewalk curb-edge convention), then
      // trunk, then canopy + hilite.
      if ((tx * 7 + ty * 11) % 23 === 0) {
        const tcx = wx + TILE / 2;
        const tcy = wy + TILE / 2;
        // Shadow — 8×3 dark ellipse offset to lower-right of trunk.
        ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
        ctx.fillRect(tcx - 3, tcy + 3, 8, 2);
        ctx.fillRect(tcx - 2, tcy + 5, 6, 1);
        // Trunk — 2×3 dark brown center-bottom.
        ctx.fillStyle = '#3a2010';
        ctx.fillRect(tcx - 1, tcy + 1, 2, 3);
        // Canopy — rounded 7×6 dark green cluster, painted as 3
        // row groups so corners stay clipped without needing
        // clearRect (which would punch through to the solid bg fill,
        // not the grass variant underneath).
        ctx.fillStyle = '#0e3a16';
        ctx.fillRect(tcx - 2, tcy - 4, 5, 1);  // top row, narrowed
        ctx.fillRect(tcx - 3, tcy - 3, 7, 4);  // middle rows, full width
        ctx.fillRect(tcx - 2, tcy + 1, 5, 1);  // bottom row, narrowed
        // Canopy hilite — 3×2 lighter green top-left for shape def.
        ctx.fillStyle = '#2a6a2a';
        ctx.fillRect(tcx - 2, tcy - 3, 3, 2);
      }
    }
  }
  ctx.imageSmoothingEnabled = smPrev;
}
