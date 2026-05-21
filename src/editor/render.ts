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

/** Returns the editor canvas. Tiny wrapper but keeps the document
 *  lookup centralized. TODO(E35-followup): port from L10471. */
export function _weCanvas(_deps: RenderDeps): HTMLCanvasElement | null {
  // TODO: L10471. return document.getElementById('weCanvas').
  return null;
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
