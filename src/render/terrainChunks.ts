/**
 * H1142 — chunk-cached terrain (the H1123 plan, executed after the
 * user measured ~40% FPS lost to the living-terrain work).
 *
 * The grass + water passes redrew ~3000 tiles' worth of drawImage/
 * fillRect calls EVERY frame (measured: grass 0.551 ms of a 0.652 ms
 * desktop frame — 85%; multiply by a 4K phone render scale for the
 * user's 40%). But the terrain only actually CHANGES when a tile's
 * wind phase steps (~1.3 Hz) or the water frame ticks (220 ms) — the
 * jomoho plugin's chunk trick applies: pre-render 8×8-tile blocks to
 * offscreen canvases and redraw a block only when its content clock
 * changes, staggered per chunk so rebakes amortize to ~1-2 per frame.
 * The per-frame cost collapses to ~25-50 chunk drawImage calls.
 *
 * Layout: each chunk canvas covers its 8×8 tiles plus a 2-tile margin
 * on every side (216×216 px) — the margin bakes the canopy overhang
 * (H1119 leaf masses hang ≤14 px past their tile) and makes adjacent
 * chunks OVERLAP with opaque pixels, killing the rotated-camera AA
 * hairline seams (the H1139 water-grid lesson, applied at chunk
 * scale). Neighbouring chunks may bake the shared strip at slightly
 * different wind steps — invisible, because per-tile phase jitter
 * already de-syncs adjacent tiles by design.
 *
 * Rebake keys: global epoch (editor edits — see
 * [[invalidateTerrainChunks]]) | wind step (1.3 Hz + per-chunk jitter
 * stagger) | water frame (220 ms, only for chunks that contain water)
 * | quantized night (water glitter count). A per-frame REBAKE BUDGET
 * caps key-driven rebakes (stale art survives a frame or two);
 * never-baked chunks always bake so no holes appear — the one-time
 * spawn/teleport bake storm is a single load hitch.
 *
 * The flatten pass (H1117 wheel tracks), buildings, roads, cloud
 * shadows and sun rays all draw ABOVE this layer, unchanged.
 */

import { TILE } from '@/config/world/tiles';
import { getTile, type TileMap } from '@/world/tileMap';
import { drawGrass } from '@/render/grass';
import { drawWater } from '@/render/water';

const CHUNK_TILES = 8;
const CHUNK_PX = CHUNK_TILES * TILE;                       // 144
const MARGIN_TILES = 2;
const CANVAS_TILES = CHUNK_TILES + MARGIN_TILES * 2;       // 12
const CANVAS_PX = CANVAS_TILES * TILE;                     // 216
/** LRU pool cap — ~2 full screens of chunks (49 visible worst case at
 *  the widest cull), ~180 KB each ≈ 17 MB peak. */
const MAX_CHUNKS = 96;
/** Wind cadence — matches grass.ts WIND_STEP_HZ so chunk rebakes keep
 *  the sway stepping at the same rate the per-frame path did. */
const WIND_STEP_HZ = 1.3;
/** Water frame cadence — matches water.ts's Date.now()/220 clock. */
const WATER_FRAME_MS = 220;
/** Key-driven rebakes allowed per frame (fresh unbaked chunks are
 *  exempt). Steady state needs ~1-2. H1146: trimmed 4→2 — the user's
 *  box measured terrain at 5.2 ms (canvas ops ~30× slower than the
 *  dev harness), and rebake bursts are the spiky half of that; wind
 *  phases just step a frame or two later under load, invisible. */
const REBAKE_BUDGET = 2;
/** H1144: prefetch bakes allowed per frame — chunks ONE RING outside
 *  the view bake ahead of arrival so driving at speed never dumps a
 *  whole never-baked column into a single frame (user: 40-70 fps
 *  oscillation at highway max speed = 5-7 simultaneous fresh bakes
 *  every chunk boundary). At ~200 wpx/s a 144-px column has ~0.7 s of
 *  warning; 2 bakes/frame retires it in 3-4 frames. */
const PREFETCH_BUDGET = 2;

const TILE_WATER = 9;

interface Chunk {
  canvas: HTMLCanvasElement;
  key: string;
  used: number;
  hasWater: boolean;
  waterKnown: boolean;
}

const chunks = new Map<number, Chunk>();
let frameStamp = 0;
let epoch = 0;

/** H1143: live diagnostics — published to window.__terrainStats every
 *  frame so headless probes can read the GAME's module instance (a
 *  dynamic import gets a different HMR instance — the known gotcha).
 *  H1144: peakFreshVisible is MONOTONIC (worst single-frame count of
 *  unavoidable in-view fresh bakes since load) — the spike detector a
 *  polling probe can't miss. */
const _stats = { visible: 0, freshBakes: 0, rebakes: 0, prefetch: 0, pool: 0, peakFreshVisible: 0 };

/** Drop every cached chunk — call after ANY tile-map mutation
 *  (editor save/stamp, baseline rebuild, map switch). */
export function invalidateTerrainChunks(): void {
  chunks.clear();
  epoch++;
}

function chunkId(cx: number, cy: number): number {
  return cy * 4096 + cx;
}

