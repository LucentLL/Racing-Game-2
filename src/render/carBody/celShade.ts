/**
 * H1085 (cel-shade): a generic Auto-Modellista-style post-pass for a
 * vehicle — INK OUTLINE + a directional SHADOW BAND — without touching
 * any per-chassis renderer.
 *
 * PERF MODEL (H1085d — the meet-idle 17fps fix): a naive per-frame
 * offscreen pass per car melts down with a lot of cars (a car-meet lot
 * ≈ 20 STATIC vehicles). So we BAKE each distinct appearance ONCE into a
 * small tile (the car drawn upright at origin, cel effects applied) and
 * then just blit that tile rotated to each car's pose. N cars become N
 * cheap drawImages instead of N full offscreen passes; a lot of
 * identical/near-identical cars collapses to a handful of bakes.
 *
 * The bake is car-LOCAL (upright), so the ink outline + shadow band ride
 * with the body when the tile is rotated to the car's heading — a common
 * toon convention. Blits use nearest-neighbour (imageSmoothing off) so
 * they stay crisp under the game's pixelated look even when the live
 * zoom differs from the bake zoom. No getImageData anywhere.
 *
 * Caller contract: `renderLocal(ctx)` must draw the vehicle at LOCAL
 * ORIGIN (0,0), UPRIGHT (angle 0), in world units (exactly what
 * drawTopCar / drawPlayerCarV2 do when handed a zero pose). We handle
 * translate/rotate to the real world pose.
 */

export interface CelOpts {
  outline?: boolean;
  band?: boolean;
}

const INK = '#0a0c14';
const BAND = '#0a0c18';
const OUTLINE_PX = 1.6;      // rim width in bake-tile px
const BAND_ALPHA = 0.15;
const MAX_TILE = 340;        // skip cel (plain render) above this tile size
const CACHE_CAP = 160;

interface Baked { canvas: HTMLCanvasElement; half: number; scale: number; }
/** null value = "too big to bake, render plain" (cached so we don't retry). */
const cache = new Map<string, Baked | null>();

/** Circumscribed world-radius of a car footprint (rotation-safe) + 10%. */
export function celRadius(size: readonly [number, number] | undefined): number {
  if (!size) return 20;
  return Math.hypot(size[0], size[1]) * 0.55;
}

function newTile(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const x = c.getContext('2d')!;
  return [c, x];
}

/** Bake the car upright at `scale` px/world into a tile, apply outline +
 *  band. Returns null if the tile would exceed MAX_TILE. */
function bake(
  scale: number, worldRadius: number,
  renderLocal: (c: CanvasRenderingContext2D) => void,
  outline: boolean, band: boolean,
): Baked | null {
  const pad = OUTLINE_PX + 4;
  const size = Math.ceil((worldRadius * scale + pad) * 2);
  if (size > MAX_TILE || size < 6) return null;
  const half = size / 2;

  // 1. the car, upright + centred.
  const [car, cctx] = newTile(size);
  cctx.setTransform(scale, 0, 0, scale, half, half);
  renderLocal(cctx);
  cctx.setTransform(1, 0, 0, 1, 0, 0);

  // 2. compose result = outline rim → car → band.
  const [res, rctx] = newTile(size);
  rctx.imageSmoothingEnabled = false;

  if (outline) {
    const [sil, sctx] = newTile(size);
    sctx.drawImage(car, 0, 0);
    sctx.globalCompositeOperation = 'source-in';
    sctx.fillStyle = INK;
    sctx.fillRect(0, 0, size, size);
    const k = OUTLINE_PX;
    const offs = [[-k, 0], [k, 0], [0, -k], [0, k], [-k, -k], [k, -k], [-k, k], [k, k]];
    for (const [ox, oy] of offs) rctx.drawImage(sil, ox, oy);
  }

  rctx.drawImage(car, 0, 0);

  if (band) {
    const [bnd, bctx] = newTile(size);
    bctx.drawImage(car, 0, 0);
    bctx.globalCompositeOperation = 'source-atop';
    bctx.fillStyle = BAND;
    bctx.globalAlpha = BAND_ALPHA;
    // hard half-plane through the tile centre, light from top-left.
    // Shadow only the FAR (down-right) corner: bias the split line PAST
    // the car centre toward the shadow side by ~42% of the car radius, so
    // it reads as a shaded corner — NOT a car cut in half (user report).
    const inv = Math.SQRT1_2, BIG = size;
    const D = worldRadius * scale * 0.42;
    const cx = half + inv * D, cy = half + inv * D;
    const nX = inv, nY = inv, tX = -inv, tY = inv;
    bctx.beginPath();
    bctx.moveTo(cx + tX * BIG, cy + tY * BIG);
    bctx.lineTo(cx - tX * BIG, cy - tY * BIG);
    bctx.lineTo(cx - tX * BIG + nX * BIG, cy - tY * BIG + nY * BIG);
    bctx.lineTo(cx + tX * BIG + nX * BIG, cy + tY * BIG + nY * BIG);
    bctx.closePath();
    bctx.fill();
    rctx.drawImage(bnd, 0, 0);
  }

  return { canvas: res, half, scale };
}

/**
 * Draw a vehicle with the cel treatment. `worldX/worldY/worldAngle` =
 * its pose; `key` = a stable appearance id (car id / bodyType + colour +
 * braking + night + …); `worldRadius` = celRadius(size); `renderLocal`
 * draws the car at local origin, upright, in world units.
 */
export function drawVehicleCel(
  ctx: CanvasRenderingContext2D,
  worldX: number,
  worldY: number,
  worldAngle: number,
  key: string,
  worldRadius: number,
  renderLocal: (c: CanvasRenderingContext2D) => void,
  opts: CelOpts = {},
): void {
  const plain = (): void => {
    ctx.save();
    ctx.translate(worldX, worldY);
    ctx.rotate(worldAngle);
    renderLocal(ctx);
    ctx.restore();
  };
  if (typeof document === 'undefined') { plain(); return; }
  const outline = opts.outline !== false;
  const band = opts.band !== false;

  const m = ctx.getTransform();
  const scale = Math.hypot(m.a, m.b) || 1;
  // quantize the bake scale to 0.5 buckets so a zoom sweep re-bakes a
  // few times, not every frame; the NN blit covers the in-between.
  const scaleB = Math.max(0.5, Math.round(scale * 2) / 2);
  const ck = key + '|' + scaleB + '|' + (outline ? 'o' : '') + (band ? 'b' : '');

  let baked = cache.get(ck);
  if (baked === undefined) {
    baked = bake(scaleB, worldRadius, renderLocal, outline, band);
    if (cache.size >= CACHE_CAP) cache.clear();
    cache.set(ck, baked);
  }
  if (!baked) { plain(); return; }

  ctx.save();
  ctx.translate(worldX, worldY);
  ctx.rotate(worldAngle);
  ctx.scale(1 / baked.scale, 1 / baked.scale);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(baked.canvas, -baked.half, -baked.half);
  ctx.restore();
}
