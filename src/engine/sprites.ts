import {
  VEHICLE_IMAGE_BASE,
  VEHICLE_IMAGE_MANIFEST,
  type VehicleSpriteEntry,
  type PopupHeadlightSpriteEntry,
  type MultiVariantSpriteEntry,
} from '@/config/cars/manifest';
import { SPRITE_CACHE_LONG_AXIS } from '@/config/cars/spriteBuffer';

type RGB = readonly [number, number, number];

interface SpriteRecord {
  ready: boolean;
  canvas: HTMLCanvasElement | null;
  canvasUp: HTMLCanvasElement | null;
  isDual: boolean;
  isVariant: boolean;
  variantCanvases: Record<string, HTMLCanvasElement> | null;
  variantAnchors: Record<string, RGB> | null;
}

const vehicleSprites: Record<string, SpriteRecord> = {};

function isPopup(entry: VehicleSpriteEntry): entry is PopupHeadlightSpriteEntry {
  return typeof entry === 'object' && 'down' in entry && 'up' in entry;
}

function isMultiVariant(entry: VehicleSpriteEntry): entry is MultiVariantSpriteEntry {
  return typeof entry === 'object' && 'variants' in entry;
}

function downscaleSpriteToCache(src: HTMLCanvasElement): HTMLCanvasElement {
  const sw = src.width;
  const sh = src.height;
  const longAxis = Math.max(sw, sh);
  if (longAxis <= SPRITE_CACHE_LONG_AXIS) return src;
  const scale = SPRITE_CACHE_LONG_AXIS / longAxis;
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));
  const cache = document.createElement('canvas');
  cache.width = dw;
  cache.height = dh;
  const cctx = cache.getContext('2d');
  if (!cctx) return src;
  cctx.imageSmoothingEnabled = true;
  cctx.imageSmoothingQuality = 'high';
  cctx.drawImage(src, 0, 0, dw, dh);
  return cache;
}

/** H1055: after the flood-fill knocks out a sprite's solid background, an
 *  anti-aliased ring of pixels that blend the car colour into the OLD
 *  background survives — they sit too far from the pure background colour for
 *  the tol=14 fill to remove. On a light/white source background that ring
 *  reads as the grey/white HALO around the car the user reported.
 *
 *  This pass feathers + decontaminates the ring: for each boundary pixel still
 *  within `outerTol` of the background colour it drops alpha toward 0 in
 *  proportion to how background-like the pixel is (`t`), and un-mixes the
 *  background tint back out of the RGB (C = (P − t·bg)/(1−t)), so the edge
 *  fades cleanly to transparent instead of to a pale outline. Two layers cover
 *  the typical ~2 px fringe. Saturated car-colour edges (d ≥ outerTol) are left
 *  fully opaque so a brightly-painted body keeps a crisp silhouette.
 *
 *  NOTE: a near-white car on a near-white background is fundamentally ambiguous
 *  (its own light edge looks like background), so those specific sprites are
 *  still best shipped with real transparency baked in. */
