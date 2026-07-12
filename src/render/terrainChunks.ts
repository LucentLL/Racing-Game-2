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
 *  exempt). Steady state needs ~1-2; the cap absorbs jitter pileups. */
const REBAKE_BUDGET = 4;

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
  for (let cy = minCY; cy <= maxCY; cy++) {
    for (let cx = minCX; cx <= maxCX; cx++) {
      const id = chunkId(cx, cy);
      let ch = chunks.get(id);
      if (!ch) {
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
        // Fresh chunks must bake (no holes); key-refreshes respect the
        // per-frame budget and keep their slightly-stale art otherwise.
        const fresh = ch.key === '';
        if (fresh || rebakes < REBAKE_BUDGET) {
          bakeChunk(ch, cx, cy, map, sunLight);
          ch.key = key;
          if (!fresh) rebakes++;
        }
      }
      ch.used = frameStamp;
      ctx.drawImage(ch.canvas, cx * CHUNK_PX - MARGIN_TILES * TILE, cy * CHUNK_PX - MARGIN_TILES * TILE);
    }
  }
  ctx.imageSmoothingEnabled = smPrev;

  // LRU eviction — drop the least-recently-used chunks past the cap.
  if (chunks.size > MAX_CHUNKS) {
    const entries: Array<[number, number]> = [];
    for (const [id, ch] of chunks) entries.push([id, ch.used]);
    entries.sort((a, b) => a[1] - b[1]);
    const drop = chunks.size - MAX_CHUNKS;
    for (let i = 0; i < drop; i++) chunks.delete(entries[i][0]);
  }
}
