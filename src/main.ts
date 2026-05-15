import { VERSION } from '@/config/version';
import '@/styles/base.css';

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

const canvas = requireEl<HTMLCanvasElement>('c');
const hcanvas = requireEl<HTMLCanvasElement>('h');
const ctx = requireCtx(canvas);
requireCtx(hcanvas);

function fitCanvases(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = w;
  canvas.height = h;
  hcanvas.width = w;
  hcanvas.height = h;
}

function paintPlaceholder(): void {
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = '#0a0a12';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#0ff';
  ctx.font = 'bold 22px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('DRIVER CITY', w / 2, h / 2 - 40);
  ctx.fillStyle = '#888';
  ctx.font = '12px monospace';
  ctx.fillText(`v${VERSION} — Vite scaffold online`, w / 2, h / 2 - 10);
  ctx.fillText('Phase 0 complete. Modular migration in progress.', w / 2, h / 2 + 14);
  ctx.fillStyle = '#555';
  ctx.fillText('Legacy monolith at /driver_city_charlotte_v8_99_126_89.html', w / 2, h / 2 + 44);
}

window.addEventListener('resize', () => {
  fitCanvases();
  paintPlaceholder();
});

fitCanvases();
paintPlaceholder();

if (__DEV__) {
  console.log(`[DriverCity] v${VERSION} — Vite + TS scaffold online`);
}
