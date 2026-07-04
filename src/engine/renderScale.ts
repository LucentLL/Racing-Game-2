/**
 * PC render-scale value — shared between the canvas-sizing path
 * (main.ts fitCanvases) and the OPT slider handler (gameLoop).
 * Lives in its own module to break what would otherwise be a
 * main.ts ↔ gameLoop.ts circular import.
 *
 * H584: the OPT PC Render Scale slider writes
 * life.gameplaySettings.pcRenderScale and calls setRenderScale()
 * here, then dispatches a 'resize' event so fitCanvases re-runs +
 * applies the new multiplier to mainCanvas.width / height.
 *
 * Lower values (0.5 / 0.75 / 0.85) shrink the internal canvas
 * buffer — fewer pixels per frame to fragment-shade, FPS climbs,
 * but each on-screen pixel covers more backing texels so sprites
 * soften.
 *
 * H722: 0.85 is the new boot default. The previous 1.0 default
 * exhausted PC frame budget on highway-heavy scenes; 0.85 cuts
 * pixel count to ~72 % of full while staying visually sharp.
 * Players can flip back to 1.0 / 1.25 / 1.5 from OPT for
 * higher-quality stills, or drop to 0.75 / 0.5 for more FPS.
 *
 * Clamped to the OPT slider's advertised ladder [0.5, 2.0] so a
 * stale save value can't blow out the buffer.
 */

// H817: boot default 1.0 everywhere. H1008 makes the UNSET default
// platform-aware: PC / landscape ('pc' body class) boots at 1.10 for a
// crisper desktop image (user request "default Render Scale on PC 1.10"),
// while mobile / portrait ('mob' body class) stays at 1.0 to protect the
// tighter phone pixel budget. The finer 0.05-step OPT slider (0.5–2.0)
// still lets players trade crispness for FPS per-device; the moment a
// saved value or the slider calls setRenderScale(), that explicit choice
// wins over the platform default.
const PC_DEFAULT_RENDER_SCALE = 1.10;
const MOBILE_DEFAULT_RENDER_SCALE = 1.0;

// Seeded to the PC default; the explicit flag gates whether this stored
// value or the live platform default is returned (see getRenderScale).
let renderScale = PC_DEFAULT_RENDER_SCALE;
let renderScaleExplicit = false;

/** The unset default for the current layout. Reads the same 'mob' body
 *  class fitCanvases toggles (main.ts), so it is correct by the time
 *  fitCanvases queries the scale. Dependency-free on purpose — this
 *  module deliberately imports nothing to avoid a main.ts ↔ gameLoop
 *  import cycle. */
export function getDefaultRenderScale(): number {
  if (typeof document !== 'undefined' && document.body.classList.contains('mob')) {
    return MOBILE_DEFAULT_RENDER_SCALE;
  }
  return PC_DEFAULT_RENDER_SCALE;
}

export function getRenderScale(): number {
  return renderScaleExplicit ? renderScale : getDefaultRenderScale();
}

export function setRenderScale(scale: number): void {
  if (typeof scale !== 'number' || scale <= 0) return;
  // H817: ceiling raised 1.5 → 2.0 to match the OPT slider range.
  renderScale = Math.max(0.5, Math.min(2.0, scale));
  renderScaleExplicit = true;
}

/** H797: pc-overlay auto-fold state — set by fitCanvases (main.ts),
 *  read by drawPlaying (gameLoop) the same way renderScale itself is
 *  shared. True when the H796 area budget caps the overlay's
 *  effective K below PC_OVERLAY_MIN_K in main.ts — at that point the
 *  overlay sharpens the car by <1.3× while still costing a full
 *  compositor layer + a ~2.6 Mpx per-frame raster target (measured
 *  2026-06-12: Render Scale 1.5 + overlay = 53.5 fps / p50 20.8 ms vs
 *  59.3 / 14 ms with the overlay folded, same machine, same scene).
 *  When folded, the player + traffic render to mainCtx exactly like
 *  the mobile path (H732) and the OPT "PC Overlay" toggle is
 *  effectively moot until Render Scale drops again. */
let pcOverlayFolded = false;

export function setPcOverlayFolded(folded: boolean): void {
  pcOverlayFolded = folded;
}

export function isPcOverlayFolded(): boolean {
  return pcOverlayFolded;
}
