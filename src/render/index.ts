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
import { drawRoadsPass1, drawRoadsPass2, type RoadsPassDeps } from './roads';
import { drawIntersections, type IntersectionsDeps } from './intersections';
import { drawSkidMarks, type SkidMarksDeps } from './skidMarks';
import { drawSpeedTrail, type SpeedTrailDeps } from './speedTrail';
import { drawTrafficCop, type TrafficCopDeps } from './trafficCop';
import { drawTow, type TowDeps } from './tow';
import { drawTrailer, type TrailerDeps } from './trailer';
import {
  drawNightTint,
  drawStreetLightPools,
  drawHeadlightConesPassA,
  drawHeadlightConesPassB,
  drawPlayerTaillights,
  drawTrafficHeadlightCones,
  drawHeadlightIlluminationOnTraffic,
  type NightTintDeps,
  type StreetLightDeps,
  type HeadlightPassADeps,
  type HeadlightPassBDeps,
  type PlayerTaillightsDeps,
  type TrafficHeadlightsDeps,
  type RimLightDeps,
} from './headlightShadows';

/** Background color the world buffer is cleared to each frame. */
const WORLD_CLEAR_COLOR = '#0a0a12';

export interface RenderDeps {
  ground: GroundDeps;
  foregroundProps: ForegroundPropsDeps;
  roads: RoadsPassDeps;
  intersections: IntersectionsDeps;
  skidMarks: SkidMarksDeps;
  speedTrail: SpeedTrailDeps;
  trafficCop: TrafficCopDeps;
  tow: TowDeps;
  trailer: TrailerDeps;
  nightTint: NightTintDeps;
  streetLights: StreetLightDeps;
  headlightPassA: HeadlightPassADeps;
  headlightPassB: HeadlightPassBDeps;
  playerTaillights: PlayerTaillightsDeps;
  trafficHeadlights: TrafficHeadlightsDeps;
  rimLight: RimLightDeps;
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

  // Phase 3 — Road overlay pass 1 (smooth curves; roads at z <= playerZ).
  drawRoadsPass1(ctx, view, deps.roads);

  // Phase 4 — Intersections (stop bars, crosswalks).
  drawIntersections(ctx, view, deps.intersections);

  // Phase 5 — Skid marks.
  drawSkidMarks(ctx, view, deps.skidMarks);

  // Phase 6 — Particles.                                    [engine/particles wired later]
  // Phase 7 — Traffic trailers.                             [C18b — z-order revisit]

  // Phase 8 — Cop pursuit visuals (radar fan, lightbar, target ring).
  drawTrafficCop(ctx, view, deps.trafficCop);

  // Phase 9 — Tow truck winch animation (player tow job + AI incoming tow).
  drawTow(ctx, view, deps.tow);

  // Phase 10 — 53' trailer (player's TRUCK DRIVER job — tanker / box variants).
  drawTrailer(ctx, deps.trailer);

  // Phase 11a — Player headlight cones Pass A (pre-tint, off-screen mask
  // canvas with body + tire shadow casting, composited via source-over).
  drawHeadlightConesPassA(ctx, view, deps.headlightPassA);

  // Phase 11b — Night ambient tint. Returns the tint alpha; the next call
  // (street-light pools) gates on it.
  const tintAlpha = drawNightTint(ctx, view, deps.nightTint);

  // Phase 11c — Street-light pools at minor-road intersections. Only runs
  // when the ambient tint is >0.05 (i.e. it's genuinely dark out).
  if (tintAlpha > 0.05) {
    drawStreetLightPools(ctx, view, deps.streetLights);
  }

  // Phase 11d — Player headlight cones Pass B (post-tint, 'lighter'
  // composite — visibly brightens the night-tinted ground).
  drawHeadlightConesPassB(ctx, view, deps.headlightPassB);

  // Phase 11e — Player taillight halos (running + brake + reverse) with
  // trailer + traffic + bridge occluder punch.
  drawPlayerTaillights(ctx, view, deps.playerTaillights);

  // Phase 11f — Traffic + race + AI-tow vehicle headlight cones.
  drawTrafficHeadlightCones(ctx, view, deps.trafficHeadlights);

  // Phase 11g — Rim-light illumination on traffic facing the player's beam.
  drawHeadlightIlluminationOnTraffic(ctx, view, deps.rimLight);

  // Phase 12 — Car body (player + traffic + xray damage).         [C19]

  // Phase 13 — Speed trail (Akira) — drawn AFTER carBody so the newest tip
  // visually connects to the taillights (v8.99.60 z-order).
  drawSpeedTrail(ctx, view, deps.speedTrail);

  // Phase 14 — Road overlay pass 2 (roads ABOVE playerZ — these cover the
  // player car when driving under a bridge).
  drawRoadsPass2(ctx, view, deps.roads);

  // Phase 15 — HUD context swap.                            [C20]
  // Phase 16 — Minimap (SVG sync).                          [C20]
  // Phase 17 — Full map overlay.                            [C20]
  // Phase 18 — Speed/gear/RPM (canvas fallback).            [C20]
  // Phase 19 — Analog gauges.                               [C20]
  // Phase 20 — Menu overlays.                               [Phase D]
  // Phase 21 — Race HUD.                                    [Phase D]
  // Phase 22 — Scanlines / CRT.                             [C20]
  // Phase 23 — Diag badges.                                 [Phase F strip]

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
