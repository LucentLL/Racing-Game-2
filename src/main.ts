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
const pcCanvas = requireEl<HTMLCanvasElement>('pc');
const hudCanvas = requireEl<HTMLCanvasElement>('h');
const mainCtx = requireCtx(mainCanvas);
const pcCtx = requireCtx(pcCanvas);
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

/** H726: target multiplier for the player-overlay canvas backing
 *  buffer relative to mainCanvas. K=2.5 puts the silhouette at ~2.5×
 *  mainCanvas source pixels (≈100-140 px across at default
 *  renderScale + ZOOM), enough to read crisp through the CSS
 *  perspective transform without paying the full-viewport pixel cost.
 *  fitCanvases auto-caps this to whichever per-axis ratio
 *  (domW/mainCanvas.width or domH/mainCanvas.height) is more
 *  constraining, so renderScale=1.5 + portrait viewports stay
 *  aspect-correct without bloating the buffer past CSS-display size. */
const PC_OVERLAY_K_TARGET = 2.5;
/** H730: mobile uses a smaller K because phone GPUs can't absorb the
 *  PC K=2.5. The two CSS-perspective-tilted layers (mainCanvas +
 *  pcCanvas) each get rasterized at viewport output pixel count; on
 *  mid-range mobile chips even K=2.5 tanked FPS to "very low". K=1.5
 *  still gives the silhouette ~1.5× mainCanvas source pixels (≈65-90
 *  px across vs the ~48 px of mainCanvas alone) without overwhelming
 *  the second tilt layer. */
const MOBILE_OVERLAY_K_TARGET = 1.5;