function defringeEdges(
  px: Uint8ClampedArray,
  w: number,
  h: number,
  bgR: number,
  bgG: number,
  bgB: number,
): void {
  const innerTol = 14;
  const outerTol = 70;
  const layers = 2;
  for (let L = 0; L < layers; L++) {
    const edits: number[] = []; // flat quints: [i, alpha, r, g, b, ...]
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (px[i + 3] === 0) continue;
        // Boundary = image edge, or 4-adjacent to a transparent pixel.
        let bnd = x === 0 || y === 0 || x === w - 1 || y === h - 1;
        if (!bnd) {
          bnd =
            px[i - 4 + 3] === 0 || px[i + 4 + 3] === 0 ||
            px[i - w * 4 + 3] === 0 || px[i + w * 4 + 3] === 0;
        }
        if (!bnd) continue;
        const d = Math.max(
          Math.abs(px[i] - bgR),
          Math.abs(px[i + 1] - bgG),
          Math.abs(px[i + 2] - bgB),
        );
        if (d >= outerTol) continue; // real car colour — keep opaque
        let t = (outerTol - d) / (outerTol - innerTol);
        if (t < 0) t = 0; else if (t > 1) t = 1; // 1 = background, 0 = car
        const newA = Math.min(px[i + 3], Math.round(px[i + 3] * (1 - t)));
        let r = px[i], g = px[i + 1], b = px[i + 2];
        if (t < 0.985) {
          const inv = 1 / (1 - t);
          r = (px[i] - t * bgR) * inv;
          g = (px[i + 1] - t * bgG) * inv;
          b = (px[i + 2] - t * bgB) * inv;
        }
        // Uint8ClampedArray clamps/rounds the float RGB on assignment.
        edits.push(i, newA, r, g, b);
      }
    }
    for (let k = 0; k < edits.length; k += 5) {
      const i = edits[k];
      px[i] = edits[k + 2];
      px[i + 1] = edits[k + 3];
      px[i + 2] = edits[k + 4];
      px[i + 3] = edits[k + 1];
    }
  }
}

interface ProcessedSprite {
  canvas: HTMLCanvasElement;
  isPortrait: boolean;
  trimmed?: boolean;
  trimDelta?: [number, number];
}

function processLoadedImg(img: HTMLImageElement): ProcessedSprite {
  const isPortrait = img.height > img.width;
  const out = document.createElement('canvas');
  if (isPortrait) {
    out.width = img.height;
    out.height = img.width;
    const octx = out.getContext('2d');
    if (octx) {
      octx.translate(img.height, 0);
      octx.rotate(Math.PI / 2);
      octx.drawImage(img, 0, 0);
    }
  } else {
    out.width = img.width;
    out.height = img.height;
    out.getContext('2d')?.drawImage(img, 0, 0);
  }

  try {
    const octx = out.getContext('2d');
    if (!octx) return { canvas: downscaleSpriteToCache(out), isPortrait };
    const w = out.width;
    const h = out.height;
    const id = octx.getImageData(0, 0, w, h);
    const px = id.data;
    const corners: ReadonlyArray<readonly [number, number]> = [
      [0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1],
    ];

    let allCornersTransparent = true;
    for (const [cx, cy] of corners) {
      if (px[(cy * w + cx) * 4 + 3] !== 0) {
        allCornersTransparent = false;
        break;
      }
    }

    if (!allCornersTransparent) {
      let sR = 0, sG = 0, sB = 0, opCnt = 0;
      for (const [cx, cy] of corners) {
        const ci = (cy * w + cx) * 4;
        if (px[ci + 3] !== 0) {
          sR += px[ci];
          sG += px[ci + 1];
          sB += px[ci + 2];
          opCnt++;
        }
      }
      const bgR = (sR / opCnt) | 0;
      const bgG = (sG / opCnt) | 0;
      const bgB = (sB / opCnt) | 0;
      const tol = 14;
      const stack: number[] = [];
      for (const [cx, cy] of corners) {
        const ci = (cy * w + cx) * 4;
        if (
          px[ci + 3] !== 0 &&
          Math.abs(px[ci] - bgR) <= tol &&
          Math.abs(px[ci + 1] - bgG) <= tol &&
          Math.abs(px[ci + 2] - bgB) <= tol
        ) {
          stack.push(cx, cy);
        }
      }
      while (stack.length) {
        const y = stack.pop()!;
        const x = stack.pop()!;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const i = (y * w + x) * 4;
        if (px[i + 3] === 0) continue;
        if (Math.abs(px[i] - bgR) > tol) continue;
        if (Math.abs(px[i + 1] - bgG) > tol) continue;
        if (Math.abs(px[i + 2] - bgB) > tol) continue;
        px[i + 3] = 0;
        stack.push(x - 1, y);
        stack.push(x + 1, y);
        stack.push(x, y - 1);
        stack.push(x, y + 1);
      }
      // H1055: feather + decontaminate the anti-aliased ring the flood-fill
      // leaves so a light source background no longer reads as a halo.
      defringeEdges(px, w, h, bgR, bgG, bgB);
      octx.putImageData(id, 0, 0);
    }
  } catch {
    /* CORS-tainted; ship as-is */
  }

  try {
    const octx = out.getContext('2d');
    if (!octx) return { canvas: downscaleSpriteToCache(out), isPortrait };
    const w = out.width;
    const h = out.height;
    const id = octx.getImageData(0, 0, w, h);
    const px = id.data;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (px[(y * w + x) * 4 + 3] > 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX >= minX && maxY >= minY) {
      const tw = maxX - minX + 1;
      const th = maxY - minY + 1;
      if (tw < w || th < h) {
        const trimmed = document.createElement('canvas');
        trimmed.width = tw;
        trimmed.height = th;
        trimmed.getContext('2d')?.drawImage(out, -minX, -minY);
        return {
          canvas: downscaleSpriteToCache(trimmed),
          isPortrait,
          trimmed: true,
          trimDelta: [w - tw, h - th],
        };
      }
    }
  } catch {
    /* CORS-tainted; keep un-trimmed canvas */
  }

  return { canvas: downscaleSpriteToCache(out), isPortrait };
}

