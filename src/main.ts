import { VERSION } from '@/config/version';
import '@/styles/base.css';
import { createGameContext } from '@/state/gameState';
import { startGameLoop } from '@/gameLoop';
import { pickTitleImage } from '@/assets/titleImage';
import { ensureMobileControls } from '@/ui/mobileControls';
import { loadVehicleSprites } from '@/engine/sprites';
import { setGT4Lookup } from '@/render/carBody';
import { GT4_SPECS } from '@/config/cars/gt4Database';
import {
  applyCssTilt,
  recomputeTiltFactors,
  tiltState,
  effectiveTiltDeg,
  TILT_PERSPECTIVE_PX,
  CANVAS_OVERSCAN,
} from '@/engine/tilt';
import { getRenderScale } from '@/engine/renderScale';

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

// H135: GBC-base internal-canvas dims, ported from monolith resize()
// L5599-5723. The main canvas renders at LOW internal resolution (GBC
// aspect, capped at 500-640 px tall) and CSS upscales to vw × vh*tiltMul
// so the perspective+rotateX transform projects back to fit the viewport.
// Without this, H60's `mainCanvas.height = h * gh` produced a ~3× oversized
// internal canvas that rendered world content at ~1/3 the on-screen size
// the monolith ships — the "car is a tiny dot" symptom in the user's
// 2026-05-16 screenshot.
const GW = 240;
const GH_BASE = 427;
const MAX_DOM = 14000;


function fitCanvases(): void {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  recomputeTiltFactors(vh);

  // Tilt-driven height multiplier — exact monolith L5605-5615 formula.
  // Saturates at 10 when denom <= 1 (very tall viewports where the
  // perspective fold goes degenerate).
  let tiltMul = 1.0;
  if (tiltState.mode !== 0) {
    const r = (effectiveTiltDeg(vh, vw) * Math.PI) / 180;
    const denom = Math.cos(r) * TILT_PERSPECTIVE_PX - vh * Math.sin(r);
    tiltMul = denom > 1 ? Math.min(10, TILT_PERSPECTIVE_PX / denom) : 10;
    tiltMul = Math.max(1, tiltMul);
  }

  // CSS display dimensions — the canvas DOM box is taller than viewport
  // (perspective folds it back) and slightly wider (so horizontal pixels
  // still map 1:1 after the rotateX skew). L5651-5665 monolith parity.
  let domH = Math.round(vh * tiltMul * CANVAS_OVERSCAN);
  let wMul = 1.0;
  if (tiltMul > 1) {
    const r = (effectiveTiltDeg(vh, vw) * Math.PI) / 180;
    wMul = (TILT_PERSPECTIVE_PX + vh * tiltMul * Math.sin(r)) / TILT_PERSPECTIVE_PX;
  }
  let domW = Math.round(vw * wMul * CANVAS_OVERSCAN);
  if (domH > MAX_DOM) domH = MAX_DOM;
  if (domW > MAX_DOM) domW = MAX_DOM;

  // Internal canvas dimensions — small, GBC-aspect. GH_CAP per monolith
  // L5721 (scaled-with-viewport pixel cap that protects fps).
  const GH_CAP = Math.max(500, Math.min(640, Math.round(vh * 0.55)));
  const GH = Math.min(GH_CAP, Math.round(GH_BASE * tiltMul));
  const WORLD_GW = Math.max(GW, Math.round((GH * domW) / domH));

  // H584: apply the OPT PC Render Scale to the internal canvas
  // buffer. CSS dimensions stay tied to the viewport (domW × domH)
  // so the upscale ratio grows when scale<1.0 — fewer pixels per
  // frame to fragment-shade, but each on-screen pixel covers more
  // backing texels.
  const _rs = getRenderScale();
  mainCanvas.width = Math.max(1, Math.round(WORLD_GW * _rs));
  mainCanvas.height = Math.max(1, Math.round(GH * _rs));
  mainCanvas.style.width = domW + 'px';
  mainCanvas.style.height = domH + 'px';
  mainCanvas.style.left = Math.round((vw - domW) / 2) + 'px';
  // base.css pins `bottom:0`; clear any stale `top` so the bottom anchor
  // is unambiguous after viewport flips.
  mainCanvas.style.top = '';

  // HUD canvas continues to track viewport pixels — every ported HUD
  // module in src/ui assumes hudCanvas.height === vh. Switching it to
  // GH_BASE is a separate Phase H port (84 hctx references in gameLoop
  // alone would shift).
  hudCanvas.width = vw;
  hudCanvas.height = vh;

  applyCssTilt(mainCanvas);
}

window.addEventListener('resize', fitCanvases);
fitCanvases();

// H148: kick the V2 sprite cache load at boot. The function is
// idempotent + non-blocking — each entry in VEHICLE_IMAGE_MANIFEST
// fires a parallel Image() fetch, and downstream consumers
// (drawTopCar through hasVehicleSprite / getVehicleSprite) gate on
// per-entry .ready flags so the X-Ray fallback fires until the PNG
// settles in. Without this call the cache stays empty and every
// car renders as a yellow-tire wireframe (H146 + H147 are running
// off the X-Ray branch right now). Mirrors the monolith's
// _loadVehicleSprites() call at L2025.
loadVehicleSprites();

// H170: register the GT4_SPECS lookup with the V2 wheel-geom module.
// Without this, v2Helpers' xrayWheelGeomFromSpec gate fails (it
// requires both a non-null carName AND a gt4Lookup function) and
// v2Wheels falls through to the L*0.18 × 3 chunky-yellow-square
// fallback. With it wired, X-Ray-rendered cars get tire rects sized
// from real per-chassis wb / track / tire-spec data — a Miata's
// tires are visibly smaller than a Viper's. setGT4Lookup is a
// module-level setter on v2Helpers; one call at boot suffices.
setGT4Lookup((name: string) => GT4_SPECS[name]);

const titleImg = pickTitleImage();
const ctx = createGameContext(titleImg);
// H139: mobile buttons are a held-state source like the keyboard, so
// they write to ctx.inputHeld (the source-truth field). dispatch's
// per-frame mergeInputs then ORs that with the gamepad-derived
// booleans into ctx.input for arcadeUpdate.
ensureMobileControls(ctx.inputHeld);
startGameLoop({ mainCanvas, mainCtx, hudCanvas, hctx, ctx });

if (__DEV__) {
  console.log(`[DriverCity] v${VERSION} — gameLoop booted (H1)`);
}
