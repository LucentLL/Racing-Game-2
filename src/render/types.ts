/**
 * Shared types for the per-phase render modules under src/render/.
 *
 * The render orchestrator (render/index.ts) computes a FrameView each frame
 * from the live player + camera state, applies the camera transform to the
 * canvas context, and then calls each phase module in z-order.
 *
 * Phase modules accept (ctx, view, ...deps) and never read mutable globals.
 */

import type { PlayerPose } from '@/state/life';

/** Mutable camera-smoothing state. The camera applies low-pass smoothing to
 *  speed-based zoom, trailer reverse focus, jackknife widen, and trail-off
 *  focus offset. The orchestrator owns this object and passes it in by
 *  reference each frame. */
export interface CameraSmoothState {
  /** Smoothed speed ratio 0..1 for the dynamic zoom curve. */
  spdSmooth: number;
  /** Smoothed flag (0..1) — has-trailer pulls zoom out. */
  trailerZoom: number;
  /** Smoothed jackknife widen (0..1) — trailer angle > 17° pulls zoom out. */
  jkZoom: number;
  /** Smoothed reverse-with-trailer flag (0..1). */
  revTrailer: number;
  /** Camera focus drift X (world units). Lagging focus offset off the player. */
  trailOff: number;
  /** Camera focus drift Y (world units). */
  trailOffY2: number;
  /** Last frame's camY (used by tilt + minimap sync elsewhere). */
  lastCamY: number;
}

export function createCameraSmoothState(): CameraSmoothState {
  return {
    spdSmooth: 0,
    trailerZoom: 0,
    jkZoom: 0,
    revTrailer: 0,
    trailOff: 0,
    trailOffY2: 0,
    lastCamY: 0,
  };
}

/** Per-frame derived camera + viewport view. Produced by applyCamera() and
 *  threaded through every render phase. */
export interface FrameView {
  /** Effective world-zoom factor after speed/trailer/jackknife/reverse blend. */
  zoom: number;
  /** Camera's vertical anchor as a fraction of GH (0..1). Inverted via CSS
   *  perspective when TILT_MODE is on. */
  camYRatio: number;
  /** camYRatio * GH — the actual canvas Y the camera is anchored to. */
  camY: number;
  /** World-space camera focus point (player position blended with trailer
   *  rear for reverse). Lagged via CameraSmoothState. */
  smoothFocusX: number;
  smoothFocusY: number;
  /** Tile-coordinate bounds of the visible region (with a 1-tile border). */
  minTX: number;
  maxTX: number;
  minTY: number;
  maxTY: number;
  /** World-pixel radius of the visible region — view-frustum cull radius. */
  viewR: number;
}

/** Minimal player input the camera needs. */
export interface CameraPlayer extends PlayerPose {
  pSpeed: number;
  /** Camera-facing angle. Decoupled from pAngle so the camera can lag
   *  during jackknife / reverse. */
  pCamAngle: number;
  /** Body-type === 'semi' — affects camYRatio (semis sit higher for trailer
   *  visibility). */
  isSemiPlayer: boolean;
}

/** Trailer pose. Null when no trailer is attached. */
export interface CameraTrailer {
  /** World angle of the trailer (independent of pAngle during jackknife). */
  angle: number;
  /** Trailer length in world units. */
  length: number;
  /** Jackknife angle magnitude in radians. Zooming widens at > 0.3 rad. */
  jackknife: number;
}

/** Tilt-mode configuration. When mode !== 0 the canvas is CSS-rotated about
 *  its bottom edge and the camYRatio is computed by inverting the perspective
 *  divide so a target screen-Y projects back to a canvas-Y. */
export interface TiltConfig {
  /** 0 = no tilt; 1+ = tilt is on. */
  mode: number;
  /** CSS perspective() value in px. */
  perspectivePx: number;
  /** Returns the active tilt angle (degrees) for a given viewport height.
   *  Mirrors resize()'s clamp curve so the inverse-perspective matches the
   *  actual CSS rotation. */
  effectiveTiltDeg(viewportHeight: number): number;
  /** Multiplier applied to the desktop _domH calc to match resize(). */
  canvasOverscan: number;
}

/** Viewport in CSS pixels (window.innerWidth/Height) plus the internal-canvas
 *  GW/GH and the WORLD_GW that grows with tilt. */
export interface Viewport {
  /** window.innerWidth */
  vw: number;
  /** window.innerHeight */
  vh: number;
  /** Internal canvas width before tilt widening. */
  GW: number;
  /** Internal canvas height. */
  GH: number;
  /** Internal canvas width after tilt widening (= GW if tilt off). */
  WORLD_GW: number;
}

/** All scalars the camera math reads from outside the render system. */
export interface CameraInput {
  player: CameraPlayer;
  trailer: CameraTrailer | null;
  viewport: Viewport;
  tilt: TiltConfig;
  /** Frame delta-time in seconds, used by the smoothing low-pass. */
  dt: number;
  /** Meters-per-world-unit scale (px → m/s conversion: speed_mph = pSpeed/SCALE_MS * 2.237). */
  SCALE_MS: number;
  /** World tile size in world-units. */
  TILE: number;
}
