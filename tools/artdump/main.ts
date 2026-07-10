/**
 * Art-dump harness body. Renders every non-car drawable through the
 * game's REAL render modules into per-swatch canvases, shows them on
 * the page at 4× (pixelated), and packs the native-resolution PNGs
 * into a store-only ZIP (plus a labeled contact sheet and copies of
 * the static /ui PNGs).
 *
 * LIVE section = what the current game actually paints.
 * DORMANT section = the ported-but-unused GBC ground-tile pass
 * (render/ground.ts) — exported so the restyle can decide whether to
 * revive or retire it.
 */

import { TILE } from '@/config/world/tiles';
import { createTileMap, setTile } from '@/world/tileMap';
import { drawGrass } from '@/render/grass';
import { drawWater } from '@/render/water';
import { drawGround, type GroundDeps } from '@/render/ground';
import { drawRoof, drawDrivewayStrip } from '@/render/roofs';
import { drawParkingLotStalls } from '@/render/parkingLotStalls';
import { drawBaselineRoads } from '@/render/worldMap';
import { drawCrosswalks } from '@/render/crosswalks';
import { drawTrafficSignals } from '@/render/trafficSignals';
import { drawStreetlights } from '@/render/streetlights';
import { drawGasStations } from '@/render/gasStations';
import { drawCharacterBase, __test as cbTest } from '@/render/characterBase';
import { getBldg } from '@/world/buildings';
import { GAS_STATIONS } from '@/config/world/gasStations';
import { ROAD_CROSSINGS, rebuildRoadCrossings } from '@/world/roadCrossings';
import { BASELINE_ROADS } from '@/config/world/baselineRoads';

// Crossings are normally rebuilt at game boot — do it here so the
// intersection scenes have signals to draw.
try {
  if (ROAD_CROSSINGS.length === 0) rebuildRoadCrossings(BASELINE_ROADS);
} catch (err) {
  console.warn('artdump: rebuildRoadCrossings failed (intersection scenes will be skipped)', err);
}

interface Entry { path: string; canvas: HTMLCanvasElement; note?: string }
const entries: Entry[] = [];
const root = document.getElementById('root')!;
const statusEl = document.getElementById('status')!;
let currentGrid: HTMLElement | null = null;

function section(title: string): void {
  const h = document.createElement('h2');
  h.textContent = title;
  root.appendChild(h);
  currentGrid = document.createElement('div');
  currentGrid.id = 'grid';
  currentGrid.className = '';
  currentGrid.style.cssText = 'display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start;';
  root.appendChild(currentGrid);
}

/** Register + display one swatch. draw() paints into a native-res ctx. */
function swatch(
  path: string,
  w: number,
  h: number,
  draw: (ctx: CanvasRenderingContext2D) => void,
  note = '',
  viewScale = 4,
): void {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  try {
    draw(ctx);
    entries.push({ path, canvas: c, note });
  } catch (err) {
    note = `RENDER FAILED: ${(err as Error).message}`;
    console.error('artdump swatch failed:', path, err);
  }
  const box = document.createElement('div');
  box.className = 'sw';
  const shown = document.createElement('canvas');
  shown.width = w * viewScale; shown.height = h * viewScale;
  const sctx = shown.getContext('2d')!;
  sctx.imageSmoothingEnabled = false;
  sctx.drawImage(c, 0, 0, shown.width, shown.height);
  box.appendChild(shown);
  const lbl = document.createElement('div');
  lbl.className = 'lbl';
  lbl.innerHTML = `<b>${path}</b> ${w}×${h}px${note ? `<div class="${note.startsWith('RENDER') ? 'warn' : ''}">${note}</div>` : ''}`;
  box.appendChild(lbl);
  (currentGrid ?? root).appendChild(box);
}

/** World-space scene: translate so (cx,cy) world px is the canvas center. */
function scene(
  path: string,
  w: number,
  h: number,
  cx: number,
  cy: number,
  layers: (ctx: CanvasRenderingContext2D) => void,
  note = '',
): void {
  swatch(path, w, h, (ctx) => {
    ctx.save();
    ctx.translate(w / 2 - cx, h / 2 - cy);
    layers(ctx);
    ctx.restore();
  }, note, 2);
}

