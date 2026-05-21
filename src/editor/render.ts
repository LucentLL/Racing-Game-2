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
import { BASELINE_ROADS } from '@/config/world/baselineRoads';
import { ROAD_CROSSINGS } from '@/world/roadCrossings';
import { TILE } from '@/config/world/tiles';
import { getEditedBaselinePts } from './input';
import { smoothPolyline } from '@/render/pathSmoothing';
import {
  _computeMergeInnerDir,
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
 *  bodies first. The full game-render parity pass — surfaces,
 *  buildings, rivers, lakes, drafts, snap indicators, tile-pass,
 *  edge stripes, lane dividers — stays scaffolded on _weRender for
 *  follow-up commits. */
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
 *  Unreadable below zoom 0.3 — early-returns there. TODO(E35-followup):
 *  port from L10510-10595. */
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
 *  Algorithm — two passes:
 *    1. Per-segment unit perpendicular = (-dy/L, dx/L). The sign
 *       convention puts positive offset on the right-of-travel side,
 *       so the rendered offset visually lands on the right of the
 *       polyline when offsetTiles > 0.
 *    2. Per-vertex perpendicular: averaged from adjacent segment
 *       perpendiculars (re-normalized to keep |n|=1). Endpoints reuse
 *       the adjacent segment's perpendicular verbatim — there's only
 *       one neighbor to average with. This averaging smooths mitered
 *       corners so the offset stays equidistant through bends.
 *    3. Save+restore ctx.lineWidth / strokeStyle / dash so callers
 *       don't have to bracket the call themselves. Falls back
 *       gracefully when ctx.setLineDash isn't available (older Canvas
 *       implementations — monolith preserved the guard).
 *
 *  Early-returns for < 2 points (no segment to stroke). The avg
 *  length-check (`L > 0.0001`) skips re-normalization on a degenerate
 *  averaged perpendicular (anti-parallel adjacent segments would
 *  cancel to near-zero); the raw averaged vector still gets used
 *  even when not re-normalized, matching the monolith.
 *
 *  Ported 1:1 from monolith L10596-10643. */
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
  const offX = new Array<number>(N);
  const offY = new Array<number>(N);

  // Pass 1: per-segment perpendiculars. perp = (-dy/L, dx/L).
  const segPx = new Array<number>(N - 1);
  const segPy = new Array<number>(N - 1);
  for (let i = 0; i < N - 1; i++) {
    const dx = tilePts[i + 1][0] - tilePts[i][0];
    const dy = tilePts[i + 1][1] - tilePts[i][1];
    const L = Math.hypot(dx, dy) || 1;
    segPx[i] = -dy / L;
    segPy[i] = dx / L;
  }

  // Pass 2: per-vertex perpendicular = average of adjacent segments
  // (re-normalized when the average has non-trivial length).
  for (let i = 0; i < N; i++) {
    let nx: number;
    let ny: number;
    if (i === 0) {
      nx = segPx[0]; ny = segPy[0];
    } else if (i === N - 1) {
      nx = segPx[N - 2]; ny = segPy[N - 2];
    } else {
      nx = (segPx[i - 1] + segPx[i]) * 0.5;
      ny = (segPy[i - 1] + segPy[i]) * 0.5;
      const L = Math.hypot(nx, ny);
      if (L > 0.0001) { nx /= L; ny /= L; }
    }
    offX[i] = tilePts[i][0] + nx * offsetTiles;
    offY[i] = tilePts[i][1] + ny * offsetTiles;
  }

  // Save state so callers don't have to bracket the call.
  const prevW = ctx.lineWidth;
  const prevSS = ctx.strokeStyle;
  const prevDash = ctx.getLineDash ? ctx.getLineDash() : null;
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = color;
  if (ctx.setLineDash) ctx.setLineDash(dashArr || []);

  ctx.beginPath();
  const p0 = _weTileToScreen(offX[0], offY[0], state, canvasSize);
  ctx.moveTo(p0[0], p0[1]);
  for (let i = 1; i < N; i++) {
    const p = _weTileToScreen(offX[i], offY[i], state, canvasSize);
    ctx.lineTo(p[0], p[1]);
  }
  ctx.stroke();

  // Restore — matches monolith's tail.
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
  ctx.fillStyle = getMergeRoadAsphaltColor(road);
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
  prof: { lps: number[]; laneW: number; totalW: number };
  isSelected: boolean;
}

