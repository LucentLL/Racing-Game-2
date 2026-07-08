/**
 * H1085 (cel-shade): a generic Auto-Modellista-style post-pass for a
 * vehicle — HARD CAST SHADOW + INK OUTLINE + a directional SHADOW BAND —
 * without touching any per-chassis renderer.
 *
 * How: the caller hands us a render function that draws the vehicle
 * exactly as it does today (sprite / V2 vector / X-ray — drawTopCar
 * self-applies the car pose on top of the active camera transform). We
 * render it into a small per-car off-screen buffer (the car centred in a
 * fixed SIZE×SIZE tile — cost is car-sized, NOT canvas-sized, so it
 * scales to a full traffic pool + a car-meet lot), then composite:
 *
 *   1. cast shadow — the silhouette, tinted dark, offset down-right onto
 *      the ground (grounds the car, kills the "floating flat" look);
 *   2. ink outline — the dark silhouette drawn at 8 one-pixel offsets so
 *      a crisp near-black rim rings the body (the strongest AM cue);
 *   3. the car itself;
 *   4. shadow band — a hard-edged dark half-plane through the car centre
 *      (light from screen top-left), clipped to the body via source-atop,
 *      so one side reads as a flat cel shadow.
 *
 * NO getImageData (that poisons perf — [[project_perf_cost_model]]). All
 * work happens in a SIZE×SIZE scratch; a vehicle whose on-screen extent
 * exceeds it falls back to a plain render (no cel) rather than clip.
 */

export interface CelOpts {
  outline?: boolean;
  band?: boolean;
  shadow?: boolean;
}

const INK = '#0a0c14';
const CAST = '#0a0c16';
const BAND = '#0a0c18';
const OUTLINE_PX = 1.6;      // screen-space rim width
const CAST_DX = 2.5, CAST_DY = 3.5, CAST_ALPHA = 0.34;
const BAND_ALPHA = 0.26;

/** Per-car scratch tile. Big enough for the largest vehicle at the
 *  highest zoom (semi ≈ 34 gu × ~7 pc-zoom ≈ 240 px + outline margin). */
const SIZE = 320, HALF = 160;

let buf: HTMLCanvasElement | null = null;
let bctx: CanvasRenderingContext2D | null = null;
let scr: HTMLCanvasElement | null = null;
let sctx: CanvasRenderingContext2D | null = null;

function ensure(): boolean {
  if (typeof document === 'undefined') return false;
  if (!buf) {
    buf = document.createElement('canvas'); buf.width = SIZE; buf.height = SIZE;
    bctx = buf.getContext('2d');
    scr = document.createElement('canvas'); scr.width = SIZE; scr.height = SIZE;
    sctx = scr.getContext('2d');
  }
  return !!(bctx && sctx);
}

/** Circumscribed world-radius of a car footprint (rotation-safe) + 10%. */
export function celRadius(size: readonly [number, number] | undefined): number {
  if (!size) return 20;
  return Math.hypot(size[0], size[1]) * 0.55;
}

/** Build a solid-`color` silhouette of `buf` onto `scr` (whole tile). */
function silhouette(color: string): void {
  const s = sctx!;
  s.setTransform(1, 0, 0, 1, 0, 0);
  s.globalCompositeOperation = 'source-over';
  s.globalAlpha = 1;
  s.clearRect(0, 0, SIZE, SIZE);
  s.drawImage(buf!, 0, 0);
  s.globalCompositeOperation = 'source-in';
  s.fillStyle = color;
  s.fillRect(0, 0, SIZE, SIZE);
  s.globalCompositeOperation = 'source-over';
}

/**
 * Draw `renderFn` (a vehicle) with the cel post-pass composited onto
 * `ctx`. `worldX/worldY` = vehicle centre (its px/py); `worldRadius` =
 * celRadius(car.size). `renderFn` must draw the car at its world pose
 * using the ctx it's given (exactly like the normal draw call).
 */