/** H173: bookkeeping for the diagnostic dump. Tracks total entries
 *  enqueued vs ready so the debug HUD strip can show "X/N" and the
 *  delayed log can name what's still missing. */
let _spriteLoadTotal = 0;
let _spriteLoadStarted = false;
export function getSpriteLoadStats(): { ready: number; total: number; missing: string[] } {
  let ready = 0;
  const missing: string[] = [];
  for (const key in vehicleSprites) {
    if (vehicleSprites[key].ready) ready++;
    else missing.push(key);
  }
  return { ready, total: _spriteLoadTotal, missing };
}

export function loadVehicleSprites(): void {
  if (_spriteLoadStarted) {
    console.warn('[VehicleSprites] loadVehicleSprites() called twice — second call ignored');
    return;
  }
  _spriteLoadStarted = true;
  _spriteLoadTotal = Object.keys(VEHICLE_IMAGE_MANIFEST).length;
  // H173 → H174: 3-second post-boot regression check. Logs ONLY when
  // sprites are still missing (success path is silent now that LFS
  // setup is documented in the project_driver_city_lfs_gotcha memory).
  // Catches future LFS / network / manifest issues automatically.
  setTimeout(() => {
    const stats = getSpriteLoadStats();
    if (stats.missing.length > 0) {
      console.error(
        '[VehicleSprites] still NOT-READY after 3s:',
        stats.missing.length, '/', stats.total,
        '— missing keys:', stats.missing,
      );
    }
  }, 3000);
  for (const bodyType in VEHICLE_IMAGE_MANIFEST) {
    const entry = VEHICLE_IMAGE_MANIFEST[bodyType];
    const dual = isPopup(entry);
    const variant = isMultiVariant(entry);

    const rec: SpriteRecord = {
      ready: false,
      canvas: null,
      canvasUp: null,
      isDual: dual,
      isVariant: variant,
      variantCanvases: variant ? {} : null,
      variantAnchors: variant ? {} : null,
    };
    vehicleSprites[bodyType] = rec;

    let loaded = 0;
    const need = dual ? 2 : variant ? Object.keys(entry.variants).length : 1;

    const maybeReady = (): void => {
      if (loaded < need) return;
      rec.ready = true;
    };

    const loadOne = (filename: string, slotKey: string, isVariantSlot: boolean): void => {
      const url = VEHICLE_IMAGE_BASE + filename;
      const img = new Image();
      // H172: REMOVED img.crossOrigin = 'anonymous'. Public/ assets
      // are same-origin under Vite dev + Vite preview + the eventual
      // Tauri/Capacitor bundle. crossOrigin='anonymous' forces the
      // browser to require an Access-Control-Allow-Origin header on
      // the response; some Vite middleware paths omit it for static
      // assets, causing the image to abort without firing onerror
      // (it appears to "load" but img.naturalWidth stays 0). Removing
      // the attribute lets the load proceed as a normal same-origin
      // fetch. The downside — a CROSS-origin sprite would now CORS-
      // taint its canvas making getImageData fail — is already handled
      // by processLoadedImg's try/catch around the trim pass.
      img.onload = () => {
        // H172: wrap the body in try/catch with explicit error logging
        // so any unexpected throw in processLoadedImg surfaces in
        // DevTools instead of leaving rec.ready stuck at false with no
        // visible failure. Without this, an exception here would skip
        // the loaded++ / maybeReady() sequence silently.
        try {
          const proc = processLoadedImg(img);
          if (isVariantSlot && rec.variantCanvases) {
            rec.variantCanvases[slotKey] = proc.canvas;
          } else if (slotKey === 'canvas') {
            rec.canvas = proc.canvas;
          } else if (slotKey === 'canvasUp') {
            rec.canvasUp = proc.canvas;
          }
          loaded++;
          maybeReady();
        } catch (err) {
          console.error(
            '[VehicleSprites] onload THREW:',
            bodyType,
            '→',
            VEHICLE_IMAGE_BASE + filename,
            err,
          );
        }
      };
      img.onerror = (ev) => {
        // H170: upgraded console.warn → console.error so the failure
        // surfaces in DevTools' "Errors" filter, not just "Warnings".
        // H172: with crossOrigin removed, this should only fire for
        // actual 404s / network errors. CORS-related silent failures
        // are no longer possible on same-origin assets.
        console.error(
          '[VehicleSprites] FAILED to load:',
          bodyType,
          '→',
          VEHICLE_IMAGE_BASE + filename,
          ev,
        );
      };
      img.src = url;
    };

    if (dual) {
      loadOne(entry.down, 'canvas', false);
      loadOne(entry.up, 'canvasUp', false);
    } else if (variant) {
      for (const slotKey in entry.anchors) {
        const hx = entry.anchors[slotKey];
        const m = hx.replace('#', '').match(/.{2}/g) ?? ['80', '80', '80'];
        rec.variantAnchors![slotKey] = [
          parseInt(m[0], 16),
          parseInt(m[1], 16),
          parseInt(m[2], 16),
        ];
      }
      for (const slotKey in entry.variants) {
        loadOne(entry.variants[slotKey], slotKey, true);
      }
    } else {
      loadOne(entry, 'canvas', false);
    }
  }
}

