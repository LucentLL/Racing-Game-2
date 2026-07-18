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
 */

import type { WorldEditorState } from './index';
import type { TilePoint } from './stamp';
import { BASELINE_ROADS } from '@/config/world/baselineRoads';
import { ROAD_CROSSINGS } from '@/world/roadCrossings';
import { TILE } from '@/config/world/tiles';
import { getEditedBaselinePts } from './input';
import { _weSpanHighlightPts } from './span';
import { computeEndWelds, applyWeldClips } from '@/render/endWelds';
// H1181: the live render list — the editor's auto-taper flare pass reads
// the SAME autoTaperStart/End metadata the game bakes at rebuild, so the
// editor preview shows lane-count transitions with zero duplicated math.
// (worldMap imports editor/merge geometry helpers but never editor/render
// — no cycle.)
import { RENDER_ENTRIES } from '@/render/worldMap';
import { smoothPolyline } from '@/render/pathSmoothing';
import { computeStallLayout } from './parkingLayout';
import { _weParseParkingLotMeta, _weIsDrivewayName } from './stamp';
import { parseIntersectionRow, INTERSECTION_CONTROL_NAMES } from './intersectionSchema';
import { drawRoof as _weDrawRoof, drawDrivewayStrip as _weDrawDrivewayStrip } from '@/render/roofs';
import { smoothPolyline as _smoothOpenPolyline, smoothClosedPolygon as _smoothClosedPolygon } from '@/render/pathSmoothing';
import {
  _computeMergeInnerDir,
  _resolveMergeInnerDir,
  _weBuildTaperedMergeEdges,
  type InnerDirRoad,
} from './merge/taper';

/** Inline TilePoint type to keep render.ts decoupled from stamp.ts. */
type TPt = [number, number];

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
   *  to draw lane dividers + edge stripes at game-parity. `lps` is the
   *  per-side lane count (scalar) — matches monolith getLaneGeom's
   *  return shape and snap.ts's SnapDeps.getRoadProfile.
   *
   *  H610: `wearOffsets` / `oilOffsets` carry the per-lane tire-wear
   *  track and oil-drip stripe offsets (signed, both sides). Populated
   *  only when lps >= 2; empty/absent for single-lane minors so the
   *  wear/oil pass no-ops cheaply. */
  getRoadProfile(road: { pts: number[][]; w: number }): {
    lps: number;
    laneW: number;
    totalW: number;
    /** H642: full visual stroke width including shoulders. For divided
     *  highways (I-485 grass median + w>=12 jersey barrier) this is
     *  `totalW + 2 * (0.5 * laneW)`; for non-divided roads it equals
     *  `totalW`. Optional for back-compat — callers fall back to
     *  totalW when absent. Matches monolith getRoadProfile L18757. */
    asphaltW?: number;
    dividers?: number[];
    edgeOffsets?: number[];
    /** H643: yellow inner-edge stripe offsets for divided highways
     *  (I-485 + w>=12 jersey barrier). Mirrors monolith worldMap.ts
     *  pass 18 — paired stripes at ±(medHalf + STRIPE_INSET). */
    innerEdgeOffsets?: number[];
    wearOffsets?: number[];
    oilOffsets?: number[];
  } | null;
  /** Tile dimension in pixels — drives STRIPE_INSET conversion
   *  (1.7/TILE in the game-render math). */
  TILE: number;
}

/** Returns the editor canvas, or null if the editor DOM hasn't been
 *  mounted yet. Centralizing the document lookup means every editor
 *  helper that needs the canvas reads from one place — easy to swap
 *  the lookup mechanism (test stub, multi-instance, etc.) without
 *  hunting through every call site.
 *
 *  Returns `null` rather than throwing on missing element so the
 *  editor's tick / render path can defensively short-circuit during
 *  the brief window between F9-toggle and DOM mount. All call sites
 *  in the monolith follow the `const c = _weCanvas(); if(!c) return;`
 *  pattern (see L10473 / L10480 / L12171 / L13189).
 *
 *  Ported 1:1 from monolith L10471. */
export function _weCanvas(): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  return document.getElementById('weCanvas') as HTMLCanvasElement | null;
}

/** Project a tile coord to screen pixels using the current view.
 *  1:1 port of monolith L10479. */
export function _weTileToScreen(
  tx: number,
  ty: number,
  state: WorldEditorState,
  canvasSize: { w: number; h: number },
): ScreenPoint {
  return [
    canvasSize.w / 2 + (tx - state.view.cx) * state.view.zoom,
    canvasSize.h / 2 + (ty - state.view.cy) * state.view.zoom,
  ];
}

/** Inverse: project screen pixel to tile coords.
 *  1:1 port of monolith L10472. */
export function _weScreenToTile(
  sx: number,
  sy: number,
  state: WorldEditorState,
  canvasSize: { w: number; h: number },
): { tx: number; ty: number } {
  return {
    tx: (sx - canvasSize.w / 2) / state.view.zoom + state.view.cx,
    ty: (sy - canvasSize.h / 2) / state.view.zoom + state.view.cy,
  };
}

/** H116: minimal editor render pass — paints the baseline-roads
 *  network + crossings + a status banner. Self-contained (imports
 *  data directly instead of going through RenderDeps) so the editor
 *  can come alive without all 13 sibling modules porting their
 *  bodies first. Superseded for production use by `_weRender` (H358),
 *  which composes the full game-render parity pipeline; this
 *  function remains as the boot-time render path used by `_weTick`
 *  before deps are wired. */
