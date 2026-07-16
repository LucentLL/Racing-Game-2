/**
 * H1167 — chunk-baked GROUND ROADS (first slice of the static-world
 * bake arc; the 2026-07-16 perf audit's largest confirmed win).
 *
 * drawBaselineRoads live-strokes every visible road EVERY frame —
 * ~20 stroke calls on the sparse baseline and 55-130 downtown in the
 * user's overlay city (~3-13 ms of deferred raster on their box at
 * 0.05-0.1 ms/call), yet the geometry only changes when the render
 * list is rebuilt (editor Ctrl+S / map switch). Same shape as the
 * H1142 terrain-chunk win, so this applies the same recipe: bake
 * world-anchored chunks to offscreen canvases through the EXISTING
 * drawBaselineRoads pipeline, blit ~9-16 images per frame, and rebake
 * only when getRenderEntriesEpoch() flips. World Editor edits stay
 * fully live: every mutation path routes through rebuildRenderEntries,
 * which bumps the epoch (user requirement 2026-07-16: "roads still
 * need to be editable in the World Editor").
 *
 * Differences from the terrain recipe, both driven by roads being a
 * TRANSPARENT layer of high-contrast vector art (terrain is opaque
 * pixel art):
 *
 *  - BAKE SCALE 3 px/world-px (terrain bakes 1:1 and NN-upscales).
 *    Live road strokes rasterize at the world zoom (~2.93 internal px
 *    per wpx on desktop), so a 1:1 bake blitted through the same
 *    transform would visibly soften lane stripes. Scale 3 ≈ the live
 *    raster density; the blit downsamples ~0.98× with smoothing ON —
 *    visually equivalent (verified by pixel A/B at ship time).
 *
 *  - CORE-ONLY BLIT (terrain blits full canvases and lets opaque
 *    margins overlap). Overlapping TRANSPARENT canvases would double-
 *    composite the anti-aliased stroke edges into darker seam lines,
 *    so each blit crops to the chunk core (9-arg drawImage). Adjacent
 *    chunks rasterize the same primitives at the same world positions
 *    and scale, so pixels along the shared cut line are identical —
 *    seamless without overlap. The 1-tile margin is only a safety
 *    band so canvas-edge clipping never touches core pixels.
 *
 * Correctness note on culling: bakeChunk calls drawBaselineRoads with
 * the chunk centre and half-extent; its internal culls are generous
 * (entry bbox at cullR×1.6, chunk lookahead +460 wpx — far wider than
 * any road's painted half-width), so every primitive that intersects
 * the canvas is drawn and the canvas edge is the exact clip.
 */

import { TILE } from '@/config/world/tiles';
import {
  drawBaselineRoads,
  getRenderEntriesEpoch,
  anyGroundRoadIntersects,
} from '@/render/worldMap';

const CHUNK_TILES = 8;
const CHUNK_PX = CHUNK_TILES * TILE;                 // 144 wpx core
const MARGIN_PX = TILE;                              // 18 wpx safety band
const CANVAS_WPX = CHUNK_PX + MARGIN_PX * 2;         // 180 wpx covered
/** Bake density — see header. ~2.93 is the desktop play zoom. */
const SCALE = 3;
const CANVAS_PX = CANVAS_WPX * SCALE;                // 540 px canvas
const CORE_PX = CHUNK_PX * SCALE;                    // 432 px blit crop
/** Floor for the LRU pool. The live cap is max(this, visible×2) same
 *  as terrain H1143 — never evict in-view. ~1.17 MB per chunk at
 *  540², so a 16-chunk view holds ~19 MB live / ~37 MB pooled. */
const MAX_CHUNKS = 48;
/** H1144 lesson applied here too: chunks one ring OUTSIDE the view
 *  pre-bake (budgeted per frame) so driving at speed never dumps a
 *  whole never-baked column into a single frame — road bakes are
 *  costlier than terrain's (dozens of strokes at 540²). In-view fresh
 *  bakes stay unconditional so holes never appear. */
