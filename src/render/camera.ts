/**
 * Camera setup — computes the per-frame FrameView from player + trailer
 * state, smooths the speed/trailer/jackknife/reverse pulls into the supplied
 * CameraSmoothState, and applies the canvas transform (translate → scale →
 * rotate → translate) so subsequent phase modules can draw in world space.
 *
 * Ported from render() L29957–30097 of the v8.99.126.89 monolith. The
 * function MUTATES `smooth` in place each frame; the orchestrator owns the
 * lifetime of that object.
 *
 * Caller is responsible for ctx.save() before invoking and ctx.restore()
 * after the matching phases — applyCamera does the translate/scale/rotate
 * but does NOT push a new save() context (the orchestrator does that so the
 * world-clear at the top of the frame can happen in the identity matrix).
 */

import type {
  CameraInput,
  CameraSmoothState,
  FrameView,
} from './types';

/** Maximum DOM-height value used by resize() when tilt mode is on (desktop
 *  branch). Mirrors the literal 14000 in the monolith. */
const DESKTOP_DOM_HEIGHT_CAP = 14000;

/** Computes the effective DOM height the canvas element is set to (desktop
 *  only) so the inverse-perspective math projects screen_y back to camera_y
 *  using the same scale the CSS rotation actually applies. */
function computeDesktopDomHeight(
  perspectivePx: number,
  effectiveTiltRad: number,
  vh: number,
  canvasOverscan: number,
): number {
  const denom = Math.cos(effectiveTiltRad) * perspectivePx - vh * Math.sin(effectiveTiltRad);
  const base = denom > 1 ? Math.min(10, perspectivePx / denom) * vh : 10 * vh;
  const withOverscan = base * canvasOverscan;
  return Math.min(withOverscan, DESKTOP_DOM_HEIGHT_CAP);
}

function computeMobileDomHeight(
  perspectivePx: number,
  effectiveTiltRad: number,
  vh: number,
): number {
  const denom = Math.cos(effectiveTiltRad) * perspectivePx - vh * Math.sin(effectiveTiltRad);
  return denom > 1 ? Math.min(10, perspectivePx / denom) * vh : 10 * vh;
}

/** Inverts the CSS perspective() projection to find the canvas-relative y
 *  that — after rotateX about (50%, 100%) and the perspective divide —
 *  lands at viewportY = vh * camYRatio. Returns the new camYRatio that, in
 *  the absence of tilt, projects to the same screen position. */
function camYRatioForTilt(
  camYRatio: number,
  tiltDeg: number,
  perspectivePx: number,
  viewport: { vw: number; vh: number; GH: number },
  canvasOverscan: number,
): number {
  const rotRad = (tiltDeg * Math.PI) / 180;
  const isDesktop = viewport.vw >= viewport.vh;
  const domH = isDesktop
    ? computeDesktopDomHeight(perspectivePx, rotRad, viewport.vh, canvasOverscan)
    : computeMobileDomHeight(perspectivePx, rotRad, viewport.vh);
  const screenY = viewport.vh * (camYRatio - 1);
  const dy = (screenY * perspectivePx) / (Math.cos(rotRad) * perspectivePx + screenY * Math.sin(rotRad));
  const camYTarget = (domH + dy) * viewport.GH / domH;
  return camYTarget / viewport.GH;
}

/**
 * Sets up the camera, applies the canvas transform, mutates `smooth` with
 * the new smoothed values, and returns the FrameView the phase modules
 * consume.
 *
 * The caller MUST have already saved the ctx and cleared the world buffer
 * (the orchestrator does that in identity space before calling this).
 */