export function renderEditor(state: WorldEditorState, canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const cs = { w: canvas.width, h: canvas.height };
  const zoom = state.view.zoom;
  // Background — grass green at any zoom for now; tile-pass that
  // colors per-tile lands when we port that branch.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#1a2818';
  ctx.fillRect(0, 0, cs.w, cs.h);
  // Major grid every 100 tiles, only when zoom is high enough to
  // read it (matches monolith L12180-12210 grid pass). Subtle
  // dark-on-grass so it doesn't compete with the roads.
  if (zoom > 0.05) {
    const halfTilesW = (cs.w / 2) / zoom;
    const halfTilesH = (cs.h / 2) / zoom;
    const minTx = Math.floor((state.view.cx - halfTilesW) / 100) * 100;
    const maxTx = Math.ceil((state.view.cx + halfTilesW) / 100) * 100;
    const minTy = Math.floor((state.view.cy - halfTilesH) / 100) * 100;
    const maxTy = Math.ceil((state.view.cy + halfTilesH) / 100) * 100;
    ctx.strokeStyle = 'rgba(60, 80, 50, 0.6)';
    ctx.lineWidth = 1;
    for (let tx = minTx; tx <= maxTx; tx += 100) {
      const [sx] = _weTileToScreen(tx, state.view.cy, state, cs);
      ctx.beginPath();
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, cs.h);
      ctx.stroke();
    }
    for (let ty = minTy; ty <= maxTy; ty += 100) {
      const [, sy] = _weTileToScreen(state.view.cx, ty, state, cs);
      ctx.beginPath();
      ctx.moveTo(0, sy);
      ctx.lineTo(cs.w, sy);
      ctx.stroke();
    }
  }
  // Baseline roads pass — paint each as a width-band stroke (asphalt
  // grey for minors, slightly lighter for majors). Centerline dash on
  // top for legibility. H121: applies state.baselineEdits via the
  // getEditedBaselinePts resolver so vertex drags show up immediately.
  const deletedSet = new Set(state.baselineDeletes);
  for (let rIdx = 0; rIdx < BASELINE_ROADS.length; rIdx++) {
    // H122: skip baseline roads the user has deleted in the editor.
    // Index stays stable (the slot just renders nothing) so subsequent
    // baselineEdits keyed by index remain valid.
    if (deletedSet.has(rIdx)) continue;
    const row = BASELINE_ROADS[rIdx];
    const w = row[0];
    const maj = row[1] === 1;
    const pts = getEditedBaselinePts(state, rIdx);
    if (pts.length < 2) continue;
    const isSelected = state.selectedKind === 'baselineRoad' && state.selectedBaselineRoad === rIdx;
    // H123: smooth the polyline so vertex joints curve gently instead
    // of kinking. The smoothed pts feed the stroke + halo + centerline
    // passes; vertex dots still use the SOURCE pts so they stay on the
    // user's actual click positions, not on the interpolated curve.
    const smoothed: readonly TPt[] = pts.length >= 3 ? smoothPolyline(pts) : pts;
    // Bbox cull uses the smoothed pts (they include the source pts as
    // exact samples so the bbox is at least as wide as the source).
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of smoothed) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
    const [sxMin, syMin] = _weTileToScreen(minX, minY, state, cs);
    const [sxMax, syMax] = _weTileToScreen(maxX, maxY, state, cs);
    if (sxMax < -50 || sxMin > cs.w + 50 || syMax < -50 || syMin > cs.h + 50) continue;
    // H121 selection halo — pale yellow stroke at 1.5× the road width
    // painted BEFORE the asphalt so the halo peeks out as an outline.
    if (isSelected) {
      ctx.strokeStyle = 'rgba(255, 220, 120, 0.55)';
      ctx.lineWidth = Math.max(3, w * zoom * 1.5);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (let i = 0; i < smoothed.length; i++) {
        const [sx, sy] = _weTileToScreen(smoothed[i][0], smoothed[i][1], state, cs);
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      }
      ctx.stroke();
    }
    // Asphalt stroke.
    ctx.strokeStyle = maj ? '#3a3a3e' : '#2e2e30';
    ctx.lineWidth = Math.max(1, w * zoom);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i < smoothed.length; i++) {
      const [sx, sy] = _weTileToScreen(smoothed[i][0], smoothed[i][1], state, cs);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    ctx.stroke();
    // Centerline dash on majors only — readability at low zoom.
    if (maj && zoom > 0.2) {
      ctx.strokeStyle = '#e8c060';
      ctx.lineWidth = Math.max(0.5, zoom * 0.4);
      ctx.setLineDash([8, 8]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // H121 vertex dots on the selected baseline road. White-filled
    // circles with a yellow ring (active vertex gets the ring filled
    // bright yellow so the user knows which one is dragging). Dots
    // sit on the SOURCE pts, not the smoothed samples — they mark
    // the user's actual click positions.
    if (isSelected && zoom > 0.1) {
      for (let vi = 0; vi < pts.length; vi++) {
        const [vsx, vsy] = _weTileToScreen(pts[vi][0], pts[vi][1], state, cs);
        const isActive = vi === state.activeVertex;
        ctx.fillStyle = isActive ? '#ffea60' : '#fff';
        ctx.strokeStyle = '#e8c060';
        ctx.lineWidth = 1.5;
        const radius = Math.max(3, zoom * 3);
        ctx.beginPath();
        ctx.arc(vsx, vsy, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
  }
  // H118: overlay roads — drawn AFTER baseline so user-placed roads
  // sit on top of the source-defined network. Same width-band stroke
  // style; uses a slightly different asphalt shade so overlay rows
  // are visually distinct from baseline rows at high zoom.
  // H123: same Catmull-Rom smoothing baseline gets.
  // H130: selection halo + vertex dots on the selected overlay row.
  for (let oIdx = 0; oIdx < state.overlay.length; oIdx++) {
    const rowRaw = state.overlay[oIdx];
    const row = rowRaw as readonly (string | number)[];
    if (row.length < 6) continue;
    const w = row[0] as number;
    const maj = row[1] === 1;
    const xStart = row.length % 2 === 0 ? 4 : 5;
    const tuples: TPt[] = [];
    for (let i = xStart; i + 1 < row.length; i += 2) {
      tuples.push([row[i] as number, row[i + 1] as number]);
    }
    if (tuples.length < 2) continue;
    const smoothed: readonly TPt[] = tuples.length >= 3 ? smoothPolyline(tuples) : tuples;
    const isSelected = state.selectedKind === 'road' && state.selected === oIdx;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of smoothed) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
    const [sxMin, syMin] = _weTileToScreen(minX, minY, state, cs);
    const [sxMax, syMax] = _weTileToScreen(maxX, maxY, state, cs);
    if (sxMax < -50 || sxMin > cs.w + 50 || syMax < -50 || syMin > cs.h + 50) continue;
    // H130 selection halo — same yellow stroke baseline gets.
    if (isSelected) {
      ctx.strokeStyle = 'rgba(255, 220, 120, 0.55)';
      ctx.lineWidth = Math.max(3, w * zoom * 1.5);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (let i = 0; i < smoothed.length; i++) {
        const [sx, sy] = _weTileToScreen(smoothed[i][0], smoothed[i][1], state, cs);
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      }
      ctx.stroke();
    }
    ctx.strokeStyle = maj ? '#454550' : '#383840';
    ctx.lineWidth = Math.max(1, w * zoom);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i < smoothed.length; i++) {
      const [sx, sy] = _weTileToScreen(smoothed[i][0], smoothed[i][1], state, cs);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    ctx.stroke();
    // H130 vertex dots — on the SOURCE pts (not the smoothed samples)
    // so the user's clicked positions stay accurate. Active vertex
    // (currently dragging) fills bright yellow.
    if (isSelected && zoom > 0.1) {
      for (let vi = 0; vi < tuples.length; vi++) {
        const [vsx, vsy] = _weTileToScreen(tuples[vi][0], tuples[vi][1], state, cs);
        const isActive = vi === state.activeVertex;
        ctx.fillStyle = isActive ? '#ffea60' : '#fff';
        ctx.strokeStyle = '#e8c060';
        ctx.lineWidth = 1.5;
        const radius = Math.max(3, zoom * 3);
        ctx.beginPath();
        ctx.arc(vsx, vsy, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
  }
  // H118: in-flight draft polyline + vertex dots. Cyan so it pops
  // against the asphalt grays; thinner than the eventual committed
  // width since the draft is "preview" not "real". Vertex dots make
  // it obvious how many points have been placed.
  const draft = state.draft;
  if (draft && draft.kind === 'road' && draft.pts.length > 0) {
    // H123: smooth the draft preview so the user sees what the road
    // will look like (curved at joints) before committing.
    const draftTuples = draft.pts.map((p) => [p[0], p[1]] as TPt);
    const draftSmooth: readonly TPt[] = draftTuples.length >= 3
      ? smoothPolyline(draftTuples)
      : draftTuples;
    ctx.strokeStyle = 'rgba(120, 220, 230, 0.85)';
    ctx.lineWidth = Math.max(1, 1.5);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    for (let i = 0; i < draftSmooth.length; i++) {
      const pt = draftSmooth[i];
      const [sx, sy] = _weTileToScreen(pt[0], pt[1], state, cs);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    // H119 ghost segment — translucent stroke from the last placed
    // vertex to the live cursor tile. Updates per-frame as the user
    // moves the mouse so they can see where the next click will land
    // before committing. Faded alpha + no dash so it reads as
    // "preview, not yet placed" vs the dashed committed-vertices line.
    const last = draft.pts[draft.pts.length - 1];
    const [lx, ly] = _weTileToScreen(last[0], last[1], state, cs);
    const [hx, hy] = _weTileToScreen(state.hoverTile.tx, state.hoverTile.ty, state, cs);
    ctx.strokeStyle = 'rgba(120, 220, 230, 0.35)';
    ctx.lineWidth = Math.max(1, 1.5);
    ctx.beginPath();
    ctx.moveTo(lx, ly);
    ctx.lineTo(hx, hy);
    ctx.stroke();
    // Vertex dots (drawn AFTER ghost so the dots sit on top of any
    // ghost line that loops back near a previous vertex).
    ctx.fillStyle = '#78dce8';
    for (const pt of draft.pts) {
      const [sx, sy] = _weTileToScreen(pt[0], pt[1], state, cs);
      ctx.beginPath();
      ctx.arc(sx, sy, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    // H119 cursor ring at the ghost endpoint — small open circle at
    // the live tile so the user sees the exact landing point.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(hx, hy, 4, 0, Math.PI * 2);
    ctx.stroke();
  }
  // Crossings — small ring at each intersection so the user can
  // visually verify the auto-detection from world/roadCrossings.ts.
  if (zoom > 0.15) {
    ctx.strokeStyle = '#ff6';
    ctx.lineWidth = 1;
    for (const c of ROAD_CROSSINGS) {
      const tx = c.x / TILE;
      const ty = c.y / TILE;
      const [sx, sy] = _weTileToScreen(tx, ty, state, cs);
      if (sx < -8 || sx > cs.w + 8 || sy < -8 || sy > cs.h + 8) continue;
      ctx.beginPath();
      ctx.arc(sx, sy, Math.max(3, zoom * 4), 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  // H133: snap-preview indicator. While a vertex drag is in flight
  // and the cursor is within snap radius of another road's vertex,
  // _snapPreview holds the target tile coords. Paint a bright yellow
  // outlined ring so the user sees the "magnetic" lock visually.
  // Cleared on mouseup by _weCanvasMouseUp.
  if (state._snapPreview) {
    const [snx, sny] = _weTileToScreen(state._snapPreview.x, state._snapPreview.y, state, cs);
    ctx.strokeStyle = '#ffea60';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(snx, sny, Math.max(6, zoom * 5), 0, Math.PI * 2);
    ctx.stroke();
    // Inner crosshair so it's unambiguous which exact tile is the
    // snap target, even when zoomed out.
    ctx.beginPath();
    ctx.moveTo(snx - 3, sny);
    ctx.lineTo(snx + 3, sny);
    ctx.moveTo(snx, sny - 3);
    ctx.lineTo(snx, sny + 3);
    ctx.stroke();
  }

  // Status banner — overlay text bottom-left + top-right.
  ctx.fillStyle = '#e8c060';
  ctx.font = 'bold 14px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('WORLD EDITOR — F9/ESC exit · Shift+click select · drag vertex · Alt+click insert · Del remove · Ctrl+S save', 12, 24);
  // H120 save-confirmation flash. Triggers 2-second "MAP SAVED" toast
  // at top-center; needsRedraw is set on the Ctrl+S press so the first
  // frame paints the flash; subsequent frames within the 2-second
  // window don't auto-redraw, so the toast is "set and forget" rather
  // than animated. Acceptable for a confirmation message; the user
  // sees it on the save-frame and any subsequent input refresh.
  if (state.lastSaveAtMs > 0) {
    const age = Date.now() - state.lastSaveAtMs;
    if (age < 2000) {
      const fade = 1 - age / 2000;
      ctx.fillStyle = `rgba(127, 255, 90, ${fade})`;
      ctx.font = 'bold 18px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('MAP SAVED', cs.w / 2, 60);
      ctx.textAlign = 'left';
    }
  }
  ctx.fillStyle = '#aaa';
  ctx.font = '11px monospace';
  const draftInfo = state.draft && state.draft.kind === 'road'
    ? `   draft: ${state.draft.pts.length} pts (right-click commit, ESC cancel)`
    : '   click to place road vertex';
  ctx.fillText(
    `tool: ${state.tool}   view: (${state.view.cx.toFixed(0)}, ${state.view.cy.toFixed(0)})   zoom: ${zoom.toFixed(2)}   baseline: ${BASELINE_ROADS.length}   overlay: ${state.overlay.length}${draftInfo}`,
    12,
    42,
  );
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
 *  Unreadable below zoom 0.3 — early-returns there.
 *  Ported 1:1 from monolith L10510-L10595. */
export function _weDrawMergeChevrons(
  ctx: CanvasRenderingContext2D,
  tilePts: TilePoint[],
  zoom: number,
  bright: boolean,
  state: WorldEditorState,
  canvasSize: { w: number; h: number },
): void {
  if (!tilePts || tilePts.length < 2) return;
  if (zoom < 0.3) return; // chevrons unreadable below this zoom

  // Same constants as the game-side pass, in TILE units.
  const SPACING_T = 3.0;
  const DEPTH_T = 1.0;
  const HALFW_T = 0.55;
  const SKIP_END_T = 1.5;

  // Total length in TILE units, for the end-skip threshold check.
  // (Per-point screen projections are cheap but the cumulative-length
  // walk below needs raw tile-space anyway.)
  let totLen = 0;
  for (let i = 0; i < tilePts.length - 1; i++) {
    const dx = tilePts[i + 1][0] - tilePts[i][0];
    const dy = tilePts[i + 1][1] - tilePts[i][1];
    totLen += Math.hypot(dx, dy);
  }
  const skipEnd = totLen - SKIP_END_T;
  if (skipEnd <= SKIP_END_T) return; // too short to fit chevrons safely.

  // Save ctx state — caller doesn't have to bracket.
  const prevW = ctx.lineWidth;
  const prevCap = ctx.lineCap;
  const prevSS = ctx.strokeStyle;
  const prevDash = ctx.getLineDash ? ctx.getLineDash() : null;
  ctx.lineWidth = Math.max(1.5, zoom * 0.18);
  ctx.lineCap = 'round';
  ctx.strokeStyle = bright ? 'rgba(255,234,90,0.95)' : 'rgba(240,240,240,0.85)';
  if (ctx.setLineDash) ctx.setLineDash([]);

  // Walk SPACING_T-spaced anchors along the polyline, skipping the
  // first SKIP_END_T tiles so the leading chevron doesn't crowd the
  // start vertex and the last SKIP_END_T tiles so the trailing
  // chevron doesn't overlap the bonded-end taper geometry.
  let traveled = 0;
  let nextAt = SKIP_END_T;
  for (let i = 0; i < tilePts.length - 1 && nextAt < skipEnd; i++) {
    const ax = tilePts[i][0], ay = tilePts[i][1];
    const bx = tilePts[i + 1][0], by = tilePts[i + 1][1];
    const dx = bx - ax, dy = by - ay;
    const segLen = Math.hypot(dx, dy);
    if (segLen < 0.01) continue;
    const tx = dx / segLen, ty = dy / segLen; // tangent (forward)
    const nx = -ty, ny = tx;                   // perpendicular (right)
    const segEnd = traveled + segLen;
    while (nextAt < segEnd && nextAt < skipEnd) {
      const f = (nextAt - traveled) / segLen;
      // Chevron center in TILE coords.
      const ctxT = ax + dx * f;
      const ctyT = ay + dy * f;
      // Three chevron vertices in TILE coords: tip is +DEPTH/2 along
      // tangent; left/right base are -DEPTH/2 along tangent and
      // ±HALFW along perpendicular.
      const tipTx = ctxT + tx * DEPTH_T * 0.5;
      const tipTy = ctyT + ty * DEPTH_T * 0.5;
      const tlTx = ctxT - tx * DEPTH_T * 0.5 + nx * HALFW_T;
      const tlTy = ctyT - ty * DEPTH_T * 0.5 + ny * HALFW_T;
      const trTx = ctxT - tx * DEPTH_T * 0.5 - nx * HALFW_T;
      const trTy = ctyT - ty * DEPTH_T * 0.5 - ny * HALFW_T;
      const tip = _weTileToScreen(tipTx, tipTy, state, canvasSize);
      const tl = _weTileToScreen(tlTx, tlTy, state, canvasSize);
      const tr = _weTileToScreen(trTx, trTy, state, canvasSize);
      ctx.beginPath();
      ctx.moveTo(tl[0], tl[1]);
      ctx.lineTo(tip[0], tip[1]);
      ctx.lineTo(tr[0], tr[1]);
      ctx.stroke();
      nextAt += SPACING_T;
    }
    traveled = segEnd;
  }

  // Restore ctx state.
  ctx.lineWidth = prevW;
  ctx.lineCap = prevCap;
  ctx.strokeStyle = prevSS;
  if (ctx.setLineDash && prevDash) ctx.setLineDash(prevDash);
}

/** Stroke an offset polyline (tile coords) onto the canvas, with the
 *  given perpendicular offset (tile units) and lineWidth (screen px).
 *  Used for road edge stripes + lane dividers in the editor's game-
 *  render branch.
 *
 *  Algorithm — one pass, central-difference per-vertex tangent.
 *  H636 switched from the monolith's two-pass average-of-normalized-
 *  segment-perpendiculars (L10596-10643) to chord-difference between
 *  the prior and next vertex — the same pattern the game's
 *  src/render/worldMap.ts:tracePathOffset uses for its stripe stack.
 *  Reason: on baseline roads with very uneven vertex spacing (I-485
 *  has runs of 1-2 tile sub-segments interleaved with 10-20 tile
 *  hops) the average-of-normalized perpendiculars produced visibly
 *  jagged offset stripes — each short segment's normalized perp got
 *  full weight regardless of its physical length, so short noise
 *  segments wobbled the offset path. Central-difference reads the
 *  chord across the vertex (one normalization step), so short noise
 *  segments contribute proportionally to their actual length and the
 *  resulting tangent tracks the underlying smooth direction.
 *
 *  Endpoints fall back to the adjacent segment's tangent (clamping pi
 *  / ni to the polyline bounds matches tracePathOffset L1252-1253).
 *
 *  Save+restore ctx.lineWidth / strokeStyle / dash so callers don't
 *  have to bracket the call themselves. */
export function _weStrokeOffsetTilePath(
  ctx: CanvasRenderingContext2D,
  tilePts: TilePoint[],
  offsetTiles: number,
  lineWidth: number,
  color: string,
  dashArr: number[] | null,
  state: WorldEditorState,
  canvasSize: { w: number; h: number },
): void {
  if (!tilePts || tilePts.length < 2) return;
  const N = tilePts.length;

  // Save state so callers don't have to bracket the call.
  const prevW = ctx.lineWidth;
  const prevSS = ctx.strokeStyle;
  const prevDash = ctx.getLineDash ? ctx.getLineDash() : null;
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = color;
  if (ctx.setLineDash) ctx.setLineDash(dashArr || []);

  ctx.beginPath();
  for (let s = 0; s < N; s++) {
    const pi = s === 0 ? 0 : s - 1;
    const ni = s === N - 1 ? N - 1 : s + 1;
    const tdx = tilePts[ni][0] - tilePts[pi][0];
    const tdy = tilePts[ni][1] - tilePts[pi][1];
    const tlen = Math.hypot(tdx, tdy) || 1;
    const nx = -tdy / tlen;
    const ny =  tdx / tlen;
    const ox = tilePts[s][0] + nx * offsetTiles;
    const oy = tilePts[s][1] + ny * offsetTiles;
    const p = _weTileToScreen(ox, oy, state, canvasSize);
    if (s === 0) ctx.moveTo(p[0], p[1]);
    else ctx.lineTo(p[0], p[1]);
  }
  ctx.stroke();

  // Restore.
  ctx.lineWidth = prevW;
  ctx.strokeStyle = prevSS;
  if (ctx.setLineDash && prevDash) ctx.setLineDash(prevDash);
}

/** Build a smoothed (quadratic-Bezier) screen-space `Path2D` from a
 *  tile polyline. Used when WORLD_EDITOR.gameRender is on so the
 *  editor preview matches the game-side renderer's lane-curve
 *  smoothing pattern (see preprocessRoadsForRender in worldMap.ts).
 *
 *  Three-region pattern:
 *    • Segment 0       — lineTo midpoint(0..1). Straight leg from
 *                        vertex 0 to the midpoint between v0 and v1.
 *    • Segments 1..N-2 — quadraticCurveTo through pts[i] to
 *                        midpoint(i..i+1). The interior vertex
 *                        serves as the Bezier control point; the
 *                        previous segment's endpoint (a midpoint)
 *                        and this segment's endpoint (the next
 *                        midpoint) are the start and end. Midpoint-
 *                        anchored Beziers give C1 continuity through
 *                        every interior vertex without needing
 *                        Catmull-Rom math.
 *    • Last segment     — quadraticCurveTo through pts[N-2] to
 *                        pts[N-1]. End-vertex is the real endpoint
 *                        (NOT a midpoint) so the polyline terminates
 *                        exactly where the user placed it.
 *
 *  Early-exits:
 *    • Empty / 1-point polyline → returns an empty Path2D.
 *    • 2-point polyline → straight lineTo from v0 to v1 (no
 *                          midpoint smoothing on a single segment).
 *
 *  Returns Path2D — directly strokable by the caller (matches
 *  monolith). Caller chooses stroke style / width / dash.
 *
 *  Ported 1:1 from monolith L10697-10723. */
export function _weBuildSmoothedScreenPath(
  tilePts: TilePoint[],
  state: WorldEditorState,
  canvasSize: { w: number; h: number },
): Path2D {
  const path = new Path2D();
  if (!tilePts || tilePts.length < 2) return path;
  const sp = (i: number): ScreenPoint =>
    _weTileToScreen(tilePts[i][0], tilePts[i][1], state, canvasSize);

  const N = tilePts.length;
  const p0 = sp(0);
  path.moveTo(p0[0], p0[1]);

  // Single-segment polyline — just a straight line, no midpoint
  // smoothing needed.
  if (N === 2) {
    const p1 = sp(1);
    path.lineTo(p1[0], p1[1]);
    return path;
  }

  for (let i = 0; i < N - 1; i++) {
    if (i === 0) {
      // Leg 0: straight line from v0 to midpoint(0..1).
      const a = sp(0);
      const b = sp(1);
      path.lineTo((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    } else if (i === N - 2) {
      // Last leg: quad through interior vertex to the real endpoint.
      const a = sp(i);
      const b = sp(i + 1);
      path.quadraticCurveTo(a[0], a[1], b[0], b[1]);
    } else {
      // Interior leg: quad through pts[i] to midpoint(i..i+1).
      const a = sp(i);
      const b = sp(i + 1);
      path.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    }
  }

  return path;
}

/** Effective material+age resolver for a road's segment. Plugged in
 *  by the host because the source-of-truth lookup lives in
 *  editor/delete.ts; this module stays decoupled from delete's deps
 *  shape (DeleteDeps) by accepting the resolved tuple as a callback. */
export type EffectiveMaterialAgeResolver = (
  road: Record<string, unknown>,
  segIdx: number,
) => EffectiveMaterialAge;

/** Inputs for game-render branch road draw. */
export interface DrawRoadFullOpts {
  ctx: CanvasRenderingContext2D;
  road: {
    pts: number[][];
    w: number;
    maj: number;
    name: string;
    z: number;
    [k: string]: unknown;
  };
  isOverlay: boolean;
  isSelected: boolean;
  /** v8.99.126.50 per-section override resolver. Optional — when
   *  absent, the asphalt pass takes the fast path (single stroke of
   *  the pre-smoothed Path2D with the road-level color). */
  effectiveMaterialAge?: EffectiveMaterialAgeResolver;
}

/** Pass 2 — asphalt fill with per-section material/age override
 *  support. Fast path (single stroke of the pre-smoothed Path2D)
 *  fires when no overrides are present; slow path walks segments and
 *  strokes each with its resolved material+age color. Slow-path
 *  lineCap flips to 'round' so adjacent same-material sections join
 *  smoothly without sub-pixel gaps at the seam.
 *
 *  Per monolith L11581-L11607. */
function _drawRoadAsphaltPass(
  ctx: CanvasRenderingContext2D,
  road: DrawRoadFullOpts['road'],
  smoothPath: Path2D,
  lwAsphalt: number,
  effectiveMaterialAge: EffectiveMaterialAgeResolver | undefined,
  state: WorldEditorState,
  canvasSize: { w: number; h: number },
): void {
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';
  ctx.lineWidth = lwAsphalt;
  const overrides = road.materialOverrides as unknown[] | undefined;
  if (Array.isArray(overrides) && overrides.length > 0 && effectiveMaterialAge) {
    ctx.lineCap = 'round';
    const N = road.pts.length;
    for (let s = 0; s < N - 1; s++) {
      const eff = effectiveMaterialAge(road as Record<string, unknown>, s);
      let baseColor: string;
      if (eff.material === 'concrete') {
        baseColor = eff.age === 'new' ? '#c0b8a8' : '#988772';
      } else {
        baseColor = eff.age === 'new' ? '#1e1e22' : '#43403e';
      }
      ctx.strokeStyle = baseColor;
      const a = _weTileToScreen(road.pts[s][0], road.pts[s][1], state, canvasSize);
      const b = _weTileToScreen(road.pts[s + 1][0], road.pts[s + 1][1], state, canvasSize);
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
  } else {
    ctx.strokeStyle = _getAsphaltBaseColor(road as Record<string, unknown>);
    ctx.stroke(smoothPath);
  }
}

/** Walk a road's polyline outward from a T-junction point (segIdx,
 *  tParam) until ±`radius` arc-distance is covered. Returns sample
 *  points in tile coords ordered backward-walk-reversed → junction →
 *  forward-walk. Mirrors `_samplesInZone` from `_weDetectTeeJunctions`
 *  (monolith L19651-L19712); kept inline / private here to avoid
 *  hoisting concerns and keep the editor render path self-contained.
 *  Per monolith L11803-L11849. */
function _samplesInZoneEditor(
  pts: number[][],
  segIdx: number,
  tParam: number,
  radius: number,
): Array<[number, number]> {
  const N = pts.length;
  const jx = pts[segIdx][0] + tParam * (pts[segIdx + 1][0] - pts[segIdx][0]);
  const jy = pts[segIdx][1] + tParam * (pts[segIdx + 1][1] - pts[segIdx][1]);
  const out: Array<[number, number]> = [];

  // Backward walk.
  const backList: Array<[number, number]> = [];
  let walkSeg = segIdx;
  let walkPos: [number, number] = [jx, jy];
  let distB = 0;
  while (walkSeg >= 0) {
    const aBack = pts[walkSeg];
    const ddx = walkPos[0] - aBack[0];
    const ddy = walkPos[1] - aBack[1];
    const segPart = Math.hypot(ddx, ddy);
    if (distB + segPart >= radius) {
      const rem = radius - distB;
      const ratio = rem / segPart;
      backList.push([walkPos[0] - ratio * ddx, walkPos[1] - ratio * ddy]);
      break;
    }
    backList.push([aBack[0], aBack[1]]);
    distB += segPart;
    walkSeg--;
    if (walkSeg < 0) break;
    walkPos = [aBack[0], aBack[1]];
  }
  for (let k = backList.length - 1; k >= 0; k--) out.push(backList[k]);
  out.push([jx, jy]);

  // Forward walk.
  let distF = 0;
  walkSeg = segIdx;
  walkPos = [jx, jy];
  while (walkSeg < N - 1) {
    const aFwd = pts[walkSeg + 1];
    const ddx = aFwd[0] - walkPos[0];
    const ddy = aFwd[1] - walkPos[1];
    const segPart = Math.hypot(ddx, ddy);
    if (distF + segPart >= radius) {
      const rem = radius - distF;
      const ratio = rem / segPart;
      out.push([walkPos[0] + ratio * ddx, walkPos[1] + ratio * ddy]);
      break;
    }
    out.push([aFwd[0], aFwd[1]]);
    distF += segPart;
    walkSeg++;
    if (walkSeg >= N - 1) break;
    walkPos = [aFwd[0], aFwd[1]];
  }
  return out;
}

/** Tee junction record shape — what road._teeJunctions carries.
 *  Mirrors the record pushed by `_weDetectTeeJunctions` at monolith
 *  L19636-L19642. */
interface TeeJunctionRecord {
  segIdx: number;
  t: number;
  radius: number;
}

/** Pass 5b — T-junction dashed edge stripes (v8.99.126.62). For each
 *  T-junction record on this road, walks its samples and ERASES the
 *  solid edge stripe just laid down by Pass 5 inside the zone (no
 *  dashed re-stroke, per v126.63 — DOT MUTCD spec is a GAP, not a
 *  dashed marking). Per monolith L11796-L11892. */
function _drawTeeJunctionEdgePass(
  ctx: CanvasRenderingContext2D,
  road: DrawRoadFullOpts['road'],
  pts: number[][],
  edgeOffsets: number[],
  z: number,
  state: WorldEditorState,
  canvasSize: { w: number; h: number },
): void {
  const tjs = road._teeJunctions as TeeJunctionRecord[] | undefined;
  if (!tjs || tjs.length === 0) return;
  const eraseWidth = Math.max(2, z * 0.16);
  for (const tj of tjs) {
    const samples = _samplesInZoneEditor(pts, tj.segIdx, tj.t, tj.radius);
    if (!samples || samples.length < 2) continue;
    for (const eo of edgeOffsets) {
      const M = samples.length;
      const pp = new Path2D();
      for (let i = 0; i < M; i++) {
        let tx: number;
        let ty: number;
        if (i < M - 1) {
          tx = samples[i + 1][0] - samples[i][0];
          ty = samples[i + 1][1] - samples[i][1];
        } else {
          tx = samples[i][0] - samples[i - 1][0];
          ty = samples[i][1] - samples[i - 1][1];
        }
        const tLen = Math.hypot(tx, ty);
        if (tLen < 1e-6) continue;
        tx /= tLen;
        ty /= tLen;
        const perpX = -ty * eo;
        const perpY = tx * eo;
        const sp = _weTileToScreen(
          samples[i][0] + perpX,
          samples[i][1] + perpY,
          state,
          canvasSize,
        );
        if (i === 0) pp.moveTo(sp[0], sp[1]);
        else pp.lineTo(sp[0], sp[1]);
      }
      const prev = ctx.getLineDash ? ctx.getLineDash() : null;
      if (ctx.setLineDash) ctx.setLineDash([]);
      ctx.lineWidth = eraseWidth;
      ctx.lineCap = 'butt';
      ctx.strokeStyle = _getAsphaltBaseColor(road as Record<string, unknown>);
      ctx.stroke(pp);
      if (ctx.setLineDash) ctx.setLineDash(prev || []);
    }
  }
}

/** Pass 5c — lane-addition dashed stripe inside the auto-taper polygon
 *  (v8.99.126.63). For each taper-end's plus/minus sample arrays
 *  (stored on road by `_weDetectAutoTapers`), ERASES the solid edge
 *  stripe at the narrow road's OLD edge offset (Pass 5 already drew
 *  it there) and re-strokes DASHED — the DOT MUTCD entrance-taper
 *  "lane addition" marking that vehicles cross to enter the new lane.
 *
 *  v126.65 unified the dash length with Pass 4's lane dividers
 *  (`z * 0.6`) so the dashed pattern reads as a single coherent
 *  marking system across the taper.
 *
 *  Per monolith L11913-L11952. */
function _drawTaperLaneAddPass(
  ctx: CanvasRenderingContext2D,
  road: DrawRoadFullOpts['road'],
  z: number,
  state: WorldEditorState,
  canvasSize: { w: number; h: number },
): void {
  const start = road._autoTaperStart as unknown;
  const end = road._autoTaperEnd as unknown;
  if (!start && !end) return;
  const dashLen = Math.max(2, z * 0.6);
  const eraseWidth = Math.max(2, z * 0.16);
  const dashWidth = Math.max(1, z * 0.08);
  const drawLaSamples = (samples: number[][] | undefined): void => {
    if (!samples || samples.length < 2) return;
    const L = samples.length;
    const sp = new Path2D();
    for (let k = 0; k < L; k++) {
      const s = _weTileToScreen(samples[k][0], samples[k][1], state, canvasSize);
      if (k === 0) sp.moveTo(s[0], s[1]);
      else sp.lineTo(s[0], s[1]);
    }
    const prev = ctx.getLineDash ? ctx.getLineDash() : null;
    if (ctx.setLineDash) ctx.setLineDash([]);
    ctx.lineWidth = eraseWidth;
    ctx.lineCap = 'butt';
    ctx.strokeStyle = _getAsphaltBaseColor(road as Record<string, unknown>);
    ctx.stroke(sp);
    ctx.lineWidth = dashWidth;
    ctx.strokeStyle = 'rgba(240,240,240,0.78)';
    if (ctx.setLineDash) ctx.setLineDash([dashLen, dashLen]);
    ctx.stroke(sp);
    if (ctx.setLineDash) ctx.setLineDash(prev || []);
  };
  if (start) {
    drawLaSamples(road._autoTaperStartLaneAddSamplesPlus as number[][] | undefined);
    drawLaSamples(road._autoTaperStartLaneAddSamplesMinus as number[][] | undefined);
  }
  if (end) {
    drawLaSamples(road._autoTaperEndLaneAddSamplesPlus as number[][] | undefined);
    drawLaSamples(road._autoTaperEndLaneAddSamplesMinus as number[][] | undefined);
  }
}

/** Full-fidelity editor road draw — same 7-pass pipeline the game-side
 *  render uses, scaled to editor camera. Used when the editor's
 *  `gameRender` toggle is on (default).
 *
 *  EARLY-OUTS:
 *    - `pts.length < 2`        → nothing to draw.
 *    - `getRoadProfile` null   → nothing to draw (no lane geometry).
 *    - `road.merge`            → delegate to `_weDrawTaperedMergeRoad`
 *      (the polygon-based renderer for merge / aux-lane roads, which
 *      can actually narrow pavement at a merge endpoint where a
 *      stroke's constant width can't — see v8.99.126.04 design note
 *      at monolith L11539-L11549).
 *
 *  THEN the 7 PASSES:
 *
 *    1. BRIDGE CONCRETE DECK — slightly wider stroke (asphaltW + 0.6
 *       tiles) at color #4a4640, only when `road.z >= 2`.
 *
 *    2. ASPHALT FILL — color from `_getAsphaltBaseColor(road)` (6-color
 *       material × age palette, v8.99.126.49). Per-section overrides
 *       (v8.99.126.50) walk segments individually via the host's
 *       `effectiveMaterialAge` resolver; roads without overrides take
 *       the fast path (single stroke of the pre-smoothed Path2D).
 *
 *    2b. AUTO-TAPER POLYGONS (v8.99.126.61) — when this road joins a
 *        wider road at either endpoint, paint the flared polygon that
 *        carries asphalt + edge stripes from the road's natural halfW
 *        to the wider peer's halfW. Delegates to
 *        `_weDrawAutoTaperEditor` (H335) per end.
 *
 *    3. YELLOW CENTERLINE — non-divided roads only. v8.99.126.60 gate
 *       switched from numeric `medHalf < 0.05` to the same
 *       `hasRealMedian = (road.name === 'I-485') || (road.w >= 12)`
 *       predicate the in-game `drawRoadOverlay` uses, so editor and
 *       gameplay paint identical centerline coverage for every width.
 *       Also gated on z > 0.4 and totalW >= 1.5.
 *
 *    4. LANE DIVIDERS — dashed white at `prof.dividers` offsets.
 *       Skipped below z = 0.6 to avoid sub-pixel dash smear.
 *
 *    5. WHITE OUTER-EDGE FOG LINES — solid stroke at `prof.edgeOffsets`.
 *       `lineCap = 'square'` (v8.99.126.66) so the stripe extends half
 *       its width past each endpoint, guaranteeing overlap with the
 *       auto-taper's outer/inner stripe at width-mismatched joins
 *       (FP rounding through tile→screen otherwise leaves a 1-3 px
 *       visible gap).
 *
 *    5b. T-JUNCTION DASHED EDGE STRIPES (v8.99.126.62) — for each
 *        T-junction record on this road, ERASE the solid edge stripe
 *        just laid down by Pass 5 inside the zone (no dashed
 *        re-stroke, per v126.63 — DOT MUTCD spec is a GAP, not a
 *        dashed marking).
 *
 *    5c. TAPER LANE-ADDITION DASHED STRIPE (v8.99.126.63) — inside the
 *        auto-taper polygon, at the narrow road's OLD edge offset,
 *        erase the solid stripe and re-stroke dashed. v126.65 unified
 *        dash length with Pass 4 lane dividers.
 *
 *    6. YELLOW INNER-EDGE STRIPES — divided highways only
 *       (`prof.innerEdgeOffsets`).
 *
 *    7. SELECTION HALO — bright yellow outline at `lwAsphalt + 4`,
 *       drawn last so it sits on top of everything.
 *
 *  Ported 1:1 from monolith L11533-L11971.
 */
/** H964: trim `t0`/`t1` tiles of arc length off a tile-space polyline
 *  (interpolated cut points). Null when nothing survives. Editor mirror
 *  of worldMap's _trimmedDeckBand — the bridge parapet band stops short
 *  of CONNECTED deck ends so no concrete cuts across the joined road. */
function _weTrimPolyTiles(
  pts: ReadonlyArray<readonly [number, number]>,
  t0: number,
  t1: number,
): Array<[number, number]> | null {
  const n = pts.length;
  if (n < 2) return null;
  const seg: number[] = new Array(n - 1);
  let total = 0;
  for (let i = 0; i + 1 < n; i++) {
    seg[i] = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    total += seg[i];
  }
  if (total - t0 - t1 < 1.0) return null;
  const at = (a: number): [number, number] => {
    let acc = 0;
    for (let i = 0; i + 1 < n; i++) {
      if (acc + seg[i] >= a) {
        const t = seg[i] > 0 ? (a - acc) / seg[i] : 0;
        return [
          pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t,
          pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t,
        ];
      }
      acc += seg[i];
    }
    return [pts[n - 1][0], pts[n - 1][1]];
  };
  const a1 = total - t1;
  const out: Array<[number, number]> = [at(t0)];
  let acc = 0;
  for (let i = 0; i + 1 < n; i++) {
    acc += seg[i];
    if (acc > t0 && acc < a1) out.push([pts[i + 1][0], pts[i + 1][1]]);
  }
  out.push(at(a1));
  return out;
}

export function _weDrawRoadFull(
  opts: DrawRoadFullOpts,
  state: WorldEditorState,
  canvasSize: { w: number; h: number },
  deps: RenderDeps,
): void {
  const { ctx, road, isSelected } = opts;
  const pts = road.pts;
  if (!pts || pts.length < 2) return;
  const z = state.view.zoom;
  const prof = (road._prof as ReturnType<RenderDeps['getRoadProfile']>) ?? deps.getRoadProfile(road);
  if (!prof) return;

  // Merge roads use the tapered-polygon renderer instead of the
  // constant-width stroke pipeline. v8.99.126.04 design note: polygon-
  // based rendering is the ONLY way to make pavement actually narrow
  // at a merge endpoint — a stroke of any kind has constant width at
  // every point along its length.
  if (road.merge) {
    _weDrawTaperedMergeRoad(
      {
        ctx,
        road: road as DrawTaperedMergeRoadOpts['road'],
        prof: prof as DrawTaperedMergeRoadOpts['prof'],
        isSelected,
      },
      state,
      canvasSize,
      deps,
    );
    return;
  }

  const isBridge = (road.z || 0) >= 2;
  // H642: stroke at the FULL visual width including shoulders. The
  // tile-stamping brush in src/world/buildBaselineMap.ts paints
  // tile=1 squares with brushR = floor(w/2) — so I-485 (w=10) gets
  // an 11-tile-wide tile=1 footprint, but totalW = 9.56 tiles. The
  // asphalt stroke at totalW left ~0.7 tiles of tile=1 staircase
  // visible on each edge (the tile pass at v=1 paints '#2e2e34'
  // squares slightly past the stroke). Falls back to totalW for
  // back-compat with hosts that don't return asphaltW yet.
  const asphaltW = prof.asphaltW ?? prof.totalW;
  const lwAsphalt = Math.max(2, asphaltW * z);

  // H631: Catmull-Rom oversample the polyline once at the top of the
  // pass. Matches src/render/worldMap.ts's `entry.smoothed =
  // smoothFlatPolyline(...)` so the editor sees the same dense
  // 8×-sample polyline the game renderer does. Lane dividers, edge
  // stripes, centerline, and wear/oil all stroke through smoothPts
  // below so their offsets follow smooth curves through every
  // intermediate sample instead of jagging at every source vertex.
  // The asphalt fill path uses the same smoothPts (a straight lineTo
  // through the dense polyline) — no more quad-Bezier midpoint hack.
  const smoothPts: TPt[] = pts.length >= 3
    ? (smoothPolyline(pts as unknown as readonly [number, number][]) as TPt[])
    : (pts as TPt[]);

  // H631: build the screen-space Path2D from smoothPts (Catmull-Rom
  // dense). Replaces the earlier `_weBuildSmoothedScreenPath` quad-
  // Bezier midpoint pass — smoothPts is already smooth, so a straight
  // lineTo through every sample reads as a continuous curve. Asphalt
  // fill + bridge deck + all offset strokes now share the same
  // smoothing pipeline.
  const smoothPath = new Path2D();
  if (smoothPts.length >= 2) {
    const sp0 = _weTileToScreen(smoothPts[0][0], smoothPts[0][1], state, canvasSize);
    smoothPath.moveTo(sp0[0], sp0[1]);
    for (let si = 1; si < smoothPts.length; si++) {
      const sp = _weTileToScreen(smoothPts[si][0], smoothPts[si][1], state, canvasSize);
      smoothPath.lineTo(sp[0], sp[1]);
    }
  }

  // PASS 1 — bridge concrete deck (H782: parapets + shadow, parity with
  // game's drawRoadOverlay pass 9). Three sublayers in width order, so
  // the subsequent asphalt fill at asphaltW exposes a ~0.2-tile gray
  // parapet on EACH side that reads as a side barrier the player can't
  // drive off of.
  //   - Drop shadow (asphaltW + 0.8 tiles, rgba black 0.45). Sells the
  //     under-bridge depth from the road below.
  //   - Concrete parapet (asphaltW + 0.4 tiles, #888884). 0.2 tile per
  //     side becomes the visible side wall after asphalt covers center.
  // Asphalt fill follows in PASS 2 — its width = asphaltW, so the
  // parapet's 0.2 tile per side stays exposed as the wall.
  // H964: connected-end detection for the abutment treatment — mirror of
  // worldMap's _deckEndConnected (2-tile segment-projection scan). Only
  // computed for bridges; the scan is cheap and the editor repaints on
  // needsRedraw, not per frame.
  let _deckConnS = false;
  let _deckConnE = false;
  if (isBridge) {
    const _all = deps.getMajorRoads();
    const _endConn = (ex: number, ey: number): boolean => {
      for (const r of _all) {
        const rp = r.pts as ReadonlyArray<readonly number[]> | undefined;
        if (!rp || rp.length < 2 || rp === (pts as unknown)) continue;
        for (let i = 0; i < rp.length - 1; i++) {
          const ax = rp[i][0];
          const ay = rp[i][1];
          const dx = rp[i + 1][0] - ax;
          const dy = rp[i + 1][1] - ay;
          const L2 = dx * dx + dy * dy;
          if (L2 < 1e-9) continue;
          let t = ((ex - ax) * dx + (ey - ay) * dy) / L2;
          if (t < 0) t = 0;
          else if (t > 1) t = 1;
          const qx = ax + dx * t - ex;
          const qy = ay + dy * t - ey;
          if (qx * qx + qy * qy <= 4.0) return true;
        }
      }
      return false;
    };
    _deckConnS = _endConn(pts[0][0], pts[0][1]);
    _deckConnE = _endConn(pts[pts.length - 1][0], pts[pts.length - 1][1]);
  }

  if (isBridge) {
    const prevCap = ctx.lineCap;
    const prevJoin = ctx.lineJoin;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';
    // H964: shadow + parapet stop 3 tiles short of CONNECTED ends so
    // the concrete band no longer cuts across the joined road (the
    // abutment look). Free ends keep the full band unchanged.
    let bandPath = smoothPath;
    if (_deckConnS || _deckConnE) {
      const trimmed = _weTrimPolyTiles(
        smoothPts as ReadonlyArray<readonly [number, number]>,
        _deckConnS ? 3 : 0,
        _deckConnE ? 3 : 0,
      );
      if (trimmed) {
        bandPath = new Path2D();
        const b0 = _weTileToScreen(trimmed[0][0], trimmed[0][1], state, canvasSize);
        bandPath.moveTo(b0[0], b0[1]);
        for (let bi = 1; bi < trimmed.length; bi++) {
          const bp = _weTileToScreen(trimmed[bi][0], trimmed[bi][1], state, canvasSize);
          bandPath.lineTo(bp[0], bp[1]);
        }
      } else {
        bandPath = null as unknown as Path2D; // deck shorter than the abutments
      }
    }
    if (bandPath) {
      ctx.lineWidth = Math.max(4, (asphaltW + 0.8) * z);
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.stroke(bandPath);
      ctx.lineWidth = Math.max(3, (asphaltW + 0.4) * z);
      ctx.strokeStyle = '#888884';
      ctx.stroke(bandPath);
    }
    ctx.lineCap = prevCap;
    ctx.lineJoin = prevJoin;
  }

  // PASS 2 — asphalt fill (+ per-section override walk).
  _drawRoadAsphaltPass(
    ctx,
    road,
    smoothPath,
    lwAsphalt,
    opts.effectiveMaterialAge,
    state,
    canvasSize,
  );

  // PASS 2a1 (H995) — grass median for the "divided · grass" preset (w===10),
  // so the editor preview distinguishes it from the asphalt-median preset
  // (w===11) the user just as easily could have picked. Parity with the
  // game's GRASS_MEDIAN_COLOR strip. effectiveMedHalf ≈ medHalf − inner
  // shoulder, derived from the profile's inner-edge stripe offset.
  if (road.w === 10) {
    const _ieo = (prof as { innerEdgeOffsets?: number[]; laneW?: number }).innerEdgeOffsets;
    if (_ieo && _ieo.length > 0) {
      const medHalf = Math.abs(_ieo[0]);
      const shoulderW = 0.5 * ((prof as { laneW?: number }).laneW ?? 1.275);
      const effMed = Math.max(0, medHalf - shoulderW);
      if (effMed > 0.02) {
        const prevCap = ctx.lineCap;
        const prevJoin = ctx.lineJoin;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = '#1a3a1a';
        ctx.lineWidth = Math.max(1, effMed * 2 * z);
        ctx.stroke(smoothPath);
        ctx.lineCap = prevCap;
        ctx.lineJoin = prevJoin;
      }
    }
  }

  // H964: 1-tile asphalt extension past CONNECTED bridge ends — mirrors
  // the game deck bake's end-cap so an angled butt joint can't open a
  // wedge gap; the overhang lands on the neighbour's own asphalt.
  if (isBridge && (_deckConnS || _deckConnE)) {
    const prevCap2 = ctx.lineCap;
    ctx.lineCap = 'butt';
    ctx.strokeStyle = _getAsphaltBaseColor(road as Record<string, unknown>);
    ctx.lineWidth = lwAsphalt;
    for (const atStart of [true, false]) {
      if (atStart ? !_deckConnS : !_deckConnE) continue;
      const n = smoothPts.length;
      const e = atStart ? smoothPts[0] : smoothPts[n - 1];
      const inn = atStart ? smoothPts[1] : smoothPts[n - 2];
      const L = Math.hypot(e[0] - inn[0], e[1] - inn[1]) || 1;
      const cx2 = e[0] + (e[0] - inn[0]) / L;
      const cy2 = e[1] + (e[1] - inn[1]) / L;
      const s0 = _weTileToScreen(e[0], e[1], state, canvasSize);
      const s1 = _weTileToScreen(cx2, cy2, state, canvasSize);
      ctx.beginPath();
      ctx.moveTo(s0[0], s0[1]);
      ctx.lineTo(s1[0], s1[1]);
      ctx.stroke();
    }
    ctx.lineCap = prevCap2;
  }

  // PASS 2b — auto-taper polygons (H335).
  const taperStart = road._autoTaperStart as AutoTaperEditorMeta | undefined;
  const taperEnd = road._autoTaperEnd as AutoTaperEditorMeta | undefined;
  if (taperStart) {
    _weDrawAutoTaperEditor(
      { ctx, road: road as Record<string, unknown>, prof, meta: taperStart },
      state,
      canvasSize,
    );
  }
  if (taperEnd) {
    _weDrawAutoTaperEditor(
      { ctx, road: road as Record<string, unknown>, prof, meta: taperEnd },
      state,
      canvasSize,
    );
  }

  // PASS 2c — tire wear + oil drip stripes. 1:1 with monolith
  // L30814-L31057 (worldMap.ts:1295-1397 for the H561 game port).
  // Six sub-strokes per offset set: solid baseline + two relatively-
  // prime dashed-emphasis layers, for each of wear and oil.
  //
  // Gated on isMajor + lps >= 2 + z >= 5.0.
  //  - z >= 0.4 (game-render gate) would fire at the editor's default
  //    zoom and crater FPS — the editor sees every major highway at
  //    low zoom, unlike the game's viewport-culled list.
  //  - z >= 2.0 (H611) avoided the FPS cliff but the dash arrays are
  //    in world-px units (tuned for the in-game camera zoom ~12); at
  //    editor mid-zoom (z = 2-4) they compress to 3-10 screen-px
  //    dashes layered six deep, reading visually as a noisy swirling
  //    pattern across every highway rather than as wear/oil texture.
  //  - z >= 5.0 (H636) holds wear/oil for near-game zoom where the
  //    dashes resolve at game-natural sizes. At editor mid-zoom the
  //    road reads as clean asphalt + dividers + edge stripes, which
  //    matches the user's expectation of an "authoring view".
  const wearOffsets = prof.wearOffsets;
  const oilOffsets = prof.oilOffsets;
  const isMajor = road.maj === 1;
  if (
    isMajor &&
    z >= 5.0 &&
    wearOffsets &&
    wearOffsets.length > 0 &&
    oilOffsets &&
    oilOffsets.length > 0
  ) {
    // Editor uses tile→screen via zoom (1 tile = z screen px), so
    // scale the monolith's world-px dash arrays by (z / TILE_PX).
    // TILE_PX matches gameLoop's TILE (= 18) — the editor's tiles-to-
    // world conversion the game render uses.
    const TILE_PX = 18;
    const dashScale = z / TILE_PX;
    const baseWearW = Math.max(0.8, prof.laneW * z * 0.18);
    const baseOilW = Math.max(0.3, prof.laneW * z * 0.025);
    const prevDashOff = ctx.lineDashOffset;
    const prevCap = ctx.lineCap;
    ctx.lineCap = 'butt';

    // WEAR pass 1 — solid baseline.
    ctx.lineDashOffset = 0;
    for (const off of wearOffsets) {
      _weStrokeOffsetTilePath(
        ctx, smoothPts as TilePoint[], off,
        baseWearW * 0.65, 'rgba(0,0,0,0.07)', null,
        state, canvasSize,
      );
    }
    // WEAR pass 2 — primary dashed (sum 460, prime phase 37).
    const wear2 = [70, 35, 45, 60, 90, 30, 50, 80].map((d) => d * dashScale);
    for (let pi = 0; pi < wearOffsets.length; pi++) {
      ctx.lineDashOffset = pi * 37 * dashScale;
      _weStrokeOffsetTilePath(
        ctx, smoothPts as TilePoint[], wearOffsets[pi],
        baseWearW * 1.15, 'rgba(0,0,0,0.13)', wear2,
        state, canvasSize,
      );
    }
    // WEAR pass 3 — secondary dashed (sum 397, prime phase 31, bias 100).
    const wear3 = [55, 25, 70, 40, 65, 35, 50, 57].map((d) => d * dashScale);
    for (let pi = 0; pi < wearOffsets.length; pi++) {
      ctx.lineDashOffset = (pi * 31 + 100) * dashScale;
      _weStrokeOffsetTilePath(
        ctx, smoothPts as TilePoint[], wearOffsets[pi],
        baseWearW * 0.85, 'rgba(0,0,0,0.10)', wear3,
        state, canvasSize,
      );
    }
    // OIL pass 1 — solid baseline.
    ctx.lineDashOffset = 0;
    for (const off of oilOffsets) {
      _weStrokeOffsetTilePath(
        ctx, smoothPts as TilePoint[], off,
        baseOilW * 0.55, 'rgba(8,5,2,0.20)', null,
        state, canvasSize,
      );
    }
    // OIL pass 2 — primary dashed (sum 450, prime phase 73, bias 200).
    const oil2 = [55, 70, 30, 90, 40, 50, 80, 35].map((d) => d * dashScale);
    for (let pi = 0; pi < oilOffsets.length; pi++) {
      ctx.lineDashOffset = (pi * 73 + 200) * dashScale;
      _weStrokeOffsetTilePath(
        ctx, smoothPts as TilePoint[], oilOffsets[pi],
        baseOilW * 1.10, 'rgba(8,5,2,0.42)', oil2,
        state, canvasSize,
      );
    }
    // OIL pass 3 — secondary dashed (sum 401, prime phase 67, bias 50).
    const oil3 = [45, 60, 35, 80, 25, 55, 70, 31].map((d) => d * dashScale);
    for (let pi = 0; pi < oilOffsets.length; pi++) {
      ctx.lineDashOffset = (pi * 67 + 50) * dashScale;
      _weStrokeOffsetTilePath(
        ctx, smoothPts as TilePoint[], oilOffsets[pi],
        baseOilW * 0.85, 'rgba(8,5,2,0.30)', oil3,
        state, canvasSize,
      );
    }

    ctx.lineDashOffset = prevDashOff;
    ctx.lineCap = prevCap;
  }

  // PASS 3 — yellow centerline (TWO-WAY non-divided roads only). H885: a
  // one-way road has no opposing traffic, so no center line. H974: gate
  // on the ONE-WAY signal (flag or w===2, the Lanes-1 one-way road) —
  // NOT lps===1, which wrongly stripped centers from two-way 2-lane
  // roads (one lane each direction = yellow line per DOT).
  const hasRealMedian = road.name === 'I-485' || road.w >= 12 || road.w === 10 || road.w === 11; // H995
  const oneWay = !!(road as { oneway?: boolean }).oneway || road.w === 2;
  const showCenter = !hasRealMedian && !oneWay && z > 0.4 && prof.totalW >= 1.5;
  if (showCenter) {
    _weStrokeOffsetTilePath(
      ctx,
      smoothPts as TilePoint[],
      0,
      Math.max(1, z * 0.12),
      '#f0c83a',
      null,
      state,
      canvasSize,
    );
  }

  // PASS 4 — dashed white lane dividers.
  const dividers = (prof as { dividers?: number[] }).dividers;
  if (z >= 0.6 && dividers && dividers.length > 0) {
    const dashLen = Math.max(2, z * 0.6);
    const gapLen = Math.max(2, z * 0.6);
    for (const off of dividers) {
      _weStrokeOffsetTilePath(
        ctx,
        smoothPts as TilePoint[],
        off,
        Math.max(1, z * 0.1),
        'rgba(240,240,240,0.62)',
        [dashLen, gapLen],
        state,
        canvasSize,
      );
    }
  }

  // PASS 5 — white outer-edge fog lines.
  const edgeOffsets = prof.edgeOffsets;
  if (z >= 0.4 && edgeOffsets && edgeOffsets.length > 0) {
    const prevCap = ctx.lineCap;
    ctx.lineCap = 'square';
    for (const off of edgeOffsets) {
      _weStrokeOffsetTilePath(
        ctx,
        smoothPts as TilePoint[],
        off,
        Math.max(1, z * 0.08),
        'rgba(240,240,240,0.78)',
        null,
        state,
        canvasSize,
      );
    }
    ctx.lineCap = prevCap;
  }

  // PASS 5b — T-junction dashed edge stripes.
  if (z >= 0.4 && edgeOffsets && edgeOffsets.length > 0) {
    _drawTeeJunctionEdgePass(ctx, road, pts, edgeOffsets, z, state, canvasSize);
  }

  // PASS 5c — taper lane-addition dashed stripe.
  if (z >= 0.4) {
    _drawTaperLaneAddPass(ctx, road, z, state, canvasSize);
  }

  // PASS 6 — yellow inner-edge stripes (divided highways).
  const innerEdgeOffsets = (prof as { innerEdgeOffsets?: number[] }).innerEdgeOffsets;
  if (z >= 0.4 && innerEdgeOffsets && innerEdgeOffsets.length > 0) {
    for (const off of innerEdgeOffsets) {
      _weStrokeOffsetTilePath(
        ctx,
        smoothPts as TilePoint[],
        off,
        Math.max(1, z * 0.1),
        'rgba(240,200,58,0.85)',
        null,
        state,
        canvasSize,
      );
    }
  }

  // PASS 7 — selection halo.
  if (isSelected) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = lwAsphalt + 4;
    ctx.strokeStyle = 'rgba(255,234,90,0.55)';
    ctx.stroke(smoothPath);
  }
}

/** Shared shape for the editor's auto-taper meta. Matches the in-game
 *  render-side AutoTaperMeta — both come from _weDetectAutoTapers and
 *  populate road._autoTaperStart / _autoTaperEnd. Outer/inner are the
 *  polygon's flared geometric edges; outerStripe/innerStripe shadow
 *  them inset by `1.7 / TILE` so the stripe joins the wider road's
 *  edge stripe seamlessly (v8.99.126.64). The stripe arrays are marked
 *  optional to preserve back-compat with pre-126.64 meta records. */
export interface AutoTaperEditorMeta {
  outer: ReadonlyArray<readonly [number, number]>;
  inner: ReadonlyArray<readonly [number, number]>;
  outerStripe?: ReadonlyArray<readonly [number, number]>;
  innerStripe?: ReadonlyArray<readonly [number, number]>;
}

/** Inputs for the editor's auto-taper polygon draw. The road, prof,
 *  and z fields are the three values the monolith's nested closure
 *  captured from its `_weDrawRoadFull` parent — surfaced as explicit
 *  parameters so this can be unit-tested and called from outside its
 *  parent once `_weDrawRoadFull` itself is ported. */
export interface DrawAutoTaperEditorOpts {
  ctx: CanvasRenderingContext2D;
  /** The road being drawn. Used only for asphalt-base-color decision
   *  (concrete vs asphalt × new vs old). The same row shape used by
   *  every editor render helper — only material / age / name fields
   *  are consulted here. */
  road: Record<string, unknown>;
  /** Road profile — only `totalW` is read (gates the edge-stripe pass
   *  on roads narrow enough that the normal pipeline wouldn't draw
   *  stripes either). */
  prof: { totalW: number };
  /** The taper polygon to draw (one of `road._autoTaperStart` /
   *  `_autoTaperEnd`). Polylines are in tile coords; this function
   *  projects to screen per-frame because camera/zoom changes every
   *  frame in the editor (the in-game render uses pre-built world-pixel
   *  Path2D from rebuildRenderEntries instead). */
  meta: AutoTaperEditorMeta;
}

/** Editor preview for auto-taper polygons — fill + outer/inner edge
 *  stripes for one taper end. Builds screen-space Path2D per frame
 *  from the tile-coord arrays.
 *
 *  Two passes:
 *    1. POLYGON FILL — outer forward, inner reversed, closed. Filled
 *       with the road's asphalt base color (matches `_getAsphaltBaseColor`
 *       monolith L2777-2782). The polygon's `outer[N-1]` / `inner[N-1]`
 *       points coincide with the road's normal edge offset at the
 *       widened-side connection so the fill blends seamlessly with the
 *       road's main pavement.
 *
 *    2. EDGE STRIPES — gated on `prof.totalW >= 1.5 && z >= 0.4`
 *       (same gate as the normal edge-stripe pass — narrow roads /
 *       low zoom skip stripes everywhere, not just here). Strokes
 *       `outerStripe` / `innerStripe` when present, falling back to
 *       outer/inner for legacy pre-v126.64 meta. Stroked SOLID:
 *       v8.99.126.63 reverted to solid because the flared edges of
 *       the taper polygon ARE the road's pavement boundary in the
 *       taper region — boundaries stay solid; the DOT-spec dashed
 *       "lane addition" stripe is drawn separately INSIDE the polygon
 *       at the narrow road's old edge position (PASS 5c in the parent,
 *       not this helper).
 *
 *       v8.99.126.66 set `lineCap = 'square'` (was `'butt'`). Even
 *       with v65's geometric fix aligning `sample[0]` with the peer
 *       road's edge perpendicular EXACTLY, FP rounding through the
 *       tile→screen projection plus 1-bit rasterization at the
 *       joining endpoint left a 1-3 px visible gap where the wide
 *       road's edge stripe ended and the taper's outer stripe began.
 *       'square' extends each cap by half lineWidth along the path
 *       direction, guaranteeing an overlap region regardless of
 *       subpixel or small angular differences. Bulge is negligible
 *       on a 3-4 px wide stripe but the joint reads clean.
 *
 *  Saves and restores `getLineDash()` around the explicit `setLineDash([])`
 *  so we don't poison the dashed state of subsequent draw passes.
 *
 *  Ported 1:1 from monolith _weDrawAutoTaperEditor (L11631-11706).
 *  Called twice per road from `_weDrawRoadFull` — once with
 *  `road._autoTaperStart`, once with `_autoTaperEnd` (L11707-11708). */
export function _weDrawAutoTaperEditor(
  opts: DrawAutoTaperEditorOpts,
  state: WorldEditorState,
  canvasSize: { w: number; h: number },
): void {
  const { ctx, road, prof, meta } = opts;
  const o = meta.outer;
  const n = meta.inner;
  const L = o.length;
  if (L < 2) return;
  const z = state.view.zoom;

  // PASS 1 — polygon fill. Outer forward → inner reversed → closePath.
  const poly = new Path2D();
  const p0 = _weTileToScreen(o[0][0], o[0][1], state, canvasSize);
  poly.moveTo(p0[0], p0[1]);
  for (let k = 1; k < L; k++) {
    const p = _weTileToScreen(o[k][0], o[k][1], state, canvasSize);
    poly.lineTo(p[0], p[1]);
  }
  for (let k = L - 1; k >= 0; k--) {
    const p = _weTileToScreen(n[k][0], n[k][1], state, canvasSize);
    poly.lineTo(p[0], p[1]);
  }
  poly.closePath();
  ctx.fillStyle = _getAsphaltBaseColor(road);
  ctx.fill(poly);

  // PASS 2 — outer / inner edge stripes (solid white fog lines).
  if (prof.totalW >= 1.5 && z >= 0.4) {
    const os = meta.outerStripe || meta.outer;
    const ns = meta.innerStripe || meta.inner;
    const outerP = new Path2D();
    let s0 = _weTileToScreen(os[0][0], os[0][1], state, canvasSize);
    outerP.moveTo(s0[0], s0[1]);
    for (let k = 1; k < L; k++) {
      const p = _weTileToScreen(os[k][0], os[k][1], state, canvasSize);
      outerP.lineTo(p[0], p[1]);
    }
    const innerP = new Path2D();
    s0 = _weTileToScreen(ns[0][0], ns[0][1], state, canvasSize);
    innerP.moveTo(s0[0], s0[1]);
    for (let k = 1; k < L; k++) {
      const p = _weTileToScreen(ns[k][0], ns[k][1], state, canvasSize);
      innerP.lineTo(p[0], p[1]);
    }
    ctx.lineWidth = Math.max(1, z * 0.08);
    ctx.lineCap = 'square';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(240,240,240,0.78)';
    const prevDash = ctx.getLineDash ? ctx.getLineDash() : null;
    if (ctx.setLineDash) ctx.setLineDash([]);
    ctx.stroke(outerP);
    ctx.stroke(innerP);
    if (ctx.setLineDash) ctx.setLineDash(prevDash || []);
  }
}

/** Inputs for tapered-merge road draw. */
export interface DrawTaperedMergeRoadOpts {
  ctx: CanvasRenderingContext2D;
  road: { pts: number[][]; w: number; [k: string]: unknown };
  prof: { lps: number; laneW: number; totalW: number; edgeOffsets?: number[] };
  isSelected: boolean;
}

/** Material × age → asphalt base color. Ported 1:1 from monolith
 *  _getAsphaltBaseColor (L2777-2782). Material 'concrete' covers
 *  Driveway-named rows; everything else is asphalt. Age falls back
 *  to 'old' when the road's `age` field is missing or set to 'auto'
 *  (the editor's hash-per-road branch lives in roadTextures.ts; for
 *  the editor preview we only need the four discrete swatches). */
function _getAsphaltBaseColor(road: Record<string, unknown>): string {
  const explicitMat = road.material;
  const material =
    explicitMat === 'concrete' || explicitMat === 'asphalt'
      ? explicitMat
      : road.name === 'Driveway'
        ? 'concrete'
        : 'asphalt';
  const isNew = road.age === 'new';
  if (material === 'concrete') return isNew ? '#c0b8a8' : '#988772';
  return isNew ? '#1e1e22' : '#43403e';
}

/** Nearest-OTHER-road search at an endpoint: is it within searchR tiles
 *  of any other road's segment? Returns the closest matching road, or
 *  null. Sole caller is the merge re-bond scan (_bondedRoadAt below).
 *  H889: with preferZ set it prefers a same-elevation road, falling back
 *  to the nearest of any elevation. */
function findClosestOtherRoadAtEndpoint<R extends InnerDirRoad>(
  ex: number,
  ey: number,
  allRoads: ReadonlyArray<R>,
  selfRoad: R,
  searchR: number | ((r: R) => number),
  /** H889: when provided, PREFER a same-elevation destination (falls back
   *  to any-z), mirroring the z-aware commit detector (H888) so the
   *  editor preview resolves a bridge deck, not the ground beneath it.
   *  Omitted → no z preference (unchanged for non-merge callers). */
  preferZ?: number,
): R | null {
  // H786: searchR may be a per-road resolver. Bonded merge tips sit on
  // the DESTINATION'S outer edge stripe (≈ destHalfW from its
  // centerline), so a fixed radius silently un-bonds any merge onto a
  // road wider than the constant — pass (r) => halfW(r) + slack to
  // accept an endpoint that physically sits on r's asphalt.
  const rOf = typeof searchR === 'function' ? searchR : () => searchR;
  let best: R | null = null;
  let bestD2 = Infinity;
  // H889: parallel same-elevation best (preferred when found in range).
  let bestSame: R | null = null;
  let bestSameD2 = Infinity;
  const wantZ = preferZ === undefined ? null : (preferZ | 0);
  for (const r of allRoads) {
    if (r === selfRoad) continue;
    if (!r.pts || r.pts.length < 2) continue;
    const rr = rOf(r);
    const rr2 = rr * rr;
    const isSameZ = wantZ !== null && (Number((r as { z?: unknown }).z) | 0) === wantZ;
    for (let i = 0; i < r.pts.length - 1; i++) {
      const ax = r.pts[i][0];
      const ay = r.pts[i][1];
      const bx = r.pts[i + 1][0];
      const by = r.pts[i + 1][1];
      const dx = bx - ax;
      const dy = by - ay;
      const lenSq = dx * dx + dy * dy;
      if (lenSq < 0.0001) continue;
      let t = ((ex - ax) * dx + (ey - ay) * dy) / lenSq;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const px = ax + dx * t;
      const py = ay + dy * t;
      const ddx = ex - px;
      const ddy = ey - py;
      const d2 = ddx * ddx + ddy * ddy;
      if (isSameZ && d2 <= rr2 && d2 < bestSameD2) {
        bestSameD2 = d2;
        bestSame = r;
      }
      if (d2 <= rr2 && d2 < bestD2) {
        bestD2 = d2;
        best = r;
      }
    }
  }
  // H889: prefer the same-elevation bond, else fall back to nearest.
  return (wantZ !== null && bestSame) ? bestSame : best;
}

/** Render a merge road with v126.04+ polygon-based pavement.
 *
 *  Five-pass pipeline (mirrors monolith L11336-11531):
 *
 *    Pass 1 — bridge concrete underlay. When road.z >= 2 the road
 *             rides a bridge deck; stroke the polygon outline in
 *             deck-color (#4a4640) at 1.2-tile width before filling
 *             so the deck reads as a wider band than the asphalt.
 *    Pass 2 — asphalt fill. Color comes from _getAsphaltBaseColor
 *             (material × age, four swatches). v126.49 delegated this
 *             to a single helper so editor preview matches the
 *             gameplay renderer's six-swatch palette base case.
 *    Pass 3 — OPEN-edge outlines (NOT closed). v126.07's key fix —
 *             the v126.04-06 closed stroke painted perpendicular caps
 *             at the bonded tips, fencing the polygon in as a visible
 *             "separate piece" overlaid on the destination. Stroking
 *             outer and inner as separate open polylines leaves the
 *             tip-ends unstroked, so the destination's pavement +
 *             stripes naturally extend through the gap.
 *    Pass 3b — inner stripe DASHED when the merge is asymmetric
 *             (innerDirStart or innerDirEnd resolved). Matches DOT
 *             MUTCD channelizing line for entrance/exit ramps. Dash
 *             length unified at z*0.6 (v126.67) so it doesn't read
 *             shorter than the regular lane dividers in the same view.
 *    Pass 4 — selection halo. Yellow translucent stroke around the
 *             closed polygon outline when the user has the road
 *             selected.
 *
 *  Color promotion (v126.15): a user-drawn merge ramp defaults to
 *  road.maj=false, but if either bonded endpoint touches a MAJOR
 *  destination, the merge promotes to major-asphalt rendering so it
 *  reads as the same pavement as the destination's auxiliary lane.
 *  Conservative — never demotes a user-set major.
 *
 *  Bond detection (v126.05): SEARCH_R = 3.5 tiles. Only endpoints
 *  within range of ANOTHER road's segment count as bonded. Non-bonded
 *  endpoints don't taper (the v126.04 "isolated needle" problem
 *  rendered both ends tapered regardless of context).
 *
 *  Inner direction (v126.08): only computed for non-CENTER alignments
 *  (LEFT/RIGHT branches). CENTER tips land on the destination's
 *  centerline so there's no clear "inner side" — symmetric taper.
 *
 *  Ported 1:1 from monolith _weDrawTaperedMergeRoad (L11336-11531).
 *  H328 — depends on H325 (_computeMergeInnerDir) + H327
 *  (_weBuildTaperedMergeEdges) + H323 (_weDrawMergeChevrons — caller
 *  decides whether to draw chevrons over the centerline; this fn
 *  doesn't, matching the monolith). */
export function _weDrawTaperedMergeRoad(
  opts: DrawTaperedMergeRoadOpts,
  state: WorldEditorState,
  canvasSize: { w: number; h: number },
  deps: RenderDeps,
): void {
  const { ctx, road, prof, isSelected } = opts;
  const pts = road.pts;
  if (!pts || pts.length < 2) return;
  const allRoads = deps.getMajorRoads();
  // H786: edge-aware bond radius. Bonded merge tips are placed on the
  // destination's outer edge stripe (offsetMag ≈ destHalfW), so the
  // prior fixed 3.5-tile centerline radius un-bonded every merge onto
  // a destination wider than ~7 tiles — the polygon builder then
  // skipped the bonded-tip apex collapse and the ramp ended in a flat
  // slab sitting across the highway's lanes (the user's "loops overlap
  // roads" report). An endpoint now counts as bonded when it sits
  // within (that road's halfW + 1) of its centerline — i.e. physically
  // on the destination's asphalt.
  const _bondR = (r: InnerDirRoad): number => {
    const rr = r as { pts: number[][]; w?: number };
    const p = deps.getRoadProfile(rr as { pts: number[][]; w: number });
    const halfW = p ? p.totalW * 0.5 : (rr.w || 2) * 0.425;
    return halfW + 1.0;
  };
  // H889: pass the merge road's own z so the re-scan prefers a same-z
  // destination (bridge deck over the ground road beneath it), matching
  // the z-aware commit detector.
  const _mergeZ = (Number((road as { z?: unknown }).z) | 0);
  const _bondedRoadAt = (endIdx: number) =>
    findClosestOtherRoadAtEndpoint(pts[endIdx][0], pts[endIdx][1], allRoads, road, _bondR, _mergeZ);
  const bondedStartRoad = _bondedRoadAt(0);
  const bondedEndRoad = _bondedRoadAt(pts.length - 1);
  const bondedStart = bondedStartRoad !== null;
  const bondedEnd = bondedEndRoad !== null;
  const _mType = ((road.mergeType as number) | 0) || 0;
  // H786: a cloverleaf loop is by definition an outboard auxiliary
  // lane hugging the destinations' edges. With the stored Center
  // alignment the polygon built a symmetric band STRADDLING the edge
  // stripe — half the lane overlapping the highway's outer lane, with
  // flat butt ends across its markings. Coerce loops to click-bonded
  // asymmetric (inner edge ON the stripe, lane fully outboard, bonded
  // tips collapsing to the DOT gore apex) regardless of the stored
  // align so previously-committed rows heal on render.
  const _mAlign = _mType === 1 ? 4 : (((road.mergeAlign as number) | 0) || 1);
  // H786: resolve inner direction against the BONDED road specifically
  // (not a blind re-scan) so wide destinations resolve, with the
  // search radius widened to that road's halfW + slack for the same
  // edge-offset reason as _bondR.
  // H887: prefer the side STORED at commit (overlayRoadProps bondInner*,
  // pushed onto the road by apply.ts) over the per-rebuild re-derivation,
  // so the merge holds the side the user drew toward. Legacy rows (no
  // stored vector) fall back to the gated _computeMergeInnerDir path.
  const _bondInner = road as { bondInnerStart?: readonly number[]; bondInnerEnd?: readonly number[] };
  const innerDirStart = _resolveMergeInnerDir(
    _bondInner.bondInnerStart, _mType,
    () => _mAlign !== 1 && bondedStartRoad
      ? _computeMergeInnerDir(pts, 0, [bondedStartRoad], road, _bondR(bondedStartRoad))
      : null,
  );
  const innerDirEnd = _resolveMergeInnerDir(
    _bondInner.bondInnerEnd, _mType,
    () => _mAlign !== 1 && bondedEndRoad
      ? _computeMergeInnerDir(pts, pts.length - 1, [bondedEndRoad], road, _bondR(bondedEndRoad))
      : null,
  );
  const edges = _weBuildTaperedMergeEdges({
    tilePts: pts,
    prof,
    bondedStart,
    bondedEnd,
    innerDirStart,
    innerDirEnd,
    mergeAlign: _mAlign,
    mergeType: _mType,
    // H933: hand the bonded roads' geometry to the polygon builder so it can
    // sign the per-vertex outboard normal away from the nearest road.
    bondedRoadStartPts: bondedStartRoad ? bondedStartRoad.pts : null,
    bondedRoadEndPts: bondedEndRoad ? bondedEndRoad.pts : null,
    // H967: lane-centered rows render the symmetric band (apply.ts pushes
    // the persisted flag onto the live road object).
    laneCentered: (road as { laneCentered?: unknown }).laneCentered === true,
    // H985: constructive-builder rows render pure symmetric bands.
    builderV: typeof (road as { builderV?: unknown }).builderV === 'number'
      ? ((road as { builderV?: unknown }).builderV as number) : undefined,
  });
  if (!edges) return;
  const z = state.view.zoom;
  const isBridge = ((road.z as number) || 0) >= 2;
  const N = edges.outer.length;

  // Closed polygon path: outer forward → inner backward → close.
  const path = new Path2D();
  const p0 = _weTileToScreen(edges.outer[0][0], edges.outer[0][1], state, canvasSize);
  path.moveTo(p0[0], p0[1]);
  for (let i = 1; i < N; i++) {
    const p = _weTileToScreen(edges.outer[i][0], edges.outer[i][1], state, canvasSize);
    path.lineTo(p[0], p[1]);
  }
  for (let i = N - 1; i >= 0; i--) {
    const p = _weTileToScreen(edges.inner[i][0], edges.inner[i][1], state, canvasSize);
    path.lineTo(p[0], p[1]);
  }
  path.closePath();

  // Pass 1 — bridge deck underlay + parapets (H782, parity with
  // _weDrawRoadFull's pass 1). Wider shadow + concrete-gray parapet
  // stroked around the closed merge polygon; the asphalt fill in
  // pass 2 exposes the parapet as a visible side barrier.
  if (isBridge) {
    const prevJoin = ctx.lineJoin;
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(3, 1.0 * z);
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.stroke(path);
    ctx.lineWidth = Math.max(2, 0.5 * z);
    ctx.strokeStyle = '#888884';
    ctx.stroke(path);
    ctx.lineJoin = prevJoin;
  }

  // Pass 2 — asphalt fill.
  ctx.fillStyle = _getAsphaltBaseColor(road as Record<string, unknown>);
  ctx.fill(path);

  // Pass 2c — H989: along the parallel runs the lane BORDERS the road, and
  // DOT paint replaces the road's SOLID edge line with the dashed
  // channelizing line. Erase the road's stripe by stroking asphalt along
  // the band's inner edge for the bonded-run spans (the dashed line in
  // Pass 3 then reads as the only marking there).
  const isBuilderRow = (road as { builderV?: unknown }).builderV === 2;
  // H1163: arc walk hoisted out of the builder-only gate — Pass 3's
  // dashed/solid inner-edge split below needs it for every merge row.
  // SPAN constants mirror worldMap.ts MERGE_ERASE_SPAN_S/E.
  const arcIn: number[] = new Array(N);
  arcIn[0] = 0;
  for (let i = 1; i < N; i++) {
    arcIn[i] = arcIn[i - 1] + Math.hypot(
      edges.inner[i][0] - edges.inner[i - 1][0],
      edges.inner[i][1] - edges.inner[i - 1][1]);
  }
  const totalIn = arcIn[N - 1] || 1;
  const SPAN_S = 12.0;   // ease 4 + decel run 7 + margin
  const SPAN_E = 15.6;   // ease 4 + accel run 10.6 + margin
  if (isBuilderRow && z >= 0.4) {
    const erase = new Path2D();
    let open = false;
    for (let i = 0; i < N; i++) {
      const inSpan = arcIn[i] <= SPAN_S || (totalIn - arcIn[i]) <= SPAN_E;
      if (inSpan) {
        const p = _weTileToScreen(edges.inner[i][0], edges.inner[i][1], state, canvasSize);
        if (!open) { erase.moveTo(p[0], p[1]); open = true; }
        else erase.lineTo(p[0], p[1]);
      } else {
        open = false;
      }
    }
    ctx.lineWidth = Math.max(2, z * 0.3);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'butt';
    ctx.strokeStyle = _getAsphaltBaseColor(road as Record<string, unknown>);
    ctx.stroke(erase);
  }

  // Pass 3 — OPEN edges (no closePath; long sides only).
  if (z >= 0.4) {
    const outerP = new Path2D();
    let ep = _weTileToScreen(edges.outer[0][0], edges.outer[0][1], state, canvasSize);
    outerP.moveTo(ep[0], ep[1]);
    for (let i = 1; i < N; i++) {
      ep = _weTileToScreen(edges.outer[i][0], edges.outer[i][1], state, canvasSize);
      outerP.lineTo(ep[0], ep[1]);
    }
    // H1163: split the inner edge by span — dashed only along the
    // bonded gore/parallel windows, solid on the free spans, matching
    // the in-game strokeRoad merge branch (worldMap.ts).
    const editorAsym = !!(innerDirStart || innerDirEnd);
    const dashS = bondedStart ? (isBuilderRow ? SPAN_S : 16) : 0; // 16 = MERGE_TAPER_TILES
    const dashE = bondedEnd ? (isBuilderRow ? SPAN_E : 16) : 0;
    const innerSolidP = new Path2D();
    const innerDashP = new Path2D();
    let curKind: boolean | null = null;
    for (let i = 0; i < N - 1; i++) {
      const mid = (arcIn[i] + arcIn[i + 1]) / 2;
      const kind = editorAsym && (mid <= dashS || (totalIn - mid) <= dashE);
      const p = kind ? innerDashP : innerSolidP;
      if (curKind !== kind) {
        ep = _weTileToScreen(edges.inner[i][0], edges.inner[i][1], state, canvasSize);
        p.moveTo(ep[0], ep[1]);
        curKind = kind;
      }
      ep = _weTileToScreen(edges.inner[i + 1][0], edges.inner[i + 1][1], state, canvasSize);
      p.lineTo(ep[0], ep[1]);
    }
    ctx.lineWidth = Math.max(1, z * 0.08);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(240,240,240,0.78)';
    const prevDash = ctx.getLineDash ? ctx.getLineDash() : null;
    if (ctx.setLineDash) ctx.setLineDash([]);
    ctx.stroke(outerP);
    ctx.stroke(innerSolidP);
    if (ctx.setLineDash) {
      const dashLen = Math.max(2, z * 0.6);
      ctx.setLineDash([dashLen, dashLen]);
    }
    ctx.stroke(innerDashP);
    if (ctx.setLineDash) ctx.setLineDash(prevDash || []);
  }

  // Pass 4 — selection halo.
  if (isSelected) {
    ctx.lineWidth = Math.max(2, z * 0.18);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,234,90,0.55)';
    ctx.stroke(path);

    // H970: FLOW chevrons — a merge lane's travel direction is its
    // polyline order (pts[0] → pts[N-1]); traffic drives ramps in this
    // direction once the lane-graph phase lands. Three arrowheads along
    // the centerline make the ➔ Flow button's effect visible at a
    // glance. Selected-only so unselected ramps stay clean.
    const segLen: number[] = new Array(pts.length - 1);
    let totalLen = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      segLen[i] = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
      totalLen += segLen[i];
    }
    if (totalLen > 0.5) {
      const size = Math.max(6, 0.9 * z);
      ctx.strokeStyle = '#ffea5a';
      ctx.lineWidth = Math.max(2, z * 0.1);
      ctx.lineCap = 'round';
      for (const f of [0.25, 0.5, 0.75]) {
        let want = totalLen * f;
        let seg = 0;
        while (seg + 1 < segLen.length && want > segLen[seg]) { want -= segLen[seg]; seg++; }
        const t = segLen[seg] > 0 ? want / segLen[seg] : 0;
        const cx0 = pts[seg][0] + (pts[seg + 1][0] - pts[seg][0]) * t;
        const cy0 = pts[seg][1] + (pts[seg + 1][1] - pts[seg][1]) * t;
        const L = segLen[seg] || 1;
        const dx = (pts[seg + 1][0] - pts[seg][0]) / L;
        const dy = (pts[seg + 1][1] - pts[seg][1]) / L;
        const s = _weTileToScreen(cx0, cy0, state, canvasSize);
        // Arrowhead: two strokes sweeping back from the tip at ±140°.
        const a1 = Math.atan2(dy, dx) + Math.PI * 0.78;
        const a2 = Math.atan2(dy, dx) - Math.PI * 0.78;
        ctx.beginPath();
        ctx.moveTo(s[0] + Math.cos(a1) * size, s[1] + Math.sin(a1) * size);
        ctx.lineTo(s[0], s[1]);
        ctx.lineTo(s[0] + Math.cos(a2) * size, s[1] + Math.sin(a2) * size);
        ctx.stroke();
      }
    }
  }
}

/** Viewport bounds in tile-coords, with a +20-tile margin so off-screen
 *  geometry whose smoothed/Bezier sample fans out beyond its raw
 *  bbox still hits the cull check correctly. Mirrors the
 *  `tx0/ty0/tx1/ty1` computation at monolith L12181-L12184. */
export interface TileViewport {
  tx0: number;
  ty0: number;
  tx1: number;
  ty1: number;
}

/** Compute the tile-coord viewport for the current view + canvas size.
 *  Same `+20` slack the monolith uses. */
export function _weComputeTileViewport(
  state: WorldEditorState,
  canvasSize: { w: number; h: number },
): TileViewport {
  const z = state.view.zoom;
  return {
    tx0: state.view.cx - canvasSize.w / 2 / z - 20,
    ty0: state.view.cy - canvasSize.h / 2 / z - 20,
    tx1: state.view.cx + canvasSize.w / 2 / z + 20,
    ty1: state.view.cy + canvasSize.h / 2 / z + 20,
  };
}

/** Whether the tile pass is active at the current zoom. Used by
 *  `_weRender` for both the BACKGROUND color decision (grass when
 *  tile-pass is active, dark editor BG otherwise — so unstamped tiles
 *  show as terrain without paying 80k+ fillRect calls per frame) and
 *  the road pass branch (width band drawn under centerline when
 *  visible). Threshold 0.5 matches monolith L12178 / L12207. */
export function _weTilesVisibleAtZoom(zoom: number): boolean {
  return zoom >= 0.5;
}

/** v8.99.124.22 world-tile rendering pass.
 *
 *  Reads the live `map[]` Uint8Array and colors each visible tile by
 *  its type. Activates at zoom >= 0.5 — below that, the simplified
 *  centerline view is enough (individual tile pixels aren't
 *  distinguishable). ADAPTIVE STRIDE keeps per-frame cost bounded by
 *  capping total iterations near 80k regardless of viewport × zoom.
 *
 *  STRIDE = ceil(sqrt(visibleTiles / 80000)). At low zoom each
 *  on-screen pixel represents many tiles; the stride samples one per
 *  cell. Sampling MISSES intermediate tiles but the visual is still
 *  representative for orientation.
 *
 *  CELL SIZE = stride * zoom + 1. The +1 avoids sub-pixel gaps between
 *  adjacent tiles when zoom × stride lands on a non-integer.
 *
 *  TILE COLOR PALETTE (matches monolith L12224-L12231):
 *    1 / 2 / 3 / 15  → #2e2e34 road asphalt
 *    4 / 5 / 17      → #4a3a3a building (procedural + user)
 *    9               → #143858 water
 *    10              → #3a3530 bridge deck
 *    11              → #0a1a10 forest
 *    12 / 14 / 16    → #5a4828 dirt / canyon
 *    6 / 255         → #1a2818 grass (resolved)
 *    else            → skip (leaves dark editor background showing)
 *
 *  The clamping at `Math.max(0, ...)` / `Math.min(MAP_W-1, ...)` /
 *  etc. handles the viewport-overhangs-the-map case so the loop never
 *  reads past array bounds (the +20 viewport margin can push the
 *  computed bounds outside the actual map dimensions).
 *
 *  Ported 1:1 from monolith `_weRender` tile pass (L12201-L12237).
 */
export function _weDrawWorldTilePass(
  ctx: CanvasRenderingContext2D,
  state: WorldEditorState,
  canvasSize: { w: number; h: number },
  viewport: TileViewport,
  deps: { getMap(): Uint8Array; MAP_W: number; MAP_H: number },
): void {
  const z = state.view.zoom;
  if (!_weTilesVisibleAtZoom(z)) return;
  const map = deps.getMap();
  if (!map) return;
  const MAP_W = deps.MAP_W;
  const MAP_H = deps.MAP_H;
  const w = canvasSize.w;
  const h = canvasSize.h;

  const tx0i = Math.max(0, Math.floor(viewport.tx0));
  const ty0i = Math.max(0, Math.floor(viewport.ty0));
  const tx1i = Math.min(MAP_W - 1, Math.ceil(viewport.tx1));
  const ty1i = Math.min(MAP_H - 1, Math.ceil(viewport.ty1));
  if (tx1i < tx0i || ty1i < ty0i) return;

  const visW = tx1i - tx0i + 1;
  const visH = ty1i - ty0i + 1;
  const totalIfFull = visW * visH;
  const stride = Math.max(1, Math.ceil(Math.sqrt(totalIfFull / 80000)));
  // +1 avoids sub-pixel gaps between tiles when zoom × stride isn't
  // an integer.
  const cellSize = stride * z + 1;

  // H697 note: tile=18/19 (parking-lot pavement) render as a flat color
  // here — the procedural stall overlay (_weDrawParkingLotStallsPass)
  // handles all stall visuals on top. The H694-era cellSize threshold
  // for baked stripes is no longer needed.

  for (let ty = ty0i; ty <= ty1i; ty += stride) {
    const rowBase = ty * MAP_W;
    const sy = h / 2 + (ty - state.view.cy) * z;
    for (let tx = tx0i; tx <= tx1i; tx += stride) {
      const v = map[rowBase + tx];
      // H697: tile=18/19 = flat pavement (asphalt/concrete). The baked
      // stall stripes from H694/H695 are gone — the procedural stall
      // overlay (_weDrawParkingLotStallsPass) draws actual oriented
      // stall rectangles + ADA + aisle dashes on top.
      if (v === 18 || v === 19) {
        const sx = w / 2 + (tx - state.view.cx) * z;
        ctx.fillStyle = v === 19 ? '#bcb6a8' : '#4a4a48';
        ctx.fillRect(sx, sy, cellSize, cellSize);
        continue;
      }
      let color: string | null = null;
      if (v === 1 || v === 2 || v === 3 || v === 15) color = '#2e2e34';
      else if (v === 4 || v === 5 || v === 17) color = '#4a3a3a';
      else if (v === 9) color = '#143858';
      else if (v === 10) color = '#3a3530';
      else if (v === 11) color = '#0a1a10';
      else if (v === 12 || v === 14 || v === 16) color = '#5a4828';
      else if (v === 6 || v === 255) color = '#1a2818';
      if (!color) continue;
      ctx.fillStyle = color;
      const sx = w / 2 + (tx - state.view.cx) * z;
      ctx.fillRect(sx, sy, cellSize, cellSize);
    }
  }
}

/** Inputs for the simplified road draw — the legacy width-band +
 *  centerline pipeline used at low zoom (z < 0.4) and when the
 *  game-render toggle is off. Same `road` shape as `DrawRoadFullOpts`.
 *  `tilesVisible` is the canonical `_weTilesVisibleAtZoom(zoom)` value
 *  cached by the caller so both passes use the same threshold without
 *  re-evaluating per road. */
export interface DrawRoadSimplifiedOpts {
  ctx: CanvasRenderingContext2D;
  road: DrawRoadFullOpts['road'];
  isOverlay: boolean;
  isSelected: boolean;
  tilesVisible: boolean;
}

/** Simplified road draw — width band + centerline + optional bridge
 *  dash. Used when the game-render branch is OFF or zoom is below
 *  the 0.4 game-render threshold (a city-overview shouldn't waste
 *  time drawing 3-px-wide stripes on every highway).
 *
 *  COLOR CODING (v8.99.124.24). Roads paint in their actual property's
 *  color family so the editor mirrors the in-game render:
 *
 *    isSelected → '#ffea5a' yellow halo.
 *    isMajor    → gray   ('#9aa0b0' overlay / '#666' baseline).
 *    !isMajor   → tan    ('#a88860' overlay / '#5a4a30' baseline).
 *
 *  Pre-v124.24 all overlay roads were cyan regardless of properties,
 *  which masked major/minor/driveway mix-ups in the editor. v126.48
 *  bumped the minor color from brown to weathered gray to match the
 *  in-game pattern.
 *
 *  TWO BRANCHES on tile-pass visibility:
 *
 *    TILE-PASS ACTIVE (high zoom):
 *      • Width band — translucent (alpha 0.32) stroke at `w * z * 0.85`
 *        line width (matches getRoadProfile.totalW). The band shows
 *        the actual asphalt extent so users see lane-count differences
 *        without numbers.
 *      • Bridge dash — yellow dashed outline traced along the band so
 *        bridges read as "elevated" without obscuring asphalt color.
 *      • Centerline — thin (1.5 px) opaque polyline on top, as the
 *        edit reference.
 *
 *    TILE-PASS INACTIVE (low zoom):
 *      • Centerline IS the road. Stroke at `max(1, w * z * 0.9)`.
 *      • Bridge dash — yellow dashed centerline overlay at
 *        `strokeW * 0.4` width.
 *      • Subtle white centerline overlay (z > 0.15) for visual
 *        distinction between overlay (brighter) and baseline (dimmer)
 *        roads.
 *
 *  Ported 1:1 from monolith `_weRender` simplified road pass
 *  (L12271-L12376, the `else` branch after `if(gameRender && z >= 0.4)`).
 */
export function _weDrawRoadSimplified(
  opts: DrawRoadSimplifiedOpts,
  state: WorldEditorState,
  canvasSize: { w: number; h: number },
): void {
  const { ctx, road, isOverlay, isSelected, tilesVisible } = opts;
  const pts = road.pts;
  if (!pts || pts.length < 2) return;
  const z = state.view.zoom;
  const isMajor = !!road.maj;
  const isBridge = (road.z || 0) >= 2;

  let baseCol: string;
  if (isSelected) {
    baseCol = '#ffea5a';
  } else if (isMajor) {
    baseCol = isOverlay ? '#9aa0b0' : '#666';
  } else {
    baseCol = isOverlay ? '#a88860' : '#5a4a30';
  }

  const bp0 = _weTileToScreen(pts[0][0], pts[0][1], state, canvasSize);

  if (tilesVisible) {
    // High zoom — translucent band first, optional bridge dash, then
    // thin centerline reference on top.
    const bandW = Math.max(2, road.w * z * 0.85);
    ctx.lineWidth = bandW;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = 0.32;
    ctx.strokeStyle = baseCol;
    ctx.beginPath();
    ctx.moveTo(bp0[0], bp0[1]);
    for (let k = 1; k < pts.length; k++) {
      const p = _weTileToScreen(pts[k][0], pts[k][1], state, canvasSize);
      ctx.lineTo(p[0], p[1]);
    }
    ctx.stroke();
    ctx.globalAlpha = 1.0;
    if (isBridge) {
      ctx.strokeStyle = '#ffcc33';
      ctx.lineWidth = Math.max(1.5, bandW * 0.12);
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.moveTo(bp0[0], bp0[1]);
      for (let k = 1; k < pts.length; k++) {
        const p = _weTileToScreen(pts[k][0], pts[k][1], state, canvasSize);
        ctx.lineTo(p[0], p[1]);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // Centerline polyline — at low zoom this IS the road; at high zoom
  // this sits on top of the width band as a thin edit reference.
  const strokeW = tilesVisible ? 1.5 : Math.max(1, road.w * z * 0.9);
  ctx.strokeStyle = baseCol;
  ctx.lineWidth = strokeW;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(bp0[0], bp0[1]);
  for (let k = 1; k < pts.length; k++) {
    const p = _weTileToScreen(pts[k][0], pts[k][1], state, canvasSize);
    ctx.lineTo(p[0], p[1]);
  }
  ctx.stroke();

  // Bridge outline at low zoom — when the polyline IS the visible
  // road, overlay a yellow dashed centerline so bridges still read
  // distinctly.
  if (isBridge && !tilesVisible) {
    ctx.strokeStyle = '#ffcc33';
    ctx.lineWidth = Math.max(1, strokeW * 0.4);
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(bp0[0], bp0[1]);
    for (let k = 1; k < pts.length; k++) {
      const p = _weTileToScreen(pts[k][0], pts[k][1], state, canvasSize);
      ctx.lineTo(p[0], p[1]);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Subtle lighter centerline (low-zoom only — at high zoom the band
  // + centerline already provides enough visual distinction).
  if (z > 0.15 && !tilesVisible) {
    ctx.strokeStyle =
      isOverlay || isSelected ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(bp0[0], bp0[1]);
    for (let k = 1; k < pts.length; k++) {
      const p = _weTileToScreen(pts[k][0], pts[k][1], state, canvasSize);
      ctx.lineTo(p[0], p[1]);
    }
    ctx.stroke();
  }
}

/** Color palette for an overlay-polygon pass — surfaces / lakes /
 *  buildings share the same fill+stroke+vertex-dot structure with
 *  different colors. `selectedFill` / `selectedStroke` are used when
 *  the pass-specific row matches `state.selected*`; the regular
 *  variants apply otherwise. */
export interface OverlayPolygonPalette {
  fill: string;
  stroke: string;
  selectedFill: string;
  selectedStroke: string;
  /** Color of the corner vertex dots (drawn at z > 0.2). */
  vertexDot: string;
}

/** Inputs for a single overlay-polygon pass (surfaces / lakes /
 *  buildings). `rows` is the state.<kind> array; `xStart` is the
 *  first vertex-pair index in each row (2 for surfaces+buildings, 1
 *  for lakes whose meta is just `[name, x1, y1, ...]`); `minLen` is
 *  the minimum row length to render (3 vertices = 6 coords + meta).
 *  `selectedIdx` is the kind-specific selection index from state. */
export interface OverlayPolygonPassOpts {
  ctx: CanvasRenderingContext2D;
  rows: unknown[];
  xStart: number;
  minLen: number;
  selectedIdx: number;
  palette: OverlayPolygonPalette;
  viewport: TileViewport;
  /** H1004: 'building' rows render an OPAQUE per-type roof (shingle /
   *  flat concrete, keyed on row[1] type) instead of the translucent box;
   *  'surface' rows named "…driveway" render an opaque concrete strip.
   *  Both keep the selection outline + (selected-only) vertex dots. */
  structKind?: 'building' | 'surface';
}

/** Generic overlay-polygon render pass — used for surfaces, lakes,
 *  and buildings, which differ only in meta column offset + color
 *  palette. Each row is a flat `[meta..., x1, y1, x2, y2, ...]` array;
 *  vertices are read starting at `xStart`. Bbox-culls each row
 *  against the tile viewport before fill+stroke.
 *
 *  Vertex dots paint at z > 0.2 in the palette's vertexDot color.
 *
 *  Ported 1:1 from monolith `_weRender` surface (L12450-L12481),
 *  lake (L12537-L12568), and building (L12569-L12600) passes — all
 *  three share this exact structure.
 */
export function _weDrawOverlayPolygonPass(
  opts: OverlayPolygonPassOpts,
  state: WorldEditorState,
  canvasSize: { w: number; h: number },
): void {
  const { ctx, rows, xStart, minLen, selectedIdx, palette, viewport } = opts;
  const z = state.view.zoom;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row) || row.length < minLen) continue;
    const pts: Array<[number, number]> = [];
    for (let k = xStart; k + 1 < row.length; k += 2) {
      pts.push([row[k] as number, row[k + 1] as number]);
    }
    if (pts.length < 3) continue;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      if (p[0] < minX) minX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] > maxY) maxY = p[1];
    }
    if (maxX < viewport.tx0 || minX > viewport.tx1 || maxY < viewport.ty0 || minY > viewport.ty1) {
      continue;
    }
    const isSelected = i === selectedIdx;
    const project = (tx: number, ty: number): [number, number] =>
      _weTileToScreen(tx, ty, state, canvasSize) as [number, number];
    // H1004: opaque roof / driveway render (covers the tile blob). Only
    // when NOT selected — a selected item still gets the yellow highlight
    // fill so the user sees the pick.
    const isDriveway = _weIsDrivewayName((row as unknown[])[0]);
    const structural = opts.structKind === 'building' || (opts.structKind === 'surface' && isDriveway);
    let customFilled = false;
    if (!isSelected && opts.structKind === 'building') {
      _weDrawRoof(ctx, pts, String((row as unknown[])[1] ?? 'house'), project);
      customFilled = true;
    } else if (!isSelected && opts.structKind === 'surface' && isDriveway) {
      _weDrawDrivewayStrip(ctx, pts, project, 1.2);
      customFilled = true;
    }
    if (!customFilled) {
      ctx.fillStyle = isSelected ? palette.selectedFill : palette.fill;
      ctx.strokeStyle = isSelected ? palette.selectedStroke : palette.stroke;
      ctx.lineWidth = isSelected ? 2 : 1.5;
      ctx.beginPath();
      const p0 = _weTileToScreen(pts[0][0], pts[0][1], state, canvasSize);
      ctx.moveTo(p0[0], p0[1]);
      for (let k = 1; k < pts.length; k++) {
        const p = _weTileToScreen(pts[k][0], pts[k][1], state, canvasSize);
        ctx.lineTo(p[0], p[1]);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    // Vertex dots: always for generic polygons; only when selected for
    // structural (building/driveway) rows so a neighborhood isn't dotted.
    if (z > 0.2 && (isSelected || !structural)) {
      ctx.fillStyle = palette.vertexDot;
      for (const p of pts) {
        const sp = _weTileToScreen(p[0], p[1], state, canvasSize);
        ctx.beginPath();
        ctx.arc(sp[0], sp[1], 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

/** Color palettes for the three overlay-polygon kinds. Kept at module
 *  scope so callers (orchestrator + tests) share the same exact
 *  values. */
export const SURFACE_POLYGON_PALETTE: OverlayPolygonPalette = {
  fill: 'rgba(92,204,255,0.18)',
  stroke: '#5cf',
  selectedFill: 'rgba(255,255,85,0.30)',
  selectedStroke: '#ff5',
  vertexDot: '#5cf',
};
export const LAKE_POLYGON_PALETTE: OverlayPolygonPalette = {
  fill: 'rgba(58,127,200,0.30)',
  stroke: '#3a7fc8',
  selectedFill: 'rgba(255,255,85,0.30)',
  selectedStroke: '#ff5',
  vertexDot: '#5fa8e0',
};
export const BUILDING_POLYGON_PALETTE: OverlayPolygonPalette = {
  fill: 'rgba(180,140,90,0.30)',
  stroke: '#c89060',
  selectedFill: 'rgba(255,255,85,0.30)',
  selectedStroke: '#ff5',
  vertexDot: '#c89060',
};
// H693: parking-lot palette — neutral gray matching the tile=18 base.
export const PARKING_LOT_POLYGON_PALETTE: OverlayPolygonPalette = {
  fill: 'rgba(180,180,180,0.25)',
  stroke: '#bcbcbc',
  selectedFill: 'rgba(255,255,85,0.30)',
  selectedStroke: '#ff5',
  vertexDot: '#e6e6e6',
};

/** H699: parking-lot polygon outlines. Mirrors _weDrawOverlayPolygonPass
 *  but reads xStart per-row from _weParseParkingLotMeta so H693/H695/H699
 *  rows all decode correctly without the shared pass picking up a
 *  schema-aware path. Paints the polygon fill + outline using the
 *  parking-lot palette; selection swap matches the shared pass. */
export function _weDrawParkingLotPolygonsPass(
  ctx: CanvasRenderingContext2D,
  state: WorldEditorState,
  canvasSize: { w: number; h: number },
  viewport: TileViewport,
): void {
  const z = state.view.zoom;
  const selectedIdx =
    state.selectedKind === 'parkingLot' ? state.selectedParkingLot : -1;
  for (let i = 0; i < state.parkingLots.length; i++) {
    const row = state.parkingLots[i];
    if (!Array.isArray(row) || row.length < 7) continue;
    const meta = _weParseParkingLotMeta(row);
    const pts: Array<[number, number]> = [];
    for (let k = meta.xStart; k + 1 < row.length; k += 2) {
      pts.push([row[k] as number, row[k + 1] as number]);
    }
    if (pts.length < 3) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
    }
    if (maxX < viewport.tx0 || minX > viewport.tx1 ||
        maxY < viewport.ty0 || minY > viewport.ty1) continue;
    const isSelected = i === selectedIdx;
    ctx.fillStyle = isSelected
      ? PARKING_LOT_POLYGON_PALETTE.selectedFill
      : PARKING_LOT_POLYGON_PALETTE.fill;
    ctx.strokeStyle = isSelected
      ? PARKING_LOT_POLYGON_PALETTE.selectedStroke
      : PARKING_LOT_POLYGON_PALETTE.stroke;
    ctx.lineWidth = 2;
    ctx.beginPath();
    const p0 = _weTileToScreen(pts[0][0], pts[0][1], state, canvasSize);
    ctx.moveTo(p0[0], p0[1]);
    for (let k = 1; k < pts.length; k++) {
      const p = _weTileToScreen(pts[k][0], pts[k][1], state, canvasSize);
      ctx.lineTo(p[0], p[1]);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    if (z > 0.2) {
      ctx.fillStyle = PARKING_LOT_POLYGON_PALETTE.vertexDot;
      for (const p of pts) {
        const sp = _weTileToScreen(p[0], p[1], state, canvasSize);
        ctx.beginPath();
        ctx.arc(sp[0], sp[1], 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

/** H1038: intersection marker palette by control type (index = control 0-4). */
const INTERSECTION_MARKER: ReadonlyArray<{ c: string; g: string }> = [
  { c: '#9aa0a9', g: '–' }, // 0 uncontrolled (en dash)
  { c: '#E8A13A', g: 'Y' },      // 1 yield
  { c: '#E5534B', g: 'S' },      // 2 two-way stop
  { c: '#E5534B', g: 'S' },      // 3 all-way stop (name label distinguishes)
  { c: '#46B26B', g: '◉' }, // 4 signal (fisheye)
];

/** H1038: draw authored intersection MARKERS — a control-colored ring + glyph
 *  (+ control name when zoomed in) at each placed crossing. Editor-only; the
 *  in-game markings/behavior land in later commits. Reads state.intersections
 *  directly (like the parking-lot polygon pass). */
export function _weDrawIntersectionsPass(
  ctx: CanvasRenderingContext2D,
  state: WorldEditorState,
  canvasSize: { w: number; h: number },
  viewport: TileViewport,
): void {
  const z = state.view.zoom;
  const selIdx = state.selectedKind === 'intersection' ? state.selectedIntersection : -1;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < state.intersections.length; i++) {
    const parsed = parseIntersectionRow(state.intersections[i]);
    if (!parsed) continue;
    const { x, y, control, laneCounts } = parsed;
    if (x < viewport.tx0 || x > viewport.tx1 || y < viewport.ty0 || y > viewport.ty1) continue;
    const sp = _weTileToScreen(x, y, state, canvasSize);
    const mk = INTERSECTION_MARKER[control] ?? INTERSECTION_MARKER[0];
    const isSel = i === selIdx;
    const r = isSel ? 13 : 10;
    ctx.beginPath();
    ctx.arc(sp[0], sp[1], r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(10,12,16,0.62)';
    ctx.fill();
    ctx.lineWidth = isSel ? 3 : 2;
    ctx.strokeStyle = isSel ? '#ffffff' : mk.c;
    ctx.stroke();
    ctx.fillStyle = mk.c;
    ctx.font = `bold ${isSel ? 12 : 11}px monospace`;
    ctx.fillText(mk.g, sp[0], sp[1]);
    if (z > 0.28) {
      ctx.font = '10px monospace';
      ctx.fillStyle = isSel ? '#ffffff' : 'rgba(230,230,220,0.9)';
      ctx.fillText(INTERSECTION_CONTROL_NAMES[control], sp[0], sp[1] + r + 9);
      // H1041: per-road lane counts (A = crossing road 1, B = road 2), seeded
      // from the actual road widths at placement.
      ctx.fillStyle = isSel ? '#ffe9b0' : 'rgba(200,190,150,0.85)';
      ctx.fillText(`A${laneCounts[0]} · B${laneCounts[2]}`, sp[0], sp[1] + r + 20);
    }
  }
  ctx.restore();
}

/** H697: render the procedural stall layout for every parking lot.
 *  Runs AFTER the parking-lot polygon outline pass so stalls paint on
 *  top of the polygon fill. Each lot's stalls are computed from the
 *  longest-edge angle via computeStallLayout() — no caching, no row
 *  schema bloat, recomputed each frame (cheap; a typical lot is dozens
 *  of stalls, costs a microsecond). */
export function _weDrawParkingLotStallsPass(
  ctx: CanvasRenderingContext2D,
  parkingLots: unknown[],
  state: WorldEditorState,
  canvasSize: { w: number; h: number },
  viewport: TileViewport,
): void {
  for (let i = 0; i < parkingLots.length; i++) {
    const row = parkingLots[i];
    if (!Array.isArray(row) || row.length < 7) continue;
    // H699: row schema runs through _weParseParkingLotMeta to handle
    // all of H693/H695/H699 in one place. Storage migrates to H699 at
    // load, so in practice we usually see H699 — the parser still
    // accepts in-memory rows that haven't round-tripped.
    const meta = _weParseParkingLotMeta(row);
    const pts: [number, number][] = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let k = meta.xStart; k + 1 < row.length; k += 2) {
      const x = row[k] as number;
      const y = row[k + 1] as number;
      pts.push([x, y]);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    if (pts.length < 3) continue;
    // Bbox-cull against the visible tile viewport.
    if (maxX < viewport.tx0 || minX > viewport.tx1 ||
        maxY < viewport.ty0 || minY > viewport.ty1) continue;
    const layout = computeStallLayout(pts, {
      stallW: meta.stallW,
      stallL: meta.stallL,
      aisleW: meta.aisleW,
      // H703: editor-wide ADA count flows through every lot's render.
      // Per-lot ADA would require an H703 schema bump (deferred).
      maxAdaPerRow: state.parkingLotProps.adaCount,
    });
    if (!layout.stalls.length) continue;
    // Aisle strip — subtle dashed centerline across each aisle band.
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.setLineDash([4, 4]);
    for (const aisle of layout.aisles) {
      // Draw the dashed centerline (midpoint of the long side of the
      // band) by sampling corners 0+1 (front edge) and 2+3 (back).
      const mx0 = (aisle.corners[0][0] + aisle.corners[3][0]) * 0.5;
      const my0 = (aisle.corners[0][1] + aisle.corners[3][1]) * 0.5;
      const mx1 = (aisle.corners[1][0] + aisle.corners[2][0]) * 0.5;
      const my1 = (aisle.corners[1][1] + aisle.corners[2][1]) * 0.5;
      const sp0 = _weTileToScreen(mx0, my0, state, canvasSize);
      const sp1 = _weTileToScreen(mx1, my1, state, canvasSize);
      ctx.beginPath();
      ctx.moveTo(sp0[0], sp0[1]);
      ctx.lineTo(sp1[0], sp1[1]);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // Stalls — white outline rectangles with ADA cells fill-cyan.
    for (const s of layout.stalls) {
      const c0 = _weTileToScreen(s.corners[0][0], s.corners[0][1], state, canvasSize);
      const c1 = _weTileToScreen(s.corners[1][0], s.corners[1][1], state, canvasSize);
      const c2 = _weTileToScreen(s.corners[2][0], s.corners[2][1], state, canvasSize);
      const c3 = _weTileToScreen(s.corners[3][0], s.corners[3][1], state, canvasSize);
      if (s.ada) {
        ctx.fillStyle = 'rgba(58,180,220,0.55)';
        ctx.beginPath();
        ctx.moveTo(c0[0], c0[1]);
        ctx.lineTo(c1[0], c1[1]);
        ctx.lineTo(c2[0], c2[1]);
        ctx.lineTo(c3[0], c3[1]);
        ctx.closePath();
        ctx.fill();
      }
      // Stall divider stripes — paint the two long sides of the cell
      // (front-left→back-left and front-right→back-right) in white.
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(c0[0], c0[1]);
      ctx.lineTo(c3[0], c3[1]);
      ctx.moveTo(c1[0], c1[1]);
      ctx.lineTo(c2[0], c2[1]);
      ctx.stroke();
    }
    // H700: tree islands — tan planter rect + green tree blob centered.
    for (const ti of layout.treeIslands) {
      const c0 = _weTileToScreen(ti.corners[0][0], ti.corners[0][1], state, canvasSize);
      const c1 = _weTileToScreen(ti.corners[1][0], ti.corners[1][1], state, canvasSize);
      const c2 = _weTileToScreen(ti.corners[2][0], ti.corners[2][1], state, canvasSize);
      const c3 = _weTileToScreen(ti.corners[3][0], ti.corners[3][1], state, canvasSize);
      ctx.fillStyle = 'rgba(140,120,90,0.7)'; // tan planter
      ctx.beginPath();
      ctx.moveTo(c0[0], c0[1]);
      ctx.lineTo(c1[0], c1[1]);
      ctx.lineTo(c2[0], c2[1]);
      ctx.lineTo(c3[0], c3[1]);
      ctx.closePath();
      ctx.fill();
      // Tree blob — circle at centroid of the planter cell, sized to
      // ~60% of the planter's short axis.
      const cxp = (c0[0] + c1[0] + c2[0] + c3[0]) * 0.25;
      const cyp = (c0[1] + c1[1] + c2[1] + c3[1]) * 0.25;
      const span = Math.min(
        Math.hypot(c1[0] - c0[0], c1[1] - c0[1]),
        Math.hypot(c3[0] - c0[0], c3[1] - c0[1]),
      );
      const r = Math.max(2, span * 0.32);
      ctx.fillStyle = '#1a5a1a';
      ctx.beginPath();
      ctx.arc(cxp, cyp, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#2d8c2d';
      ctx.beginPath();
      ctx.arc(cxp - r * 0.25, cyp - r * 0.25, r * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** Inputs for the river pass — width band + centerline polyline +
 *  endpoint dots. */
export interface RiverPassOpts {
  ctx: CanvasRenderingContext2D;
  rivers: unknown[];
  selectedIdx: number;
  tilesVisible: boolean;
  viewport: TileViewport;
}

/** v8.99.124.28 river render pass — mirrors the road render style but
 *  in water-blue. Each row is `[w, name, x1, y1, x2, y2, ...]`:
 *  vertex pairs start at index 2.
 *
 *  Same two-branch pattern as `_weDrawRoadSimplified`:
 *    TILE-PASS ACTIVE (high zoom) → translucent band + thin centerline.
 *    TILE-PASS INACTIVE (low zoom) → centerline IS the river.
 *
 *  Endpoint dots (z > 0.2) so the user can pinpoint river endpoints
 *  for snapping new vertices.
 *
 *  Ported 1:1 from monolith `_weRender` river pass (L12482-L12536). */
export function _weDrawRiverPass(
  opts: RiverPassOpts,
  state: WorldEditorState,
  canvasSize: { w: number; h: number },
): void {
  const { ctx, rivers, selectedIdx, tilesVisible, viewport } = opts;
  const z = state.view.zoom;
  for (let i = 0; i < rivers.length; i++) {
    const rv = rivers[i];
    if (!Array.isArray(rv) || rv.length < 6) continue;
    const w = (rv[0] as number) || 4;
    const pts: Array<[number, number]> = [];
    for (let k = 2; k + 1 < rv.length; k += 2) {
      pts.push([rv[k] as number, rv[k + 1] as number]);
    }
    if (pts.length < 2) continue;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      if (p[0] < minX) minX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] > maxY) maxY = p[1];
    }
    if (maxX < viewport.tx0 || minX > viewport.tx1 || maxY < viewport.ty0 || minY > viewport.ty1) {
      continue;
    }
    const isSelected = i === selectedIdx;
    const baseCol = isSelected ? '#ffea5a' : '#3a7fc8';
    const bp0 = _weTileToScreen(pts[0][0], pts[0][1], state, canvasSize);

    if (tilesVisible) {
      const bandW = Math.max(2, w * z * 0.85);
      ctx.lineWidth = bandW;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.globalAlpha = 0.42;
      ctx.strokeStyle = baseCol;
      ctx.beginPath();
      ctx.moveTo(bp0[0], bp0[1]);
      for (let k = 1; k < pts.length; k++) {
        const p = _weTileToScreen(pts[k][0], pts[k][1], state, canvasSize);
        ctx.lineTo(p[0], p[1]);
      }
      ctx.stroke();
      ctx.globalAlpha = 1.0;
    }

    const strokeW = tilesVisible ? 1.5 : Math.max(1, w * z * 0.9);
    ctx.strokeStyle = baseCol;
    ctx.lineWidth = strokeW;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(bp0[0], bp0[1]);
    for (let k = 1; k < pts.length; k++) {
      const p = _weTileToScreen(pts[k][0], pts[k][1], state, canvasSize);
      ctx.lineTo(p[0], p[1]);
    }
    ctx.stroke();

    if (z > 0.2) {
      const ep0 = _weTileToScreen(pts[0][0], pts[0][1], state, canvasSize);
      const last = pts[pts.length - 1];
      const ep1 = _weTileToScreen(last[0], last[1], state, canvasSize);
      ctx.fillStyle = isSelected ? '#ffea5a' : '#5fa8e0';
      ctx.beginPath();
      ctx.arc(ep0[0], ep0[1], 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(ep1[0], ep1[1], 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** Inputs for the active-vertex ring pass. The pass needs the
 *  selected-item resolver (`_weGetSelectedItem` in select.ts) plumbed
 *  through deps because render.ts otherwise has no import on select. */
export interface ActiveVertexPassOpts {
  ctx: CanvasRenderingContext2D;
  /** Resolves the currently-selected item to a vertex-bearing record.
   *  Discriminated union with kinds 'baselineRoad' (uses majorRoads
   *  pts) or row-based ('road' / 'surface' / 'building' / 'river' /
   *  'lake' — flat-array row + xStart meta offset). Mirrors the
   *  v126.46 dispatch at monolith L12608-L12624. */
  getSelectedItem(): ActiveVertexSelectedItem | null;
  /** Live majorRoads array — read by the baselineRoad branch to look
   *  up the selected baseline's vertex coords. */
  getMajorRoads(): Array<{ pts: number[][]; [k: string]: unknown }>;
}

/** Subset of `_weGetSelectedItem`'s return type that the active-vertex
 *  highlight needs. Kept structurally compatible with select.ts's
 *  SelectedItem so callers can plug `_weGetSelectedItem` directly. */
export type ActiveVertexSelectedItem =
  | { kind: 'baselineRoad'; baseRoadIdx: number }
  | { kind: 'road' | 'surface' | 'building' | 'river' | 'lake'; row: unknown[]; xStart: number };

/** v8.99.124.34 active-vertex highlight — bright orange ring + filled
 *  dot drawn on top of everything else so the user sees which vertex
 *  is currently in "next-tap moves this" mode. Vertex dots themselves
 *  are drawn by each kind's render block; this just adds the extra
 *  ring on the ACTIVE one.
 *
 *  v8.99.126.46 dispatch — baselineRoad reads from majorRoads[idx].pts
 *  (a [[x, y], ...] array), the row-based kinds (road / surface /
 *  building / river / lake) index a flat array by
 *  `xStart + activeVertex * 2`. The xStart meta-offset comes from
 *  select.ts's SelectedItem discriminated union.
 *
 *  Returns silently when:
 *    - state.activeVertex < 0 (no active vertex set).
 *    - No selected item (deps.getSelectedItem returns null).
 *    - Vertex index out of bounds for the resolved kind.
 *
 *  Ported 1:1 from monolith `_weRender` active-vertex block
 *  (L12601-L12633).
 */
export function _weDrawActiveVertexHighlight(
  opts: ActiveVertexPassOpts,
  state: WorldEditorState,
  canvasSize: { w: number; h: number },
): void {
  if (state.activeVertex < 0) return;
  const sel = opts.getSelectedItem();
  if (!sel) return;
  let avX: number | null = null;
  let avY: number | null = null;
  if (sel.kind === 'baselineRoad') {
    const idx = sel.baseRoadIdx;
    const majorRoads = opts.getMajorRoads();
    if (idx >= 0 && idx < majorRoads.length) {
      const pts = majorRoads[idx].pts;
      if (pts && state.activeVertex < pts.length) {
        avX = pts[state.activeVertex][0];
        avY = pts[state.activeVertex][1];
      }
    }
  } else if (Array.isArray(sel.row)) {
    const r = sel.row;
    const xi = sel.xStart + state.activeVertex * 2;
    const yi = xi + 1;
    if (yi < r.length) {
      avX = r[xi] as number;
      avY = r[yi] as number;
    }
  }
  if (avX === null || avY === null) return;
  const ctx = opts.ctx;
  const sp = _weTileToScreen(avX, avY, state, canvasSize);
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#ff8000';
  ctx.fillStyle = '#ffcc44';
  ctx.beginPath();
  ctx.arc(sp[0], sp[1], 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

/** H991: SPAN highlight — blue sub-polyline over the armed stretch plus
 *  a perpendicular cut TICK at each cut point (the "blue line across the
 *  road" the user draws when marking where to cut). Drawn top-most in
 *  BOTH view modes. The stroke rides the RAW polyline; it's wide and
 *  semi-transparent so the smoothed road curve stays covered. Blue is
 *  free in the editor's color vocabulary (yellow=selection, cyan=draft/
 *  endpoint, magenta=lane, orange=active vertex). */
export function _weDrawSpanHighlight(
  ctx: CanvasRenderingContext2D,
  state: WorldEditorState,
  canvasSize: { w: number; h: number },
): void {
  if (state.selectMode !== 'span' || !state.spanA) return;
  let pts: TPt[] = [];
  let w = 4;
  if (state.selectedKind === 'road' && state.selected >= 0) {
    const row = state.overlay[state.selected] as readonly (string | number)[] | undefined;
    if (!row || row.length < 6) return;
    w = (row[0] as number) || 4;
    const xStart = (row.length & 1) === 1 ? 5 : 4;
    for (let i = xStart; i + 1 < row.length; i += 2) {
      pts.push([row[i] as number, row[i + 1] as number]);
    }
  } else if (state.selectedKind === 'baselineRoad' && state.selectedBaselineRoad >= 0) {
    pts = getEditedBaselinePts(state, state.selectedBaselineRoad) as TPt[];
    w = (BASELINE_ROADS[state.selectedBaselineRoad]?.[0] as number) || 4;
  } else {
    return;
  }
  if (pts.length < 2) return;
  const zoom = state.view.zoom;
  const spanPts = _weSpanHighlightPts(state, pts);
  // Stroke the armed stretch (needs both cuts).
  if (spanPts.length >= 2) {
    ctx.strokeStyle = 'rgba(80, 160, 255, 0.55)';
    ctx.lineWidth = Math.max(4, w * zoom * 1.1);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i < spanPts.length; i++) {
      const [sx, sy] = _weTileToScreen(spanPts[i][0], spanPts[i][1], state, canvasSize);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    ctx.stroke();
  }
  // Perpendicular cut ticks at each armed cut point.
  const drawTick = (cut: { seg: number; t: number; x: number; y: number }): void => {
    // H992: clamp — a stale span (geometry rewritten under it) may carry
    // a seg index past the polyline; an unguarded pts[seg] read here ran
    // inside the render tick and could kill the whole frame loop.
    const seg = Math.min(Math.max(cut.seg, 0), pts.length - 2);
    const a = pts[seg];
    const b = pts[seg + 1];
    if (!a || !b) return;
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    const L = Math.hypot(dx, dy) || 1;
    dx /= L; dy /= L;
    const half = Math.max(9, (w * zoom * 1.4) / 2); // screen px
    const [cx, cy] = _weTileToScreen(cut.x, cut.y, state, canvasSize);
    ctx.strokeStyle = '#4da6ff';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - -dy * half, cy - dx * half);
    ctx.lineTo(cx + -dy * half, cy + dx * half);
    ctx.stroke();
    ctx.fillStyle = '#4da6ff';
    ctx.beginPath();
    ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
    ctx.fill();
  };
  drawTick(state.spanA);
  if (state.spanB) drawTick(state.spanB);
}

/** Hover-snap record shape the draft preview reads. Mirrors the shape
 *  set by `_weFindSnap` — endpoint / segment / lane targets share tx/ty
 *  and a `kind` discriminator; lane targets also carry `laneIdx`. */
export interface HoverSnapRecord {
  tx: number;
  ty: number;
  kind?: 'endpoint' | 'segment' | 'lane' | 'garage' | 'crossing';
  laneIdx?: number;
  /** H894: derived direction-of-travel of the picked lane (unit, tile
   *  coords) — drives the magenta direction arrow. UX-only. */
  travelDir?: [number, number];
  oneway?: boolean;
  [k: string]: unknown;
}

/** Draft-preview state read straight off state.draft. The render path
 *  treats `pts` as `[number, number]` even though the on-disk row uses
 *  flat arrays — the draft state carries the structured shape so the
 *  preview can read it without slicing meta. */
interface DraftForPreview {
  kind: string;
  pts: number[][];
  w?: number;
  autoDriveway?: boolean;
  /** Merge-bond preview fields — v8.99.126.39/.51. */
  merge?: boolean;
  mergeAlign?: number;
  mergeType?: number;
  loopDiameter?: number;
  /** H695: parking-lot in-flight material — drives the preview color
   *  shift between asphalt (neutral gray) and concrete (warm tan). */
  material?: 'asphalt' | 'concrete';
}

/** Host bindings the draft preview needs that aren't on RenderDeps —
 *  `_weCurvePoints` lives in draft.ts, `_weMakeDriveway` in stamp.ts,
 *  `_weMergeBondEndpoints` in merge/index.ts. Plumbing them through
 *  callbacks keeps render.ts decoupled from those modules' import
 *  graphs.
 *
 *  All three are optional — the preview falls back to the raw user
 *  click polyline when a resolver is absent, matching the monolith's
 *  `typeof X === 'function'` guards at L12747 / L12793 / L12664. */
export interface DraftPreviewDeps {
  /** Quadratic-Bezier curve sampler used by Arc-on-draw road/river
   *  drafts. (Identical to the `curve` parameter on
   *  WorldEditorState.draftProps.) Mirrors monolith _weCurvePoints. */
  curvePoints?: (pts: number[][], curve: number) => number[][];
  /** Merge bond-endpoint dispatcher — used by Loop/Stop/Yield road
   *  drafts to show the live auto-arc shape. Mirrors monolith
   *  _weMergeBondEndpoints (the dispatcher at H334). H890: the trailing
   *  optional params mirror the live dispatcher (sideOut, rampZ) so the
   *  preview can pass the draft's z and bond to a same-elevation deck,
   *  matching what the commit will bake. The preview omits sideOut. */
  mergeBondEndpoints?: (
    pts: number[][],
    dW: number,
    mergeAlign: number,
    mergeType: number,
    loopDiameter: number,
    sideOut?: { start?: [number, number]; end?: [number, number] },
    rampZ?: number,
  ) => number[][];
  /** Auto-driveway preview generator for building drafts (v124.28).
   *  Returns null when the polygon shape doesn't admit a driveway
   *  (e.g. no nearby road). Mirrors monolith _weMakeDriveway. */
  makeDriveway?: (buildingPts: number[][]) => number[][] | null;
}

/** Inputs for the draft preview pass. */
export interface DraftPreviewOpts {
  ctx: CanvasRenderingContext2D;
  /** Snapshot of state.draft at the start of the render frame — kept
   *  as a separate type from WorldEditorState so the resolver can read
   *  the structured `pts: number[][]` shape directly. */
  draft: DraftForPreview;
}

/** Compute the live-cursor tile coords for a draft preview — snap
 *  target when one is held, raw hover tile otherwise. Mirrors the
 *  inline `cur = hoverSnap || hoverTile` pattern in monolith
 *  L12686 / L12711 / L12743 / L12772. */
function _draftPreviewCursor(state: WorldEditorState): [number, number] {
  const snap = state.hoverSnap as HoverSnapRecord | null;
  if (snap && typeof snap.tx === 'number' && typeof snap.ty === 'number') {
    return [snap.tx, snap.ty];
  }
  return [state.hoverTile.tx, state.hoverTile.ty];
}

/** Stroke a closed-polygon draft preview (building / surface / lake)
 *  with the supplied palette. Vertex dots use `vertexFill`. Cursor is
 *  the live tile so the polygon closes back through it. */
function _drawClosedPolygonDraft(
  ctx: CanvasRenderingContext2D,
  draftPts: number[][],
  cursor: [number, number],
  fillColor: string,
  strokeColor: string,
  vertexFill: string,
  state: WorldEditorState,
  canvasSize: { w: number; h: number },
  // H696: optional pre-curved polyline. When supplied, the outline is
  // drawn from this point sequence instead of the raw (draftPts+cursor)
  // path — letting the caller pass a Bezier-sampled approximation of
  // what _weCommitDraft will bake at commit time. Vertex dots still
  // paint at the user's raw click positions (draftPts) so the user can
  // see which points they placed vs the smoothed shape.
  renderPts?: number[][],
): void {
  const outline = renderPts ?? null;
  ctx.fillStyle = fillColor;
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (outline && outline.length >= 2) {
    const o0 = _weTileToScreen(outline[0][0], outline[0][1], state, canvasSize);
    ctx.moveTo(o0[0], o0[1]);
    for (let k = 1; k < outline.length; k++) {
      const p = _weTileToScreen(outline[k][0], outline[k][1], state, canvasSize);
      ctx.lineTo(p[0], p[1]);
    }
  } else {
    const p0 = _weTileToScreen(draftPts[0][0], draftPts[0][1], state, canvasSize);
    ctx.moveTo(p0[0], p0[1]);
    for (let k = 1; k < draftPts.length; k++) {
      const p = _weTileToScreen(draftPts[k][0], draftPts[k][1], state, canvasSize);
      ctx.lineTo(p[0], p[1]);
    }
    const pc = _weTileToScreen(cursor[0], cursor[1], state, canvasSize);
    ctx.lineTo(pc[0], pc[1]);
  }
  ctx.closePath();
  if (draftPts.length >= 2) ctx.fill();
  ctx.stroke();
  ctx.fillStyle = vertexFill;
  for (const p of draftPts) {
    const sp = _weTileToScreen(p[0], p[1], state, canvasSize);
    ctx.beginPath();
    ctx.arc(sp[0], sp[1], 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** v8.99.124.x draft preview render pass — visualizes the in-flight
 *  user draw for road / surface / building / lake / river. Each kind
 *  has its own palette and geometry hint pattern, but they all share:
 *
 *    1. Polyline of placed clicks + closing leg to the live cursor.
 *    2. Vertex dots on the placed clicks (NOT the interpolated
 *       samples — interior clicks must stay draggable).
 *
 *  KIND-SPECIFIC LOGIC:
 *
 *    building (closed polygon, tan)
 *      + auto-driveway preview (v124.28) when `draft.autoDriveway`
 *        is on and the building has ≥3 vertices. Calls
 *        `deps.makeDriveway` on `pts + cursor`; if a driveway shape
 *        comes back, fills it in cyan dashed.
 *
 *    surface (closed polygon, yellow)
 *    lake    (closed polygon, water-blue)
 *      Both share the same closed-polygon helper, different palette.
 *
 *    river (open polyline, water-blue)
 *      Width band based on draft.w. Arc-on-draw via `deps.curvePoints`
 *      when `draftProps.arc && draftProps.curve !== 0`.
 *
 *    road (open polyline, yellow — default kind)
 *      Width band based on draft.w. Three render modes (mutually
 *      exclusive):
 *        Arc-on-draw      → `curvePoints(previewPts, curve)`.
 *        Merge bond live  → `mergeBondEndpoints(previewPts, w,
 *                           mergeAlign, mergeType, loopDiameter)`,
 *                           wrapped in try/catch (failures fall back
 *                           to user clicks). Triggers for merge
 *                           drafts of type Loop (1), Stop (2), or
 *                           Yield (3) — Standard mergeType=0 stays
 *                           unbonded in preview since the auto-arc
 *                           geometry isn't useful for it.
 *        Plain            → user click polyline verbatim.
 *
 *  Returns silently when:
 *    - state.draft is null.
 *    - draft.pts.length === 0 (no clicks placed yet).
 *
 *  Ported 1:1 from monolith `_weRender` draft preview (L12634-L12824).
 */
export function _weDrawDraftPreview(
  opts: DraftPreviewOpts,
  state: WorldEditorState,
  canvasSize: { w: number; h: number },
  deps: DraftPreviewDeps,
): void {
  const { ctx, draft } = opts;
  if (!draft || draft.pts.length === 0) return;
  const z = state.view.zoom;
  const cursor = _draftPreviewCursor(state);

  // H698: closed-polygon auto-smooth preview. _weCommitDraft now ALWAYS
  // smooths closed polygons (no Arc toggle required) via
  // smoothClosedPolygon. The preview shows the same smoothed outline
  // while drafting so the user sees what they'll commit. Vertex dots
  // stay on the user's raw click positions.
  // Need at least 3 placed points before smoothing kicks in — until
  // then the outline reads as a straight polyline including cursor.
  const closedArcPreview = (): number[][] | null => {
    if (draft.pts.length < 2) return null;
    const seq: [number, number][] = draft.pts.map((p) => [p[0], p[1]] as [number, number]);
    seq.push([cursor[0], cursor[1]]);
    if (seq.length < 3) return null;
    return _smoothClosedPolygon(seq, 4) as number[][];
  };

  if (draft.kind === 'building') {
    _drawClosedPolygonDraft(
      ctx,
      draft.pts,
      cursor,
      'rgba(255,200,120,0.25)',
      '#ffaa55',
      '#ffaa55',
      state,
      canvasSize,
      closedArcPreview() ?? undefined,
    );
    // Live auto-driveway preview (v8.99.124.28).
    if (draft.autoDriveway && draft.pts.length >= 3 && deps.makeDriveway) {
      const previewPts = draft.pts.concat([[cursor[0], cursor[1]]]);
      const dwPts = deps.makeDriveway(previewPts);
      if (dwPts && dwPts.length >= 3) {
        ctx.fillStyle = 'rgba(120,200,255,0.25)';
        ctx.strokeStyle = '#5cf';
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        const dp0 = _weTileToScreen(dwPts[0][0], dwPts[0][1], state, canvasSize);
        ctx.moveTo(dp0[0], dp0[1]);
        for (let k = 1; k < dwPts.length; k++) {
          const dp = _weTileToScreen(dwPts[k][0], dwPts[k][1], state, canvasSize);
          ctx.lineTo(dp[0], dp[1]);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    return;
  }

  if (draft.kind === 'surface') {
    _drawClosedPolygonDraft(
      ctx,
      draft.pts,
      cursor,
      'rgba(255,255,0,0.18)',
      '#ff0',
      '#ff0',
      state,
      canvasSize,
      closedArcPreview() ?? undefined,
    );
    return;
  }

  if (draft.kind === 'lake') {
    _drawClosedPolygonDraft(
      ctx,
      draft.pts,
      cursor,
      'rgba(58,127,200,0.30)',
      '#3a7fc8',
      '#5fa8e0',
      state,
      canvasSize,
      closedArcPreview() ?? undefined,
    );
    return;
  }

  if (draft.kind === 'parkingLot') {
    // H693 + H695: preview color shifts with the chosen material so the
    // user can see at draft time which surface they're about to commit.
    // Asphalt = neutral gray (close to tile=18 base); concrete = warmer
    // light tan (close to tile=19 base).
    const isConcrete = draft.material === 'concrete';
    _drawClosedPolygonDraft(
      ctx,
      draft.pts,
      cursor,
      isConcrete ? 'rgba(212,205,188,0.30)' : 'rgba(180,180,180,0.28)',
      isConcrete ? '#cabea8' : '#bcbcbc',
      isConcrete ? '#e8e0cc' : '#e6e6e6',
      state,
      canvasSize,
      closedArcPreview() ?? undefined,
    );
    return;
  }

  if (draft.kind === 'river') {
    const w = draft.w || 4;
    ctx.strokeStyle = '#3a7fc8';
    ctx.lineWidth = Math.max(1.5, w * z * 0.9);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    // H698: rivers now ALWAYS smooth at commit via the same midpoint-
    // Bezier smoother roads use for their visual overlay. Preview
    // matches so the user sees what they'll commit; falls back to the
    // raw click polyline until there are 3 placed points (the smoother
    // is a no-op below that anyway).
    const previewPts: [number, number][] = draft.pts
      .map((p) => [p[0], p[1]] as [number, number])
      .concat([[cursor[0], cursor[1]] as [number, number]]);
    const renderPts: number[][] = previewPts.length >= 3
      ? _smoothOpenPolyline(previewPts, 4) as number[][]
      : previewPts as number[][];
    ctx.beginPath();
    const p0 = _weTileToScreen(renderPts[0][0], renderPts[0][1], state, canvasSize);
    ctx.moveTo(p0[0], p0[1]);
    for (let k = 1; k < renderPts.length; k++) {
      const p = _weTileToScreen(renderPts[k][0], renderPts[k][1], state, canvasSize);
      ctx.lineTo(p[0], p[1]);
    }
    ctx.stroke();
    ctx.fillStyle = '#5fa8e0';
    for (const p of draft.pts) {
      const sp = _weTileToScreen(p[0], p[1], state, canvasSize);
      ctx.beginPath();
      ctx.arc(sp[0], sp[1], 3, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }

  // Default — road draft (open polyline). Arc / merge-bond / plain
  // dispatch matches monolith L12768-L12815.
  const w = draft.w || 4;
  ctx.strokeStyle = '#ff0';
  ctx.lineWidth = Math.max(1.5, w * z * 0.9);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const arcOn = !!state.draftProps.arc && (state.draftProps.curve || 0) !== 0;
  const previewPts = draft.pts.concat([[cursor[0], cursor[1]]]);
  const mtPrev = (state.draftProps.mergeType || 0) | 0;
  const shouldBondPrev =
    !!state.draftProps.merge &&
    (mtPrev === 1 || mtPrev === 2 || mtPrev === 3) &&
    previewPts.length >= 2 &&
    !!deps.mergeBondEndpoints;
  let renderPts: number[][];
  if (arcOn && deps.curvePoints) {
    renderPts = deps.curvePoints(previewPts, state.draftProps.curve);
  } else if (shouldBondPrev && deps.mergeBondEndpoints) {
    try {
      renderPts =
        deps.mergeBondEndpoints(
          previewPts,
          w,
          state.draftProps.mergeAlign || 4,
          mtPrev,
          state.draftProps.loopDiameter || 0,
          // H890: no sideOut for preview; pass the draft's elevation so a
          // bridge-deck loop/stop preview bonds to the deck like the
          // commit will. (`z` here is the zoom — use draftProps.z.)
          undefined,
          state.draftProps.z | 0,
        ) || previewPts;
    } catch {
      renderPts = previewPts;
    }
  } else {
    renderPts = previewPts;
  }
  ctx.beginPath();
  const p0 = _weTileToScreen(renderPts[0][0], renderPts[0][1], state, canvasSize);
  ctx.moveTo(p0[0], p0[1]);
  for (let k = 1; k < renderPts.length; k++) {
    const p = _weTileToScreen(renderPts[k][0], renderPts[k][1], state, canvasSize);
    ctx.lineTo(p[0], p[1]);
  }
  ctx.stroke();
  ctx.fillStyle = '#ff0';
  for (const p of draft.pts) {
    const sp = _weTileToScreen(p[0], p[1], state, canvasSize);
    ctx.beginPath();
    ctx.arc(sp[0], sp[1], 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** v8.99.124.x hover-snap indicator + no-snap crosshair pass.
 *
 *  Branches on `state.hoverSnap`:
 *
 *    SNAP HELD — visualize the target with a kind-specific marker:
 *
 *      kind === 'lane' (v126.24, magenta #f0f):
 *        Bright magenta open ring (radius 9, lineWidth 2.5) +
 *        filled center dot (radius 2.5) marking the exact lane
 *        center. When `laneIdx` is set, an 'L<n>' label sits
 *        14 px to the right and 9 px above the ring. The magenta
 *        family makes it visually obvious the click will land
 *        on a specific lane, not the centerline.
 *
 *      kind === 'endpoint' (cyan #0ff):
 *        Open ring (radius 8, lineWidth 2). The cyan family ties
 *        endpoint snaps to the vertex-dot color convention.
 *
 *      kind === anything else (defaults to 'segment', yellow #ff0):
 *        Open ring (radius 8, lineWidth 2). Yellow matches the
 *        general highlight family used for "in-progress" cues.
 *
 *    NO SNAP — when no snap is held AND the user is in a polyline-
 *      placing tool (place / surface / building), draw a small
 *      translucent crosshair at the live hover tile so the user
 *      can see where the next click will land. Other tools
 *      (select / building-after-placement / etc.) skip the
 *      crosshair because the action target is implicit.
 *
 *  Both branches read coords from `state.hoverSnap` or
 *  `state.hoverTile` respectively, project via `_weTileToScreen`,
 *  and paint immediately. No state mutation.
 *
 *  Ported 1:1 from monolith `_weRender` snap pass (L12826-L12869).
 */
export function _weDrawSnapIndicator(
  ctx: CanvasRenderingContext2D,
  state: WorldEditorState,
  canvasSize: { w: number; h: number },
): void {
  const snap = state.hoverSnap as HoverSnapRecord | null;
  if (snap && typeof snap.tx === 'number' && typeof snap.ty === 'number') {
    const sp = _weTileToScreen(snap.tx, snap.ty, state, canvasSize);
    const kind = snap.kind;
    if (kind === 'lane') {
      ctx.strokeStyle = '#f0f';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(sp[0], sp[1], 9, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#f0f';
      ctx.beginPath();
      ctx.arc(sp[0], sp[1], 2.5, 0, Math.PI * 2);
      ctx.fill();
      // H894: direction-of-travel arrow for the picked lane. Transform a
      // 1-tile step along travelDir to screen so it stays correct under any
      // zoom/pan, then draw a short magenta arrow from the ring center.
      const td = snap.travelDir as [number, number] | undefined;
      if (td && (td[0] !== 0 || td[1] !== 0)) {
        const tip = _weTileToScreen(snap.tx + td[0], snap.ty + td[1], state, canvasSize);
        let ax = tip[0] - sp[0];
        let ay = tip[1] - sp[1];
        const al = Math.hypot(ax, ay) || 1;
        ax /= al;
        ay /= al;
        const LEN = 18;
        const ex = sp[0] + ax * LEN;
        const ey = sp[1] + ay * LEN;
        const px = -ay;
        const py = ax;
        const HW = 4;
        const HL = 6;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(sp[0], sp[1]);
        ctx.lineTo(ex, ey);
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - ax * HL + px * HW, ey - ay * HL + py * HW);
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - ax * HL - px * HW, ey - ay * HL - py * HW);
        ctx.stroke();
      }
      if (typeof snap.laneIdx === 'number') {
        const prevAlign = ctx.textAlign;
        ctx.font = 'bold 11px monospace';
        ctx.fillStyle = '#f0f';
        ctx.textAlign = 'center';
        ctx.fillText('L' + snap.laneIdx, sp[0] + 14, sp[1] - 9);
        ctx.textAlign = prevAlign;
      }
    } else if (kind === 'garage') {
      // H1180: garage-door snap — green ring + house glyph so a tap on
      // a residence reads unmistakably as "driveway → this garage".
      ctx.strokeStyle = '#5f5';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(sp[0], sp[1], 9, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#5f5';
      ctx.beginPath();
      ctx.arc(sp[0], sp[1], 2.5, 0, Math.PI * 2);
      ctx.fill();
      const prevAlign = ctx.textAlign;
      ctx.font = 'bold 12px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('⌂', sp[0], sp[1] - 13);
      ctx.textAlign = prevAlign;
    } else if (kind === 'crossing') {
      // H1180: junction snap — yellow diamond at the crossing center.
      ctx.strokeStyle = '#ff0';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(sp[0], sp[1] - 10);
      ctx.lineTo(sp[0] + 10, sp[1]);
      ctx.lineTo(sp[0], sp[1] + 10);
      ctx.lineTo(sp[0] - 10, sp[1]);
      ctx.closePath();
      ctx.stroke();
    } else {
      const isEp = kind === 'endpoint';
      ctx.strokeStyle = isEp ? '#0ff' : '#ff0';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sp[0], sp[1], 8, 0, Math.PI * 2);
      ctx.stroke();
    }
    return;
  }

  // No snap — crosshair only for polyline-placing tools.
  const tool = state.tool;
  if (tool === 'place' || tool === 'surface' || tool === 'building') {
    const sp = _weTileToScreen(
      state.hoverTile.tx,
      state.hoverTile.ty,
      state,
      canvasSize,
    );
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(sp[0] - 6, sp[1]);
    ctx.lineTo(sp[0] + 6, sp[1]);
    ctx.moveTo(sp[0], sp[1] - 6);
    ctx.lineTo(sp[0], sp[1] + 6);
    ctx.stroke();
  }
}

/** Tile-pass dep accessor for the orchestrator. Optional — when
 *  absent, the tile-pass simply doesn't fire. */
export type WorldTileDeps = { getMap(): Uint8Array; MAP_W: number; MAP_H: number };

/** Host bindings the orchestrator needs that aren't on RenderDeps. */
export interface RenderOrchestratorDeps {
  /** Game-render road draw resolver — material/age callback for the
   *  per-section override walk in `_weDrawRoadFull`'s Pass 2. */
  effectiveMaterialAge?: EffectiveMaterialAgeResolver;
  /** Active-vertex resolver — typically bound to select.ts's
   *  `_weGetSelectedItem`. */
  getSelectedItem?(): ActiveVertexSelectedItem | null;
  /** Draft preview helpers — see DraftPreviewDeps. */
  draftPreview?: DraftPreviewDeps;
  /** World tile bitmap deps — needed for the v124.22 tile pass. */
  worldTile?: WorldTileDeps;
  /** H641: status-composer extras. When the host provides these,
   *  `_weRender` calls `_weUpdateStatus` at the end of the pass so
   *  #weStatus + tool-button active classes + Done/Cancel/Delete/
   *  Snap/Smooth visibility + weRoadOnly/weBuildingOnly dimming stay
   *  in sync with the editor state. Without these, the status DOM
   *  stays at its initial placeholder and the visibility gates never
   *  fire (Done shows even with no draft, weBuildingOnly stays
   *  hidden even with the Building tool active, etc.). */
  getBaselineMajorRoads?(): RoadForStatus[];
  defaultMaterial?(road: RoadForStatus): string;
  defaultAge?(road: RoadForStatus): string;
}

/** The editor render orchestrator. Composes the eight render passes
 *  ported in H352-H357 in the canonical per-frame order:
 *
 *    1. BACKGROUND       — grass when tile-pass is active, dark
 *                          editor BG otherwise. Matches monolith
 *                          L12175-L12180.
 *    2. MAJOR GRID       — 100-tile spacing, gated zoom > 0.05.
 *                          Matches monolith L12186-L12200.
 *    3. TILE PASS        — `_weDrawWorldTilePass` (H352) when deps.
 *                          worldTile is supplied AND zoom >= 0.5.
 *    4. ROAD PASS        — for each road in `getMajorRoads()`,
 *                          bbox-cull → branch gameRender on / off
 *                          → `_weDrawRoadFull` (H351) or
 *                          `_weDrawRoadSimplified` (H353).
 *                          v126.46 selection spans overlay AND
 *                          baseline.
 *    5. OVERLAY ROWS     — surfaces / lakes / buildings via
 *                          `_weDrawOverlayPolygonPass` (H354) with
 *                          the kind-specific palettes; rivers via
 *                          `_weDrawRiverPass` (H354).
 *    6. ACTIVE VERTEX    — `_weDrawActiveVertexHighlight` (H355).
 *    7. DRAFT PREVIEW    — `_weDrawDraftPreview` (H356).
 *    8. SNAP INDICATOR   — `_weDrawSnapIndicator` (H357).
 *
 *  Per-frame setup at the top (canvas + ctx + viewport + tile-pass
 *  visibility cache) is hoisted out of the individual passes so each
 *  pass receives consistent values and the orchestrator can reason
 *  about the canvas state in one place.
 *
 *  Ported 1:1 from monolith `_weRender` (L12170-L12869).
 */
export function _weRender(
  state: WorldEditorState,
  deps: RenderDeps & RenderOrchestratorDeps,
): void {
  const canvas = deps.getCanvas();
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const canvasSize = { w: canvas.width, h: canvas.height };
  const z = state.view.zoom;
  const tilesVisible = _weTilesVisibleAtZoom(z);

  // 1. BACKGROUND.
  ctx.fillStyle = tilesVisible ? '#1a2818' : '#0a0a14';
  ctx.fillRect(0, 0, canvasSize.w, canvasSize.h);

  // 2. MAJOR GRID — 100-tile spacing.
  const viewport = _weComputeTileViewport(state, canvasSize);
  if (z > 0.05) {
    ctx.strokeStyle = '#1a1a28';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const g = 100;
    for (let gx = Math.ceil(viewport.tx0 / g) * g; gx <= viewport.tx1; gx += g) {
      const sx = canvasSize.w / 2 + (gx - state.view.cx) * z;
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, canvasSize.h);
    }
    for (let gy = Math.ceil(viewport.ty0 / g) * g; gy <= viewport.ty1; gy += g) {
      const sy = canvasSize.h / 2 + (gy - state.view.cy) * z;
      ctx.moveTo(0, sy);
      ctx.lineTo(canvasSize.w, sy);
    }
    ctx.stroke();
  }

  // 3. TILE PASS — runs only when the world tile bitmap is supplied.
  if (deps.worldTile) {
    _weDrawWorldTilePass(ctx, state, canvasSize, viewport, deps.worldTile);
  }

  // 4. ROAD PASS.
  // H782: iterate sorted by z ascending so elevated roads (z>=2 bridges)
  // paint OVER ground roads. Without this an overlay road added after a
  // bridge in array order would cover the bridge's deck at the crossing —
  // the user's "merges and bridge" screenshot showed exactly this: roads
  // visible THROUGH the bridge instead of being hidden under it. Selection
  // logic below still uses the original index `i`, so this only changes
  // paint order, not identity.
  const majorRoads = deps.getMajorRoads();
  const baseLen = deps.getBaselineLength();
  const roadOrder: number[] = new Array(majorRoads.length);
  for (let i = 0; i < majorRoads.length; i++) roadOrder[i] = i;
  roadOrder.sort((a, b) => {
    const za = (majorRoads[a] as { z?: number }).z || 0;
    const zb = (majorRoads[b] as { z?: number }).z || 0;
    if (za !== zb) return za - zb;
    return a - b; // stable: preserve original order within a z-band
  });
  // H789: same-z junction boxes — editor parity with the game's H788
  // pass. For each pair of visible same-z non-merge roads whose
  // polylines cross mid-segment, the LATER-painted road overpaints a
  // plain-asphalt box over the intersection after its markings, so
  // the editor preview shows the same bare-pavement junction the game
  // renders (paint order already buries the earlier road's markings
  // under the later road's asphalt). Computed per redraw over the
  // viewport-culled set with per-pair bbox early-outs; full-detail
  // mode only (the simplified zoom-out render has no markings to
  // blend).
  const _jbBoxes = new Map<number, Array<{
    x: number; y: number; tx: number; ty: number;
    alongHalf: number; acrossHalf: number;
  }>>();
  // H790: rounded end-caps for FREE road termini (editor parity with
  // the game pass) — endpoints not connected to any other same-z road
  // get an asphalt half-disc + wrapping fog-line arc instead of the
  // butt stroke's hard square edge.
  const _ecCaps = new Map<number, Array<{
    x: number; y: number; ang: number; halfW: number;
  }>>();
  if (state.gameRender && z >= 0.4) {
    interface JbVis {
      i: number;
      pts: ReadonlyArray<readonly number[]>;
      zr: number;
      halfW: number;
      minX: number; minY: number; maxX: number; maxY: number;
    }
    const vis: JbVis[] = [];
    for (const i of roadOrder) {
      const r = majorRoads[i];
      if (!r.pts || r.pts.length < 2) continue;
      if ((r as { merge?: unknown }).merge) continue;
      // H989: no at-grade junction boxes on divided highways — a
      // highway×highway crossing is an interchange (Phase B ramps), not
      // a bare-pavement box (user's "strange squares").
      if ((r.w as number) >= 8) continue;
      let mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
      for (const p of r.pts) {
        if (p[0] < mnX) mnX = p[0];
        if (p[1] < mnY) mnY = p[1];
        if (p[0] > mxX) mxX = p[0];
        if (p[1] > mxY) mxY = p[1];
      }
      if (mxX < viewport.tx0 || mnX > viewport.tx1 || mxY < viewport.ty0 || mnY > viewport.ty1) continue;
      const p = deps.getRoadProfile(r as { pts: number[][]; w: number });
      const halfW = (((p as { asphaltW?: number } | null)?.asphaltW ?? p?.totalW) || (r.w as number) || 2) * 0.5;
      vis.push({ i, pts: r.pts, zr: (r.z as number) || 0, halfW, minX: mnX, minY: mnY, maxX: mxX, maxY: mxY });
    }
    const JB_GUARD2 = 2.5 * 2.5;
    for (let bI = 1; bI < vis.length; bI++) {
      const B = vis[bI];
      for (let aI = 0; aI < bI; aI++) {
        const A = vis[aI];
        if (A.zr !== B.zr) continue;
        if (A.maxX < B.minX || A.minX > B.maxX || A.maxY < B.minY || A.minY > B.maxY) continue;
        for (let sb = 0; sb < B.pts.length - 1; sb++) {
          for (let sa = 0; sa < A.pts.length - 1; sa++) {
            const x1 = B.pts[sb][0], y1 = B.pts[sb][1];
            const x2 = B.pts[sb + 1][0], y2 = B.pts[sb + 1][1];
            const x3 = A.pts[sa][0], y3 = A.pts[sa][1];
            const x4 = A.pts[sa + 1][0], y4 = A.pts[sa + 1][1];
            const d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
            if (Math.abs(d) < 1e-9) continue;
            const t = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d;
            const u = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d;
            if (t <= 0.01 || t >= 0.99 || u <= 0.01 || u >= 0.99) continue;
            const hx = x1 + t * (x2 - x1);
            const hy = y1 + t * (y2 - y1);
            // Endpoint guard — tees/tapers keep their own treatments.
            const nearEnd = (pp: ReadonlyArray<readonly number[]>): boolean => {
              const s = pp[0];
              const e = pp[pp.length - 1];
              return ((hx - s[0]) * (hx - s[0]) + (hy - s[1]) * (hy - s[1])) < JB_GUARD2
                  || ((hx - e[0]) * (hx - e[0]) + (hy - e[1]) * (hy - e[1])) < JB_GUARD2;
            };
            if (nearEnd(B.pts) || nearEnd(A.pts)) continue;
            let tx = x4 - x3;
            let ty = y4 - y3;
            const tl = Math.hypot(tx, ty) || 1;
            tx /= tl; ty /= tl;
            const list = _jbBoxes.get(B.i) ?? [];
            let dup = false;
            for (const bx of list) {
              if (Math.abs(bx.x - hx) < 2 && Math.abs(bx.y - hy) < 2) { dup = true; break; }
            }
            if (dup) continue;
            list.push({ x: hx, y: hy, tx, ty, alongHalf: B.halfW, acrossHalf: A.halfW });
            _jbBoxes.set(B.i, list);
          }
        }
      }
    }
    // H790: free-terminus detection for visible roads. Connection test
    // scans ALL roads (not just visible) so a peer just outside the
    // viewport doesn't make a connected end flicker into a cap.
    const _halfWAll: number[] = majorRoads.map((r) => {
      const p = deps.getRoadProfile(r as { pts: number[][]; w: number });
      return (((p as { asphaltW?: number } | null)?.asphaltW ?? p?.totalW) || (r.w as number) || 2) * 0.5;
    });
    const ECAP_SLACK = 0.75;
    for (const v of vis) {
      const selfRoad = majorRoads[v.i];
      const ends: Array<{ px: number; py: number; qx: number; qy: number }> = [
        { px: v.pts[0][0], py: v.pts[0][1], qx: v.pts[1][0], qy: v.pts[1][1] },
        {
          px: v.pts[v.pts.length - 1][0], py: v.pts[v.pts.length - 1][1],
          qx: v.pts[v.pts.length - 2][0], qy: v.pts[v.pts.length - 2][1],
        },
      ];
      const caps: Array<{ x: number; y: number; ang: number; halfW: number }> = [];
      for (const en of ends) {
        let connected = false;
        for (let ri = 0; ri < majorRoads.length && !connected; ri++) {
          const r = majorRoads[ri];
          if (r === selfRoad) continue;
          if (((r.z as number) || 0) !== v.zr) continue;
          const rp = r.pts;
          if (!rp || rp.length < 2) continue;
          const rr = _halfWAll[ri] + ECAP_SLACK;
          const rr2 = rr * rr;
          for (let s = 0; s < rp.length - 1; s++) {
            const ax = rp[s][0], ay = rp[s][1];
            const bx = rp[s + 1][0], by = rp[s + 1][1];
            const dx = bx - ax, dy = by - ay;
            const lenSq = dx * dx + dy * dy;
            if (lenSq < 0.0001) continue;
            let t = ((en.px - ax) * dx + (en.py - ay) * dy) / lenSq;
            if (t < 0) t = 0; else if (t > 1) t = 1;
            const qx = ax + dx * t, qy = ay + dy * t;
            if ((en.px - qx) * (en.px - qx) + (en.py - qy) * (en.py - qy) <= rr2) {
              connected = true;
              break;
            }
          }
        }
        if (!connected) {
          caps.push({
            x: en.px, y: en.py,
            ang: Math.atan2(en.py - en.qy, en.px - en.qx),
            halfW: v.halfW,
          });
        }
      }
      if (caps.length > 0) _ecCaps.set(v.i, caps);
    }
  }

  // H993: endpoint-to-endpoint weld seam planes — same computation the
  // game render bakes into RENDER_ENTRIES, recomputed here per frame
  // (cheap: endpoint-pairs only) so the editor's game-parity view shows
  // the same transverse butt joints. Merge rows excluded (bonder tips).
  const _weldPlanes = computeEndWelds(majorRoads.map((mr) => ({
    pts: (mr.pts ?? []) as number[][],
    z: ((mr.z as number) || 0),
    skip: (mr as { mergeAlign?: number }).mergeAlign !== undefined,
  })));

  for (const i of roadOrder) {
    const r = majorRoads[i];
    if (!r.pts || r.pts.length < 2) continue;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of r.pts) {
      if (p[0] < minX) minX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] > maxY) maxY = p[1];
    }
    if (maxX < viewport.tx0 || minX > viewport.tx1 || maxY < viewport.ty0 || minY > viewport.ty1) {
      continue;
    }
    const isOverlay = i >= baseLen;
    const isSelectedOverlay =
      isOverlay && i - baseLen === state.selected && state.selectedKind === 'road';
    const isSelectedBaseline =
      !isOverlay && i === state.selectedBaselineRoad && state.selectedKind === 'baselineRoad';
    const isSelected = isSelectedOverlay || isSelectedBaseline;
    // H993: clip this road's paint to its side of each weld seam plane
    // (screen coords — the editor draws through _weTileToScreen). Both
    // welded roads clip complementarily → one straight transverse joint.
    const _rw = _weldPlanes[i];
    let _weldClipped = false;
    if (_rw) {
      ctx.save();
      _weldClipped = true;
      const _ext = (canvasSize.w + canvasSize.h) * 4;
      applyWeldClips(ctx, _rw.map((p) => {
        const [sx, sy] = _weTileToScreen(p.x, p.y, state, canvasSize);
        return { x: sx, y: sy, nx: p.nx, ny: p.ny };
      }), _ext);
    }
    if (state.gameRender && z >= 0.4) {
      _weDrawRoadFull(
        {
          ctx,
          road: r as DrawRoadFullOpts['road'],
          isOverlay,
          isSelected,
          effectiveMaterialAge: deps.effectiveMaterialAge,
        },
        state,
        canvasSize,
        deps,
      );
      // H789: junction-box erase — overpaint this road's own markings
      // inside each crossing box (peer-tangent-aligned quad, padded
      // 15%/10% like the game's H788 pass) with the same flat asphalt
      // color _drawRoadAsphaltPass used, leaving bare pavement.
      const _boxes = _jbBoxes.get(i);
      if (_boxes) {
        ctx.fillStyle = _getAsphaltBaseColor(r as Record<string, unknown>);
        for (const bx of _boxes) {
          const al = bx.alongHalf * 1.15;
          const ac = bx.acrossHalf * 1.1;
          const c1 = _weTileToScreen(bx.x + bx.tx * al - bx.ty * ac, bx.y + bx.ty * al + bx.tx * ac, state, canvasSize);
          const c2 = _weTileToScreen(bx.x - bx.tx * al - bx.ty * ac, bx.y - bx.ty * al + bx.tx * ac, state, canvasSize);
          const c3 = _weTileToScreen(bx.x - bx.tx * al + bx.ty * ac, bx.y - bx.ty * al - bx.tx * ac, state, canvasSize);
          const c4 = _weTileToScreen(bx.x + bx.tx * al + bx.ty * ac, bx.y + bx.ty * al - bx.tx * ac, state, canvasSize);
          ctx.beginPath();
          ctx.moveTo(c1[0], c1[1]);
          ctx.lineTo(c2[0], c2[1]);
          ctx.lineTo(c3[0], c3[1]);
          ctx.lineTo(c4[0], c4[1]);
          ctx.closePath();
          ctx.fill();
        }
      }
      // H953: H790 rounded end-caps DISABLED — road termini render FLAT at the
      // user's repeated request. Single-material roads already butt-cap in the
      // asphalt pass, so the half-disc + fog-arc that used to paint here were
      // the only thing rounding the ends. The _ecCaps detection above is left
      // dormant (result unused); restore from git (H790, commit c1db560) to
      // bring the rounded ends back. Multi-material slow-path section joins
      // keep their own 'round' cap (that one is load-bearing, untouched).
      void _ecCaps;
    } else {
      _weDrawRoadSimplified(
        {
          ctx,
          road: r as DrawRoadFullOpts['road'],
          isOverlay,
          isSelected,
          tilesVisible,
        },
        state,
        canvasSize,
      );
    }
    if (_weldClipped) ctx.restore();
  }

  // 4b. H1181: AUTO-TAPER flares — editor parity with the game's H283/
  // H284 lane-count transition (a narrow road joining a wider one at a
  // vertex flares out over ~5 tiles). The editor never drew these, so
  // a 2-lane → 4-lane connection showed a hard width step here while
  // the game rendered a taper — the user read that as "the transition
  // feature was lost". Zero duplicated math: we read the SAME
  // autoTaperStart/End metadata computeRoadCrossings' sibling pass
  // bakes onto the live RENDER_ENTRIES at every rebuild. (During a
  // mid-drag edit the flare lags until the next rebuild — same
  // staleness contract as the ROAD_CROSSINGS rings.)
  if (state.gameRender && z >= 0.4) {
    const white = 'rgba(255,255,255,0.78)';
    for (const e of RENDER_ENTRIES as ReadonlyArray<{
      row: ReadonlyArray<unknown>;
      material?: string; age?: string;
      autoTaperStart?: {
        outer: ReadonlyArray<readonly [number, number]>;
        inner: ReadonlyArray<readonly [number, number]>;
        outerStripe: ReadonlyArray<readonly [number, number]>;
        innerStripe: ReadonlyArray<readonly [number, number]>;
      };
      autoTaperEnd?: {
        outer: ReadonlyArray<readonly [number, number]>;
        inner: ReadonlyArray<readonly [number, number]>;
        outerStripe: ReadonlyArray<readonly [number, number]>;
        innerStripe: ReadonlyArray<readonly [number, number]>;
      };
    }>) {
      const metas = [e.autoTaperStart, e.autoTaperEnd];
      if (!metas[0] && !metas[1]) continue;
      const fill = _getAsphaltBaseColor({
        material: e.material, age: e.age, name: String(e.row[2] ?? ''),
      } as Record<string, unknown>);
      for (const meta of metas) {
        if (!meta) continue;
        const { outer, inner, outerStripe, innerStripe } = meta;
        if (outer.length < 2 || inner.length !== outer.length) continue;
        // Viewport cull on the flare's first vertex (flares are ≤ ~6t).
        const o0 = outer[0];
        if (o0[0] < viewport.tx0 - 8 || o0[0] > viewport.tx1 + 8
          || o0[1] < viewport.ty0 - 8 || o0[1] > viewport.ty1 + 8) continue;
        ctx.fillStyle = fill;
        ctx.beginPath();
        let sp = _weTileToScreen(outer[0][0], outer[0][1], state, canvasSize);
        ctx.moveTo(sp[0], sp[1]);
        for (let k = 1; k < outer.length; k++) {
          sp = _weTileToScreen(outer[k][0], outer[k][1], state, canvasSize);
          ctx.lineTo(sp[0], sp[1]);
        }
        for (let k = inner.length - 1; k >= 0; k--) {
          sp = _weTileToScreen(inner[k][0], inner[k][1], state, canvasSize);
          ctx.lineTo(sp[0], sp[1]);
        }
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = white;
        ctx.lineWidth = Math.max(1, z * 0.08);
        ctx.lineCap = 'square';
        for (const stripe of [outerStripe, innerStripe]) {
          if (!stripe || stripe.length < 2) continue;
          ctx.beginPath();
          sp = _weTileToScreen(stripe[0][0], stripe[0][1], state, canvasSize);
          ctx.moveTo(sp[0], sp[1]);
          for (let k = 1; k < stripe.length; k++) {
            sp = _weTileToScreen(stripe[k][0], stripe[k][1], state, canvasSize);
            ctx.lineTo(sp[0], sp[1]);
          }
          ctx.stroke();
        }
        ctx.lineCap = 'butt';
      }
    }
  }

  // 5. OVERLAY ROWS — surfaces, rivers, lakes, buildings.
  _weDrawOverlayPolygonPass(
    {
      ctx,
      rows: state.surfaces,
      xStart: 2,
      minLen: 8,
      selectedIdx: state.selectedKind === 'surface' ? state.selectedSurface : -1,
      palette: SURFACE_POLYGON_PALETTE,
      viewport,
      structKind: 'surface', // H1004: driveways render as opaque concrete
    },
    state,
    canvasSize,
  );
  _weDrawRiverPass(
    {
      ctx,
      rivers: state.rivers,
      selectedIdx: state.selectedKind === 'river' ? state.selectedRiver : -1,
      tilesVisible,
      viewport,
    },
    state,
    canvasSize,
  );
  _weDrawOverlayPolygonPass(
    {
      ctx,
      rows: state.lakes,
      xStart: 1,
      minLen: 8,
      selectedIdx: state.selectedKind === 'lake' ? state.selectedLake : -1,
      palette: LAKE_POLYGON_PALETTE,
      viewport,
    },
    state,
    canvasSize,
  );
  // H699: parking-lot overlay polygons use a per-row xStart since the
  // schema bumped from H695 (xStart=2) to H699 (xStart=5). Storage
  // migrates to H699 on load so most rows seen here are H699 — but
  // the existing _weDrawOverlayPolygonPass only takes a fixed xStart,
  // so we use a per-row pre-pass that parses meta and re-routes to
  // an inline mini-pass. Same palette + cull as the shared pass.
  _weDrawParkingLotPolygonsPass(ctx, state, canvasSize, viewport);
  // H697: procedural stall layout overlay, drawn AFTER the polygon
  // outline above. Stalls are recomputed from the longest-edge angle
  // each frame — cheap, no schema bloat, polygon edits auto-recompute.
  _weDrawParkingLotStallsPass(ctx, state.parkingLots, state, canvasSize, viewport);
  // H1038: authored intersection markers (control ring + glyph).
  _weDrawIntersectionsPass(ctx, state, canvasSize, viewport);
  _weDrawOverlayPolygonPass(
    {
      ctx,
      rows: state.buildings,
      xStart: 2,
      minLen: 8,
      selectedIdx: state.selectedKind === 'building' ? state.selectedBuilding : -1,
      palette: BUILDING_POLYGON_PALETTE,
      viewport,
      structKind: 'building', // H1004: per-type roof render (shingle/flat)
    },
    state,
    canvasSize,
  );

  // 6. ACTIVE VERTEX RING.
  if (deps.getSelectedItem) {
    _weDrawActiveVertexHighlight(
      {
        ctx,
        getSelectedItem: deps.getSelectedItem,
        getMajorRoads: deps.getMajorRoads,
      },
      state,
      canvasSize,
    );
  }

  // 6.5. SPAN HIGHLIGHT (H991) — armed cut points + stretch, top-most
  // so it reads over both the simplified and game-render road passes.
  _weDrawSpanHighlight(ctx, state, canvasSize);

  // 7. DRAFT PREVIEW.
  if (state.draft && state.draft.pts.length > 0) {
    _weDrawDraftPreview(
      {
        ctx,
        draft: {
          kind: state.draft.kind,
          pts: state.draft.pts,
          w: (state.draft as { w?: number }).w,
          autoDriveway: (state.draft as { autoDriveway?: boolean }).autoDriveway,
          merge: (state.draft as { merge?: boolean }).merge,
          mergeAlign: (state.draft as { mergeAlign?: number }).mergeAlign,
          mergeType: (state.draft as { mergeType?: number }).mergeType,
          loopDiameter: (state.draft as { loopDiameter?: number }).loopDiameter,
        },
      },
      state,
      canvasSize,
      deps.draftPreview ?? {},
    );
  }

  // 8. SNAP INDICATOR.
  _weDrawSnapIndicator(ctx, state, canvasSize);

  // 9. STATUS LINE + DOM SYNC (H641). When the host provides the
  // status-composer extras, paint #weStatus and reapply the toggle/
  // visibility/dimming passes so tool button active classes, action
  // button visibility, and weRoadOnly/weBuildingOnly visibility track
  // the editor state every frame. Without this, the status placeholder
  // never updates and Done/Cancel/Delete/Snap/Smooth + the per-tool
  // property rows behave as if frozen at editor-mount time.
  if (
    deps.effectiveMaterialAge
    && deps.getBaselineMajorRoads
    && deps.defaultMaterial
    && deps.defaultAge
  ) {
    _weUpdateStatus(state, {
      ...deps,
      effectiveMaterialAge: deps.effectiveMaterialAge,
      getBaselineMajorRoads: deps.getBaselineMajorRoads,
      defaultMaterial: deps.defaultMaterial,
      defaultAge: deps.defaultAge,
    });
  }
}

/** Convert a road's width to its standard lane-count tag. v8.99.124.24
 *  used these thresholds throughout the editor's status display so the
 *  user can match the in-game getRoadProfile output without having to
 *  remember the width-to-lane mapping. Returns one of '8L' / '6L' /
 *  '4L' / '2L'. Mirrors the inline `w>=12` / `w>=8` / `w>=6` / else
 *  ladder at monolith L12896-L12899 / L12917-L12920 / L12943-L12946. */
function laneTagForWidth(w: number): string {
  if (w >= 12) return '8L';
  if (w >= 8) return '6L';
  if (w >= 6) return '4L';
  return '2L';
}

/** Minimal HoverSnap shape the status composer reads. The full snap
 *  carries more (`tx`, `ty`, `kind`, `laneIdx`); the status composer
 *  only needs `roadIdx` for the "snap to ..." annotation when drafting
 *  a road. Defined here rather than on WorldEditorState so the editor's
 *  state remains structurally typed against unknown — only consumers
 *  that read snap fields commit to the shape. */
interface HoverSnapForStatus {
  roadIdx?: number;
  /** H894: derived lane direction-of-travel + one-way flag, for the
   *  heading-word annotation on the snap-target hint. */
  travelDir?: [number, number];
  oneway?: boolean;
}

/** H894: compass heading word for a tile-space (y-down) travel vector.
 *  Convention: +y = SOUTH, -y = NORTH, +x = EAST, -x = WEST (map north up). */
function _weHeadingWord(td: [number, number]): string {
  if (Math.abs(td[0]) >= Math.abs(td[1])) return td[0] >= 0 ? 'EASTBOUND' : 'WESTBOUND';
  return td[1] >= 0 ? 'SOUTHBOUND' : 'NORTHBOUND';
}

/** Light road shape the status composer needs for the snap-target /
 *  selection annotations. A subset of the structural type used
 *  throughout the editor render path. */
interface RoadForStatus {
  pts: number[][];
  w: number;
  maj: number;
  name: string;
  z: number;
  material?: string;
  age?: string;
  materialOverrides?: Array<{ seg: number; material?: string; age?: string }>;
  [k: string]: unknown;
}

/** Effective per-section material/age tuple. Returned by the host's
 *  effectiveMaterialAge lookup (mirrors monolith L15370-L15385
 *  `_weEffectiveMaterialAge`). */
export interface EffectiveMaterialAge {
  material: string;
  age: string;
}

/** Host bindings the status composer needs beyond RenderDeps. The
 *  material / age resolvers are factored out as deps because they live
 *  in the editor's delete module (`_weEffectiveMaterialAge`) and the
 *  game's road-textures module (`_roadMaterial` / `_roadAge`); having
 *  the composer reach across modules directly would couple render.ts
 *  to either. */
export interface StatusDeps {
  /** Live majorRoads (overlay + baseline). Status composer reads it
   *  to resolve `hoverSnap.roadIdx` to the snap target's row data. */
  getMajorRoads(): RoadForStatus[];
  /** Baseline length so overlay-road status (`state.selected` is an
   *  overlay index) can resolve `majorRoads[baseLen + state.selected]`
   *  for material/age display. */
  getBaselineLength(): number;
  /** Live baseline majorRoads array. Indexed by
   *  `state.selectedBaselineRoad`. */
  getBaselineMajorRoads(): RoadForStatus[];
  /** Effective material/age at a given segment, honoring per-section
   *  overrides. Mirrors monolith _weEffectiveMaterialAge. */
  effectiveMaterialAge(road: RoadForStatus, segIdx: number): EffectiveMaterialAge;
  /** Per-road default material (no segIdx). Mirrors monolith
   *  _roadMaterial L2758. */
  defaultMaterial(road: RoadForStatus): string;
  /** Per-road default age. Mirrors monolith _roadAge L2738. */
  defaultAge(road: RoadForStatus): string;
}

/** Compose the bracketed status-string content for `#weStatus` — the
 *  "mode" portion that comes BEFORE the tile / zoom / counts suffix.
 *
 *  Reads (in this dispatch order) the first matching state condition:
 *
 *    DRAFT in flight             → "DRAWING <kind> (N pts)"
 *                                  + optional "snap to '<name>' [<tags>]"
 *                                  for road drafts with a hover-snap target
 *                                  (v8.99.124.24 hint preventing the
 *                                  "I drew a road and it looked different
 *                                  from the one I connected to" confusion).
 *
 *    Overlay road selected       → "ROAD #N  <lanes> | MAJOR/minor [| 🌉 BRIDGE]  '<name>'"
 *                                  (v8.99.124.24 — surface major/minor/bridge
 *                                  at a glance; the "lines don't connect"
 *                                  complaints were really property-mismatches).
 *
 *    Baseline road selected      → "PERM ROAD #N[✎]  <tags>  '<name>' (props locked)"
 *                                  (v8.99.126.46/.47 — baselines are vertex-
 *                                  editable and fully deletable but their
 *                                  width/major/bridge are immutable; the ✎
 *                                  marker fires when an entry exists in
 *                                  baselineEdits).
 *
 *    Surface / building / lake   → simple "<KIND> #N".
 *    River selected              → "RIVER #N  w=W  '<name>'".
 *    Nothing selected            → tool.toUpperCase().
 *
 *  Then conditionally appends (in this order):
 *
 *    activeVertex >= 0           → "✏ vertex N (tap to move)" (v8.99.124.34 —
 *                                  the bright orange dot is the only other
 *                                  cue that vertex-edit mode is engaged).
 *
 *    selectMode === 'section'    → "▬ section vN-vN+1  [<material>·<age>]"
 *                                  (v8.99.126.47 + .50 — section indicator
 *                                  with the resolved effective material/age
 *                                  via deps.effectiveMaterialAge).
 *
 *    Otherwise road selected     → "[<material>·<age>]" (v8.99.126.50 —
 *                                  same display in Whole / Point mode
 *                                  via deps.defaultMaterial / defaultAge).
 *
 *    Select tool active          → "· <SUBMODE>" (v8.99.126.47 — the
 *                                  Whole/Section/Point indicator).
 *
 *  Returns the composed string. The full `_weUpdateStatus` wraps this
 *  with the bracketing + tile / zoom / counts suffix + DOM button
 *  toggles; those follow in later hops.
 *
 *  Ported 1:1 from the modeStr-composition portion of monolith
 *  `_weUpdateStatus` (L12880-L13029). */
export function _weComposeStatusModeString(
  state: WorldEditorState,
  deps: StatusDeps,
): string {
  let modeStr: string;

  if (state.draft) {
    const dk = state.draft.kind;
    let k = 'ROAD';
    if (dk === 'surface') k = 'SURFACE';
    else if (dk === 'building') k = 'BUILDING';
    else if (dk === 'river') k = 'RIVER';
    else if (dk === 'lake') k = 'LAKE';
    else if (dk === 'parkingLot') k = 'PARKING LOT'; // H693
    const draftPts = (state.draft as { pts?: unknown[] }).pts ?? [];
    modeStr = 'DRAWING ' + k + ' (' + draftPts.length + ' pts)';
    // v8.99.124.24 snap-target hint.
    if (dk === 'road' && state.hoverSnap) {
      const snap = state.hoverSnap as HoverSnapForStatus;
      if (typeof snap.roadIdx === 'number' && snap.roadIdx >= 0) {
        const tgt = deps.getMajorRoads()[snap.roadIdx];
        if (tgt) {
          const ttags = [laneTagForWidth(tgt.w), tgt.maj ? 'MAJOR' : 'minor'];
          if ((tgt.z || 0) >= 2) ttags.push('🌉');
          // H894: heading word for the picked lane's direction of travel.
          if (snap.oneway) ttags.push('ONE-WAY ➡');
          else if (snap.travelDir) ttags.push(_weHeadingWord(snap.travelDir));
          modeStr += '  → snap to "' + (tgt.name || '(unnamed)') + '" [' + ttags.join(' ') + ']';
        }
      }
    }
  } else if (state.selectedKind === 'road' && state.selected >= 0) {
    // Overlay road status — read row fields directly per monolith
    // L12914 (`r[0]` = w, `r[1]` = maj, `r[2]` = name, `r[3]` = z).
    const r = state.overlay[state.selected] as
      | [number, number, string, number, ...unknown[]]
      | undefined;
    if (r) {
      const w = r[0];
      const maj = r[1];
      const rname = r[2];
      const rz = r[3];
      const tags = [laneTagForWidth(w), maj ? 'MAJOR' : 'minor'];
      if ((rz || 0) >= 2) tags.push('🌉 BRIDGE');
      modeStr = 'ROAD #' + state.selected + '  ' + tags.join(' | ') + '  "' + rname + '"';
    } else {
      modeStr = 'ROAD #' + state.selected;
    }
  } else if (state.selectedKind === 'baselineRoad' && state.selectedBaselineRoad >= 0) {
    // v8.99.126.46/.47 baseline road status.
    const r = deps.getMajorRoads()[state.selectedBaselineRoad];
    if (r) {
      const tags = [laneTagForWidth(r.w), r.maj ? 'MAJOR' : 'minor'];
      if ((r.z || 0) >= 2) tags.push('🌉 BRIDGE');
      const editedFlag = state.baselineEdits[state.selectedBaselineRoad] ? ' ✎' : '';
      modeStr =
        'PERM ROAD #' +
        state.selectedBaselineRoad +
        editedFlag +
        '  ' +
        tags.join(' | ') +
        '  "' +
        (r.name || '(unnamed)') +
        '" (props locked)';
    } else {
      modeStr = 'PERM ROAD #' + state.selectedBaselineRoad;
    }
  } else if (state.selectedKind === 'surface' && state.selectedSurface >= 0) {
    modeStr = 'SURFACE #' + state.selectedSurface;
  } else if (state.selectedKind === 'building' && state.selectedBuilding >= 0) {
    modeStr = 'BUILDING #' + state.selectedBuilding;
  } else if (state.selectedKind === 'river' && state.selectedRiver >= 0) {
    const rv = state.rivers[state.selectedRiver] as
      | [number, string, ...unknown[]]
      | undefined;
    if (rv) {
      const rvW = rv[0] || 4;
      const rvName = rv[1] || 'River';
      modeStr = 'RIVER #' + state.selectedRiver + '  w=' + rvW + '  "' + rvName + '"';
    } else {
      modeStr = 'RIVER #' + state.selectedRiver;
    }
  } else if (state.selectedKind === 'lake' && state.selectedLake >= 0) {
    const lk = state.lakes[state.selectedLake] as [string, ...unknown[]] | undefined;
    if (lk) {
      const lkName = lk[0] || 'Lake';
      modeStr = 'LAKE #' + state.selectedLake + '  "' + lkName + '"';
    } else {
      modeStr = 'LAKE #' + state.selectedLake;
    }
  } else if (state.selectedKind === 'parkingLot' && state.selectedParkingLot >= 0) {
    // H693 + H695: parking-lot selection status with material suffix.
    // Material lives at row[1] in the H695 schema (even row length),
    // absent in legacy H693 rows (odd length) where it defaults to
    // asphalt.
    const pl = state.parkingLots[state.selectedParkingLot] as unknown[] | undefined;
    if (pl) {
      const plName = (pl[0] as string) || 'Parking Lot';
      const mat: 'asphalt' | 'concrete' =
        (pl.length & 1) === 0 && pl[1] === 'concrete' ? 'concrete' : 'asphalt';
      modeStr = 'PARKING LOT #' + state.selectedParkingLot + '  [' + mat + ']  "' + plName + '"';
    } else {
      modeStr = 'PARKING LOT #' + state.selectedParkingLot;
    }
  } else {
    modeStr = state.tool.toUpperCase();
  }

  // v8.99.124.34 active-vertex indicator.
  if (state.activeVertex >= 0) {
    modeStr += '  ✏ vertex ' + state.activeVertex + ' (tap to move)';
  }

  // Resolve the selected road for the v126.47/.50 material+age suffix.
  // Used by both the section-mode and whole-/point-mode branches below.
  const resolveSelectedRoad = (): RoadForStatus | null => {
    if (state.selectedKind === 'road' && state.selected >= 0) {
      const baseLen = deps.getBaselineLength();
      return deps.getMajorRoads()[baseLen + state.selected] ?? null;
    }
    if (state.selectedKind === 'baselineRoad' && state.selectedBaselineRoad >= 0) {
      return deps.getBaselineMajorRoads()[state.selectedBaselineRoad] ?? null;
    }
    return null;
  };

  // v8.99.126.47 + .50 section indicator with effective material/age.
  if (state.selectMode === 'section' && state.selectedSegmentIdx >= 0) {
    const si = state.selectedSegmentIdx;
    modeStr += '  ▬ section v' + si + '-v' + (si + 1);
    const statRoad = resolveSelectedRoad();
    if (statRoad) {
      const eff = deps.effectiveMaterialAge(statRoad, si);
      modeStr += ' [' + eff.material + '·' + eff.age + ']';
    }
  } else if (
    (state.selectedKind === 'road' && state.selected >= 0) ||
    (state.selectedKind === 'baselineRoad' && state.selectedBaselineRoad >= 0)
  ) {
    // v8.99.126.50 road-level material+age suffix (Whole / Point mode).
    const statRoad = resolveSelectedRoad();
    if (statRoad) {
      const mat = deps.defaultMaterial(statRoad);
      const age = deps.defaultAge(statRoad);
      modeStr += '  [' + mat + '·' + age + ']';
    }
  }

  // H991: span-mode guidance / armed-span readout.
  if (
    state.selectMode === 'span' &&
    ((state.selectedKind === 'road' && state.selected >= 0) ||
     (state.selectedKind === 'baselineRoad' && state.selectedBaselineRoad >= 0))
  ) {
    if (!state.spanA) {
      modeStr += '  ⧉ SPAN: tap 1st cut point on the road';
    } else if (!state.spanB) {
      modeStr += '  ⧉ SPAN: tap 2nd cut point on the SAME road';
    } else {
      const a = state.spanA, b = state.spanB;
      modeStr +=
        '  ⧉ SPAN v' + (a.seg + a.t).toFixed(2) + '→v' + (b.seg + b.t).toFixed(2) +
        ' — Delete / Material / Bridge / Z / ✂ Split apply to it';
    }
  }

  // v8.99.126.47 select-tool sub-mode indicator.
  if (state.tool === 'select') {
    modeStr += '  · ' + (state.selectMode || 'whole').toUpperCase();
  }

  return modeStr;
}

/** Toggle the editor's tool buttons + visibility-gated controls + the
 *  property-field opacity dimming to match the current editor state.
 *  Strictly DOM mutation — no return value, no state mutation.
 *
 *  THREE PASSES:
 *
 *    1. TOOL BUTTONS — set the `active` class on the toolbar button
 *       matching `state.tool`. The other five buttons get the class
 *       removed.
 *
 *    2. ACTION-BUTTON VISIBILITY — Done / Cancel / Delete / Snap /
 *       Smooth show/hide based on draft + selection state:
 *
 *         Done / Cancel  → visible while a draft is in flight.
 *
 *         Delete         → visible when any selectable kind is picked
 *                          (overlay road, baseline road, surface,
 *                          building, river, lake). v126.47 added
 *                          baseline; the new _weDeleteSelected handles
 *                          baseline deletes via baselineDeletes /
 *                          baselineEdits / segment promotion.
 *
 *         Snap           → visible when a polyline is selected (road
 *                          or river) OR a draft has ≥ 1 placed point
 *                          (v124.31 extended to drafts so the user
 *                          gets a "fix this click" override and an
 *                          easy way to close polygons by snapping
 *                          the last vertex to the first; v124.29
 *                          hide-when-inapplicable so users don't see
 *                          a silent no-op).
 *
 *         Smooth         → visible only when a polygon is selected
 *                          (surface, building, lake). Polygons benefit
 *                          from edge smoothing; roads/rivers use the
 *                          Arc-on-draw pipeline instead (v124.34).
 *
 *    3. ANGLE CONTROLS (v126.41) — visible only when a road is
 *       SELECTED (not during drafting, not for surface/building/lake/
 *       river selections). Side-effect: clear angleRefMode +
 *       angleRefDirection when the road selection drops so picking
 *       ref is a per-selection action. Ref button styling toggles
 *       between idle ("📐 Ref") and pick-active ("📐 Tap ref…").
 *       Angle input disabled until a reference is set.
 *
 *    4. CONTEXT-ROW + PROPERTY-FIELD DIMMING (v126.42 + v124.23+):
 *         .weRoadOnly      — Road tool active OR road selected OR
 *                            road draft (visible).
 *         .weBuildingOnly  — Building tool / selected / draft (visible).
 *
 *       Then property-field opacity:
 *         laneGroup        → dim for surface/lake/building tool
 *                            (only road and river use lanes — v124.23
 *                            replaced wePropW with the lane button
 *                            group, river kept reusing it).
 *         majEl / brEl / mgEl → dim for surface/lake/river/building
 *                              tool (only roads have Major / Bridge /
 *                              Merge flags). v126.00 added Merge to
 *                              the same gating.
 *         arcEl / curveEl  → only for road and river drafts (open
 *                            polylines benefit from arc / curve).
 *                            v124.30 extended Arc/Curve to rivers.
 *
 *  Modifying state inside a "DOM pass" looks suspicious but matches
 *  the monolith verbatim at L13099-L13101 — the angleRef* clear is
 *  a derived-state reset that genuinely belongs with the UI sync
 *  (the user expects the next ref-pick to start fresh when they
 *  change selection). Keeping it here preserves the 1:1 contract.
 *
 *  Ported 1:1 from monolith _weUpdateStatus L13036-L13156 (the
 *  post-text-set DOM pass).
 */
function _weApplyStatusDomToggles(state: WorldEditorState): void {
  if (typeof document === 'undefined') return;

  // 1. Tool buttons.
  const bp = document.getElementById('weBtnPlace');
  const bsf = document.getElementById('weBtnSurface');
  const bbl = document.getElementById('weBtnBuilding');
  const bs = document.getElementById('weBtnSelect');
  const briv = document.getElementById('weBtnRiver');
  const blak = document.getElementById('weBtnLake');
  // H693: parking-lot tool button.
  const bpl = document.getElementById('weBtnParkingLot');
  // H1038: intersection tool button.
  const bisect = document.getElementById('weBtnIntersection');
  if (bisect) bisect.classList.toggle('active', state.tool === 'intersection');
  if (bp) bp.classList.toggle('active', state.tool === 'place');
  if (bsf) bsf.classList.toggle('active', state.tool === 'surface');
  if (bbl) bbl.classList.toggle('active', state.tool === 'building');
  if (bs) bs.classList.toggle('active', state.tool === 'select');
  if (briv) briv.classList.toggle('active', state.tool === 'river');
  if (blak) blak.classList.toggle('active', state.tool === 'lake');
  if (bpl) bpl.classList.toggle('active', state.tool === 'parkingLot');

  // 2. Action-button visibility.
  const bd = document.getElementById('weBtnDone');
  const bc = document.getElementById('weBtnCancel');
  const bdel = document.getElementById('weBtnDelete');
  const bsnap = document.getElementById('weBtnSnapEnds');
  const bsmooth = document.getElementById('weBtnSmooth');
  const drafting = !!state.draft;
  const hasSel =
    (state.selectedKind === 'road' && state.selected >= 0) ||
    (state.selectedKind === 'baselineRoad' && state.selectedBaselineRoad >= 0) ||
    (state.selectedKind === 'surface' && state.selectedSurface >= 0) ||
    (state.selectedKind === 'building' && state.selectedBuilding >= 0) ||
    (state.selectedKind === 'river' && state.selectedRiver >= 0) ||
    (state.selectedKind === 'lake' && state.selectedLake >= 0) ||
    (state.selectedKind === 'parkingLot' && state.selectedParkingLot >= 0) ||
    (state.selectedKind === 'intersection' && state.selectedIntersection >= 0);
  const draftPts = drafting
    ? ((state.draft as { pts?: unknown[] }).pts ?? [])
    : [];
  const hasSnappable =
    (state.selectedKind === 'road' && state.selected >= 0) ||
    (state.selectedKind === 'river' && state.selectedRiver >= 0) ||
    (drafting && draftPts.length >= 1);
  const isPolygonSel =
    (state.selectedKind === 'surface' && state.selectedSurface >= 0) ||
    (state.selectedKind === 'building' && state.selectedBuilding >= 0) ||
    (state.selectedKind === 'lake' && state.selectedLake >= 0) ||
    (state.selectedKind === 'parkingLot' && state.selectedParkingLot >= 0);
  if (bd) bd.style.display = drafting ? '' : 'none';
  if (bc) bc.style.display = drafting ? '' : 'none';
  if (bdel) bdel.style.display = hasSel ? '' : 'none';
  if (bsnap) bsnap.style.display = hasSnappable ? '' : 'none';
  if (bsmooth) bsmooth.style.display = isPolygonSel ? '' : 'none';
  // H991: ✂ Split shows only with a COMPLETE span armed on a road.
  const bspl = document.getElementById('weBtnSpanSplit');
  if (bspl) {
    const spanArmed =
      state.selectMode === 'span' && !!state.spanA && !!state.spanB &&
      ((state.selectedKind === 'road' && state.selected >= 0) ||
       (state.selectedKind === 'baselineRoad' && state.selectedBaselineRoad >= 0));
    bspl.style.display = spanArmed ? '' : 'none';
  }

  // 3. Angle controls.
  const angleLabel = document.getElementById('weAngleLabel');
  const angleRefBtn = document.getElementById('weBtnAngleRef');
  const angleInput = document.getElementById('wePropAngle') as HTMLInputElement | null;
  const isRoadSel = state.selectedKind === 'road' && state.selected >= 0;
  if (angleLabel) angleLabel.style.display = isRoadSel ? '' : 'none';
  // v126.41: clear angle-ref state when the road selection drops so
  // the next selection starts fresh.
  if (!isRoadSel) {
    state.angleRefMode = false;
    state.angleRefDirection = null;
  }
  if (angleRefBtn) {
    if (state.angleRefMode) {
      angleRefBtn.classList.add('weMergeTypeActive');
      angleRefBtn.textContent = '📐 Tap ref…';
    } else {
      angleRefBtn.classList.remove('weMergeTypeActive');
      angleRefBtn.textContent = '📐 Ref';
    }
  }
  if (angleInput) angleInput.disabled = !state.angleRefDirection;

  // 4. Context-row + property-field dimming.
  const isRoadCtx =
    state.tool === 'place' ||
    (state.selectedKind === 'road' && state.selected >= 0) ||
    (!!state.draft && state.draft.kind === 'road');
  const isBuildingCtx =
    state.tool === 'building' ||
    (state.selectedKind === 'building' && state.selectedBuilding >= 0) ||
    (!!state.draft && state.draft.kind === 'building');
  document.querySelectorAll<HTMLElement>('.weRoadOnly').forEach((el) => {
    el.style.display = isRoadCtx ? '' : 'none';
  });
  document.querySelectorAll<HTMLElement>('.weBuildingOnly').forEach((el) => {
    el.style.display = isBuildingCtx ? '' : 'none';
  });
  // H695: Material row is visible whenever a road OR a parking lot is
  // the active context (tool, selected, or in-flight draft). Parking-lot
  // material picks asphalt (tile=18) vs concrete (tile=19); roads pick
  // their existing surface material.
  const isParkingLotCtxForMat =
    state.tool === 'parkingLot' ||
    (state.selectedKind === 'parkingLot' && state.selectedParkingLot >= 0) ||
    (!!state.draft && state.draft.kind === 'parkingLot');
  const isMaterialCtx = isRoadCtx || isParkingLotCtxForMat;
  document.querySelectorAll<HTMLElement>('.weMaterialCtx').forEach((el) => {
    el.style.display = isMaterialCtx ? '' : 'none';
  });
  // H699: parking-lot dimension row is visible only in parkingLot
  // context. Initial-value sync mirrors the Material active-state sync
  // below — pulls from selected row when one is picked, else
  // parkingLotProps.
  document.querySelectorAll<HTMLElement>('.weParkingLotCtx').forEach((el) => {
    el.style.display = isParkingLotCtxForMat ? '' : 'none';
  });
  // H1039: intersection control row — visible in intersection context (tool
  // active or a marker selected). Highlights the active control button from
  // intersectionProps so the next placed marker previews the picked control.
  const isIntersectionCtx =
    state.tool === 'intersection' ||
    (state.selectedKind === 'intersection' && state.selectedIntersection >= 0);
  document.querySelectorAll<HTMLElement>('.weIntersectionCtx').forEach((el) => {
    el.style.display = isIntersectionCtx ? '' : 'none';
  });
  if (isIntersectionCtx) {
    // Show the SELECTED marker's control when one is picked, else the props
    // default for the next placed marker.
    let ctrl = state.intersectionProps.control;
    if (state.selectedKind === 'intersection' && state.selectedIntersection >= 0) {
      const parsed = parseIntersectionRow(state.intersections[state.selectedIntersection]);
      if (parsed) ctrl = parsed.control;
    }
    document.querySelectorAll<HTMLElement>('.weIsectCtrlBtn').forEach((b) => {
      b.classList.toggle('weIsectCtrlActive', (parseInt(b.dataset.control || '0') || 0) === ctrl);
    });
  }
  if (isParkingLotCtxForMat) {
    let stallW = state.parkingLotProps.stallW;
    let stallL = state.parkingLotProps.stallL;
    let aisleW = state.parkingLotProps.aisleW;
    if (state.selectedKind === 'parkingLot' && state.selectedParkingLot >= 0) {
      const row = state.parkingLots[state.selectedParkingLot] as unknown[] | undefined;
      // H699 row has stallW/stallL/aisleW at indices 2/3/4 (odd length,
      // row[1] string).
      if (row && (row.length & 1) === 1 && typeof row[1] === 'string') {
        if (typeof row[2] === 'number') stallW = row[2];
        if (typeof row[3] === 'number') stallL = row[3];
        if (typeof row[4] === 'number') aisleW = row[4];
      }
    } else if (state.draft && state.draft.kind === 'parkingLot') {
      if (typeof state.draft.stallW === 'number') stallW = state.draft.stallW;
      if (typeof state.draft.stallL === 'number') stallL = state.draft.stallL;
      if (typeof state.draft.aisleW === 'number') aisleW = state.draft.aisleW;
    }
    const stallWEl = document.getElementById('wePropStallW') as HTMLInputElement | null;
    const stallLEl = document.getElementById('wePropStallL') as HTMLInputElement | null;
    const aisleWEl = document.getElementById('wePropAisleW') as HTMLInputElement | null;
    // H703: ADA input syncs from editor-wide parkingLotProps.adaCount —
    // it's not per-row yet, so selection/draft don't override it.
    const adaEl = document.getElementById('wePropAdaCount') as HTMLInputElement | null;
    // Only write the field if the user isn't currently focused on it —
    // otherwise typing gets interrupted by the live sync.
    if (stallWEl && document.activeElement !== stallWEl) stallWEl.value = String(stallW);
    if (stallLEl && document.activeElement !== stallLEl) stallLEl.value = String(stallL);
    if (aisleWEl && document.activeElement !== aisleWEl) aisleWEl.value = String(aisleW);
    if (adaEl && document.activeElement !== adaEl) adaEl.value = String(state.parkingLotProps.adaCount);
  }
  // H695: sync the Material button active state in parking-lot context.
  // Priority: selected lot's material > in-flight draft's material >
  // parkingLotProps.material. In road context, the existing click /
  // road-category handlers own this sync, so we only touch it for
  // parking lots to avoid stomping on the road-side logic.
  if (isParkingLotCtxForMat) {
    let activeMat: 'asphalt' | 'concrete' = state.parkingLotProps.material;
    if (state.selectedKind === 'parkingLot' && state.selectedParkingLot >= 0) {
      const row = state.parkingLots[state.selectedParkingLot] as unknown[] | undefined;
      if (row && (row.length & 1) === 0 && row[1] === 'concrete') activeMat = 'concrete';
      else if (row && (row.length & 1) === 0 && row[1] === 'asphalt') activeMat = 'asphalt';
    } else if (state.draft && state.draft.kind === 'parkingLot' && state.draft.material) {
      activeMat = state.draft.material;
    }
    document.querySelectorAll<HTMLElement>('.weMaterialBtn').forEach((b) => {
      b.classList.toggle('weMaterialActive', b.dataset.material === activeMat);
    });
  }

  const laneGroup = document.querySelector<HTMLElement>('.weLanesGroup');
  const majEl = document.getElementById('wePropMaj') as HTMLInputElement | null;
  const brEl = document.getElementById('wePropBridge') as HTMLInputElement | null;
  const mgEl = document.getElementById('wePropMerge') as HTMLInputElement | null;
  const owEl = document.getElementById('wePropOneway') as HTMLInputElement | null;
  const arcEl = document.getElementById('wePropArc') as HTMLInputElement | null;
  const curveEl = document.getElementById('wePropCurve') as HTMLInputElement | null;
  const isSurfaceTool =
    state.tool === 'surface' || (!!state.draft && state.draft.kind === 'surface');
  const isLakeTool =
    state.tool === 'lake' || (!!state.draft && state.draft.kind === 'lake');
  const isRiverTool =
    state.tool === 'river' || (!!state.draft && state.draft.kind === 'river');
  // H693: parking-lot tool also dims road-only controls.
  const isParkingLotTool =
    state.tool === 'parkingLot' || (!!state.draft && state.draft.kind === 'parkingLot');

  const lanesDim = isSurfaceTool || isLakeTool || isParkingLotTool || state.tool === 'building';
  if (laneGroup) laneGroup.style.opacity = lanesDim ? '0.4' : '1';

  const roadOnlyDim =
    isSurfaceTool || isLakeTool || isRiverTool || isParkingLotTool || state.tool === 'building';
  if (majEl?.parentElement) majEl.parentElement.style.opacity = roadOnlyDim ? '0.4' : '1';
  if (brEl?.parentElement) brEl.parentElement.style.opacity = roadOnlyDim ? '0.4' : '1';
  if (mgEl?.parentElement) mgEl.parentElement.style.opacity = roadOnlyDim ? '0.4' : '1';
  // H886: dim + sync the One-Way checkbox. Reflect the selected road's
  // one-way flag (sidecar-stored, not in the numeric row); fall back to
  // draftProps when nothing is selected so the next-drawn-road intent
  // shows. Skip the sync while the box has focus to avoid fighting a
  // mid-click toggle.
  if (owEl?.parentElement) owEl.parentElement.style.opacity = roadOnlyDim ? '0.4' : '1';
  if (owEl && document.activeElement !== owEl) {
    let owChecked = !!state.draftProps.oneway;
    if (state.selectedKind === 'road' && state.selected >= 0) {
      owChecked = !!(state.overlayRoadProps?.[String(state.selected)]?.oneway);
    } else if (state.selectedKind === 'baselineRoad' && state.selectedBaselineRoad >= 0) {
      owChecked = !!(state.baselineRoadProps?.[String(state.selectedBaselineRoad)]?.oneway);
    }
    owEl.checked = owChecked;
  }

  // H698: closed polygons + rivers auto-smooth at commit (no Arc toggle
  // needed). Arc/Curve only matters for ROADS now — that's the one path
  // where the user wants explicit control over bow direction and depth
  // for AI/traffic alignment. Reverts the H696 extension that brightened
  // these controls for non-road tools.
  const arcApplies =
    state.tool === 'place' ||
    (!!state.draft && state.draft.kind === 'road');
  if (arcEl?.parentElement) arcEl.parentElement.style.opacity = arcApplies ? '1' : '0.4';
  if (curveEl?.parentElement) curveEl.parentElement.style.opacity = arcApplies ? '1' : '0.4';
}

/** Update the #weStatus DOM with hover tile, zoom, tool, draft state,
 *  and (when drafting a road) the hover-target's properties so the
 *  user can match Major/lane/Bridge before placing (v8.99.124.24).
 *
 *  Three responsibilities:
 *    1. Compose the mode string via `_weComposeStatusModeString` and
 *       concatenate the tile / zoom / overlay counts suffix.
 *    2. Write the result to `#weStatus.textContent`.
 *    3. Run `_weApplyStatusDomToggles` to sync tool buttons + visibility
 *       gates + property-field dimming.
 *
 *  Early-return when `#weStatus` is missing — matches monolith
 *  L12872-L12873 (the editor DOM may not be mounted yet during the
 *  brief F9-toggle window).
 *
 *  Ported 1:1 from monolith `_weUpdateStatus` (L12871-L13157).
 */
export function _weUpdateStatus(
  state: WorldEditorState,
  deps: RenderDeps & StatusDeps,
): void {
  const el = deps.getStatusEl();
  if (!el) return;
  const hoverSnap = state.hoverSnap as { tx?: number; ty?: number } | null;
  const t = hoverSnap ?? state.hoverTile;
  const tx = Math.round(t.tx || 0);
  const ty = Math.round(t.ty || 0);
  const z = state.view.zoom.toFixed(2);
  const overlayN = state.overlay.length;
  const surfN = state.surfaces.length;
  const bldN = state.buildings.length;
  const rivN = state.rivers.length;
  const lakN = state.lakes.length;
  const plN = state.parkingLots.length;
  const modeStr = _weComposeStatusModeString(state, deps);
  // H974: transient status flash — actions like ⟳ Rebuild Roads report
  // here because the game HUD's toast never renders while the editor
  // owns the frame (gameLoop short-circuits to _weTick). Expires by
  // wall clock on the next recompose after `until`.
  const flash = (state as { statusFlash?: { msg: string; until: number } | null }).statusFlash;
  const flashStr = flash && Date.now() < flash.until ? '★ ' + flash.msg + '  |  ' : '';
  el.textContent =
    flashStr +
    '[' +
    modeStr +
    ']  tile ' +
    tx +
    ',' +
    ty +
    '  zoom ' +
    z +
    'x  roads: ' +
    overlayN +
    '  surfaces: ' +
    surfN +
    '  buildings: ' +
    bldN +
    '  rivers: ' +
    rivN +
    '  lakes: ' +
    lakN +
    '  lots: ' +
    plN +
    '  build ' +
    __BUILD_ID__;
  _weApplyStatusDomToggles(state);
}
