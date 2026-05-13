/**
 * Roads phase entry points. Two passes drive the z-layered look: pass 1
 * draws roads at or below the player's z-level (so the player car overdraws
 * them), pass 2 draws roads above the player (covers the player when they
 * drive under a bridge).
 *
 * Ported from render() L31676–31681 (pass 1) and L32726–32733 (pass 2).
 */

import type { FrameView } from '../types';
import type { Road, RoadOverlayDeps } from './types';
import { drawRoadOverlay } from './overlay';

export interface RoadsPassDeps extends RoadOverlayDeps {
  /** Roads to consider — typically the precomputed _sortedRoadsByZ list. */
  roads: ReadonlyArray<Road>;
  /** Player's current z-level for the pass-1/pass-2 split. */
  playerZ: number;
}

export function drawRoadsPass1(
  ctx: CanvasRenderingContext2D,
  _view: FrameView,
  deps: RoadsPassDeps,
): void {
  if (deps.diagOffRoads) return;
  for (const road of deps.roads) {
    if ((road.z || 0) <= deps.playerZ) drawRoadOverlay(ctx, road, deps);
  }
}

export function drawRoadsPass2(
  ctx: CanvasRenderingContext2D,
  _view: FrameView,
  deps: RoadsPassDeps,
): void {
  if (deps.diagOffRoads) return;
  for (const road of deps.roads) {
    if ((road.z || 0) > deps.playerZ) drawRoadOverlay(ctx, road, deps);
  }
}

export { drawRoadOverlay } from './overlay';
export { traceRoadPath } from './traceRoadPath';
export type { Road, RoadProfile, RoadChunk, RoadOverlayDeps, BBox, BridgePoint } from './types';