function fitCanvases(): void {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  recomputeTiltFactors(vh);

  // H623: mobile-mode body class. 1:1 with monolith L5505-5514 — portrait
  // viewports (vw < vh) get `body.mob`, landscape gets `body.pc`. Foundation
  // for the SVG speedo / wheel RPM / mobile-layout arc; CSS rules and JS
  // gates downstream read off these classes. Toggled inside fitCanvases so
  // orientation flips on phones / window resize on desktop pick it up
  // automatically. Wider 'ontouchstart' detection is intentionally NOT used
  // — Chrome desktop reports touch true by default and would mis-classify.
  const isMobile = vw < vh;
  if (isMobile) {
    document.body.classList.add('mob');
    document.body.classList.remove('pc');
  } else {
    document.body.classList.add('pc');
    document.body.classList.remove('mob');
  }

  // Tilt-driven height multiplier.
  //
  // H689: mobile path now uses the precomputed tiltState.ghFactor
  // (clamped to [1.0, 4.0] inside recomputeTiltFactors) instead of
  // the live denom formula capped at 10. Monolith parity — resize()
  // mobile branch at L5525 reads TILT_GH_FACTOR[TILT_MODE], whose
  // 4.0 ceiling at L5371 is critical: at 35° on portrait phones
  // (vh ≈ 900-1300) the live formula saturates at the 10× cap and
  // grows the canvas DOM height to 9000+ px while the internal
  // canvas stays at 1600 px, leaving a 5.6× CSS upscale that
  // collapses the visible world into a strip at the top of the
  // viewport (and crushes mobile perf).
  //
  // PC branch keeps the live formula (cap 10) — monolith L5613-5614
  // intentionally raises the cap there for desktop viewports in
  // the 1000-1600 vh range.
  let tiltMul = 1.0;
  if (tiltState.mode !== 0) {
    if (isMobile) {
      tiltMul = Math.max(1, tiltState.ghFactor[tiltState.mode] || 1.0);
    } else {
      const r = (effectiveTiltDeg(vh, vw) * Math.PI) / 180;
      const denom = Math.cos(r) * TILT_PERSPECTIVE_PX - vh * Math.sin(r);
      tiltMul = denom > 1 ? Math.min(10, TILT_PERSPECTIVE_PX / denom) : 10;
      tiltMul = Math.max(1, tiltMul);
    }
  }

  const _rs = getRenderScale();

  // H655: mobile branch — 1:1 port of monolith L5515-L5557. Canvas internal
  // dimensions match the phone's aspect ratio (GH derived from vh/vw) so
  // CSS stretches the canvas UNIFORMLY (same scale horizontal + vertical).
  // Without this, the desktop branch's hard-coded GH_BASE=427 + WORLD_GW=240
  // produced a canvas aspect 0.56 stretched to a phone aspect 0.47 — making
  // vertical CSS-scale ~2.67× while horizontal stretched only 2.25×. Cars
  // looked elongated vertically and the world appeared "squashed" horizontally
  // relative to monolith's mobile rendering. User-reported: car/road sizes
  // wrong on mobile.
  if (isMobile) {
    let mobGH = Math.round(GW * vh / vw);
    mobGH = Math.max(320, Math.min(600, mobGH));
    // Tilt extension matches monolith L5527-L5531 — grow canvas taller so
    // perspective transform sees more world above the player.
    if (tiltMul > 1) {
      mobGH = Math.round(mobGH * tiltMul);
      mobGH = Math.min(1600, mobGH);
    }
    let mobWMul = 1.0;
    if (tiltMul > 1) {
      const r = (effectiveTiltDeg(vh, vw) * Math.PI) / 180;
      mobWMul = (TILT_PERSPECTIVE_PX + vh * tiltMul * Math.sin(r)) / TILT_PERSPECTIVE_PX;
    }
    const mobWORLD_GW = Math.round(GW * mobWMul);
    const mobDomH = Math.round(vh * tiltMul);
    const mobDomW = Math.round(vw * mobWMul);
    mainCanvas.width = Math.max(1, Math.round(mobWORLD_GW * _rs));
    mainCanvas.height = Math.max(1, Math.round(mobGH * _rs));
    mainCanvas.style.width = mobDomW + 'px';
    mainCanvas.style.height = mobDomH + 'px';
    mainCanvas.style.left = Math.round((vw - mobDomW) / 2) + 'px';
    // Monolith mobile pins the canvas top (style.top = vh - _domH) so
    // extra height extends UP off-screen for the perspective fold. The
    // base.css default has bottom:0; clearing top would re-anchor at
    // bottom which is what we want, but the monolith uses explicit
    // top anchor to keep the math symmetric. Both end at vh on bottom.
    mainCanvas.style.bottom = '';
    mainCanvas.style.top = (vh - mobDomH) + 'px';
    // H732: disable the H726 player overlay on mobile entirely. With
    // mainCanvas at renderScale=1.0 (H732 default for mobile) the
    // world canvas matches the monolith's resolution and the player
    // car silhouette has enough source pixels going through the CSS
    // perspective bilinear filter to read crisp. pcCanvas was adding
    // both per-frame canvas work AND a second GPU layer the monolith
    // didn't have — monolith ran 120fps without it, so modular mobile
    // can too.
    pcCanvas.width = 1;
    pcCanvas.height = 1;
    pcCanvas.style.display = 'none';
    // HUD canvas stays at viewport size on mobile — the ported HUD
    // modules read hudCanvas.height === vh (same back-compat reason
    // as the PC path below).
    hudCanvas.width = vw;
    hudCanvas.height = vh;
    applyCssTilt(mainCanvas);
    pcCanvas.style.transform = '';
    pcCanvas.style.transformOrigin = '';
    return;
  }

  // PC / desktop path — unchanged from H60 + H584. Canvas internal stays
  // at GW × GH_BASE; CSS spans the viewport with horizontal letterboxing
  // (the GW=240 strip is centered, full-height after tilt overscan).
  let domH = Math.round(vh * tiltMul * CANVAS_OVERSCAN);
  let wMul = 1.0;
  if (tiltMul > 1) {
    const r = (effectiveTiltDeg(vh, vw) * Math.PI) / 180;
    wMul = (TILT_PERSPECTIVE_PX + vh * tiltMul * Math.sin(r)) / TILT_PERSPECTIVE_PX;
  }
  let domW = Math.round(vw * wMul * CANVAS_OVERSCAN);
  if (domH > MAX_DOM) domH = MAX_DOM;
  if (domW > MAX_DOM) domW = MAX_DOM;

  const GH_CAP = Math.max(500, Math.min(640, Math.round(vh * 0.55)));
  const GH = Math.min(GH_CAP, Math.round(GH_BASE * tiltMul));
  const WORLD_GW = Math.max(GW, Math.round((GH * domW) / domH));

  mainCanvas.width = Math.max(1, Math.round(WORLD_GW * _rs));
  mainCanvas.height = Math.max(1, Math.round(GH * _rs));
  mainCanvas.style.width = domW + 'px';
  mainCanvas.style.height = domH + 'px';
  mainCanvas.style.left = Math.round((vw - domW) / 2) + 'px';
  mainCanvas.style.top = '';

  // H726: player overlay shares mainCanvas's CSS footprint + tilt
  // but its backing buffer is sized at K×mainCanvas dimensions
  // (see mobile branch above for the FPS rationale). Uniform scale
  // on both axes preserves the camera transform math.
  // H728: restore display in case a previous resize-into-mobile
  // collapsed it (orientation flip on tablets / desktop window
  // resize through portrait).
  pcCanvas.style.display = '';
  {
    const kEff = Math.min(
      PC_OVERLAY_K_TARGET,
      domW / mainCanvas.width,
      domH / mainCanvas.height,
    );
    pcCanvas.width = Math.max(1, Math.round(kEff * mainCanvas.width));
    pcCanvas.height = Math.max(1, Math.round(kEff * mainCanvas.height));
  }
  pcCanvas.style.width = domW + 'px';
  pcCanvas.style.height = domH + 'px';
  pcCanvas.style.left = Math.round((vw - domW) / 2) + 'px';
  pcCanvas.style.top = '';

  hudCanvas.width = vw;
  hudCanvas.height = vh;

  applyCssTilt(mainCanvas);
  applyCssTilt(pcCanvas);
}