export function drawVehicleCel(
  ctx: CanvasRenderingContext2D,
  worldX: number,
  worldY: number,
  worldRadius: number,
  renderFn: (c: CanvasRenderingContext2D) => void,
  opts: CelOpts = {},
): void {
  if (!ensure()) { renderFn(ctx); return; }
  const b = bctx!, s = sctx!;
  const outline = opts.outline !== false;
  const band = opts.band !== false;
  const shadow = opts.shadow !== false;

  const m = ctx.getTransform();
  const scale = Math.hypot(m.a, m.b) || 1;
  const sx = m.a * worldX + m.c * worldY + m.e;
  const sy = m.b * worldX + m.d * worldY + m.f;
  const screenR = worldRadius * scale + OUTLINE_PX + CAST_DY + 4;
  // Too big for the scratch tile (huge zoom) → plain render, no cel.
  if (screenR * 2 > SIZE) { renderFn(ctx); return; }

  // --- render the vehicle into the tile, centred at (HALF, HALF) ---
  // Same camera matrix, but shifted so the car's screen centre lands at
  // the tile centre: buffer = screen + (HALF - sx, HALF - sy).
  b.setTransform(1, 0, 0, 1, 0, 0);
  b.globalCompositeOperation = 'source-over';
  b.globalAlpha = 1;
  b.clearRect(0, 0, SIZE, SIZE);
  b.setTransform(m.a, m.b, m.c, m.d, m.e + HALF - sx, m.f + HALF - sy);
  renderFn(b);
  b.setTransform(1, 0, 0, 1, 0, 0);

  // where the tile lands on the target (identity, screen space)
  const dx = sx - HALF, dy = sy - HALF;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;

  // 1. CAST SHADOW — offset dark silhouette on the ground.
  if (shadow) {
    silhouette(CAST);
    ctx.globalAlpha = CAST_ALPHA;
    ctx.drawImage(scr!, dx + CAST_DX, dy + CAST_DY);
    ctx.globalAlpha = 1;
  }

  // 2. INK OUTLINE — dark silhouette at 8 offsets → crisp rim.
  if (outline) {
    silhouette(INK);
    const k = OUTLINE_PX;
    const offs = [[-k, 0], [k, 0], [0, -k], [0, k], [-k, -k], [k, -k], [-k, k], [k, k]];
    for (const [ox, oy] of offs) ctx.drawImage(scr!, dx + ox, dy + oy);
  }

  // 3. THE CAR.
  ctx.drawImage(buf!, dx, dy);

  // 4. SHADOW BAND — hard half-plane through the tile centre, light from
  //    top-left, clipped to the body via source-atop.
  if (band) {
    s.setTransform(1, 0, 0, 1, 0, 0);
    s.globalCompositeOperation = 'source-over';
    s.globalAlpha = 1;
    s.clearRect(0, 0, SIZE, SIZE);
    s.drawImage(buf!, 0, 0);
    s.globalCompositeOperation = 'source-atop';
    s.fillStyle = BAND;
    s.globalAlpha = BAND_ALPHA;
    const inv = Math.SQRT1_2, BIG = SIZE;
    const D = 4;                    // bias toward the lit side
    const cx = HALF - inv * D, cy = HALF - inv * D;
    const nX = inv, nY = inv, tX = -inv, tY = inv;
    s.beginPath();
    s.moveTo(cx + tX * BIG, cy + tY * BIG);
    s.lineTo(cx - tX * BIG, cy - tY * BIG);
    s.lineTo(cx - tX * BIG + nX * BIG, cy - tY * BIG + nY * BIG);
    s.lineTo(cx + tX * BIG + nX * BIG, cy + tY * BIG + nY * BIG);
    s.closePath();
    s.fill();
    s.globalCompositeOperation = 'source-over';
    s.globalAlpha = 1;
    ctx.drawImage(scr!, dx, dy);
  }

  ctx.restore();
}
