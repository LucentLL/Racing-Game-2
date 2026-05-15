import { VERSION } from '@/config/version';
import '@/styles/base.css';
import { createGameContext } from '@/state/gameState';
import { startGameLoop } from '@/gameLoop';
import { pickTitleImage } from '@/assets/titleImage';

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
  mainCanvas.width = w;
  mainCanvas.height = h;
  hudCanvas.width = w;
  hudCanvas.height = h;
}

window.addEventListener('resize', fitCanvases);
fitCanvases();

const titleImg = pickTitleImage();
const ctx = createGameContext(titleImg);
startGameLoop({ mainCanvas, mainCtx, hudCanvas, hctx, ctx });

if (__DEV__) {
  console.log(`[DriverCity] v${VERSION} — gameLoop booted (H1)`);
}
