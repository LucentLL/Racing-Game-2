/**
 * H1085 (cel-shade): a generic Auto-Modellista-style post-pass for a
 * vehicle — an INK OUTLINE — without touching any per-chassis renderer.
 * (H1085h: the directional SHADOW BAND was removed from vehicles; a flat
 * band on a top-down car with real height reads wrong. Buildings, which
 * are flat, keep their band in roofs.ts.)
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
}

const INK = '#0a0c14';
const OUTLINE_PX = 1.6;      // rim width in bake-tile px
const MAX_TILE = 340;        // skip cel (plain render) above this tile size
const CACHE_CAP = 160;

interface Baked { canvas: HTMLCanvasElement; half: number; scale: number; }
/** null value = "too big to bake, render plain" (cached so we don't retry). */
const cache = new Map<string, Baked | null>();
/** H1145: lifetime bake counter, published to window.__celBakes — a
 *  probe watching it while driving detects rebake storms (it should go
 *  quiet once every appearance in view has baked once). */
let _celBakes = 0;

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
  outline: boolean,
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

  // 2. compose result = outline rim → car. H1085h: the shadow BAND was
  // removed from vehicles — a flat cast/band on a top-down car reads wrong
  // (cars have height; user report "shadow cutting cars in half"). Cel on
  // vehicles is now the ink outline only; the world (roofs) keeps its band.
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

  // H1145: FIXED bake scale — the key used to embed the LIVE camera
  // zoom quantized to 0.5 buckets, and the game zoom BREATHES with
  // speed (speed/trailer/reverse blend). Whenever the zoom sat near a
  // bucket edge, the bucket flapped and EVERY visible car re-baked its
  // tile EVERY frame — the user's recording showed trf-e at 18-24 ms
  // during a 99-135 mph chase (scales with car count → the congested-
  // intersection 20 fps). The blit below already rescales the tile to
  // the live transform, so the bake scale never needed to track zoom:
  // bake once at 4 px/world-unit (≥ any play zoom; NN keeps the
  // pixel-art read) and the cache is zoom-independent.
  const scaleB = 4;
  const ck = key + '|' + (outline ? 'o' : '');

  let baked = cache.get(ck);
  if (baked === undefined) {
    baked = bake(scaleB, worldRadius, renderLocal, outline);
    // H1145: incremental eviction — the old cache.clear() at cap threw
    // away EVERY tile and re-baked the whole view over the next frames
    // (a periodic storm). Drop the ~oldest quarter instead (Map keeps
    // insertion order).
    if (cache.size >= CACHE_CAP) {
      let drop = CACHE_CAP >> 2;
      for (const k of cache.keys()) {
        cache.delete(k);
        if (--drop <= 0) break;
      }
    }
    cache.set(ck, baked);
    _celBakes++;
    (window as unknown as { __celBakes?: number }).__celBakes = _celBakes;
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