const PREFETCH_BUDGET = 2;

interface RoadChunkTile {
  /** null = chunk verified roadless (bbox probe) — no alloc, no blit. */
  canvas: HTMLCanvasElement | null;
  baked: boolean;
  used: number;
}

/** Bbox inflation for the roadless probe — must exceed the widest
 *  painted half-width (an 8-lane interstate's asphalt half-width plus
 *  fog lines is ~110 wpx; entry bboxes are centerline extents). */
const ROAD_HALFW_WPX = 150;

const chunks = new Map<number, RoadChunkTile>();
let frameStamp = 0;
let lastEpoch = -1;

/** Diagnostics published to window.__roadChunkStats (same pattern as
 *  __terrainStats — headless probes must read the GAME's module
 *  instance, not a fresh dynamic import). */
const _stats = { visible: 0, freshBakes: 0, prefetch: 0, pool: 0, epochFlushes: 0 };

function chunkId(cx: number, cy: number): number {
  return cy * 4096 + cx;
}

function bakeChunk(ch: RoadChunkTile, cx: number, cy: number): void {
  const g = ch.canvas!.getContext('2d')!;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, CANVAS_PX, CANVAS_PX);
  const originWX = cx * CHUNK_PX - MARGIN_PX;
  const originWY = cy * CHUNK_PX - MARGIN_PX;
  g.setTransform(SCALE, 0, 0, SCALE, -originWX * SCALE, -originWY * SCALE);
  drawBaselineRoads(
    g,
    originWX + CANVAS_WPX / 2,
    originWY + CANVAS_WPX / 2,
    CANVAS_WPX / 2,
  );
  g.setTransform(1, 0, 0, 1, 0, 0);
  ch.baked = true;
}

/**
 * Draw the cached ground-road layer. Drop-in replacement for the
 * per-frame drawBaselineRoads call — same call site, same world-space
 * ctx, same content (asphalt + markings + merge polygons + junction
 * erases, all through the real strokeRoad pipeline at bake time).
 */