// ---------------------------------------------------------------------------
// LIVE TERRAIN — grass (render/grass.ts) + water (render/water.ts)
// ---------------------------------------------------------------------------

// Mirror of grass.ts's private tile-hash + variant distribution, used ONLY
// to find coordinates that render each variant (the art itself comes from
// the real drawGrass call).
function grassHash(tx: number, ty: number): number { return (tx * 0x1f1f1f1f) ^ (ty * 0x12345678); }
function variantForHash(hash: number): number {
  const b = hash & 0xf;
  if (b <= 3) return 0;
  if (b <= 6) return 1;
  if (b <= 10) return 2;
  return b - 8;
}
const GRASS_NAMES = ['standard', 'dry', 'lush', 'dirt', 'clay', 'rocks', 'flowers', 'tallgrass'];

function findGrassTile(v: number, wantBush: boolean): [number, number] {
  const ty = 52;
  for (let tx = 3; tx < 4000; tx++) {
    const isBush = (tx + ty * 3) % 5 === 0;
    if (isBush !== wantBush) continue;
    if (variantForHash(grassHash(tx, ty)) === v) return [tx, ty];
  }
  return [3, ty];
}

function run(): void {
  const emptyMap = createTileMap();

  section('LIVE TERRAIN — grass variants (render/grass.ts, 18×18, hash-picked per tile)');
  for (let v = 0; v < 8; v++) {
    const [tx, ty] = findGrassTile(v, false);
    swatch(`tiles-live/grass_v${v}_${GRASS_NAMES[v]}.png`, TILE, TILE, (ctx) => {
      ctx.translate(-tx * TILE, -ty * TILE);
      drawGrass(ctx, emptyMap, tx * TILE + TILE / 2, ty * TILE + TILE / 2, 1);
    }, `variant ${v} — ${GRASS_NAMES[v]}`, 6);
  }
  {
    const [tx, ty] = findGrassTile(0, true);
    swatch('tiles-live/grass_bush_overlay.png', TILE, TILE, (ctx) => {
      ctx.translate(-tx * TILE, -ty * TILE);
      drawGrass(ctx, emptyMap, tx * TILE + TILE / 2, ty * TILE + TILE / 2, 1);
    }, 'bush overlay — lands on every (tx+ty*3)%5==0 tile', 6);
  }
  swatch('tiles-live/grass_field_8x8.png', TILE * 8, TILE * 8, (ctx) => {
    ctx.translate(-40 * TILE, -40 * TILE);
    drawGrass(ctx, emptyMap, 44 * TILE, 44 * TILE, 4.5 * TILE);
  }, 'natural 8×8 mix (25% std / 19% dry / 25% lush / 6% each deco)', 2);

  section('LIVE TERRAIN — water (render/water.ts, animated ripples: one frame shown)');
  {
    const waterMap = createTileMap();
    for (let y = 40; y < 48; y++) for (let x = 40; x < 48; x++) setTile(waterMap, x, y, 9);
    swatch('tiles-live/water_8x8.png', TILE * 8, TILE * 8, (ctx) => {
      ctx.translate(-40 * TILE, -40 * TILE);
      drawWater(ctx, waterMap, 44 * TILE, 44 * TILE, 4.5 * TILE);
    }, 'tile=9 — 4-color GBC water, 3 scrolling scanline ripples', 2);
  }

  // -------------------------------------------------------------------------
  // LIVE WORLD SCENES — the real Charlotte road art via drawBaselineRoads
  // -------------------------------------------------------------------------
  section('LIVE WORLD SCENES — real map coords through the live render passes (2× view)');

  // Mid-waypoint of a wide ground-level baseline road.
  // Row format: [width, isMajor, name, z, x1, y1, x2, y2, ...].
  const seg = BASELINE_ROADS.find((r) => r[0] >= 2 && r[3] <= 1 && r.length >= 8) ?? BASELINE_ROADS[0];
  const segName = seg[2];
  const nPts = (seg.length - 4) / 2;
  const midIdx = 4 + Math.floor(nPts / 2) * 2;
  const roadCx = (seg[midIdx] as number) * TILE, roadCy = (seg[midIdx + 1] as number) * TILE;

  scene('scenes/road_segment.png', 420, 280, roadCx, roadCy, (ctx) => {
    drawGrassBackdrop(ctx, roadCx, roadCy, 420, 280, emptyMap);
    drawBaselineRoads(ctx, roadCx, roadCy, 320);
  }, `asphalt + stripes near "${segName}" (render/worldMap.ts drawBaselineRoads)`);

  // First ground-level crossing: crosswalks + signals day & night.
  const xing = ROAD_CROSSINGS.find((c) => c.z1 <= 1 && c.z2 <= 1);
  if (xing) {
    scene('scenes/intersection_day.png', 420, 320, xing.x, xing.y, (ctx) => {
      drawGrassBackdrop(ctx, xing.x, xing.y, 420, 320, emptyMap);
      drawBaselineRoads(ctx, xing.x, xing.y, 340);
      drawCrosswalks(ctx, xing.x, xing.y, 340);
      drawTrafficSignals(ctx, ROAD_CROSSINGS, xing.x, xing.y, 0.25, 340);
    }, 'crosswalk zebras (render/crosswalks.ts) + signal cones day (render/trafficSignals.ts)');
    scene('scenes/intersection_night.png', 420, 320, xing.x, xing.y, (ctx) => {
      drawGrassBackdrop(ctx, xing.x, xing.y, 420, 320, emptyMap);
      drawBaselineRoads(ctx, xing.x, xing.y, 340);
      drawCrosswalks(ctx, xing.x, xing.y, 340);
      drawTrafficSignals(ctx, ROAD_CROSSINGS, xing.x, xing.y, 1.0, 340);
      drawStreetlights(ctx, xing.x, xing.y, 1.0, 340);
    }, 'night: vivid signal cones + streetlight glow (render/streetlights.ts)');
  }

  // Gas station marker pad.
  const gs = GAS_STATIONS[0] as { tx: number; ty: number };
  if (gs) {
    const gx = gs.tx * TILE, gy = gs.ty * TILE;
    scene('scenes/gas_station.png', 360, 280, gx, gy, (ctx) => {
      drawGrassBackdrop(ctx, gx, gy, 360, 280, emptyMap);
      drawBaselineRoads(ctx, gx, gy, 300);
      drawGasStations(ctx);
    }, 'yellow 5×5-tile pump pad + ⛽ (render/gasStations.ts)');
  }

  // Parking lot (synthetic polygon through the real stall renderer).
  scene('scenes/parking_lot_asphalt.png', 300, 220, 55 * TILE, 45 * TILE, (ctx) => {
    drawGrassBackdrop(ctx, 55 * TILE, 45 * TILE, 300, 220, emptyMap);
    drawParkingLotStalls(ctx, {
      TILE,
      parkingLots: [['dump lot', 'asphalt', 0.6, 1.2, 1.5, 51, 42, 59, 42, 59, 48, 51, 48]],
      adaCount: 1,
      minTX: 45, maxTX: 65, minTY: 36, maxTY: 54,
    });
  }, 'H699 lot: pavement + aisles + stalls + ADA cell (render/parkingLotStalls.ts)');
  scene('scenes/parking_lot_concrete.png', 300, 220, 55 * TILE, 45 * TILE, (ctx) => {
    drawGrassBackdrop(ctx, 55 * TILE, 45 * TILE, 300, 220, emptyMap);
    drawParkingLotStalls(ctx, {
      TILE,
      parkingLots: [['dump lot', 'concrete', 0.6, 1.2, 1.5, 51, 42, 59, 42, 59, 48, 51, 48]],
      adaCount: 0,
      minTX: 45, maxTX: 65, minTY: 36, maxTY: 54,
    });
  }, 'concrete material variant');

  // -------------------------------------------------------------------------
  // BUILDINGS — roofs.ts polygons (the only building art the player sees)
  // -------------------------------------------------------------------------
  section('BUILDINGS — placed-building roofs (render/roofs.ts, native world scale)');

  const project = (tx: number, ty: number): [number, number] => [tx * TILE, ty * TILE];
  const rectFoot = (x: number, y: number, w: number, h: number): Array<[number, number]> =>
    [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

  /** shinglePal mirror — find an x-offset whose centroid hash lands on pal i. */
  const palIndex = (cx: number, cy: number): number => {
    const h = (Math.round(cx) * 73856093) ^ (Math.round(cy) * 19349663);
    return Math.abs(h) % 5;
  };
  const PAL_NAMES = ['brown', 'gray', 'weathered-green', 'tan-brown', 'slate-blue'];

  const roofSwatch = (
    path: string, foot: Array<[number, number]>, type: string, note: string, cel = false,
  ): void => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of foot) {
      minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
      minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
    }
    const w = Math.ceil((maxX - minX + 2) * TILE), h = Math.ceil((maxY - minY + 2) * TILE);
    swatch(path, w, h, (ctx) => {
      ctx.translate((1 - minX) * TILE, (1 - minY) * TILE);
      drawRoof(ctx, foot, type, project, cel);
    }, note, 2);
  };

  for (let pal = 0; pal < 5; pal++) {
    // Slide the footprint right until its centroid hashes to palette `pal`.
    let off = 0;
    while (palIndex(4 + off, 3.5) !== pal && off < 60) off++;
    roofSwatch(`buildings/roof_house_shingle_${pal}_${PAL_NAMES[pal]}.png`,
      rectFoot(1 + off, 1, 6, 5), 'house',
      `shingle palette ${pal} (${PAL_NAMES[pal]}) — courses + ridge + eave`);
  }
  roofSwatch('buildings/roof_trailer.png', rectFoot(1, 1, 3, 7), 'trailer', 'narrow shingle footprint');
  roofSwatch('buildings/roof_apartment.png', rectFoot(1, 1, 10, 7), 'apartment', 'large shingle footprint');
  roofSwatch('buildings/roof_flat_commercial.png', rectFoot(1, 1, 10, 8), 'dealership',
    'flat gravel roof + parapet + HVAC (dealership/mechanic/junkyard/autoparts)');
  roofSwatch('buildings/roof_house_CEL.png', rectFoot(1, 1, 6, 5), 'house',
    'H1085 cel-shade variant (ink outline + hard shadow band)', true);
  roofSwatch('buildings/roof_flat_commercial_CEL.png', rectFoot(1, 1, 10, 8), 'dealership',
    'cel-shade variant', true);

  swatch('buildings/driveway_strip.png', TILE * 4, TILE * 6, (ctx) => {
    ctx.translate(TILE, TILE);
    drawDrivewayStrip(ctx, [[0, 0], [2, 0], [2, 4], [0, 4]], project, 1.2);
  }, 'concrete driveway strip (roofs.ts drawDrivewayStrip)', 2);

  // -------------------------------------------------------------------------
  // CHARACTERS — sheet-based portraits (async sheet load)
  // -------------------------------------------------------------------------
  section('CHARACTERS — portrait sheet cells (public/ui/Character-Bases-1.png, 512px cells shown at 96px)');
  const charSwatches = (): void => {
    (['M', 'F'] as const).forEach((g) => {
      ([0, 1, 2] as const).forEach((col) => {
        const build = ['muscular', 'lean', 'overweight'][col];
        swatch(`characters/base_${g}_${build}.png`, 96, 96, (ctx) => {
          drawCharacterBase(ctx, g, 50, 1, 0, 0, 96, col);
        }, `render/characterBase.ts — row ${g === 'M' ? 0 : 1} col ${col}`, 1);
      });
    });
  };

  // -------------------------------------------------------------------------
  // DORMANT GBC TILESET — render/ground.ts (NOT drawn by the current game)
  // -------------------------------------------------------------------------
  section('DORMANT GBC TILESET — render/ground.ts 18-type pass (currently unused in the modular build)');

  const groundSwatch = (
    path: string,
    tileId: number,
    note: string,
    opts?: { ring?: number; curveAngle?: number },
  ): void => {
    const base = 100; // wtx/wty base — parity + seeds vary per coord
    swatch(path, TILE * 3, TILE * 3, (ctx) => {
      ctx.translate(-base * TILE, -base * TILE);
      const pick = (x: number, y: number): number => {
        const border = x < base || x > base + 2 || y < base || y > base + 2;
        return border && opts?.ring !== undefined ? opts.ring : tileId;
      };
      const curveData: Record<string, number> = {};
      if (opts?.curveAngle !== undefined) {
        for (let y = base - 1; y <= base + 3; y++) {
          for (let x = base - 1; x <= base + 3; x++) curveData[`${x},${y}`] = opts.curveAngle;
        }
      }
      const deps: GroundDeps = {
        TILE, MAP_W: 2500, MAP_H: 2500,
        resolvedTile: pick,
        getTile: pick,
        getBldg,
        curveData,
        grassVariantCanvases: null,
        buildGrassVariantCanvases: () => { /* dormant grass path unused — live grass above */ },
      };
      drawGround(ctx, {
        zoom: 1, camYRatio: 0.5, camY: 0,
        smoothFocusX: (base + 1.5) * TILE, smoothFocusY: (base + 1.5) * TILE,
        minTX: base - 1, maxTX: base + 3, minTY: base - 1, maxTY: base + 3,
        viewR: TILE * 6,
      }, deps);
    }, note, 4);
  };

  groundSwatch('tiles-dormant/t00_base_green.png', 0, 'tiles 0-3 (empty/road) — flat alt-checker green underlay');
  groundSwatch('tiles-dormant/t04_building_floor.png', 4, 'building floor — 4×4-block palette fill (world/buildings.ts getBldg)');
  groundSwatch('tiles-dormant/t05_sidewalk.png', 5, 'sidewalk + curb dabs where neighbor is road', { ring: 1 });
  groundSwatch('tiles-dormant/t07_gas_pavement.png', 7, 'gas-station pavement + dashed lane line');
  groundSwatch('tiles-dormant/t08_gas_pump.png', 8, 'gas pump — red box, white face, hose');
  groundSwatch('tiles-dormant/t09_water.png', 9, 'GBC water (same art as live water.ts)');
  groundSwatch('tiles-dormant/t10_bridge_deck.png', 10, 'wood bridge deck + railings + posts');
  groundSwatch('tiles-dormant/t11_forest.png', 11, 'forest — rect-only tree blobs, 1-3 per tile');
  groundSwatch('tiles-dormant/t12_dirt_road.png', 12, 'dirt road — dither + dashed tire ruts');
  groundSwatch('tiles-dormant/t13_canyon_wall.png', 13, 'canyon wall — depth-shaded rock');
  groundSwatch('tiles-dormant/t14_canyon_edge_road.png', 14, 'canyon-edge road + brown rails at cliff edges', { ring: 13 });
  groundSwatch('tiles-dormant/t15_curve_road_0deg.png', 15, 'curved asphalt, tangent 0°', { curveAngle: 0 });
  groundSwatch('tiles-dormant/t15_curve_road_45deg.png', 15, 'curved asphalt, tangent 45°', { curveAngle: Math.PI / 4 });
  groundSwatch('tiles-dormant/t15_curve_road_90deg.png', 15, 'curved asphalt, tangent 90°', { curveAngle: Math.PI / 2 });
  groundSwatch('tiles-dormant/t16_curve_dirt_45deg.png', 16, 'curved dirt road, tangent 45°', { curveAngle: Math.PI / 4 });
  groundSwatch('tiles-dormant/t18_lot_asphalt.png', 18, 'parking-lot asphalt tile (live lots use polygon fill)');
  groundSwatch('tiles-dormant/t19_lot_concrete.png', 19, 'parking-lot concrete tile');

  // Characters render once the sheet finishes loading (or after 4s fallback).
  const startedAt = performance.now();
  const waitSheet = (): void => {
    const sheet = cbTest.sheets[0];
    if ((sheet && sheet.complete && sheet.naturalWidth) || performance.now() - startedAt > 4000) {
      charSwatches();
      finish();
    } else {
      setTimeout(waitSheet, 120);
    }
  };
  // Kick the lazy loader with a throwaway draw.
  const kick = document.createElement('canvas'); kick.width = 4; kick.height = 4;
  drawCharacterBase(kick.getContext('2d')!, 'M', 50, 1, 0, 0, 4);
  waitSheet();
}

