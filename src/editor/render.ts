/**
 * World Editor — canvas render pass + status line + projection helpers.
 *
 * The editor's render is independent of the game's render(). It draws
 * to its own canvas (#weCanvas, full-window) with its own camera + zoom.
 * Two render modes coexist:
 *
 *  - SIMPLIFIED (always-on baseline): grass background, optional major
 *    grid, tile-pass colored fills, simple centerline strokes for roads
 *    and overlays. Cheap; legible at low zoom.
 *
 *  - GAME-RENDER (WORLD_EDITOR.gameRender, v8.99.126.02): full-fidelity
 *    pipeline — asphalt fill, edge stripes, lane dividers, bridge
 *    concrete, chevrons. Used when the toggle is on and zoom is high
 *    enough for fine details to be legible. Default ON so users see
 *    game parity immediately.
 *
 * SELECTION (v8.99.126.46): selection spans BOTH overlay roads
 * (selectedKind='road', `selected` indexes WORLD_EDITOR.overlay) AND
 * baseline roads (selectedKind='baselineRoad', `selectedBaselineRoad`
 * indexes majorRoads). Halo, edge stripes, vertex dots, and the
 * active-vertex ring all gate on the combined `isSelected` flag so a
 * permanent road lights up identically to an overlay road when picked.
 *
 * TILE PASS (v8.99.124.22): reads live map[] and colors each tile by
 * type. Adaptive stride caps total iterations near 80k regardless of
 * viewport × zoom — at very low zoom each on-screen pixel represents
 * many tiles and the stride samples one per cell. Activates at
 * zoom >= 0.5 (below that, simplified centerline view alone is fine).
 *
 * STATUS LINE: a sibling DOM element (#weStatus) shows hover tile, zoom,
 * active tool, draft state, and (v8.99.124.24) the hover-target road's
 * properties when drafting, so the user can match Major/lane/Bridge
 * settings before placing.
 *
 * Ported from monolith L10510-12871 (chevrons + tile→screen + smoothing
 * + render orchestrator + tapered merge road + full road draw + status).
 *
 * SCAFFOLD status: type contract + entry points stubbed with TODO line refs.
 */

import type { WorldEditorState } from './index';
import type { TilePoint } from './stamp';

/** A point in screen (canvas pixel) coordinates. */
export type ScreenPoint = [number, number];

/** Host bindings for the render pass. The renderer reads from the world
 *  arrays the game already maintains — keeping those dependencies
 *  inverted at the call site means render.ts has no direct
 *  dependency on world/buildings.ts, world/surfaces.ts, etc. */
export interface RenderDeps {
  /** The editor's canvas (full-window #weCanvas). */
  getCanvas(): HTMLCanvasElement | null;
  /** The status DOM element (#weStatus). */
  getStatusEl(): HTMLElement | null;
  /** Live map tile array + dimensions for the tile-pass. */
  getMap(): Uint8Array;
  MAP_W: number;
  MAP_H: number;
  /** Live majorRoads array. Includes baseline (with empty pts for
   *  v126.47 deletes) + overlay. */
  getMajorRoads(): Array<{ pts: number[][]; w: number; maj: number; name: string; z: number; [k: string]: unknown }>;
  /** Baseline length so the renderer can tell overlay rows from
   *  baseline rows by index. */
  getBaselineLength(): number;
  /** Per-road profile (lane geometry). Used by the game-render branch
   *  to draw lane dividers + edge stripes at game-parity. */
  getRoadProfile(road: { pts: number[][]; w: number }): {
    lps: number[];
    laneW: number;
    totalW: number;
    edgeOffsets?: number[];
  } | null;
  /** Tile dimension in pixels — drives STRIPE_INSET conversion
   *  (1.7/TILE in the game-render math). */
  TILE: number;
}

/** Returns the editor canvas. Tiny wrapper but keeps the document
 *  lookup centralized. TODO(E35-followup): port from L10471. */
export function _weCanvas(_deps: RenderDeps): HTMLCanvasElement | null {
  // TODO: L10471. return document.getElementById('weCanvas').
  return null;
}

/** Project a tile coord to screen pixels using the current view.
 *  TODO(E35-followup): port from L10479. */
export function _weTileToScreen(
  _tx: number,
  _ty: number,
  _state: WorldEditorState,
  _canvasSize: { w: number; h: number },
): ScreenPoint {
  // TODO: L10479. sx = w/2 + (tx - view.cx)*zoom; sy = h/2 + (ty - view.cy)*zoom.
  return [0, 0];
}

/** Inverse: project screen pixel to tile coords.
 *  TODO(E35-followup): port from L10472. */
export function _weScreenToTile(
  _sx: number,
  _sy: number,
  _state: WorldEditorState,
  _canvasSize: { w: number; h: number },
): { tx: number; ty: number } {
  // TODO: L10472. tx = (sx - w/2)/zoom + view.cx; symmetric for ty.
  return { tx: 0, ty: 0 };
}

/** Draw merge chevrons along a polyline. Spacing/depth/halfW/skip-end
 *  constants match the game-side pass byte-for-byte so the editor
 *  preview matches the live render.
 *  Constants (tile units):
 *    SPACING_T  = 3.0
 *    DEPTH_T    = 1.0
 *    HALFW_T    = 0.55
 *    SKIP_END_T = 1.5  (chevrons skip the last 1.5 tiles so they don't
 *                      overlap the bonded-end taper geometry)
 *  Unreadable below zoom 0.3 — early-returns there. TODO(E35-followup):
 *  port from L10510-10595. */
