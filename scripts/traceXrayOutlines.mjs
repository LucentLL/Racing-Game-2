// X-ray body-outline tracer + XRAY_OUTLINES codegen.
//
// GOAL (user, 2026-07-29): the X-ray mode's dashed body outline must match
// the car sprite's outline AS IMPORTED — not the generic per-bodyType vector
// silhouette. This script replicates the game's sprite processing pipeline
// (engine/sprites.ts processLoadedImg: rotate portrait->landscape, corner
// background flood-removal, alpha-trim) on every manifest PNG, traces the
// alpha contour of the trimmed box, simplifies it, and bakes normalized
// polygons into src/config/cars/xrayOutlines.ts.
//
// A point (u, v) in [0,1]^2 spans the TRIMMED opaque box — exactly the
// canvas the renderer stretches to (L*sb[0]) x (W*sb[1]) — so the runtime
// mapping is x = (u - 0.5) * L * sb0, y = (v - 0.5) * W * sb1.
//
// USAGE:
//   node scripts/traceXrayOutlines.mjs           -> writes xrayOutlines.ts
//   node scripts/traceXrayOutlines.mjs --debug   -> also writes a visual
//        contact sheet (mask + traced outline per key) to
//        scripts/.xray_outline_debug.png for eyeball verification.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { decode, floodRemoveBg, parseManifest, CARS_DIR } from './measureSprite.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PATH = path.join(ROOT, 'src', 'config', 'cars', 'xrayOutlines.ts');
const DEBUG_PNG = path.join(ROOT, 'scripts', '.xray_outline_debug.png');

const ALPHA_T = 8;      // same opacity threshold the trim + measurer use
const TRACE_RES = 150;  // long-axis resolution the contour is traced at
const RDP_EPS = 1.15;   // simplification tolerance in trace-res pixels

// Bikes keep their bespoke X-ray body (drawTopCar's bike branch) — their
// traced outlines are handlebar/mirror noise, so they are not emitted.
const SKIP_KEYS = new Set(['kawasaki_ninja', 'honda_cb500', 'suzuki_bandit', 'suzuki_katana']);

// ---------------------------------------------------------------- pipeline
/** Rotate portrait art to landscape exactly like processLoadedImg:
 *  translate(H,0) rotate(+90deg) => src (x,y) -> out (H-1-y, x). */
function toLandscape(width, height, rgba) {
  if (height <= width) return { w: width, h: height, px: rgba };
  const w = height, h = width;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const si = (y * width + x) * 4;
      const ox = height - 1 - y, oy = x;
      const oi = (oy * w + ox) * 4;
      out[oi] = rgba[si]; out[oi + 1] = rgba[si + 1];
      out[oi + 2] = rgba[si + 2]; out[oi + 3] = rgba[si + 3];
    }
  }
  return { w, h, px: out };
}

function trimBox(w, h, px) {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3] > ALPHA_T) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX) return null;
  return { minX, minY, tw: maxX - minX + 1, th: maxY - minY + 1 };
}

/** Downsample the trimmed alpha into a boolean mask, long axis = TRACE_RES.
 *  A cell is solid when >= 45% of its source pixels are opaque — keeps the
 *  traced edge on the visual silhouette instead of the anti-alias skirt. */
function downsampleMask(w, px, box) {
  const scale = Math.min(1, TRACE_RES / Math.max(box.tw, box.th));
  const mw = Math.max(2, Math.round(box.tw * scale));
  const mh = Math.max(2, Math.round(box.th * scale));
  const mask = new Uint8Array(mw * mh);
  for (let my = 0; my < mh; my++) {
    const y0 = box.minY + Math.floor((my / mh) * box.th);
    const y1 = box.minY + Math.max(y0 - box.minY + 1, Math.floor(((my + 1) / mh) * box.th));
    for (let mx = 0; mx < mw; mx++) {
      const x0 = box.minX + Math.floor((mx / mw) * box.tw);
      const x1 = box.minX + Math.max(x0 - box.minX + 1, Math.floor(((mx + 1) / mw) * box.tw));
      let solid = 0, total = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          total++;
          if (px[(y * w + x) * 4 + 3] > ALPHA_T) solid++;
        }
      }
      mask[my * mw + mx] = solid / total >= 0.45 ? 1 : 0;
    }
  }
  return { mask, mw, mh };
}

/** Keep only the largest 4-connected solid component (drops stray pixels
 *  like exhaust smoke specks so the contour trace can't latch onto them). */
