/**
 * Render-pass orchestrator. Per frame:
 *   1. Clear the world buffer in identity space.
 *   2. Save the context, then apply the camera transform.
 *   3. Call each phase module in z-order (back to front).
 *   4. Restore the context for the HUD overlays.
 *
 * Ported from render() L29957–36272 of the v8.99.126.89 monolith. The 22
 * z-ordered phases are documented in MIGRATION_PLAN.md §2.2. This file owns
 * the call order; each phase module owns its own drawing.
 *
 * The remaining 19 phases land in commits C17–C20:
 *   C17 — roads, intersections, skidMarks, speedTrail
 *   C18 — trafficCop, tow, trailer, headlightShadows
 *   C19 — carBody (player + traffic + V2 + xray damage)
 *   C20 — gauges, canvasHud, crt
 *
 * Until those modules land, the matching phase calls below are commented
 * stubs. Wiring against this orchestrator (the cutover from the monolith)
 * is its own future step — Phase C is extraction-only.
 */

import type {
  CameraInput,
  CameraSmoothState,
  FrameView,
  Viewport,
} from './types';
import { applyCamera } from './camera';
import { drawGround, type GroundDeps } from './ground';
import { drawForegroundProps, type ForegroundPropsDeps } from './foregroundProps';

/** Background color the world buffer is cleared to each frame. */
const WORLD_CLEAR_COLOR = '#0a0a12';

export interface RenderDeps {
  ground: GroundDeps;
  foregroundProps: ForegroundPropsDeps;
}

export interface RenderInput {
  camera: CameraInput;
  /** Mutable camera-smoothing state — owned by the caller (game module). */
  smooth: CameraSmoothState;
}

/** Single-frame render entry point. Returns the FrameView so HUD overlays
 *  drawn outside the world transform can still consult zoom/camY/etc. */
export function render(
  ctx: CanvasRenderingContext2D,
  input: RenderInput,
  deps: RenderDeps,
): FrameView {
  const view = setupFrame(ctx, input);

  // Phase 1 — Ground tiles.
  drawGround(ctx, view, deps.ground);

  // Phase 2 — Foreground props (water shimmer, canyon fog, exit signs,
  // interstate shields). Sits after the ground but before the road overlay
  // so exit signs land on top of grass/asphalt and below curve overlays.
  drawForegroundProps(ctx, view, deps.foregroundProps);

  // Phase 3 — Road overlay pass 1 (smooth curves).         [C17]
  // Phase 4 — Intersections (stop bars, crosswalks).        [C17]
  // Phase 5 — Skid marks.                                   [C17]
  // Phase 6 — Speed trail (Akira taillight).                [C17]
  // Phase 7 — Particles.                                    [C17]
  // Phase 8 — Traffic trailers.                             [C18]
  // Phase 9 — Cop pursuit visuals.                          [C18]
  // Phase 10 — Tow truck winch animation.                   [C18]
  // Phase 11 — 53' trailer.                                 [C18]
  // Phase 12 — Headlight shadow mask.                       [C18]
  // Phase 13 — HUD context swap.                            [C20]
  // Phase 14 — Minimap (SVG sync).                          [C20]
  // Phase 15 — Full map overlay.                            [C20]
  // Phase 16 — Speed/gear/RPM (canvas fallback).            [C20]
  // Phase 17 — Analog gauges.                               [C20]
  // Phase 18 — Menu overlays.                               [Phase D]
  // Phase 19 — Race HUD.                                    [Phase D]
  // Phase 20 — Scanlines / CRT.                             [C20]
  // Phase 21 — Diag badges.                                 [Phase F strip]
  // Phase 22 — Car body (player + traffic + xray damage).   [C19]

  ctx.restore();
  return view;
}

/** Clears the world buffer in identity space, saves the ctx, and applies
 *  the camera transform. The returned FrameView is consumed by every
 *  subsequent phase. */
function setupFrame(
  ctx: CanvasRenderingContext2D,
  input: RenderInput,
): FrameView {
  const vp: Viewport = input.camera.viewport;
  ctx.fillStyle = WORLD_CLEAR_COLOR;
  // v8.98.24: use WORLD_GW so the full canvas is cleared when tilt widens it.
  ctx.fillRect(0, 0, vp.WORLD_GW, vp.GH);
  ctx.save();
  return applyCamera(ctx, input.camera, input.smooth);
}