export function hasVehicleSprite(bodyType: string): boolean {
  const s = vehicleSprites[bodyType];
  return !!(s && s.ready);
}

export function getVehicleSprite(
  bodyType: string,
  headlightsUp?: boolean,
  factoryHex?: string,
): HTMLCanvasElement | null {
  const s = vehicleSprites[bodyType];
  if (!s || !s.ready) return null;
  if (s.isVariant && s.variantCanvases && s.variantAnchors) {
    const slots = Object.keys(s.variantCanvases);
    if (!slots.length) return null;
    let bestSlot = slots[0];
    if (factoryHex && typeof factoryHex === 'string') {
      const m = factoryHex.replace('#', '').match(/.{2}/g);
      if (m && m.length === 3) {
        const cr = parseInt(m[0], 16);
        const cg = parseInt(m[1], 16);
        const cb = parseInt(m[2], 16);
        let bestD = Infinity;
        for (const slot of slots) {
          const a = s.variantAnchors[slot];
          if (!a) continue;
          const dr = a[0] - cr;
          const dg = a[1] - cg;
          const db = a[2] - cb;
          const d = dr * dr + dg * dg + db * db;
          if (d < bestD) {
            bestD = d;
            bestSlot = slot;
          }
        }
      }
    }
    return s.variantCanvases[bestSlot] ?? s.variantCanvases[slots[0]];
  }
  if (headlightsUp && s.canvasUp) return s.canvasUp;
  return s.canvas;
}
