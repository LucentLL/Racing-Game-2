/**
 * CRT scanline overlay — final post-process pass that paints subtle
 * horizontal scanlines over the entire canvas to give the GBC-aesthetic
 * a vintage tube-TV feel. Toggleable via LIFE.gameplaySettings.crtEffect.
 *
 * Ported from monolith — small block near end of render(). Two passes:
 *   1. Dark scanlines (alpha ~0.08) every 2 px
 *   2. Optional subtle vignette/chroma shift (deferred)
 */

export interface CrtDeps {
  WORLD_GW: number;
  GH: number;
  /** True if the user toggle is enabled. Skipped entirely when false. */
  enabled: boolean;
}

export function drawCrtScanlines(
  ctx: CanvasRenderingContext2D,
  deps: CrtDeps,
): void {
  if (!deps.enabled) return;
  const { WORLD_GW: w, GH: h } = deps;
  // 1px dark scanlines on every other row.
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.08)';
  for (let y = 0; y < h; y += 2) {
    ctx.fillRect(0, y, w, 1);
  }
  ctx.restore();
}