window.addEventListener('resize', fitCanvases);
fitCanvases();

// H626 + H629: anchor the SVG HUD overlays to the canvas cluster's
// screen footprint. Called after fitCanvases so the hudCanvas dimensions
// it reads are fresh. Idempotent + dirty-checked — passing identical
// args twice in a row only triggers DOM writes the first time.
import { syncSpeedoSvgPosition } from '@/render/hud/speedoSvg';
import { syncMobileRpmPosition } from '@/render/hud/mobileRpmSvg';
import { installSteerWheel } from '@/input/steerWheel';
function syncSvgOnResize(): void {
  // CLUSTER_R = 42 is the PC cluster radius from gameLoop. Speedo math
  // mirrors monolith _syncSpeedoSvgPosition L22944-L22952 PC branch;
  // mobile RPM uses the legacy top-left anchor (the inside-the-wheel
  // path was retired when the minimap moved into the wheel and the
  // RPM gauge moved out to the top-left corner).
  syncSpeedoSvgPosition(window.innerWidth, 42);
  syncMobileRpmPosition(42);
}
window.addEventListener('resize', syncSvgOnResize);
syncSvgOnResize();

// H644: wire steering-wheel touch handlers. Idempotent + no-ops on PC
// (the wheel is hidden via CSS but the listeners stay attached harmlessly
// in case the user toggles mobile-emulation mid-session).
installSteerWheel();

// H645: wire gas + brake slider pedals. Same idempotent / harmless-on-PC
// pattern as the wheel — the pedal-zone is display:none on PC via CSS.
import { installPedals } from '@/input/sliderPedal';
installPedals();
// (Pre-H<date> boot polling for syncMobileRpmPositionInWheel removed —
// the RPM gauge no longer anchors inside the wheel.)

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
startGameLoop({ mainCanvas, mainCtx, pcCanvas, pcCtx, hudCanvas, hctx, ctx });

if (__DEV__) {
  console.log(`[DriverCity] v${VERSION} — gameLoop booted (H1)`);
}
