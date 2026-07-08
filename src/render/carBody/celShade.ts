/**
 * H1085 (cel-shade, step 1): a generic Auto-Modellista-style post-pass
 * for a vehicle — HARD CAST SHADOW + INK OUTLINE + a directional
 * SHADOW BAND — without touching any per-chassis renderer.
 *
 * How: the caller hands us a render function that draws the vehicle
 * exactly as it does today (sprite / V2 vector / X-ray — drawTopCar
 * self-applies the car pose on top of the active camera transform). We
 * render it to an off-screen buffer whose transform MATCHES the target
 * ctx, so the car lands at the same screen pixels. Then we composite in
 * screen space (identity):
 *
 *   1. cast shadow — the car silhouette, tinted dark, offset down-right
 *      onto the ground (grounds the car, kills the "floating flat" look);
 *   2. ink outline — the dark silhouette drawn at 8 one-pixel offsets so
 *      a crisp near-black rim rings the body (the strongest AM cue);
 *   3. the car itself;
 *   4. shadow band — a hard-edged dark half-plane through the car centre
 *      (light from screen top-left), clipped to the body via source-atop,
 *      so one side reads as a flat cel shadow.
 *
 * Cost per vehicle: one buffer render + a handful of drawImage/fill
 * composites. NO getImageData (that poisons perf — [[project_perf_cost_model]]).
 * Shipped first for the PLAYER car only (one vehicle) so it's free; the
 * traffic / parked sweep lands as a follow-up once perf is confirmed.
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

let buf: HTMLCanvasElement | null = null;
let bctx: CanvasRenderingContext2D | null = null;
let scr: HTMLCanvasElement | null = null;
let sctx: CanvasRenderingContext2D | null = null;

function ensure(w: number, h: number): boolean {
  if (typeof document === 'undefined') return false;
  if (!buf) { buf = document.createElement('canvas'); bctx = buf.getContext('2d'); }
  if (!scr) { scr = document.createElement('canvas'); sctx = scr.getContext('2d'); }
  if (!bctx || !sctx) return false;
  if (buf.width !== w || buf.height !== h) { buf.width = w; buf.height = h; }
  if (scr.width !== w || scr.height !== h) { scr.width = w; scr.height = h; }
  return true;
}

/** Build a solid-INK silhouette of the current `buf` onto `scr`. */
function silhouette(w: number, h: number, color: string): void {
  const s = sctx!;
  s.setTransform(1, 0, 0, 1, 0, 0);
  s.globalCompositeOperation = 'source-over';
  s.globalAlpha = 1;
  s.clearRect(0, 0, w, h);
  s.drawImage(buf!, 0, 0);
  s.globalCompositeOperation = 'source-in';
  s.fillStyle = color;
  s.fillRect(0, 0, w, h);
  s.globalCompositeOperation = 'source-over';
}

/**
 * Draw `renderFn` (a vehicle) into an offscreen matched to `ctx`, then
 * composite the cel effects onto `ctx`. `worldX/worldY` is the vehicle
 * centre in WORLD coords — used to place the shadow-band split; pass the
 * car's px/py.
 */
export function drawVehicleCel(
  ctx: CanvasRenderingContext2D,
  worldX: number,
  worldY: number,
  renderFn: (c: CanvasRenderingContext2D) => void,
  opts: CelOpts = {},
): void {
  const w = ctx.canvas.width, h = ctx.canvas.height;
  if (!ensure(w, h)) { renderFn(ctx); return; }
  const b = bctx!, s = sctx!;
  const outline = opts.outline !== false;
  const band = opts.band !== false;
  const shadow = opts.shadow !== false;

  // --- render the vehicle to the buffer at the SAME transform as ctx ---
  const m = ctx.getTransform();
  b.setTransform(1, 0, 0, 1, 0, 0);
  b.globalCompositeOperation = 'source-over';
  b.globalAlpha = 1;
  b.clearRect(0, 0, w, h);
  b.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
  renderFn(b);
  b.setTransform(1, 0, 0, 1, 0, 0);

  // screen-space centre of the vehicle (for the band split)
  const sx = m.a * worldX + m.c * worldY + m.e;
  const sy = m.b * worldX + m.d * worldY + m.f;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;

  // 1. CAST SHADOW — offset dark silhouette on the ground.
  if (shadow) {
    silhouette(w, h, CAST);
    ctx.globalAlpha = CAST_ALPHA;
    ctx.drawImage(scr!, CAST_DX, CAST_DY);
    ctx.globalAlpha = 1;
  }

  // 2. INK OUTLINE — dark silhouette at 8 offsets → crisp rim.
  if (outline) {
    silhouette(w, h, INK);
    const k = OUTLINE_PX;
    const offs = [[-k, 0], [k, 0], [0, -k], [0, k], [-k, -k], [k, -k], [-k, k], [k, k]];
    for (const [dx, dy] of offs) ctx.drawImage(scr!, dx, dy);
  }

  // 3. THE CAR.
  ctx.drawImage(buf!, 0, 0);

  // 4. SHADOW BAND — hard half-plane through the car centre, light from
  //    top-left, clipped to the body. Built on scr via source-atop.
  if (band) {
    s.setTransform(1, 0, 0, 1, 0, 0);
    s.globalCompositeOperation = 'source-over';
    s.globalAlpha = 1;
    s.clearRect(0, 0, w, h);
    s.drawImage(buf!, 0, 0);
    s.globalCompositeOperation = 'source-atop';
    s.fillStyle = BAND;
    s.globalAlpha = BAND_ALPHA;
    // Line through the centre (biased up-left by D so the shadow covers
    // a bit over half), normal n=(1,1)/√2 into shadow, tangent t=(-1,1)/√2.
    const inv = Math.SQRT1_2, BIG = w + h;
    const D = 4;                    // bias toward the lit side
    const cx = sx - inv * D, cy = sy - inv * D;
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
    ctx.drawImage(scr!, 0, 0);
  }

  ctx.restore();
}