/** Material × age → asphalt base color. Mirrors monolith
 *  _getAsphaltBaseColor (L2777-2782). Material 'concrete' covers
 *  Driveway-named rows; everything else is asphalt. Age falls back
 *  to 'old' when the road's `age` field is missing or set to 'auto'
 *  (the editor's hash-per-road branch lives in roadTextures.ts; for
 *  the merge polygon we only need the four discrete swatches). */
function getMergeRoadAsphaltColor(road: Record<string, unknown>): string {
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

/** Search-radius check used by both _isBonded and _bondedToMajorEnd:
 *  is endpoint within SEARCH_R tiles of any OTHER road's segment?
 *  Returns the closest matching road, or null. */
function findClosestOtherRoadAtEndpoint<R extends InnerDirRoad>(
  ex: number,
  ey: number,
  allRoads: ReadonlyArray<R>,
  selfRoad: R,
  searchR: number,
): R | null {
  const SEARCH_R2 = searchR * searchR;
  let best: R | null = null;
  let bestD2 = SEARCH_R2;
  for (const r of allRoads) {
    if (r === selfRoad) continue;
    if (!r.pts || r.pts.length < 2) continue;
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
      if (d2 < bestD2) {
        bestD2 = d2;
        best = r;
      }
    }
  }
  return best;
}

