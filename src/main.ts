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
// H724: GH_BASE raised 427 → 720 to lift the PC world canvas's
// internal resolution. At the H135 baseline (427) on a 1080p
// monitor the canvas was ~594 px tall internally → CSS stretched
// to ~1540 px → 2.6× upscale → blurry pixel art. At 720 the
// canvas can reach ~918 internally → 1.68× upscale, ~1.5× more
// pixel density per car / per tile. Mobile path computes its own
// internal dimensions from viewport aspect (GH_BASE unused
// there) so this only affects PC. Pixel count roughly 2.4× per
// frame — render scale 0.85 default brings the effective cost
// back down to ~1.8× of pre-H724. User-requested ("This is very
// important. … let's try 2").
const GH_BASE = 720;
const MAX_DOM = 14000;


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
    // HUD canvas stays at viewport size on mobile — the ported HUD
    // modules read hudCanvas.height === vh (same back-compat reason
    // as the PC path below).
    hudCanvas.width = vw;
    hudCanvas.height = vh;
    applyCssTilt(mainCanvas);
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

  // H724: GH_CAP raised from max(500, min(640, vh*0.55)) to
  // max(720, min(1080, vh*0.85)). The H135 cap (640 px hard
  // ceiling) was the bottleneck — even after raising GH_BASE the
  // cap clamped GH back to 640 on 1080p screens. Lifted to 1080
  // so the canvas can scale up to ~native viewport height on
  // common displays. WORLD_GW recomputes from aspect ratio as
  // before, so width grows proportionally with height.
  const GH_CAP = Math.max(720, Math.min(1080, Math.round(vh * 0.85)));
  const GH = Math.min(GH_CAP, Math.round(GH_BASE * tiltMul));
  const WORLD_GW = Math.max(GW, Math.round((GH * domW) / domH));

  mainCanvas.width = Math.max(1, Math.round(WORLD_GW * _rs));
  mainCanvas.height = Math.max(1, Math.round(GH * _rs));
  mainCanvas.style.width = domW + 'px';
  mainCanvas.style.height = domH + 'px';
  mainCanvas.style.left = Math.round((vw - domW) / 2) + 'px';
  mainCanvas.style.top = '';

  hudCanvas.width = vw;
  hudCanvas.height = vh;

  applyCssTilt(mainCanvas);
}

window.addEventListener('resize', fitCanvases);
fitCanvases();

// H626 + H629: anchor the SVG HUD overlays to the canvas cluster's
// screen footprint. Called after fitCanvases so the hudCanvas dimensions
// it reads are fresh. Idempotent + dirty-checked — passing identical
// args twice in a row only triggers DOM writes the first time.
import { syncSpeedoSvgPosition } from '@/render/hud/speedoSvg';
import { syncMobileRpmPosition, syncMobileRpmPositionInWheel } from '@/render/hud/mobileRpmSvg';
import { installSteerWheel } from '@/input/steerWheel';
function syncSvgOnResize(): void {
  // CLUSTER_R = 42 is the PC cluster radius from gameLoop. Speedo math
  // mirrors monolith _syncSpeedoSvgPosition L22944-L22952 PC branch;
  // mobile RPM mirrors _syncMobileRpmPosition L22640-L22656.
  syncSpeedoSvgPosition(window.innerWidth, 42);
  // H644: on mobile, anchor the RPM gauge INSIDE the steering wheel's
  // rim. Fall through to the legacy top-left anchor if the wheel hasn't
  // mounted yet (boot-time race) or on PC where the wheel is hidden.
  if (!syncMobileRpmPositionInWheel()) {
    syncMobileRpmPosition(42);
  }
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
// Re-sync RPM-in-wheel once a frame for the first second after boot —
// the wheel's getBoundingClientRect() needs the CSS layout to settle
// (viewport flips on phone rotation, font-load reflows). After that the
// resize handler covers it.
{
  let ticks = 0;
  const id = window.setInterval(() => {
    syncMobileRpmPositionInWheel();
    if (++ticks > 60) window.clearInterval(id);
  }, 16);
}

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