/** Fill the visible rect with live grass so scenes sit on real terrain. */
function drawGrassBackdrop(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, w: number, h: number,
  map: ReturnType<typeof createTileMap>,
): void {
  drawGrass(ctx, map, cx, cy, Math.max(w, h) * 0.75);
}

// ---------------------------------------------------------------------------
// Contact sheet + ZIP + extraction API
// ---------------------------------------------------------------------------

function buildContactSheet(): HTMLCanvasElement {
  const scale = 2, pad = 10, labelH = 14, cols = 6;
  const cellW = Math.max(...entries.map((e) => e.canvas.width * scale)) + pad;
  const rows = Math.ceil(entries.length / cols);
  const cellH = Math.max(...entries.map((e) => e.canvas.height * scale)) + labelH + pad;
  const sheet = document.createElement('canvas');
  sheet.width = cols * cellW + pad;
  sheet.height = rows * cellH + pad;
  const ctx = sheet.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#0d0f14';
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  entries.forEach((e, i) => {
    const x = pad + (i % cols) * cellW;
    const y = pad + Math.floor(i / cols) * cellH;
    ctx.drawImage(e.canvas, x, y, e.canvas.width * scale, e.canvas.height * scale);
    ctx.fillStyle = '#cdd3dc';
    ctx.font = '9px monospace';
    ctx.fillText(e.path.replace(/^.*\//, '').replace('.png', ''), x, y + e.canvas.height * scale + 10);
  });
  return sheet;
}

function dataURLToBytes(dataURL: string): Uint8Array {
  const b64 = dataURL.slice(dataURL.indexOf(',') + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Store-only ZIP (no compression — PNGs are already compressed).
const CRC_TABLE = ((): Uint32Array => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function buildZip(files: Array<{ path: string; data: Uint8Array }>): Blob {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const te = new TextEncoder();
  for (const f of files) {
    const name = te.encode(f.path);
    const crc = crc32(f.data);
    const local = new Uint8Array(30 + name.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, f.data.length, true);
    dv.setUint32(22, f.data.length, true);
    dv.setUint16(26, name.length, true);
    local.set(name, 30);
    chunks.push(local, f.data);
    const cent = new Uint8Array(46 + name.length);
    const cv = new DataView(cent.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, f.data.length, true);
    cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cent.set(name, 46);
    central.push(cent);
    offset += local.length + f.data.length;
  }
  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, end] as BlobPart[], { type: 'application/zip' });
}

const STATIC_COPIES = [
  'ui/CLT-Title-Day.png', 'ui/CLT-Title-Night.png',
  'ui/CLT-Title-Sunrise.png', 'ui/CLT-Title-Sunset.png',
  'ui/Character-Bases-1.png',
];

async function assembleZip(): Promise<Blob> {
  const files: Array<{ path: string; data: Uint8Array }> = [];
  for (const e of entries) {
    files.push({ path: `art-dump/${e.path}`, data: dataURLToBytes(e.canvas.toDataURL('image/png')) });
  }
  files.push({
    path: 'art-dump/contact-sheet.png',
    data: dataURLToBytes(buildContactSheet().toDataURL('image/png')),
  });
  for (const p of STATIC_COPIES) {
    try {
      const res = await fetch(`/${p}`);
      if (res.ok) files.push({ path: `art-dump/static-ui/${p.split('/').pop()}`, data: new Uint8Array(await res.arrayBuffer()) });
    } catch { /* skip missing static asset */ }
  }
  return buildZip(files);
}

function finish(): void {
  statusEl.textContent = `${entries.length} swatches rendered — DOWNLOAD ZIP packs native PNGs + contact sheet + static /ui copies`;
  (window as unknown as { __artdump: unknown }).__artdump = {
    ready: true,
    list: () => entries.map((e) => e.path),
    batch: (i: number, n: number) =>
      entries.slice(i, i + n).map((e) => ({ path: e.path, dataURL: e.canvas.toDataURL('image/png') })),
    sheet: () => buildContactSheet().toDataURL('image/png'),
  };
}

document.getElementById('dl')!.addEventListener('click', () => {
  void assembleZip().then((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `driver-city-art-dump-${new Date().toISOString().slice(0, 10)}.zip`;
    a.click();
  });
});

try {
  run();
} catch (err) {
  statusEl.innerHTML = `<span class="warn">HARNESS FAILED: ${(err as Error).stack ?? err}</span>`;
  console.error('artdump run() failed:', err);
}