/** Render a merge road with v126.04+ polygon-based pavement.
 *
 *  Five-pass pipeline (mirrors monolith L11336-11531):
 *
 *    Pass 1 — bridge concrete underlay. When road.z >= 2 the road
 *             rides a bridge deck; stroke the polygon outline in
 *             deck-color (#4a4640) at 1.2-tile width before filling
 *             so the deck reads as a wider band than the asphalt.
 *    Pass 2 — asphalt fill. Color comes from getMergeRoadAsphaltColor
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
  const _isBonded = (endIdx: number): boolean =>
    findClosestOtherRoadAtEndpoint(pts[endIdx][0], pts[endIdx][1], allRoads, road, 3.5) !== null;
  const bondedStart = _isBonded(0);
  const bondedEnd = _isBonded(pts.length - 1);
  const _mAlign = ((road.mergeAlign as number) | 0) || 1;
  const _mType = ((road.mergeType as number) | 0) || 0;
  const innerDirStart =
    _mAlign !== 1 && bondedStart
      ? _computeMergeInnerDir(pts, 0, allRoads, road)
      : null;
  const innerDirEnd =
    _mAlign !== 1 && bondedEnd
      ? _computeMergeInnerDir(pts, pts.length - 1, allRoads, road)
      : null;
  const edges = _weBuildTaperedMergeEdges({
    tilePts: pts,
    prof,
    bondedStart,
    bondedEnd,
    innerDirStart,
    innerDirEnd,
    mergeAlign: _mAlign,
    mergeType: _mType,
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

  // Pass 1 — bridge deck underlay.
  if (isBridge) {
    ctx.lineWidth = Math.max(2, 0.6 * z);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#4a4640';
    ctx.stroke(path);
  }

  // Pass 2 — asphalt fill.
  ctx.fillStyle = getMergeRoadAsphaltColor(road as Record<string, unknown>);
  ctx.fill(path);

  // Pass 3 — OPEN edges (no closePath; long sides only).
  if (z >= 0.4) {
    const outerP = new Path2D();
    let ep = _weTileToScreen(edges.outer[0][0], edges.outer[0][1], state, canvasSize);
    outerP.moveTo(ep[0], ep[1]);
    for (let i = 1; i < N; i++) {
      ep = _weTileToScreen(edges.outer[i][0], edges.outer[i][1], state, canvasSize);
      outerP.lineTo(ep[0], ep[1]);
    }
    const innerP = new Path2D();
    ep = _weTileToScreen(edges.inner[0][0], edges.inner[0][1], state, canvasSize);
    innerP.moveTo(ep[0], ep[1]);
    for (let i = 1; i < N; i++) {
      ep = _weTileToScreen(edges.inner[i][0], edges.inner[i][1], state, canvasSize);
      innerP.lineTo(ep[0], ep[1]);
    }
    ctx.lineWidth = Math.max(1, z * 0.08);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(240,240,240,0.78)';
    const editorAsym = !!(innerDirStart || innerDirEnd);
    const prevDash = ctx.getLineDash ? ctx.getLineDash() : null;
    if (ctx.setLineDash) ctx.setLineDash([]);
    ctx.stroke(outerP);
    if (editorAsym && ctx.setLineDash) {
      const dashLen = Math.max(2, z * 0.6);
      ctx.setLineDash([dashLen, dashLen]);
    }
    ctx.stroke(innerP);
    if (ctx.setLineDash) ctx.setLineDash(prevDash || []);
  }

  // Pass 4 — selection halo.
  if (isSelected) {
    ctx.lineWidth = Math.max(2, z * 0.18);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,234,90,0.55)';
    ctx.stroke(path);
  }
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
  if (bp) bp.classList.toggle('active', state.tool === 'place');
  if (bsf) bsf.classList.toggle('active', state.tool === 'surface');
  if (bbl) bbl.classList.toggle('active', state.tool === 'building');
  if (bs) bs.classList.toggle('active', state.tool === 'select');
  if (briv) briv.classList.toggle('active', state.tool === 'river');
  if (blak) blak.classList.toggle('active', state.tool === 'lake');

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
    (state.selectedKind === 'lake' && state.selectedLake >= 0);
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
    (state.selectedKind === 'lake' && state.selectedLake >= 0);
  if (bd) bd.style.display = drafting ? '' : 'none';
  if (bc) bc.style.display = drafting ? '' : 'none';
  if (bdel) bdel.style.display = hasSel ? '' : 'none';
  if (bsnap) bsnap.style.display = hasSnappable ? '' : 'none';
  if (bsmooth) bsmooth.style.display = isPolygonSel ? '' : 'none';

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

  const laneGroup = document.querySelector<HTMLElement>('.weLanesGroup');
  const majEl = document.getElementById('wePropMaj') as HTMLInputElement | null;
  const brEl = document.getElementById('wePropBridge') as HTMLInputElement | null;
  const mgEl = document.getElementById('wePropMerge') as HTMLInputElement | null;
  const arcEl = document.getElementById('wePropArc') as HTMLInputElement | null;
  const curveEl = document.getElementById('wePropCurve') as HTMLInputElement | null;
  const isSurfaceTool =
    state.tool === 'surface' || (!!state.draft && state.draft.kind === 'surface');
  const isLakeTool =
    state.tool === 'lake' || (!!state.draft && state.draft.kind === 'lake');
  const isRiverTool =
    state.tool === 'river' || (!!state.draft && state.draft.kind === 'river');

  const lanesDim = isSurfaceTool || isLakeTool || state.tool === 'building';
  if (laneGroup) laneGroup.style.opacity = lanesDim ? '0.4' : '1';

  const roadOnlyDim =
    isSurfaceTool || isLakeTool || isRiverTool || state.tool === 'building';
  if (majEl?.parentElement) majEl.parentElement.style.opacity = roadOnlyDim ? '0.4' : '1';
  if (brEl?.parentElement) brEl.parentElement.style.opacity = roadOnlyDim ? '0.4' : '1';
  if (mgEl?.parentElement) mgEl.parentElement.style.opacity = roadOnlyDim ? '0.4' : '1';

  const arcApplies =
    state.tool === 'place' ||
    state.tool === 'river' ||
    (!!state.draft && (state.draft.kind === 'road' || state.draft.kind === 'river'));
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
  const modeStr = _weComposeStatusModeString(state, deps);
  el.textContent =
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
    lakN;
  _weApplyStatusDomToggles(state);
}