function largestComponent(mask, mw, mh) {
  const labels = new Int32Array(mw * mh).fill(-1);
  let best = -1, bestSize = 0, next = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || labels[i] !== -1) continue;
    const stack = [i];
    labels[i] = next;
    let size = 0;
    while (stack.length) {
      const j = stack.pop();
      size++;
      const x = j % mw, y = (j / mw) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= mw || ny >= mh) continue;
        const k = ny * mw + nx;
        if (mask[k] && labels[k] === -1) { labels[k] = next; stack.push(k); }
      }
    }
    if (size > bestSize) { bestSize = size; best = next; }
    next++;
  }
  const out = new Uint8Array(mw * mh);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] && labels[i] === best ? 1 : 0;
  return out;
}

/** Crack-following boundary trace: walks the lattice EDGES between solid and
 *  empty cells keeping the solid region on the right, so it always produces
 *  one closed loop and cannot get lost on 1-px-wide features (antennas,
 *  mirrors) the way a Moore pixel-walk can. Returns lattice-corner coords
 *  [x, y, ...] in [0..mw] x [0..mh]. */
function traceContour(mask, mw, mh) {
  const solid = (x, y) => (x >= 0 && y >= 0 && x < mw && y < mh && mask[y * mw + x] === 1);
  let sx = -1, sy = -1;
  outer: for (let y = 0; y < mh; y++) {
    for (let x = 0; x < mw; x++) {
      if (solid(x, y)) { sx = x; sy = y; break outer; }
    }
  }
  if (sx < 0) return [];
  // Directions: 0=+x, 1=+y, 2=-x, 3=-y. Starting at the topmost-leftmost
  // solid pixel's top-left corner heading +x, that pixel is ahead-right and
  // the row above it (empty by construction) is ahead-left.
  const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
  const aheadLeft = (x, y, d) =>
    d === 0 ? solid(x, y - 1)
    : d === 1 ? solid(x, y)
    : d === 2 ? solid(x - 1, y)
    : solid(x - 1, y - 1);
  const aheadRight = (x, y, d) =>
    d === 0 ? solid(x, y)
    : d === 1 ? solid(x - 1, y)
    : d === 2 ? solid(x - 1, y - 1)
    : solid(x, y - 1);
  let x = sx, y = sy, d = 0;
  const pts = [x, y];
  for (let guard = 0; guard < (mw + 1) * (mh + 1) * 4; guard++) {
    if (aheadLeft(x, y, d)) d = (d + 3) % 4;        // solid crept left -> turn left
    else if (!aheadRight(x, y, d)) d = (d + 1) % 4; // lost the wall -> turn right
    x += DX[d]; y += DY[d];
    if (x === sx && y === sy) break;                // loop closed
    pts.push(x, y);
  }
  return pts;
}

