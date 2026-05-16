import { VERSION } from '@/config/version';
import '@/styles/base.css';
import { createGameContext } from '@/state/gameState';
import { startGameLoop } from '@/gameLoop';
import { pickTitleImage } from '@/assets/titleImage';
import { ensureMobileControls } from '@/ui/mobileControls';
import { applyCssTilt, recomputeTiltFactors, tiltState } from '@/engine/tilt';

function requireEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Required element #${id} missing from DOM`);
  return el as T;
}

function requireCtx(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable');
  return ctx;
}

const mainCanvas = requireEl<HTMLCanvasElement>('c');
const hudCanvas = requireEl<HTMLCanvasElement>('h');
const mainCtx = requireCtx(mainCanvas);
const hctx = requireCtx(hudCanvas);

/** H59 — pcRenderScale port from monolith gameplaySettings (L7774).
 *  The main canvas renders at 75% of the display resolution and gets
 *  CSS-upscaled to the full viewport, which effectively zooms the
 *  visible world by 1/0.75 ≈ 1.33× — matching the monolith's on-
 *  screen player-car size at 1080p+. Pixelated CSS image-rendering
 *  (already set in base.css) preserves the GBC pixel-art look across
 *  the upscale. */
const PC_RENDER_SCALE = 0.75;

function fitCanvases(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  // H42: recompute tilt overscan factor for the current viewport.
  recomputeTiltFactors(h);
  const gh = tiltState.ghFactor[tiltState.mode] || 1.0;
  // H59 — main canvas internal size is the display size × renderScale.
  // CSS keeps the displayed size at the full viewport.
  const internalW = Math.round(w * PC_RENDER_SCALE);
  const internalH = Math.round(h * gh * PC_RENDER_SCALE);
  mainCanvas.width = internalW;
  mainCanvas.height = internalH;
  // CSS-display the main canvas at the full viewport. Bottom-anchored
  // via base.css so the tilt origin sits at the viewport floor.
  mainCanvas.style.width = w + 'px';
  mainCanvas.style.height = Math.round(h * gh) + 'px';
  hudCanvas.width = w;
  hudCanvas.height = h;
  // Apply the CSS perspective transform — visible tilt happens here.
  applyCssTilt(mainCanvas);
}

window.addEventListener('resize', fitCanvases);
fitCanvases();

const titleImg = pickTitleImage();
const ctx = createGameContext(titleImg);
ensureMobileControls(ctx.input);
startGameLoop({ mainCanvas, mainCtx, hudCanvas, hctx, ctx });

if (__DEV__) {
  console.log(`[DriverCity] v${VERSION} — gameLoop booted (H1)`);
}