function chunkJitter(cx: number, cy: number): number {
  let h = (Math.imul(cx, 374761393) ^ Math.imul(cy, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function scanWater(map: TileMap, cx: number, cy: number): boolean {
  const tx0 = cx * CHUNK_TILES - MARGIN_TILES;
  const ty0 = cy * CHUNK_TILES - MARGIN_TILES;
  for (let ty = ty0; ty < ty0 + CANVAS_TILES; ty++) {
    for (let tx = tx0; tx < tx0 + CANVAS_TILES; tx++) {
      if (getTile(map, tx, ty) === TILE_WATER) return true;
    }
  }
  return false;
}

function bakeChunk(
  ch: Chunk,
  cx: number,
  cy: number,
  map: TileMap,
  sunLight: { tMs: number; night: number } | null,
): void {
  const g = ch.canvas.getContext('2d')!;
  g.clearRect(0, 0, CANVAS_PX, CANVAS_PX);
  const originWX = cx * CHUNK_PX - MARGIN_TILES * TILE;
  const originWY = cy * CHUNK_PX - MARGIN_TILES * TILE;
  const centerWX = originWX + CANVAS_PX / 2;
  const centerWY = originWY + CANVAS_PX / 2;
  // Radius chosen so drawGrass/drawWater's own ±1-tile border lands
  // exactly on the canvas bounds (one extra clipped row is harmless).
  const r = CANVAS_PX / 2 - TILE;
  g.save();
  g.translate(-originWX, -originWY);
  drawGrass(g, map, centerWX, centerWY, r);
  if (ch.hasWater) drawWater(g, map, centerWX, centerWY, r, sunLight);
  g.restore();
}

/**
 * Draw the cached grass+water terrain for the view. Drop-in
 * replacement for the per-frame drawGrass + drawWater pair — same
 * call site, same world-space ctx.
 */
export function drawTerrainChunks(
  ctx: CanvasRenderingContext2D,
  map: TileMap,
  centerX: number,
  centerY: number,
  radius: number,
  sunLight: { tMs: number; night: number } | null,
): void {
  frameStamp++;
  const tMs = sunLight ? sunLight.tMs : Date.now();
  const tSec = tMs * 0.001;
  const waterStep = Math.floor(tMs / WATER_FRAME_MS);
  const nightQ = sunLight ? Math.round(sunLight.night * 5) : 0;

  const minCX = Math.floor((centerX - radius) / CHUNK_PX);
  const maxCX = Math.floor((centerX + radius) / CHUNK_PX);
  const minCY = Math.floor((centerY - radius) / CHUNK_PX);
  const maxCY = Math.floor((centerY + radius) / CHUNK_PX);

  const smPrev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  let rebakes = 0;
  let freshBakes = 0;
  let prefetchBakes = 0;
  // H1144: iterate one chunk RING beyond the view. Ring chunks aren't
  // drawn — they pre-bake (budgeted) so they're warm before they
  // scroll in; in-view fresh bakes stay unconditional (no holes) but
  // now only happen on teleports/spawns.
  for (let cy = minCY - 1; cy <= maxCY + 1; cy++) {
    for (let cx = minCX - 1; cx <= maxCX + 1; cx++) {
      const inView = cx >= minCX && cx <= maxCX && cy >= minCY && cy <= maxCY;
      const id = chunkId(cx, cy);
      let ch = chunks.get(id);
      if (!ch) {
        // Ring chunks past the prefetch budget aren't even allocated
        // yet — skip cheaply until a later frame picks them up.
        if (!inView && prefetchBakes >= PREFETCH_BUDGET) continue;
        ch = {
          canvas: document.createElement('canvas'),
          key: '',
          used: 0,
          hasWater: false,
          waterKnown: false,
        };
        ch.canvas.width = CANVAS_PX;
        ch.canvas.height = CANVAS_PX;
        chunks.set(id, ch);
      }
      if (!ch.waterKnown) {
        ch.hasWater = scanWater(map, cx, cy);
        ch.waterKnown = true;
      }
      const windStep = Math.floor(tSec * WIND_STEP_HZ + chunkJitter(cx, cy));
      const key = epoch + '|' + windStep
        + (ch.hasWater ? '|' + waterStep + '|' + nightQ : '');
      if (ch.key !== key) {
        const fresh = ch.key === '';
        if (fresh) {
          // In-view fresh bakes are unconditional (no holes); ring
          // fresh bakes respect the prefetch budget.
          if (inView) {
            bakeChunk(ch, cx, cy, map, sunLight);
            ch.key = key;
            freshBakes++;
          } else if (prefetchBakes < PREFETCH_BUDGET) {
            bakeChunk(ch, cx, cy, map, sunLight);
            ch.key = key;
            prefetchBakes++;
          }
        } else if (inView && rebakes < REBAKE_BUDGET) {
          // Key refreshes only matter in view; ring chunks refresh
          // when they arrive.
          bakeChunk(ch, cx, cy, map, sunLight);
          ch.key = key;
          rebakes++;
        }
      }
      ch.used = frameStamp;
      if (inView) {
        ctx.drawImage(ch.canvas, cx * CHUNK_PX - MARGIN_TILES * TILE, cy * CHUNK_PX - MARGIN_TILES * TILE);
      }
    }
  }
  ctx.imageSmoothingEnabled = smPrev;

  // H1143: eviction — NEVER touch chunks used this frame. The H1142
  // fixed cap (96) sat BELOW the visible set on wide desktop viewports
  // (~9-14 chunks per axis), so every frame evicted live chunks and
  // re-baked them from scratch — a permanent full-view bake storm,
  // WORSE than the uncached path (user: 37 fps idle, 20 near bridges).
  // The pool now keeps every currently-visible chunk unconditionally
  // and only trims chunks that scrolled out of view, down to 2× the
  // live set (so backtracking stays warm).
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
  _stats.rebakes = rebakes;
  _stats.prefetch = prefetchBakes;
  _stats.pool = chunks.size;
  // Ignore the load/teleport storm on the very first frames — the
  // peak tracker is for STEADY-STATE spikes (driving at speed).
  if (frameStamp > 30 && freshBakes > _stats.peakFreshVisible) {
    _stats.peakFreshVisible = freshBakes;
  }
  (window as unknown as { __terrainStats?: typeof _stats }).__terrainStats = _stats;
}