export function applyCamera(
  ctx: CanvasRenderingContext2D,
  input: CameraInput,
  smooth: CameraSmoothState,
): FrameView {
  const { player, trailer, viewport, tilt, dt, SCALE_MS, TILE } = input;
  const { GH, WORLD_GW } = viewport;

  // ---- Speed-based zoom curve --------------------------------------------
  const absMph = Math.abs(player.pSpeed) / SCALE_MS * 2.237;
  const spdRatio = Math.min(1, absMph / 250);
  smooth.spdSmooth += (spdRatio - smooth.spdSmooth) * Math.min(1, dt * 3);
  const r = smooth.spdSmooth;
  // Piecewise: gentle 0-70 mph, steep 70-250 mph.
  const s = r <= 0.28 ? r * 0.536 : 0.15 + (r - 0.28) * 1.18;

  // PC zoom is CONSTANT — forward visibility comes from camYRatio shift,
  // not zoom-out. Mobile keeps the speed curve since portrait viewport
  // benefits more from the scale reduction at top speed.
  const isPCZoom = viewport.vw >= viewport.vh;
  let zoom = isPCZoom ? 2.2 : (2.9 - s * 1.0);

  // ---- Vertical anchor ---------------------------------------------------
  // Semis: keep more of the trailer in view by anchoring higher on screen.
  let camYRatio = player.isSemiPlayer ? (0.43 + s * 0.33) : (0.58 + s * 0.25);

  // Tilt-mode inverse-perspective: solve for the canvas y that projects to
  // the desired screen y after CSS rotateX + perspective divide.
  if (tilt.mode !== 0) {
    const effDeg = tilt.effectiveTiltDeg(viewport.vh);
    camYRatio = camYRatioForTilt(camYRatio, effDeg, tilt.perspectivePx, viewport, tilt.canvasOverscan);
  }

  // ---- Trailer / jackknife / reverse zoom modifiers ----------------------
  const reversing = player.pSpeed < -0.5;
  const hasTrailer = trailer !== null;

  const trailerTarget = hasTrailer ? 1.0 : 0;
  smooth.trailerZoom += (trailerTarget - smooth.trailerZoom) * Math.min(1, dt * 3);
  if (smooth.trailerZoom > 0.01) {
    zoom -= smooth.trailerZoom * 0.5;
  }

  if (trailer && trailer.jackknife > 0.3) {
    // 0 → 1 over 17° → 90°. Up to 0.55 extra zoom-out at full jackknife.
    const jkFactor = Math.min(1, (trailer.jackknife - 0.3) / 1.27);
    const target = jkFactor * 0.55;
    smooth.jkZoom += (target - smooth.jkZoom) * Math.min(1, dt * 6);
    zoom -= smooth.jkZoom;
  } else {
    smooth.jkZoom *= Math.max(0, 1 - dt * 4);
  }

  const revTrailerTarget = reversing && hasTrailer ? 1.0 : 0;
  smooth.revTrailer += (revTrailerTarget - smooth.revTrailer) * Math.min(1, dt * 3);
  if (smooth.revTrailer > 0.01) {
    zoom = Math.min(zoom, 1.9 - smooth.revTrailer * 0.2);
    camYRatio = 0.43 + smooth.revTrailer * 0.07;
  }

  const camY = GH * camYRatio;

  // ---- Focus: forward = slight offset behind cab; reverse = midpoint of
  //      cab + trailer rear (handles side jackknife) ---------------------
  let focusX = player.px;
  let focusY = player.py;
  if (trailer) {
    // 5th-wheel mount point on the cab (6 units behind pivot).
    const fwX = player.px - Math.cos(player.pAngle) * 6;
    const fwY = player.py - Math.sin(player.pAngle) * 6;
    const trRearX = fwX - Math.cos(trailer.angle) * trailer.length;
    const trRearY = fwY - Math.sin(trailer.angle) * trailer.length;
    const fwdFocusX = player.px - Math.cos(player.pAngle) * trailer.length * 0.10;
    const fwdFocusY = player.py - Math.sin(player.pAngle) * trailer.length * 0.10;
    const revFocusX = (player.px + trRearX) / 2;
    const revFocusY = (player.py + trRearY) / 2;
    const rv = smooth.revTrailer;
    focusX = fwdFocusX + (revFocusX - fwdFocusX) * rv;
    focusY = fwdFocusY + (revFocusY - fwdFocusY) * rv;
  }

  // Lag the focus to soften the per-frame motion under high steering input.
  smooth.trailOff += ((focusX - player.px) - smooth.trailOff) * Math.min(1, dt * 4);
  smooth.trailOffY2 += ((focusY - player.py) - smooth.trailOffY2) * Math.min(1, dt * 4);
  const smoothFocusX = player.px + smooth.trailOff;
  const smoothFocusY = player.py + smooth.trailOffY2;
  smooth.lastCamY = camY;

  // ---- Apply transform ---------------------------------------------------
  ctx.translate(WORLD_GW / 2, camY);
  ctx.scale(zoom, zoom);
  ctx.rotate(-player.pCamAngle - Math.PI / 2);
  ctx.translate(-smoothFocusX, -smoothFocusY);

  // ---- Tile bounds for the per-frame ground / overlay loops -------------
  const viewR = Math.max(WORLD_GW, GH) / zoom;
  const minTX = Math.floor((smoothFocusX - viewR) / TILE) - 1;
  const maxTX = Math.ceil((smoothFocusX + viewR) / TILE) + 1;
  const minTY = Math.floor((smoothFocusY - viewR) / TILE) - 1;
  // NOTE: monolith uses `focusY+viewR` (the unsmoothed focusY) here on
  // purpose — see L30097 of the source. Preserved verbatim.
  const maxTY = Math.ceil((focusY + viewR) / TILE) + 1;

  return { zoom, camYRatio, camY, smoothFocusX, smoothFocusY, viewR, minTX, maxTX, minTY, maxTY };
}