export function _weDrawMergeChevrons(
  _ctx: CanvasRenderingContext2D,
  _tilePts: TilePoint[],
  _zoom: number,
  _bright: boolean,
  _state: WorldEditorState,
  _canvasSize: { w: number; h: number },
): void {
  // TODO: L10510-10595. Project all points once via _weTileToScreen,
  // then walk SPACING_T-spaced anchors, skipping last SKIP_END_T tiles.
}

/** Stroke an offset polyline (tile coords) onto the canvas, with the
 *  given perpendicular offset (tile units) and lineWidth (screen px).
 *  Used for road edge stripes + lane dividers in the game-render branch.
 *  TODO(E35-followup): port from L10596. */
export function _weStrokeOffsetTilePath(
  _ctx: CanvasRenderingContext2D,
  _tilePts: TilePoint[],
  _offsetTiles: number,
  _lineWidth: number,
  _color: string,
  _dashArr: number[] | null,
  _state: WorldEditorState,
  _canvasSize: { w: number; h: number },
): void {
  // TODO: L10596. For each segment, perpendicular = (-ty, tx) unit;
  // offset = perp * offsetTiles; emit polyline through _weTileToScreen.
}

/** Build a smoothed (Catmull-Rom-ish) screen-space path from a tile
 *  polyline. Used when WORLD_EDITOR.gameRender is on to give the
 *  preview the same lane-curve smoothing the game-side renderer
 *  applies. TODO(E35-followup): port from L10697. */
export function _weBuildSmoothedScreenPath(
  _tilePts: TilePoint[],
  _state: WorldEditorState,
  _canvasSize: { w: number; h: number },
): ScreenPoint[] {
  // TODO: L10697. Project to screen, then apply the same smoothing
  // pass the game's render uses for road polylines.
  return [];
}

/** Inputs for game-render branch road draw. */
export interface DrawRoadFullOpts {
  ctx: CanvasRenderingContext2D;
  road: { pts: number[][]; w: number; maj: number; name: string; z: number; [k: string]: unknown };
  isOverlay: boolean;
  isSelected: boolean;
}

/** Full-fidelity road draw — asphalt fill, edge stripes, lane dividers,
 *  bridge concrete, terminal caps. Same pipeline as the game-side
 *  render, scaled to editor camera. TODO(E35-followup): port from
 *  L11533-11971. */
export function _weDrawRoadFull(
  _opts: DrawRoadFullOpts,
  _state: WorldEditorState,
  _canvasSize: { w: number; h: number },
  _deps: RenderDeps,
): void {
  // TODO: L11533-11971. Branch on road.bridgePts for concrete bridge
  // pass. Use edgeOffsets from getRoadProfile. Selection halo when
  // isSelected.
}

/** Inputs for tapered-merge road draw. */
export interface DrawTaperedMergeRoadOpts {
  ctx: CanvasRenderingContext2D;
  road: { pts: number[][]; w: number; [k: string]: unknown };
  prof: { lps: number[]; laneW: number; totalW: number };
  isSelected: boolean;
}

/** Render a merge road with width-aware tapers at bonded endpoints.
 *  Endpoint-bond detection lives inline (SEARCH_R = 3.5 tiles) — only
 *  endpoints within range of ANOTHER road's segment taper. Non-bonded
 *  endpoints render as flat road ends like any normal road
 *  (v8.99.126.05 fix for the "isolated needle" problem).
 *  TODO(E35-followup): port from L11336-11532. */
export function _weDrawTaperedMergeRoad(
  _opts: DrawTaperedMergeRoadOpts,
  _state: WorldEditorState,
  _canvasSize: { w: number; h: number },
  _deps: RenderDeps,
): void {
  // TODO: L11336-11532. Build outer/inner edge polygons via
  // editor/merge/taper.ts → _weBuildTaperedMergeEdges; fill + stroke
  // stripes; draw chevrons over the centerline.
}

/** The editor render orchestrator — clears canvas, paints background
 *  (grass when tile-pass is active, dark editor BG otherwise), draws
 *  major grid, tile-pass, road pass (simplified or game-render), draft
 *  preview, vertex dots, selection halos, river/lake/surface/building
 *  rows. TODO(E35-followup): port from L12170-12870. */
export function _weRender(
  _state: WorldEditorState,
  _deps: RenderDeps,
): void {
  // TODO: L12170-12870.
  //   1. Get canvas + ctx. Clear with grass color if zoom>=0.5 else
  //      dark editor BG.
  //   2. Compute tile-coord viewport bounds with +20 margin.
  //   3. Major grid lines every 100 tiles (gated zoom>0.05).
  //   4. Tile pass (zoom>=0.5, adaptive stride capped at 80k iters).
  //   5. For each majorRoad row:
  //        - viewport-cull via bbox
  //        - compute isSelectedOverlay / isSelectedBaseline (v126.46)
  //        - branch gameRender on/off
  //   6. Overlay rows (surfaces, buildings, rivers, lakes).
  //   7. Draft preview (if WORLD_EDITOR.draft).
  //   8. Selection halos + vertex dots + active-vertex ring.
}

/** Update the #weStatus DOM with hover tile, zoom, tool, draft state,
 *  and (when drafting a road) the hover-target's properties so the user
 *  can match Major/lane/Bridge before placing (v8.99.124.24).
 *  TODO(E35-followup): port from L12871-13157. */
export function _weUpdateStatus(
  _state: WorldEditorState,
  _deps: RenderDeps,
): void {
  // TODO: L12871-13157. Compose mode string by tool + draft, append
  // hover snap target info (lanes/major/bridge) when drafting a road.
}
