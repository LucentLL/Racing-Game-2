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
 * Clamped to the OPT slider's advertised ladder [0.5, 1.5] so a
 * stale save value can't blow out the buffer.
 */

// H750: per-platform boot defaults. PC keeps the H722 0.85 perf
// default; mobile (portrait viewport) boots at 0.75 (user-tuned
// 2026-05-29 — 1.0 was crisper than 0.85 but FPS still trailed the
// monolith). 0.75 buys back the FPS at the cost of mainCanvas
// crispness — the trade the user explicitly asked for.
let renderScale = (typeof window !== 'undefined' && window.innerWidth < window.innerHeight) ? 0.75 : 0.85;

export function getRenderScale(): number {
  return renderScale;
}

export function setRenderScale(scale: number): void {
  if (typeof scale !== 'number' || scale <= 0) return;
  renderScale = Math.max(0.5, Math.min(1.5, scale));
}
