/**
 * H852: speed-rush FX — a speed-scaled tunnel vignette that closes in as
 * you go faster, so hard acceleration READS as speed (the NFS "sensation
 * of speed" the camera zoom alone under-delivers, especially on PC where
 * the zoom is held constant by design). Net-new; no monolith equivalent.
 *
 * Deliberately ONE full-screen radial-gradient fill per frame and a full
 * no-op below the onset speed — the project's perf cost model is GPU
 * draw-CALL count, so a single gradient fill that only paints at high
 * speed is negligible against the stable-FPS budget.
 *
 * Drawn at the very bottom of the HUD-canvas pass (right after its clear),
 * so it darkens the WORLD edges but sits UNDER the gauges / minimap /
 * score, keeping the HUD crisp.
 */

/** Smoothed speed ratio (0..1), eased frame-to-frame so the vignette
 *  doesn't flap on rapid throttle/brake. */
let _smooth = 0;

/** Ratio (of the 250 mph reference) where the vignette begins — about
 *  85 mph, so normal city driving stays clean. */
const ONSET = 0.34;
/** Ratio at which the effect is at full intensity (~240 mph). */
const FULL = 0.96;
/** Peak edge darkness. Subtle on purpose — a cue, not a blindfold. */
const MAX_ALPHA = 0.34;

/** Reset the eased state (used by tests / scene changes). */
export function resetSpeedFx(): void { _smooth = 0; }

/**
 * Paint the speed vignette. `absMph` is the player's absolute speed in mph.
 * No-op (after the cheap ease) until speed crosses ONSET.
 */
export function drawSpeedFx(ctx: CanvasRenderingContext2D, W: number, H: number, absMph: number): void {
  const ratio = Math.min(1, Math.max(0, absMph) / 250);
  // ~0.2s time constant at 60fps — smooth without lagging the feel.
  _smooth += (ratio - _smooth) * 0.08;

  const t = (_smooth - ONSET) / (FULL - ONSET);
  if (t <= 0.002) return;                 // below onset → nothing painted
  const intensity = Math.min(1, t);

  const cx = W / 2;
  const cy = H / 2;
  const rOuter = Math.hypot(W, H) * 0.62;
  // Inner clear radius shrinks with speed → the tunnel closes in.
  const rInner = rOuter * (0.54 - intensity * 0.18);
  const a = (MAX_ALPHA * intensity).toFixed(3);

  const g = ctx.createRadialGradient(cx, cy, Math.max(1, rInner), cx, cy, rOuter);
  g.addColorStop(0, 'rgba(6,8,14,0)');
  g.addColorStop(0.72, `rgba(6,8,14,${(MAX_ALPHA * intensity * 0.35).toFixed(3)})`);
  g.addColorStop(1, `rgba(6,8,14,${a})`);

  ctx.save();
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}
