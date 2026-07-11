/**
 * H1116 — drifting cloud shadows.
 *
 * Canvas-2D translation of the Dynamic 2D Grass plugin's cloud overlay
 * (cloud_overlay.gdshader): there, a full-screen fragment pass multiplies
 * the scene by the thresholded PRODUCT of two scrolled samples of one
 * seamless noise texture, tinted purple-dark so shadows read cool rather
 * than grey, drifting ~20 world px/s.
 *
 * Here: ONE seamless noise canvas is baked at first use (soft blobby
 * alpha, purple-dark pixels — the plugin's gradient tint baked in), then
 * each frame it's drawn wrapped over the world in world space at low
 * alpha. Per frame that is at most 4 drawImage calls + a globalAlpha
 * set — no per-pixel work, no getImageData, ~0.05-0.1 ms.
 *
 * Product-of-two-samples is approximated at BAKE time by multiplying two
 * value-noise fields at mismatched frequency inside one texture, and at
 * RUN time by scrolling that one texture along a slow diagonal — the
 * shapes are soft and 300-700 px across, so nothing reads as the "dark
 * circle on the highway" class of artifact (H774-777): worst case is a
 * broad gentle dimming that slides across everything, exactly like the
 * demo.
 *
 * Alpha scales with DAYLIGHT (shadows need sun): callers pass the night
 * intensity and the pass fades out toward midnight. Kill switch:
 * gameplaySettings.disableCloudShadows (no OPT row yet — flag honored
 * here so it can be surfaced later or flipped in a save).
 */

/** World px per second of cloud drift (plugin: ~20 wpx/s). H1119: sped
 *  up — at play zoom, motion under ~40 screen px/s is subliminal. */
const DRIFT_X = 24;
const DRIFT_Y = 12;
/** Peak darkening at full day. H1118: 0.16 was invisible over the grass
 *  in-game (user report) — the demo's shadows are unmistakable. */
const MAX_ALPHA = 0.30;
/** Baked texture size (world px it covers before wrapping). */
const TEX = 512;

let cloudTex: HTMLCanvasElement | null = null;

/** Deterministic value noise: lattice gradients hashed from cell coords,
 *  bilinear-smoothstep interpolated. Two octaves at mismatched scale are
 *  MULTIPLIED (the plugin's dual-sample product) then thresholded. */
function bakeCloudTex(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = TEX;
  c.height = TEX;
  const cx = c.getContext('2d')!;
  const img = cx.createImageData(TEX, TEX);
  const d = img.data;

  const hash2 = (x: number, y: number): number => {
    let h = (Math.imul(x, 374761393) ^ Math.imul(y, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const smooth = (t: number): number => t * t * (3 - 2 * t);
  // Periodic value noise with period `cells` so the texture tiles.
  const vnoise = (u: number, v: number, cells: number): number => {
    const gx = Math.floor(u * cells), gy = Math.floor(v * cells);
    const fx = smooth(u * cells - gx), fy = smooth(v * cells - gy);
    const w = (x: number): number => ((x % cells) + cells) % cells;
    const a = hash2(w(gx), w(gy)), b = hash2(w(gx + 1), w(gy));
    const e = hash2(w(gx), w(gy + 1)), f = hash2(w(gx + 1), w(gy + 1));
    return a + (b - a) * fx + (e - a + (f - b) * fx - (e - a) * fx) * fy
      // (bilinear expanded to avoid a temp — standard lerp(lerp,lerp))
      ;
  };

  for (let y = 0; y < TEX; y++) {
    for (let x = 0; x < TEX; x++) {
      const u = x / TEX, v = y / TEX;
      // Product of two mismatched-frequency fields (plugin trick) —
      // multiplication carves the field into distinct drifting cells.
      // H1119: the H1118 "continents" were BIGGER THAN A PHONE SCREEN at
      // play zoom — a shadow larger than the view reads as uniform
      // dimming, i.e. invisible (user report). Cells 5/7 give ~70-100
      // wpx cores ≈ a quarter-screen blob: unmistakably a cloud passing.
      const n = vnoise(u, v, 5) * vnoise(u + 0.37, v + 0.11, 7);
      // Threshold + soft shoulder: below the floor → clear sky; the
      // shoulder keeps edges feathered so nothing reads hard-edged.
      const t = Math.max(0, Math.min(1, (n - 0.16) / 0.3));
      const a = Math.round(smooth(t) * 255);
      const i = (y * TEX + x) * 4;
      // Purple-dark shadow color (plugin's gradient multiplies toward
      // purple, not grey) — reads cool against the green world.
      d[i] = 26; d[i + 1] = 20; d[i + 2] = 44; d[i + 3] = a;
    }
  }
  cx.putImageData(img, 0, 0);
  cloudTex = c;
  return c;
}

/**
 * Draw the cloud layer over the world. `ctx` must already carry the
 * world camera transform (same space as drawGrass). Covers the view rect
 * centered on (cx, cy) with half-size `radius`, wrapping the baked
 * texture. `night` is the 0..1 night intensity — shadows fade with the
 * light that casts them.
 */
export function drawCloudShadows(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  tMs: number,
  night: number,
): void {
  const day = 1 - night;
  if (day <= 0.05) return;
  const tex = cloudTex ?? bakeCloudTex();

  const t = tMs * 0.001;
  // World-space scroll offset, wrapped to the texture period.
  const ox = ((cx - t * DRIFT_X) % TEX + TEX) % TEX;
  const oy = ((cy - t * DRIFT_Y) % TEX + TEX) % TEX;
  // Top-left world coord of the first wrapped tile at/left of the view.
  const x0 = cx - ox - Math.ceil((radius - ox) / TEX) * TEX;
  const y0 = cy - oy - Math.ceil((radius - oy) / TEX) * TEX;

  const prevAlpha = ctx.globalAlpha;
  ctx.globalAlpha = MAX_ALPHA * day;
  for (let x = x0; x < cx + radius; x += TEX) {
    for (let y = y0; y < cy + radius; y += TEX) {
      ctx.drawImage(tex, x, y);
    }
  }
  ctx.globalAlpha = prevAlpha;
}
