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

function fitCanvases(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  // H42: recompute tilt overscan factor for the current viewport.
  recomputeTiltFactors(h);
  const gh = tiltState.ghFactor[tiltState.mode] || 1.0;
  // H60: reverted H59's pcRenderScale CSS rewrite — the side borders
  // it produced weren't worth the marginal upscale-blur. Zoom now bumps
  // directly via the ZOOM constant in gameLoop. Native 1:1 canvas
  // keeps pixels crisp without any CSS upscale.
  mainCanvas.width = w;
  mainCanvas.height = Math.round(h * gh);
  hudCanvas.width = w;
  hudCanvas.height = h;
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