/** Ramer-Douglas-Peucker on a closed polyline (flat [x,y,...]). */
function simplify(flat, eps) {
  const n = flat.length / 2;
  if (n <= 8) return flat;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let worst = -1, worstD = 0;
    const ax = flat[a * 2], ay = flat[a * 2 + 1];
    const bx = flat[b * 2], by = flat[b * 2 + 1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    for (let i = a + 1; i < b; i++) {
      const px = flat[i * 2] - ax, py = flat[i * 2 + 1] - ay;
      const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
      const ex = px - t * dx, ey = py - t * dy;
      const d = ex * ex + ey * ey;
      if (d > worstD) { worstD = d; worst = i; }
    }
    if (worst >= 0 && worstD > eps * eps) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    } else {
      keep[b] = 1;
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(flat[i * 2], flat[i * 2 + 1]);
  return out;
}

function traceKey(file) {
  const { width, height, rgba } = decode(fs.readFileSync(file));
  const land = toLandscape(width, height, rgba);
  floodRemoveBg(land.w, land.h, land.px);
  const box = trimBox(land.w, land.h, land.px);
  if (!box) throw new Error('fully transparent after bg removal');
  const { mask: rawMask, mw, mh } = downsampleMask(land.w, land.px, box);
  const mask = largestComponent(rawMask, mw, mh);
  const contour = traceContour(mask, mw, mh);
  if (contour.length < 6) throw new Error('degenerate contour');
  const simp = simplify(contour, RDP_EPS);
  // Normalize lattice corners into [0,1] of the trimmed box.
  const norm = [];
  for (let i = 0; i < simp.length; i += 2) {
    norm.push(
      Math.round((simp[i] / mw) * 1000) / 1000,
      Math.round((simp[i + 1] / mh) * 1000) / 1000,
    );
  }
  return { norm, mask, mw, mh };
}

// ------------------------------------------------------------- debug sheet
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(w, h, rgb) {
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
function line(rgb, w, x0, y0, x1, y1, r, g, b) {
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy, x = x0, y = y0;
  for (let guard = 0; guard < 4096; guard++) {
    const i = (y * w + x) * 3;
    if (i >= 0 && i < rgb.length - 2) { rgb[i] = r; rgb[i + 1] = g; rgb[i + 2] = b; }
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
}

// ---------------------------------------------------------------- main
const debug = process.argv.includes('--debug');
const entries = parseManifest();
const rows = [];
const cells = [];
for (const { key, files } of entries) {
  if (SKIP_KEYS.has(key)) continue;
  const p = path.join(CARS_DIR, files[0]);
  if (!fs.existsSync(p)) { console.error(`[xray-outline] MISSING ${key}: ${files[0]}`); continue; }
  try {
    const { norm, mask, mw, mh } = traceKey(p);
    rows.push({ key, pts: norm });
    cells.push({ key, mask, mw, mh, pts: norm });
    console.error(`[xray-outline] ${key}: ${norm.length / 2} pts (mask ${mw}x${mh})`);
  } catch (e) {
    console.error(`[xray-outline] FAIL ${key}: ${e.message}`);
  }
}

const pad = Math.max(...rows.map((r) => r.key.length)) + 1;
const body = rows.map((r) =>
  `  ${(r.key + ':').padEnd(pad + 1)}[${r.pts.join(',')}],`,
).join('\n');
fs.writeFileSync(OUT_PATH, `/**
 * Per-sprite X-ray body outlines. AUTO-GENERATED by
 * scripts/traceXrayOutlines.mjs — DO NOT EDIT BY HAND; re-run the script
 * after adding or replacing a sprite PNG.
 *
 * Each entry is a closed polygon [u0,v0, u1,v1, ...] normalized to [0,1]^2
 * over the sprite's TRIMMED opaque box, traced from the PNG alpha through
 * the same pipeline the renderer uses (rotate portrait->landscape, corner
 * background flood-removal, alpha-trim). The runtime mapping matches the
 * sprite drawImage rect exactly:
 *   x = (u - 0.5) * L * spriteBuffer[0]
 *   y = (v - 0.5) * W * spriteBuffer[1]
 */
export const XRAY_OUTLINES: Record<string, readonly number[]> = {
${body}
};
`);
console.error(`[xray-outline] wrote ${rows.length} outlines -> ${path.relative(ROOT, OUT_PATH)}`);

if (debug) {
  const CELL = 170, LABEL = 12;
  const cols = 6, rowsN = Math.ceil(cells.length / cols);
  const W = cols * CELL, H = rowsN * (CELL / 2 + LABEL);
  const rgb = Buffer.alloc(W * H * 3, 24);
  cells.forEach((c, i) => {
    const cx0 = (i % cols) * CELL;
    const cy0 = ((i / cols) | 0) * (CELL / 2 + LABEL);
    const sc = Math.min((CELL - 12) / c.mw, (CELL / 2 - 8) / c.mh);
    const ox = cx0 + 6, oy = cy0 + 4;
    for (let y = 0; y < c.mh; y++) {
      for (let x = 0; x < c.mw; x++) {
        if (!c.mask[y * c.mw + x]) continue;
        const px = ox + Math.floor(x * sc), py = oy + Math.floor(y * sc);
        const j = (py * W + px) * 3;
        rgb[j] = 90; rgb[j + 1] = 90; rgb[j + 2] = 95;
      }
    }
    const n = c.pts.length / 2;
    for (let k = 0; k < n; k++) {
      const k2 = (k + 1) % n;
      line(rgb, W,
        ox + Math.round(c.pts[k * 2] * c.mw * sc), oy + Math.round(c.pts[k * 2 + 1] * c.mh * sc),
        ox + Math.round(c.pts[k2 * 2] * c.mw * sc), oy + Math.round(c.pts[k2 * 2 + 1] * c.mh * sc),
        255, 60, 60);
    }
  });
  fs.writeFileSync(DEBUG_PNG, encodePng(W, H, rgb));
  console.error(`[xray-outline] debug sheet -> ${path.relative(ROOT, DEBUG_PNG)}`);
}
