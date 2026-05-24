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
 * Lower values (0.5 / 0.75) shrink the internal canvas buffer —
 * fewer pixels per frame to fragment-shade, FPS climbs, but each
 * on-screen pixel covers more backing texels so sprites soften.
 * 1.0 = boot default, unchanged from pre-H584.
 *
 * Clamped to the OPT slider's advertised ladder [0.5, 1.5] so a
 * stale save value can't blow out the buffer.
 */

let renderScale = 1.0;

export function getRenderScale(): number {
  return renderScale;
}

export function setRenderScale(scale: number): void {
  if (typeof scale !== 'number' || scale <= 0) return;
  renderScale = Math.max(0.5, Math.min(1.5, scale));
}