export function drawRoadChunks(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  radius: number,
): void {
  frameStamp++;
  // Epoch flip = road geometry changed (editor save / map switch /
  // baseline rebuild). Drop everything; in-view chunks rebake this
  // frame unconditionally (one-frame storm, same policy as terrain's
  // invalidate — editor saves are not gameplay-hot moments).
  const epoch = getRenderEntriesEpoch();
  if (epoch !== lastEpoch) {
    if (lastEpoch !== -1) _stats.epochFlushes++;
    lastEpoch = epoch;
    chunks.clear();
  }

  const minCX = Math.floor((centerX - radius) / CHUNK_PX);
  const maxCX = Math.floor((centerX + radius) / CHUNK_PX);
  const minCY = Math.floor((centerY - radius) / CHUNK_PX);
  const maxCY = Math.floor((centerY + radius) / CHUNK_PX);

  // Smoothing ON for the blit — vector-art downsample (~0.98×), unlike
  // terrain's NN pixel-art path. Restore whatever the caller had.
  const smPrev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = true;

  // Seam-proof dest rects: two abutting drawImages at FRACTIONAL device
  // coords each write partial coverage into the shared boundary pixel;
  // src-over composes the two partial writes into a visible hairline
  // (the H1139 water-grid lesson, drawImage edition). Snap every chunk
  // edge to integer device pixels — adjacent chunks round the same
  // world coordinate identically, so rects abut exactly and the seam
  // pixel is written once at full coverage. The world ctx is a uniform
  // scale+translate (no rotation), so device x = a·wx + e, y = d·wy + f.
  const t = ctx.getTransform();
  const snapX = (wx: number): number => Math.round(wx * t.a + t.e);
  const snapY = (wy: number): number => Math.round(wy * t.d + t.f);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  let freshBakes = 0;
  let prefetchBakes = 0;
  // Iterate one chunk ring beyond the view (terrain H1144). Ring
  // chunks aren't drawn — they pre-bake within PREFETCH_BUDGET so
  // they're warm before they scroll in.
  for (let cy = minCY - 1; cy <= maxCY + 1; cy++) {
    for (let cx = minCX - 1; cx <= maxCX + 1; cx++) {
      const inView = cx >= minCX && cx <= maxCX && cy >= minCY && cy <= maxCY;
      const id = chunkId(cx, cy);
      let ch = chunks.get(id);
      if (!ch) {
        // Ring chunks past the prefetch budget aren't allocated yet —
        // skip cheaply until a later frame picks them up.
        if (!inView && prefetchBakes >= PREFETCH_BUDGET) continue;
        // Roadless probe BEFORE any canvas allocation: a chunk whose
        // inflated rect touches no ground entry bbox stores canvas:null
        // and costs nothing per frame — most of the countryside.
        const ox = cx * CHUNK_PX - MARGIN_PX;
        const oy = cy * CHUNK_PX - MARGIN_PX;
        if (!anyGroundRoadIntersects(
          ox - ROAD_HALFW_WPX, oy - ROAD_HALFW_WPX,
          ox + CANVAS_WPX + ROAD_HALFW_WPX, oy + CANVAS_WPX + ROAD_HALFW_WPX,
        )) {
          ch = { canvas: null, baked: true, used: 0 };
          chunks.set(id, ch);
        } else {
          ch = { canvas: document.createElement('canvas'), baked: false, used: 0 };
          ch.canvas!.width = CANVAS_PX;
          ch.canvas!.height = CANVAS_PX;
          chunks.set(id, ch);
        }
      }
      if (!ch.baked && ch.canvas) {
        if (inView) {
          bakeChunk(ch, cx, cy);
          freshBakes++;
        } else if (prefetchBakes < PREFETCH_BUDGET) {
          bakeChunk(ch, cx, cy);
          prefetchBakes++;
        }
      }
      ch.used = frameStamp;
      if (inView && ch.canvas && ch.baked) {
        // Integer-device-px dest rect (see snap note above), drawn
        // through an identity transform; src crop follows the snapped
        // edges so world content stays aligned across the seam.
        const dx0 = snapX(cx * CHUNK_PX);
        const dx1 = snapX((cx + 1) * CHUNK_PX);
        const dy0 = snapY(cy * CHUNK_PX);
        const dy1 = snapY((cy + 1) * CHUNK_PX);
        const sx0 = MARGIN_PX * SCALE + ((dx0 - t.e) / t.a - cx * CHUNK_PX) * SCALE;
        const sy0 = MARGIN_PX * SCALE + ((dy0 - t.f) / t.d - cy * CHUNK_PX) * SCALE;
        const sw = ((dx1 - dx0) / t.a) * SCALE;
        const sh = ((dy1 - dy0) / t.d) * SCALE;
        ctx.drawImage(ch.canvas, sx0, sy0, sw, sh, dx0, dy0, dx1 - dx0, dy1 - dy0);
      }
    }
  }
  ctx.restore();
  ctx.imageSmoothingEnabled = smPrev;

  // Eviction — terrain H1143 policy: never evict chunks used this
  // frame; trim the oldest out-of-view chunks down to 2× the live set.
  const visible = (maxCX - minCX + 1) * (maxCY - minCY + 1);
  const cap = Math.max(MAX_CHUNKS, visible * 2);
  if (chunks.size > cap) {
    const entries: Array<[number, number]> = [];
    for (const [id, ch] of chunks) {
      if (ch.used !== frameStamp) entries.push([id, ch.used]);
    }
    entries.sort((a, b) => a[1] - b[1]);
    const drop = Math.min(entries.length, chunks.size - cap);
    for (let i = 0; i < drop; i++) chunks.delete(entries[i][0]);
  }

  _stats.visible = visible;
  _stats.freshBakes = freshBakes;
  _stats.prefetch = prefetchBakes;
  _stats.pool = chunks.size;
  (window as unknown as { __roadChunkStats?: typeof _stats }).__roadChunkStats = _stats;
}
