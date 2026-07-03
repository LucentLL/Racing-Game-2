/**
 * World Editor — canvas pointer input (mouse + wheel + touch).
 *
 * The editor canvas owns its own input loop, separate from the game's
 * touch surface. PC handlers (`_weCanvasMouseDown/Move/Up/Wheel/ContextMenu`)
 * and mobile handlers (`_weTouchStart/Move/End`) are wired by
 * editor/ui.ts. The touch-end handler synthesizes a fake mouse-down
 * event and re-invokes _weCanvasMouseDown so the place/draft logic
 * lives in exactly one path — PC pointer flow IS the canonical pointer
 * flow.
 *
 * MOUSE BUTTON SEMANTICS:
 *
 *   button 0 (left)   — place / select / vertex-grab (depends on tool)
 *   button 1 (middle) — pan (drag-to-scroll)
 *   button 2 (right)  — commit active draft (right-click finalizes,
 *                       matching the standard CAD/GIS convention)
 *
 * ANGLE-REF PICK MODE (v8.99.126.41): when angleRefMode is on, the
 * first canvas tap consumes the click, detects the nearest road's
 * signed direction at that point, stores it as the reference vector,
 * resets the mode, and populates the wePropAngle input with the
 * SELECTED road's CURRENT angle relative to this reference (snapped to
 * 5°). This way, picking a reference doesn't visually rotate the
 * selected road on its own — the user can adjust the input afterward
 * to rotate.
 *
 * TOOL-AWARE SNAP DISPATCH: snap only applies to road and river
 * placement (where polylines may need to connect end-to-end). Surfaces,
 * lakes, and buildings just place at the raw click position.
 *
 *  - tool === 'place'  → _weFindSnap (roads)
 *  - tool === 'river'  → _weFindRiverSnap (rivers only)  [v8.99.124.28]
 *
 * RIVER-SNAP IS SEPARATE FROM ROAD-SNAP so river polylines naturally
 * connect to each other while staying logically distinct from the
 * road network. River drafts use the SNAPPED (px,py) when pushing
 * points so consecutive river polylines connect cleanly.
 *
 * HOVER-TILE MOBILE FIX (v8.99.124.26): on mobile, mousemove never
 * fires (touchstart preventDefault suppresses synthetic mouse events)
 * so hoverTile stays at its initial {tx:0, ty:0} default forever. The
 * draft preview renderer uses hoverTile as the live cursor anchor —
 * for surface/building drafts the preview polygon balloons into a
 * giant triangle reaching world (0,0). MouseDown now anchors hoverTile
 * to the just-placed point so all preview-edge cases collapse to zero
 * length (invisible) until the next tap. Harmless on PC where
 * mousemove already keeps it in sync.
 *
 * ZOOM-AROUND-CURSOR (`_weCanvasWheel`, pinch): keeps the tile under
 * the cursor stationary while zooming. Algorithm: read tile under
 * cursor before zoom change → apply zoom → read tile under cursor
 * after → add the delta to view.cx/cy so the difference is zero.
 * Factor 1.18 per wheel notch; zoom clamped to [0.02, 50].
 *
 * TOUCH TAP-VS-PAN DISCRIMINATOR: single-touch tap if total
 * displacement < 10 px AND duration < 600 ms; otherwise pan. Two-touch
 * always triggers pinch (zoom around midpoint) + drag (translate by
 * midpoint motion).
 *
 * Ported from monolith L15850-16378.
 */

import type { WorldEditorState, BondTarget } from './index';
import type { TilePoint } from './stamp';
import { _weParseParkingLotMeta } from './stamp';
import type { SnapResult } from './snap';
import { BASELINE_ROADS } from '@/config/world/baselineRoads';
import { _wePointInPolygon } from './select';
import { _weProjectOntoPts, _weClearSpan, MIN_SPAN_TILES } from './span';

/** H121: return the edited point list for a baseline road, or the
 *  source-defined one when no edit exists. Single source of truth so
 *  selection / hit-test / render all see the same pts. */
function getEditedBaselinePts(state: WorldEditorState, roadIdx: number): TilePoint[] {
  if (roadIdx < 0 || roadIdx >= BASELINE_ROADS.length) return [];
  const editsMap = state.baselineEdits as Record<string, number[][]>;
  const edited = editsMap[String(roadIdx)];
  if (edited && edited.length > 0) {
    return edited.map((p) => [p[0], p[1]] as TilePoint);
  }
  const row = BASELINE_ROADS[roadIdx];
  const ptsFlat = row.slice(4) as readonly number[];
  const pts: TilePoint[] = [];
  for (let i = 0; i + 1 < ptsFlat.length; i += 2) {
    pts.push([ptsFlat[i] as number, ptsFlat[i + 1] as number]);
  }
  return pts;
}

/** H131: projection of point P onto line segment AB, clamped to the
 *  segment. Returns the projection point + the segment parameter t +
 *  the squared distance to it. The insert-vertex path uses the
 *  projection coords as the spliced vertex's position. */
function pointSegProj(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): { cx: number; cy: number; d2: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) {
    const d0x = px - ax;
    const d0y = py - ay;
    return { cx: ax, cy: ay, d2: d0x * d0x + d0y * d0y };
  }
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const d0x = px - cx;
  const d0y = py - cy;
  return { cx, cy, d2: d0x * d0x + d0y * d0y };
}

/** H121: squared distance from point P to line segment AB. Standard
 *  projection-clamp helper used by the road pick. */
function pointSegDist2(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) {
    const d0x = px - ax;
    const d0y = py - ay;
    return d0x * d0x + d0y * d0y;
  }
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const d0x = px - cx;
  const d0y = py - cy;
  return d0x * d0x + d0y * d0y;
}

/** H130: minimum point-to-segment distance² across a baseline road's
 *  edited pts. Used to tie-break between baseline + overlay candidates
 *  during shift-select pick. */
function minDist2ToBaseline(
  state: WorldEditorState,
  roadIdx: number,
  tx: number,
  ty: number,
): number {
  const pts = getEditedBaselinePts(state, roadIdx);
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const d2 = pointSegDist2(tx, ty, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
    if (d2 < best) best = d2;
  }
  return best;
}

/** H130: same for an overlay road. */
function minDist2ToOverlay(
  state: WorldEditorState,
  overlayIdx: number,
  tx: number,
  ty: number,
): number {
  const pts = getOverlayPts(state, overlayIdx);
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const d2 = pointSegDist2(tx, ty, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
    if (d2 < best) best = d2;
  }
  return best;
}

/** H131: find the nearest segment on the currently-selected road
 *  within maxDistTiles. Returns null if no segment is in range OR
 *  no road is selected. Works for both baseline + overlay rows. */
function findNearestSegmentOnSelected(
  state: WorldEditorState,
  tx: number, ty: number,
  maxDistTiles: number,
): { segIdx: number; projTx: number; projTy: number } | null {
  let pts: TilePoint[] = [];
  if (state.selectedKind === 'baselineRoad' && state.selectedBaselineRoad >= 0) {
    pts = getEditedBaselinePts(state, state.selectedBaselineRoad);
  } else if (state.selectedKind === 'road' && state.selected >= 0) {
    pts = getOverlayPts(state, state.selected);
  } else {
    return null;
  }
  let bestSeg = -1;
  let bestD2 = maxDistTiles * maxDistTiles;
  let bestCx = 0, bestCy = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const proj = pointSegProj(tx, ty, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
    if (proj.d2 < bestD2) {
      bestD2 = proj.d2;
      bestSeg = i;
      bestCx = proj.cx;
      bestCy = proj.cy;
    }
  }
  if (bestSeg < 0) return null;
  return { segIdx: bestSeg, projTx: bestCx, projTy: bestCy };
}

/** H132/H134: find a snap target near (tx, ty). Two-pass, mirroring the
 *  monolith _weFindSnap precedence (L12092-12124):
 *    1. ENDPOINT/vertex pass over every non-self road. Any vertex hit
 *       wins outright — endpoints are stickier than midspan.
 *    2. H134 SEGMENT-PROJECTION pass — fallback when no vertex is in
 *       range. Projects (tx, ty) onto every non-self road's segments
 *       and snaps to the perpendicular foot so the user can attach to
 *       a road's midline, not just its joints.
 *  Both passes skip the currently-selected road so dragging a vertex
 *  never snaps to its own siblings. Returns null when nothing is within
 *  maxDistTiles. */
function findSnapTarget(
  state: WorldEditorState,
  tx: number, ty: number,
  maxDistTiles: number,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestD2 = maxDistTiles * maxDistTiles;
  const deletedSet = new Set(state.baselineDeletes);
  const overlay = state.overlay as unknown[];
  // Pass 1 — baseline vertices.
  for (let r = 0; r < BASELINE_ROADS.length; r++) {
    if (deletedSet.has(r)) continue;
    if (state.selectedKind === 'baselineRoad' && state.selectedBaselineRoad === r) continue;
    const pts = getEditedBaselinePts(state, r);
    for (const p of pts) {
      const dx = p[0] - tx;
      const dy = p[1] - ty;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = { x: p[0], y: p[1] };
      }
    }
  }
  // Pass 1 — overlay vertices.
  for (let o = 0; o < overlay.length; o++) {
    if (state.selectedKind === 'road' && state.selected === o) continue;
    const pts = getOverlayPts(state, o);
    for (const p of pts) {
      const dx = p[0] - tx;
      const dy = p[1] - ty;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = { x: p[0], y: p[1] };
      }
    }
  }
  if (best) return best;
  // Pass 2 — segment projections. Only runs when no vertex matched,
  // matching monolith L12105's `if(best.snap) return best.snap;` gate.
  for (let r = 0; r < BASELINE_ROADS.length; r++) {
    if (deletedSet.has(r)) continue;
    if (state.selectedKind === 'baselineRoad' && state.selectedBaselineRoad === r) continue;
    const pts = getEditedBaselinePts(state, r);
    for (let i = 0; i + 1 < pts.length; i++) {
      const proj = pointSegProj(tx, ty, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
      if (proj.d2 < bestD2) {
        bestD2 = proj.d2;
        best = { x: proj.cx, y: proj.cy };
      }
    }
  }
  for (let o = 0; o < overlay.length; o++) {
    if (state.selectedKind === 'road' && state.selected === o) continue;
    const pts = getOverlayPts(state, o);
    for (let i = 0; i + 1 < pts.length; i++) {
      const proj = pointSegProj(tx, ty, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
      if (proj.d2 < bestD2) {
        bestD2 = proj.d2;
        best = { x: proj.cx, y: proj.cy };
      }
    }
  }
  return best;
}

/** H131: splice a new vertex into the selected road at segIdx+1
 *  (between pts[segIdx] and pts[segIdx+1]). Works for both baseline
 *  + overlay. Sets state.activeVertex to the new vertex so it can
 *  be immediately dragged, mirroring the "insert + drag" workflow
 *  CAD tools use. */
function insertVertexOnSelected(
  state: WorldEditorState,
  segIdx: number,
  projTx: number,
  projTy: number,
): void {
  if (state.selectedKind === 'baselineRoad') {
    const roadIdx = state.selectedBaselineRoad;
    if (roadIdx < 0) return;
    const editsMap = state.baselineEdits as Record<string, number[][]>;
    const key = String(roadIdx);
    if (!editsMap[key]) {
      editsMap[key] = getEditedBaselinePts(state, roadIdx).map((p) => [p[0], p[1]]);
    }
    editsMap[key].splice(segIdx + 1, 0, [projTx, projTy]);
    state.activeVertex = segIdx + 1;
  } else if (state.selectedKind === 'road') {
    const overlayIdx = state.selected;
    if (overlayIdx < 0) return;
    const overlay = state.overlay as (string | number)[][];
    const row = overlay[overlayIdx];
    if (!row || row.length < 6) return;
    const xStart = row.length % 2 === 0 ? 4 : 5;
    row.splice(xStart + 2 * (segIdx + 1), 0, projTx, projTy);
    state.activeVertex = segIdx + 1;
  }
  state.needsRedraw = true;
}

/** H121: find the nearest baseline road to a tile-coord click within
 *  maxDistTiles. Returns null when nothing's in range. Scans all
 *  baseline rows; uses edited pts when present. */
function findNearestBaselineRoad(
  state: WorldEditorState,
  tx: number,
  ty: number,
  maxDistTiles: number,
): number {
  let bestRoad = -1;
  // H915: width-aware pick — a road is a candidate anywhere within
  // max(maxDistTiles, w*0.6) of any segment (its surface), and among
  // candidates the nearest centerline wins.
  let bestDist2 = Infinity;
  const deletedSet = new Set(state.baselineDeletes);
  for (let r = 0; r < BASELINE_ROADS.length; r++) {
    if (deletedSet.has(r)) continue;
    const pts = getEditedBaselinePts(state, r);
    const w = (BASELINE_ROADS[r][0] as number) || 4;
    const thr = Math.max(maxDistTiles, w * 0.6);
    const thr2 = thr * thr;
    for (let i = 0; i + 1 < pts.length; i++) {
      const d2 = pointSegDist2(tx, ty, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
      if (d2 < thr2 && d2 < bestDist2) {
        bestDist2 = d2;
        bestRoad = r;
      }
    }
  }
  return bestRoad;
}

/** H121: find the closest vertex on the selected baseline road within
 *  maxDistTiles. Returns -1 when none in range. Read by the vertex-
 *  drag start path. */
function findClosestVertexOnSelected(
  state: WorldEditorState,
  tx: number,
  ty: number,
  maxDistTiles: number,
): number {
  if (state.selectedKind !== 'baselineRoad') return -1;
  const roadIdx = state.selectedBaselineRoad;
  if (roadIdx < 0) return -1;
  const pts = getEditedBaselinePts(state, roadIdx);
  let bestIdx = -1;
  let bestDist2 = maxDistTiles * maxDistTiles;
  for (let i = 0; i < pts.length; i++) {
    const dx = pts[i][0] - tx;
    const dy = pts[i][1] - ty;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestDist2) {
      bestDist2 = d2;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** H121 public re-export so render.ts can reuse the same edited-pts
 *  resolution rather than duplicating the lookup logic. */
export { getEditedBaselinePts };

/** H130: overlay row coord start index. Legacy 4-meta rows have even
 *  length and start at 4; merge 5-meta rows have odd length and start
 *  at 5. */
function overlayXStart(row: readonly (string | number)[]): number {
  return row.length % 2 === 0 ? 4 : 5;
}

/** H130: read an overlay row's pts as TilePoint tuples. Mutating the
 *  returned array does NOT propagate back — callers that need to edit
 *  must mutate state.overlay[idx] directly via the xStart offset. */
export function getOverlayPts(state: WorldEditorState, overlayIdx: number): TilePoint[] {
  const overlay = state.overlay as unknown[];
  if (overlayIdx < 0 || overlayIdx >= overlay.length) return [];
  const row = overlay[overlayIdx] as readonly (string | number)[];
  if (row.length < 6) return [];
  const xStart = overlayXStart(row);
  const pts: TilePoint[] = [];
  for (let i = xStart; i + 1 < row.length; i += 2) {
    pts.push([row[i] as number, row[i + 1] as number]);
  }
  return pts;
}

/** H130: find the nearest overlay road to a tile-coord click within
 *  maxDistTiles. Returns the overlay index or -1. */
function findNearestOverlayRoad(
  state: WorldEditorState,
  tx: number,
  ty: number,
  maxDistTiles: number,
): number {
  const overlay = state.overlay as unknown[];
  let bestIdx = -1;
  // H915: width-aware pick — see findNearestBaselineRoad. Overlay row[0]
  // is the road width for both legacy 4-meta and merge 5-meta rows.
  let bestDist2 = Infinity;
  for (let r = 0; r < overlay.length; r++) {
    const pts = getOverlayPts(state, r);
    const row = overlay[r] as readonly (string | number)[];
    const w = ((row && row[0]) as number) || 4;
    const thr = Math.max(maxDistTiles, w * 0.6);
    const thr2 = thr * thr;
    for (let i = 0; i + 1 < pts.length; i++) {
      const d2 = pointSegDist2(tx, ty, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
      if (d2 < thr2 && d2 < bestDist2) {
        bestDist2 = d2;
        bestIdx = r;
      }
    }
  }
  return bestIdx;
}

/** H130: find the closest vertex on the selected overlay road within
 *  maxDistTiles. Returns -1 when none in range. */
function findClosestVertexOnSelectedOverlay(
  state: WorldEditorState,
  tx: number,
  ty: number,
  maxDistTiles: number,
): number {
  if (state.selectedKind !== 'road') return -1;
  const pts = getOverlayPts(state, state.selected);
  let bestIdx = -1;
  let bestDist2 = maxDistTiles * maxDistTiles;
  for (let i = 0; i < pts.length; i++) {
    const dx = pts[i][0] - tx;
    const dy = pts[i][1] - ty;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestDist2) {
      bestDist2 = d2;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** H122: delete-key handler. Removes either a single vertex of the
 *  selected baseline road (when the cursor is within picking radius
 *  of one) or the whole road (otherwise). Vertex removal that drops
 *  pts below 2 promotes to whole-road delete so a degenerate single-
 *  point row never lands in baselineEdits. No-op when no baseline
 *  road is selected — preserves Delete-on-other-tool-state semantics
 *  for future tool ports. */
export function _weDeleteSelected(state: WorldEditorState): void {
  // H991: span mode routes Delete through the selectMode-aware toolbar
  // path (gameLoop keydown handles the routing); if this legacy handler
  // is reached anyway with a road selected in span mode, refuse rather
  // than nuking the whole road the user was about to span-cut.
  if (state.selectMode === 'span' && state.tool === 'select' &&
      (state.selectedKind === 'road' || state.selectedKind === 'baselineRoad')) {
    return;
  }
  const radius = 6 / state.view.zoom;
  if (state.selectedKind === 'baselineRoad') {
    const roadIdx = state.selectedBaselineRoad;
    if (roadIdx < 0) return;
    const vIdx = findClosestVertexOnSelected(state, state.hoverTile.tx, state.hoverTile.ty, radius);
    const editsMap = state.baselineEdits as Record<string, number[][]>;
    const key = String(roadIdx);
    if (vIdx >= 0) {
      if (!editsMap[key]) {
        editsMap[key] = getEditedBaselinePts(state, roadIdx).map((p) => [p[0], p[1]]);
      }
      editsMap[key].splice(vIdx, 1);
      if (editsMap[key].length < 2) {
        delete editsMap[key];
        if (!state.baselineDeletes.includes(roadIdx)) {
          state.baselineDeletes.push(roadIdx);
        }
        state.selectedKind = null;
        state.selectedBaselineRoad = -1;
      }
      state.activeVertex = -1;
    } else {
      if (!state.baselineDeletes.includes(roadIdx)) {
        state.baselineDeletes.push(roadIdx);
      }
      delete editsMap[key];
      state.selectedKind = null;
      state.selectedBaselineRoad = -1;
      state.activeVertex = -1;
    }
    state.needsRedraw = true;
    return;
  }
  // H130: overlay-road delete. Vertex hit splices coords from the
  // flat row; if pts drop below 2 the whole row gets removed from
  // state.overlay. Whole-road delete also splices the row out.
  if (state.selectedKind === 'road') {
    const overlayIdx = state.selected;
    if (overlayIdx < 0) return;
    const overlay = state.overlay as (string | number)[][];
    const row = overlay[overlayIdx];
    if (!row || row.length < 6) return;
    const vIdx = findClosestVertexOnSelectedOverlay(state, state.hoverTile.tx, state.hoverTile.ty, radius);
    if (vIdx >= 0) {
      const xStart = overlayXStart(row);
      // Splice 2 entries (x + y).
      row.splice(xStart + 2 * vIdx, 2);
      const remainingPts = (row.length - xStart) / 2;
      if (remainingPts < 2) {
        overlay.splice(overlayIdx, 1);
        state.selectedKind = null;
        state.selected = -1;
      }
      state.activeVertex = -1;
    } else {
      overlay.splice(overlayIdx, 1);
      state.selectedKind = null;
      state.selected = -1;
      state.activeVertex = -1;
    }
    state.needsRedraw = true;
    return;
  }
}

/** Host bindings for input handlers. */
export interface InputDeps {
  getCanvas(): HTMLCanvasElement | null;
  /** Screen-pixel → tile coord via the current view. */
  screenToTile(sx: number, sy: number): { tx: number; ty: number };
  /** Snap dispatch — input doesn't know about the snap algorithm. */
  findSnap(tx: number, ty: number): SnapResult | null;
  findRiverSnap(tx: number, ty: number): SnapResult | null;
  /** Begin/commit/cancel — input calls into draft.ts to manage state. */
  beginDraft(kind: 'road' | 'surface' | 'building' | 'river' | 'lake' | 'parkingLot'): void;
  commitDraft(): void;
  /** Angle-ref pick (v8.99.126.41). Returns the reference direction or null. */
  detectAngleRefDirection(tx: number, ty: number): { direction: [number, number] } | null;
  /** Computes the current relative angle for the wePropAngle input. */
  currentRelativeAngleDeg(): number;
  /** DOM lookup for the angle input (so input.ts doesn't directly
   *  manipulate ui.ts state). */
  getAngleInputEl(): HTMLInputElement | null;
  /** H996: place the currently-selected building PRESET as a sized,
   *  road-facing footprint at (tx, ty) — one click, no polygon draft.
   *  Host owns it (needs live road geometry + commit). No-op when no
   *  preset is active. */
  placeBuildingPreset?(tx: number, ty: number): void;
}

/** Pan-in-progress snapshot. Captures the start screen position +
 *  start camera position so the move handler can compute camera deltas
 *  from absolute screen positions (more numerically stable than
 *  accumulating relative deltas). */
export interface PanState {
  sx: number;
  sy: number;
  scx: number;
  scy: number;
}

/** Pinch-in-progress snapshot. */
export interface PinchState {
  d0: number;
  zoom0: number;
  lastMx: number;
  lastMy: number;
}

/** Single-touch tap-or-pan snapshot. */
export interface TouchTapState {
  sx: number;
  sy: number;
  /** Initial screen pos — the moved-threshold is measured against this,
   *  not against the rolling sx/sy. */
  ssx: number;
  ssy: number;
  t0: number;
  moved: boolean;
}

/** Tap-vs-pan thresholds. */
export const TOUCH_TAP_MAX_MOVE_PX = 10;
export const TOUCH_TAP_MAX_DURATION_MS = 600;

/** Wheel-zoom factor per notch. e.deltaY<0 → multiply, >0 → divide. */
export const WHEEL_ZOOM_FACTOR = 1.18;

/** Zoom clamp range. */
export const ZOOM_MIN = 0.02;
export const ZOOM_MAX = 50;

/** Mouse-down handler. H117 implemented the pan/zoom branches; H118
 *  adds the tool dispatch on left-click and the commit on right-
 *  click. Surface / building / river / lake tool branches land with
 *  their respective draft commit paths. */
export function _weCanvasMouseDown(
  e: MouseEvent,
  state: WorldEditorState,
  deps: InputDeps,
): void {
  // H633: target gate. The gameLoop binds mousedown to `window` (so a
  // drag can continue when the cursor drifts off the canvas), but that
  // means clicks on toolbar buttons / prop inputs were also reaching
  // this handler and starting road drafts. Every interactive DOM
  // element in the editor overlay (#weBtn*, #weProp*, etc.) sits above
  // the canvas in stacking order; bail unless the actual target is the
  // canvas itself so buttons/inputs handle their own clicks normally.
  const canvas = deps.getCanvas();
  if (!canvas) return;
  if (e.target !== canvas) return;

  // Middle-click → pan (monolith CAD convention).
  if (e.button === 1) {
    state.pan = {
      sx: e.clientX,
      sy: e.clientY,
      scx: state.view.cx,
      scy: state.view.cy,
    };
    e.preventDefault();
    return;
  }
  // Right-click → commit draft (matches CAD/GIS convention).
  if (e.button === 2) {
    deps.commitDraft();
    e.preventDefault();
    return;
  }
  // Left-click → tool action OR baseline-road edit.
  if (e.button !== 0) return;
  const { sx, sy } = _weClientToCanvas(canvas, e.clientX, e.clientY);
  const { tx, ty } = deps.screenToTile(sx, sy);

  // H314: angle-ref pick mode (v8.99.126.41). When angleRefMode is on,
  // the first canvas tap consumes the click — detect the nearest road's
  // signed direction at that point, store it as the reference vector,
  // reset the mode, and populate the wePropAngle input with the
  // selected road's CURRENT angle relative to this reference (snapped
  // to 5°). Picking a reference doesn't visually rotate the selected
  // road on its own; the user adjusts the input afterward to rotate.
  // Ported 1:1 from monolith L15870-15883.
  if (state.angleRefMode) {
    const ref = deps.detectAngleRefDirection(tx, ty);
    if (ref) {
      state.angleRefDirection = [ref.direction[0], ref.direction[1]];
      state.angleRefMode = false;
      const angleEl = deps.getAngleInputEl();
      if (angleEl) {
        angleEl.value = String(deps.currentRelativeAngleDeg());
        angleEl.disabled = false;
      }
      state.needsRedraw = true;
    }
    return;
  }

  // H121/H130: Shift+click selects the nearest road. Picks the closer
  // of baseline + overlay candidates within an 8/zoom px radius.
  if (e.shiftKey) {
    const radius = 8 / state.view.zoom;
    const baselineIdx = findNearestBaselineRoad(state, tx, ty, radius);
    const overlayIdx = findNearestOverlayRoad(state, tx, ty, radius);
    // Compute the actual distances for tie-break — closer wins.
    let pickKind: 'baselineRoad' | 'road' | null = null;
    let pickIdx = -1;
    if (baselineIdx >= 0 && overlayIdx >= 0) {
      // Both candidates in range — pick whichever has the closer
      // point-to-segment distance to the click.
      const baselineD2 = minDist2ToBaseline(state, baselineIdx, tx, ty);
      const overlayD2 = minDist2ToOverlay(state, overlayIdx, tx, ty);
      pickKind = overlayD2 < baselineD2 ? 'road' : 'baselineRoad';
      pickIdx = overlayD2 < baselineD2 ? overlayIdx : baselineIdx;
    } else if (baselineIdx >= 0) {
      pickKind = 'baselineRoad';
      pickIdx = baselineIdx;
    } else if (overlayIdx >= 0) {
      pickKind = 'road';
      pickIdx = overlayIdx;
    }
    if (pickKind === 'baselineRoad') {
      state.selectedKind = 'baselineRoad';
      state.selectedBaselineRoad = pickIdx;
      state.selected = -1;
    } else if (pickKind === 'road') {
      state.selectedKind = 'road';
      state.selected = pickIdx;
      state.selectedBaselineRoad = -1;
    } else {
      state.selectedKind = null;
      state.selectedBaselineRoad = -1;
      state.selected = -1;
    }
    state.selectedSegmentIdx = -1;
    state.activeVertex = -1;
    state.draft = null;
    _weClearSpan(state); // H991: a re-pick invalidates the armed span
    state.needsRedraw = true;
    return;
  }

  // H991: in SPAN sub-mode every select-tool click is a cut-point pick —
  // the Alt-insert-vertex and vertex-drag branches below would otherwise
  // consume clicks near vertices (a span cut close to a vertex must arm
  // the span, not start a drag). Same early-gate shape as angleRefMode.
  const spanModeActive = state.tool === 'select' && state.selectMode === 'span';

  // H131: Alt+click inserts a new vertex on the selected road's
  // nearest segment, then immediately activates it for drag so the
  // user can pull the new point into place in one motion. Skipped
  // when no road is selected (Alt without selection has no effect).
  if (!spanModeActive && e.altKey && (state.selectedKind === 'baselineRoad' || state.selectedKind === 'road')) {
    const radius = 8 / state.view.zoom;
    const hit = findNearestSegmentOnSelected(state, tx, ty, radius);
    if (hit) {
      insertVertexOnSelected(state, hit.segIdx, hit.projTx, hit.projTy);
      // Seed the edits buffer for baseline so the immediate drag
      // tick has a mutable copy (insertVertexOnSelected already
      // seeded it for baseline; this is defensive).
      return;
    }
  }

  // H121/H130: no-shift click on a selected road's vertex starts a
  // drag. Both baseline + overlay routes set state.activeVertex; the
  // mousemove handler branches on selectedKind to know which row to
  // mutate. Falls through to draft-place when no vertex hit.
  // H991: skipped in span mode — see spanModeActive above.
  if (!spanModeActive && state.selectedKind === 'baselineRoad' && state.selectedBaselineRoad >= 0) {
    const radius = 6 / state.view.zoom;
    const vIdx = findClosestVertexOnSelected(state, tx, ty, radius);
    if (vIdx >= 0) {
      state.activeVertex = vIdx;
      // Seed the edits map for this road from the current pts so the
      // first mousemove tick has something to write into.
      const editsMap = state.baselineEdits as Record<string, number[][]>;
      const key = String(state.selectedBaselineRoad);
      if (!editsMap[key]) {
        editsMap[key] = getEditedBaselinePts(state, state.selectedBaselineRoad).map((p) => [p[0], p[1]]);
      }
      state.needsRedraw = true;
      return;
    }
  }
  if (!spanModeActive && state.selectedKind === 'road' && state.selected >= 0) {
    const radius = 6 / state.view.zoom;
    const vIdx = findClosestVertexOnSelectedOverlay(state, tx, ty, radius);
    if (vIdx >= 0) {
      state.activeVertex = vIdx;
      state.needsRedraw = true;
      return;
    }
  }

  // Tool dispatch — adds vertices to the appropriate draft, or routes
  // to selection in Select mode. 1:1 with monolith L15911-15999.
  //
  // SNAP: only place (roads) and river apply snap on the click position.
  // Surface, lake, and building place at the raw click — vertex
  // precision matters less for closed polygons and hand-placed
  // buildings (the user is positioning a footprint, not chaining
  // endpoints with neighbors).
  let snapTx = tx;
  let snapTy = ty;
  let placeSnap: SnapResult | null = null;
  if (state.tool === 'place') {
    const s = deps.findSnap(tx, ty);
    if (s) { snapTx = s.tx; snapTy = s.ty; placeSnap = s; }
  } else if (state.tool === 'river') {
    const s = deps.findRiverSnap(tx, ty);
    if (s) { snapTx = s.tx; snapTy = s.ty; }
  }
  // v8.99.124.26: anchor hoverTile to the just-placed point so the
  // preview edges collapse to zero length until the next click (matters
  // on mobile where mousemove doesn't fire). For 'place' and 'river',
  // use the snapped coords. Other tools use raw click.
  state.hoverTile = { tx: snapTx, ty: snapTy };

  if (state.tool === 'place') {
    if (!state.draft || state.draft.kind !== 'road') {
      deps.beginDraft('road');
    }
    state.draft!.pts.push([snapTx, snapTy]);
    // H902: for a MERGE draft, capture which lane/side the click landed on
    // (a 'lane' snap), aligned with pts, so the commit bonds to exactly that
    // — instead of re-guessing the side from geometry. Null for free-drawn
    // points (off-road clicks) or non-merge drafts → legacy re-scan fallback.
    const t: BondTarget | null =
      state.draft!.merge && placeSnap && placeSnap.kind === 'lane'
        ? {
            roadIdx: placeSnap.roadIdx,
            segIdx: placeSnap.segIdx,
            side: (placeSnap.side ?? 1) as 1 | -1,
            laneIdx: placeSnap.laneIdx ?? 1,
          }
        : null;
    (state.draft!.ptSnaps ??= []).push(t);
    // H904: reset the lane/side override so the NEXT endpoint starts from the
    // auto nearest-lane pick (the user re-cycles it for that end).
    state.mergeLaneOverride = null;
    state.mergeSideOverride = null;
    state.needsRedraw = true;
    return;
  }
  if (state.tool === 'surface') {
    if (!state.draft || state.draft.kind !== 'surface') {
      deps.beginDraft('surface');
    }
    state.draft!.pts.push([tx, ty]);
    state.needsRedraw = true;
    return;
  }
  if (state.tool === 'building') {
    // H996: a selected preset places a sized road-facing footprint on a
    // SINGLE click (delegated to the host, which has live road geometry).
    // '' / 'custom' falls through to the freeform polygon draft below.
    const _preset = state.buildingProps.preset;
    if (_preset && _preset !== 'custom' && deps.placeBuildingPreset) {
      deps.placeBuildingPreset(tx, ty);
      return;
    }
    if (!state.draft || state.draft.kind !== 'building') {
      deps.beginDraft('building');
    }
    state.draft!.pts.push([tx, ty]);
    state.needsRedraw = true;
    return;
  }
  if (state.tool === 'river') {
    if (!state.draft || state.draft.kind !== 'river') {
      deps.beginDraft('river');
    }
    state.draft!.pts.push([snapTx, snapTy]);
    state.needsRedraw = true;
    return;
  }
  if (state.tool === 'lake') {
    if (!state.draft || state.draft.kind !== 'lake') {
      deps.beginDraft('lake');
    }
    state.draft!.pts.push([tx, ty]);
    state.needsRedraw = true;
    return;
  }
  if (state.tool === 'parkingLot') {
    // H693: parking-lot polygon draw — mirrors the surface branch above.
    // Same un-snapped tile coords (lots are free-form like surfaces, not
    // grid-aligned like roads).
    if (!state.draft || state.draft.kind !== 'parkingLot') {
      deps.beginDraft('parkingLot');
    }
    state.draft!.pts.push([tx, ty]);
    state.needsRedraw = true;
    return;
  }
  if (state.tool === 'select') {
    // H991: SPAN sub-mode — roads only, two-click cut-point state machine.
    //   click 1: pick nearest road (baseline/overlay tie-break), arm spanA
    //   click 2 on the SAME road: arm spanB → span complete
    //   click on a DIFFERENT road (or a 3rd click): restart with spanA there
    //   click on empty ground: clear span + selection
    // Merge rows (odd length) are atomic (H952) — they select whole, no span.
    if (state.selectMode === 'span') {
      const radius = 8 / state.view.zoom;
      const baselineIdx = findNearestBaselineRoad(state, tx, ty, radius);
      const overlayIdx = findNearestOverlayRoad(state, tx, ty, radius);
      let roadKind: 'baselineRoad' | 'road' | null = null;
      let roadIdx = -1;
      if (baselineIdx >= 0 && overlayIdx >= 0) {
        const baselineD2 = minDist2ToBaseline(state, baselineIdx, tx, ty);
        const overlayD2 = minDist2ToOverlay(state, overlayIdx, tx, ty);
        roadKind = overlayD2 < baselineD2 ? 'road' : 'baselineRoad';
        roadIdx = overlayD2 < baselineD2 ? overlayIdx : baselineIdx;
      } else if (baselineIdx >= 0) {
        roadKind = 'baselineRoad';
        roadIdx = baselineIdx;
      } else if (overlayIdx >= 0) {
        roadKind = 'road';
        roadIdx = overlayIdx;
      }
      const sameRoad =
        roadKind !== null &&
        ((roadKind === 'road' && state.selectedKind === 'road' && state.selected === roadIdx) ||
         (roadKind === 'baselineRoad' && state.selectedKind === 'baselineRoad' && state.selectedBaselineRoad === roadIdx));
      // Clear all selection fields, then re-set the road pick (same shape
      // as the generic branch below).
      state.selected = -1;
      state.selectedBaselineRoad = -1;
      state.selectedSurface = -1;
      state.selectedBuilding = -1;
      state.selectedRiver = -1;
      state.selectedLake = -1;
      state.selectedParkingLot = -1;
      state.selectedSegmentIdx = -1;
      state.selectedKind = null;
      state.activeVertex = -1;
      state.draft = null;
      if (roadKind === null) {
        _weClearSpan(state);
        state.needsRedraw = true;
        return;
      }
      if (roadKind === 'road') {
        state.selectedKind = 'road';
        state.selected = roadIdx;
        const row = state.overlay[roadIdx] as unknown[] | undefined;
        if (row && (row.length & 1) === 1) {
          // Merge lane — whole-select only.
          _weClearSpan(state);
          state.statusFlash = { msg: '⧉ merge lane is atomic — span N/A (Whole ops only)', until: Date.now() + 4000 };
          state.needsRedraw = true;
          return;
        }
      } else {
        state.selectedKind = 'baselineRoad';
        state.selectedBaselineRoad = roadIdx;
      }
      const pts = roadKind === 'road'
        ? getOverlayPts(state, roadIdx)
        : getEditedBaselinePts(state, roadIdx);
      const cut = _weProjectOntoPts(pts, tx, ty);
      if (!cut) {
        _weClearSpan(state);
        state.needsRedraw = true;
        return;
      }
      if (sameRoad && state.spanA && !state.spanB) {
        // H992: refuse a too-short span at ARM time — the op would only
        // refuse later (after the user already reached for a button).
        if (Math.hypot(cut.x - state.spanA.x, cut.y - state.spanA.y) < MIN_SPAN_TILES) {
          state.statusFlash = { msg: '⧉ span too short — tap the 2nd point further away', until: Date.now() + 4000 };
        } else {
          state.spanB = cut;
          state.statusFlash = { msg: '⧉ span set — Delete / Material / Bridge / Z / ✂ Split apply to it', until: Date.now() + 5000 };
        }
      } else {
        state.spanA = cut;
        state.spanB = null;
      }
      state.needsRedraw = true;
      return;
    }

    // Plain (no-shift) click in Select mode. Hit-test priority mirrors
    // the monolith's _weCanvasMouseDown Whole branch (L16044-16135):
    // smaller / more specific items first so a lake drawn on top of a
    // surface (or a building over both) is still pickable.
    //   building (polygon)
    //   lake     (polygon)
    //   surface  (polygon)
    //   river    (segment-near, width-aware)
    //   road     (segment-near, baseline + overlay tie-breaks closer)
    // Section sub-mode additionally records segIdx so Delete can split
    // or trim the row at the hit segment.
    let pickedKind:
      | 'building' | 'lake' | 'parkingLot' | 'surface' | 'river' | 'baselineRoad' | 'road' | null = null;
    let pickedIdx = -1;
    // 1. Building polygons.
    for (let i = 0; i < state.buildings.length; i++) {
      const b = state.buildings[i];
      if (!Array.isArray(b) || b.length < 8) continue;
      const pts: TilePoint[] = [];
      for (let k = 2; k + 1 < b.length; k += 2) pts.push([b[k] as number, b[k + 1] as number]);
      if (pts.length >= 3 && _wePointInPolygon(tx, ty, pts)) {
        pickedKind = 'building';
        pickedIdx = i;
        break;
      }
    }
    // 2. Lake polygons.
    if (pickedKind === null) {
      for (let i = 0; i < state.lakes.length; i++) {
        const lk = state.lakes[i];
        if (!Array.isArray(lk) || lk.length < 7) continue;
        const pts: TilePoint[] = [];
        for (let k = 1; k + 1 < lk.length; k += 2) pts.push([lk[k] as number, lk[k + 1] as number]);
        if (pts.length >= 3 && _wePointInPolygon(tx, ty, pts)) {
          pickedKind = 'lake';
          pickedIdx = i;
          break;
        }
      }
    }
    // 2.5. Parking-lot polygons (H693/H695/H699). Tried before surfaces
    // so a lot drawn on top of a surface is still selectable. Row schema
    // parsed via _weParseParkingLotMeta — handles all three shapes
    // (H693/H695/H699) by type + parity.
    if (pickedKind === null) {
      for (let i = 0; i < state.parkingLots.length; i++) {
        const pl = state.parkingLots[i];
        if (!Array.isArray(pl) || pl.length < 7) continue;
        const meta = _weParseParkingLotMeta(pl);
        const pts: TilePoint[] = [];
        for (let k = meta.xStart; k + 1 < pl.length; k += 2) pts.push([pl[k] as number, pl[k + 1] as number]);
        if (pts.length >= 3 && _wePointInPolygon(tx, ty, pts)) {
          pickedKind = 'parkingLot';
          pickedIdx = i;
          break;
        }
      }
    }
    // 3. Surface polygons.
    if (pickedKind === null) {
      for (let i = 0; i < state.surfaces.length; i++) {
        const s = state.surfaces[i];
        if (!Array.isArray(s) || s.length < 8) continue;
        const pts: TilePoint[] = [];
        for (let k = 2; k + 1 < s.length; k += 2) pts.push([s[k] as number, s[k + 1] as number]);
        if (pts.length >= 3 && _wePointInPolygon(tx, ty, pts)) {
          pickedKind = 'surface';
          pickedIdx = i;
          break;
        }
      }
    }
    // 4. River polylines — segment-near hit test (same threshold the
    // road branch uses).
    const segPickRadius = Math.max(3, 10 / state.view.zoom);
    const segPickD2Max = segPickRadius * segPickRadius;
    if (pickedKind === null) {
      let bestD2 = segPickD2Max;
      let bestIdx = -1;
      for (let i = 0; i < state.rivers.length; i++) {
        const rv = state.rivers[i];
        if (!Array.isArray(rv) || rv.length < 6) continue;
        const pts: TilePoint[] = [];
        for (let k = 2; k + 1 < rv.length; k += 2) pts.push([rv[k] as number, rv[k + 1] as number]);
        for (let s = 0; s + 1 < pts.length; s++) {
          const d2 = pointSegDist2(tx, ty, pts[s][0], pts[s][1], pts[s + 1][0], pts[s + 1][1]);
          if (d2 < bestD2) { bestD2 = d2; bestIdx = i; }
        }
      }
      if (bestIdx >= 0) {
        pickedKind = 'river';
        pickedIdx = bestIdx;
      }
    }
    // 5. Roads — baseline + overlay candidate, closer wins. Reuses the
    // shift+click helpers above.
    let pickedRoadSegIdx = -1;
    if (pickedKind === null) {
      const radius = 8 / state.view.zoom;
      const baselineIdx = findNearestBaselineRoad(state, tx, ty, radius);
      const overlayIdx = findNearestOverlayRoad(state, tx, ty, radius);
      let roadKind: 'baselineRoad' | 'road' | null = null;
      let roadIdx = -1;
      if (baselineIdx >= 0 && overlayIdx >= 0) {
        const baselineD2 = minDist2ToBaseline(state, baselineIdx, tx, ty);
        const overlayD2 = minDist2ToOverlay(state, overlayIdx, tx, ty);
        roadKind = overlayD2 < baselineD2 ? 'road' : 'baselineRoad';
        roadIdx = overlayD2 < baselineD2 ? overlayIdx : baselineIdx;
      } else if (baselineIdx >= 0) {
        roadKind = 'baselineRoad';
        roadIdx = baselineIdx;
      } else if (overlayIdx >= 0) {
        roadKind = 'road';
        roadIdx = overlayIdx;
      }
      if (roadKind !== null) {
        pickedKind = roadKind;
        pickedIdx = roadIdx;
        // Section sub-mode segIdx — record before clearing the rest.
        if (state.selectMode === 'section') {
          const pts = roadKind === 'road'
            ? getOverlayPts(state, roadIdx)
            : getEditedBaselinePts(state, roadIdx);
          let bestSeg = -1;
          let bestD2 = Infinity;
          for (let i = 0; i + 1 < pts.length; i++) {
            const d2 = pointSegDist2(tx, ty, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
            if (d2 < bestD2) { bestD2 = d2; bestSeg = i; }
          }
          pickedRoadSegIdx = bestSeg;
        }
      }
    }

    // Clear ALL selection indices, then set the one that matched.
    // Matches resetSelectionForToolSwitch in editor/ui.ts but kept
    // inline so the no-pick branch (clears everything) reads the same
    // as the pick branches (clear + set one).
    state.selected = -1;
    state.selectedBaselineRoad = -1;
    state.selectedSurface = -1;
    state.selectedBuilding = -1;
    state.selectedRiver = -1;
    state.selectedLake = -1;
    state.selectedParkingLot = -1;
    state.selectedSegmentIdx = -1;
    state.selectedKind = null;
    _weClearSpan(state); // H991: non-span picks always drop the armed span
    if (pickedKind === 'building') {
      state.selectedKind = 'building';
      state.selectedBuilding = pickedIdx;
    } else if (pickedKind === 'lake') {
      state.selectedKind = 'lake';
      state.selectedLake = pickedIdx;
    } else if (pickedKind === 'parkingLot') {
      state.selectedKind = 'parkingLot';
      state.selectedParkingLot = pickedIdx;
    } else if (pickedKind === 'surface') {
      state.selectedKind = 'surface';
      state.selectedSurface = pickedIdx;
    } else if (pickedKind === 'river') {
      state.selectedKind = 'river';
      state.selectedRiver = pickedIdx;
    } else if (pickedKind === 'baselineRoad') {
      state.selectedKind = 'baselineRoad';
      state.selectedBaselineRoad = pickedIdx;
      state.selectedSegmentIdx = pickedRoadSegIdx;
    } else if (pickedKind === 'road') {
      state.selectedKind = 'road';
      state.selected = pickedIdx;
      state.selectedSegmentIdx = pickedRoadSegIdx;
    }
    state.activeVertex = -1;
    state.draft = null;
    state.needsRedraw = true;
    return;
  }
}

/** Mouse-move handler. Pan tick if pan-in-progress; else update
 *  hoverTile so the H119 ghost-segment preview can track the cursor.
 *  needsRedraw only fires when a draft is active — no-draft hover
 *  doesn't refresh the canvas (avoids burning frames on idle motion). */
export function _weCanvasMouseMove(
  e: MouseEvent,
  state: WorldEditorState,
  deps: InputDeps,
): void {
  if (state.pan) {
    const pan = state.pan as PanState;
    // H971: pan deltas are captured in CLIENT px but the view shifts in
    // canvas-INTERNAL px per zoom — scale by the buffer/CSS ratio so a
    // stretched canvas (mobile URL-bar viewport) pans 1:1 with the hand.
    const panC = deps.getCanvas();
    const pRect = panC ? panC.getBoundingClientRect() : null;
    const pkx = panC && pRect && pRect.width > 0 ? panC.width / pRect.width : 1;
    const pky = panC && pRect && pRect.height > 0 ? panC.height / pRect.height : 1;
    const dx = (e.clientX - pan.sx) * pkx;
    const dy = (e.clientY - pan.sy) * pky;
    state.view.cx = pan.scx - dx / state.view.zoom;
    state.view.cy = pan.scy - dy / state.view.zoom;
    state.needsRedraw = true;
    return;
  }
  // H119: track cursor tile for the ghost-segment preview.
  const canvas = deps.getCanvas();
  if (!canvas) return;
  // H904: the mousemove handler is bound window-wide, so moving onto the
  // toolbar would re-point hoverTile at the toolbar (off-road) and drop the
  // merge lane ring before the user can click ◀ Lane ▶ / Side. Ignore moves
  // that aren't over the canvas itself, so hoverTile (and the ring it drives)
  // stays on the last canvas position while the user reaches for a button.
  if (e.target && e.target !== canvas) return;
  const { sx, sy } = _weClientToCanvas(canvas, e.clientX, e.clientY);
  state.hoverTile = deps.screenToTile(sx, sy);
  // H640: live snap preview. Render reads state.hoverSnap to paint
  // the cyan / yellow / magenta ring at the snap target. Updated
  // every move for place + river tools (the only kinds with snap);
  // null for everything else so a stale snap ring from a previous
  // tool doesn't linger when switching to surface/building/lake/select.
  // Triggers needsRedraw only when the snap target changed to avoid
  // burning frames on idle motion outside snap range.
  if (state.tool === 'place') {
    const prev = state.hoverSnap as { tx?: number; ty?: number } | null;
    const next = deps.findSnap(state.hoverTile.tx, state.hoverTile.ty);
    if (next && next.kind === 'lane') {
      // H907: cursor is over a road — anchor this tile so the ◀ Lane ▶ / Side
      // buttons can re-snap here after the cursor leaves the road.
      state.mergeLaneAnchorTile = { tx: state.hoverTile.tx, ty: state.hoverTile.ty };
      state.hoverSnap = next;
    } else if (state.draft && state.draftProps.merge && state.mergeLaneAnchorTile) {
      // H907: off-road during a merge draft — KEEP the anchored lane ring so
      // the user doesn't lose it while reaching for the cycle buttons.
      // (hoverSnap stays as the last lane snap.)
      // H955: gated on an ACTIVE draft — after Confirm/Delete/Reset there is no
      // draft, so this keeper can't re-pin a stale ring; the next mousemove
      // falls through to the clear below (defense-in-depth for the field nulls).
    } else {
      state.hoverSnap = next;
    }
    const after = state.hoverSnap as { tx?: number; ty?: number } | null;
    const a = prev ? `${prev.tx},${prev.ty}` : '';
    const b = after ? `${after.tx},${after.ty}` : '';
    if (a !== b) state.needsRedraw = true;
  } else if (state.tool === 'river') {
    const prev = state.hoverSnap as { tx?: number; ty?: number } | null;
    const next = deps.findRiverSnap(state.hoverTile.tx, state.hoverTile.ty);
    state.hoverSnap = next;
    const a = prev ? `${prev.tx},${prev.ty}` : '';
    const b = next ? `${next.tx},${next.ty}` : '';
    if (a !== b) state.needsRedraw = true;
  } else if (state.hoverSnap) {
    state.hoverSnap = null;
    state.needsRedraw = true;
  }
  // H121/H132/H133: vertex-drag tick for baseline rows. H132 adds
  // snap; H133 stores the snap target on state._snapPreview so the
  // render can paint a feedback ring.
  if (state.selectedKind === 'baselineRoad' && state.activeVertex >= 0 && state.selectedBaselineRoad >= 0) {
    const editsMap = state.baselineEdits as Record<string, number[][]>;
    const key = String(state.selectedBaselineRoad);
    const editedPts = editsMap[key];
    if (editedPts && state.activeVertex < editedPts.length) {
      const snapRadius = 8 / state.view.zoom;
      const snap = findSnapTarget(state, state.hoverTile.tx, state.hoverTile.ty, snapRadius);
      editedPts[state.activeVertex] = snap
        ? [snap.x, snap.y]
        : [state.hoverTile.tx, state.hoverTile.ty];
      state._snapPreview = snap;
      state.needsRedraw = true;
    }
    return;
  }
  // H130/H132/H133: vertex-drag tick for overlay rows + snap + preview.
  if (state.selectedKind === 'road' && state.activeVertex >= 0 && state.selected >= 0) {
    const overlay = state.overlay as unknown[];
    const row = overlay[state.selected] as (string | number)[];
    if (row && row.length >= 6) {
      const xStart = overlayXStart(row as readonly (string | number)[]);
      const i = xStart + 2 * state.activeVertex;
      if (i + 1 < row.length) {
        const snapRadius = 8 / state.view.zoom;
        const snap = findSnapTarget(state, state.hoverTile.tx, state.hoverTile.ty, snapRadius);
        row[i]     = snap ? snap.x : state.hoverTile.tx;
        row[i + 1] = snap ? snap.y : state.hoverTile.ty;
        state._snapPreview = snap;
        state.needsRedraw = true;
      }
    }
    return;
  }
  if (state.draft && state.draft.pts.length > 0) {
    state.needsRedraw = true;
  }
}

/** Mouse-up handler. Clears pan state + vertex-drag activeVertex +
 *  H133 snap preview. */
export function _weCanvasMouseUp(
  _e: MouseEvent,
  state: WorldEditorState,
): void {
  if (state.pan) state.pan = null;
  if (state.activeVertex >= 0) {
    state.activeVertex = -1;
    state.needsRedraw = true;
  }
  if (state._snapPreview) {
    state._snapPreview = null;
    state.needsRedraw = true;
  }
}

/** Wheel handler. 1:1 port of monolith L16287-16300 zoom-around-cursor.
 *  Algorithm: read tile under cursor → multiply zoom → clamp → read
 *  tile under cursor again → adjust cx/cy so the tile stays put. */
export function _weCanvasWheel(
  e: WheelEvent,
  state: WorldEditorState,
  deps: InputDeps,
): void {
  // H633: target gate. Otherwise scrolling a number input (wePropZ,
  // wePropCurve, etc.) gets hijacked by the canvas zoom-around-cursor
  // logic instead of nudging the input's value.
  const canvas = deps.getCanvas();
  if (!canvas) return;
  if (e.target !== canvas) return;
  e.preventDefault();
  const { sx, sy } = _weClientToCanvas(canvas, e.clientX, e.clientY);
  const before = deps.screenToTile(sx, sy);
  const factor = e.deltaY < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR;
  state.view.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, state.view.zoom * factor));
  const after = deps.screenToTile(sx, sy);
  state.view.cx += before.tx - after.tx;
  state.view.cy += before.ty - after.ty;
  state.needsRedraw = true;
}

/** Context-menu suppressor — keeps right-click from showing the
 *  browser menu so it can be used for commit. H633: target-gated so a
 *  right-click on a toolbar button / input still shows the normal
 *  browser menu (useful for paste, inspect-element, etc.); only the
 *  canvas surface suppresses. */
export function _weCanvasContextMenu(e: MouseEvent): void {
  const target = e.target as HTMLElement | null;
  if (!target || target.id !== 'weCanvas') return;
  e.preventDefault();
}

/** Touch-start handler. Single-touch starts a tap-or-pan tracker;
 *  two-touch starts a pinch. Ported 1:1 from monolith L16302-16320. */
export function _weTouchStart(
  e: TouchEvent,
  state: WorldEditorState,
  deps: InputDeps,
): void {
  // H804: target gate BEFORE preventDefault — same rule as
  // _weCanvasMouseDown's H633 gate. The gameLoop binds these to
  // `window`, so without it every toolbar/input tap was
  // preventDefault()ed, which suppresses the browser's synthetic
  // click — every DOM button in the editor (including Exit) was dead
  // on mobile. Touch events dispatch to their touchstart element for
  // the whole gesture, so canvas pans/pinches still reach the gated
  // handlers below.
  if (e.target !== deps.getCanvas()) return;
  e.preventDefault();
  if (e.touches.length === 1) {
    const t = e.touches[0];
    const c = deps.getCanvas();
    if (!c) return;
    // H971: store the tap in canvas-INTERNAL px (scaled) — screenToTile
    // and the synthesized mousedown round-trip both assume internal px.
    const { sx, sy } = _weClientToCanvas(c, t.clientX, t.clientY);
    const tap: TouchTapState = { sx, sy, ssx: sx, ssy: sy, t0: Date.now(), moved: false };
    state._touchTap = tap;
  } else if (e.touches.length === 2) {
    const a = e.touches[0], b = e.touches[1];
    const dx = b.clientX - a.clientX, dy = b.clientY - a.clientY;
    const d = Math.hypot(dx, dy);
    const pinch: PinchState = {
      d0: d,
      zoom0: state.view.zoom,
      lastMx: (a.clientX + b.clientX) / 2,
      lastMy: (a.clientY + b.clientY) / 2,
    };
    state.pinch = pinch;
    state._touchTap = null;
  }
}

/** Touch-move handler. Pan via single-touch displacement once moved
 *  threshold is crossed; pinch-zoom-around-midpoint + midpoint drag
 *  on two-touch. Ported 1:1 from monolith L16321-16361. */
export function _weTouchMove(
  e: TouchEvent,
  state: WorldEditorState,
  deps: InputDeps,
): void {
  if (e.target !== deps.getCanvas()) return; // H804: see _weTouchStart
  e.preventDefault();
  if (e.touches.length === 1 && state._touchTap) {
    const tap = state._touchTap as TouchTapState;
    const t = e.touches[0];
    const c = deps.getCanvas();
    if (!c) return;
    const { sx, sy } = _weClientToCanvas(c, t.clientX, t.clientY);
    const totalDx = sx - tap.ssx;
    const totalDy = sy - tap.ssy;
    if (Math.hypot(totalDx, totalDy) > TOUCH_TAP_MAX_MOVE_PX) tap.moved = true;
    if (tap.moved) {
      const dx = sx - tap.sx;
      const dy = sy - tap.sy;
      state.view.cx -= dx / state.view.zoom;
      state.view.cy -= dy / state.view.zoom;
      tap.sx = sx;
      tap.sy = sy;
      state.needsRedraw = true;
    }
  } else if (e.touches.length === 2 && state.pinch) {
    const pinch = state.pinch as PinchState;
    const a = e.touches[0], b = e.touches[1];
    const dx = b.clientX - a.clientX, dy = b.clientY - a.clientY;
    const d = Math.hypot(dx, dy);
    const mx = (a.clientX + b.clientX) / 2, my = (a.clientY + b.clientY) / 2;
    const c = deps.getCanvas();
    if (!c) return;
    // H971: zoom-around-midpoint needs INTERNAL px; the two-finger pan
    // delta (client px) scales by the same buffer/CSS ratio.
    const { sx, sy } = _weClientToCanvas(c, mx, my);
    const pRect = c.getBoundingClientRect();
    const pkx = pRect.width > 0 ? c.width / pRect.width : 1;
    const pky = pRect.height > 0 ? c.height / pRect.height : 1;
    const before = deps.screenToTile(sx, sy);
    state.view.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, pinch.zoom0 * (d / pinch.d0)));
    const after = deps.screenToTile(sx, sy);
    state.view.cx += before.tx - after.tx;
    state.view.cy += before.ty - after.ty;
    const pdx = (mx - pinch.lastMx) * pkx;
    const pdy = (my - pinch.lastMy) * pky;
    state.view.cx -= pdx / state.view.zoom;
    state.view.cy -= pdy / state.view.zoom;
    pinch.lastMx = mx;
    pinch.lastMy = my;
    state.needsRedraw = true;
  }
}

/** Touch-end handler. If single-touch was a tap (not moved, < 600ms),
 *  synthesize a mouse-down event and re-invoke _weCanvasMouseDown so
 *  the place/select logic lives in one path. Ported 1:1 from monolith
 *  L16362-16377. */
export function _weTouchEnd(
  e: TouchEvent,
  state: WorldEditorState,
  deps: InputDeps,
): void {
  if (e.target !== deps.getCanvas()) return; // H804: see _weTouchStart
  e.preventDefault();
  if (state._touchTap) {
    const tap = state._touchTap as TouchTapState;
    if (!tap.moved && Date.now() - tap.t0 < TOUCH_TAP_MAX_DURATION_MS) {
      const c = deps.getCanvas();
      if (c) {
        // H971: tap.ssx/ssy are canvas-INTERNAL px now — invert the
        // buffer/CSS scale when reconstructing CLIENT coords so the
        // synthesized mousedown round-trips to the same internal point.
        const rect = c.getBoundingClientRect();
        const ikx = c.width > 0 ? rect.width / c.width : 1;
        const iky = c.height > 0 ? rect.height / c.height : 1;
        const fakeEv = {
          button: 0,
          clientX: tap.ssx * ikx + rect.left,
          clientY: tap.ssy * iky + rect.top,
          shiftKey: false,
          altKey: false,
          // H804: _weCanvasMouseDown's H633 gate requires target ===
          // canvas. The synthesized event carried no target at all, so
          // every tap-to-place/select silently no-opped on mobile —
          // the user couldn't select a road or drop a draft point.
          target: c,
          preventDefault: () => {},
        } as unknown as MouseEvent;
        _weCanvasMouseDown(fakeEv, state, deps);
      }
    }
  }
  if (e.touches.length === 0) {
    state._touchTap = null;
    state.pinch = null;
  } else if (e.touches.length === 1) {
    state.pinch = null;
  }
}

/** H971: client → canvas-INTERNAL coordinates. The editor canvas's CSS
 *  box can diverge from its internal buffer — _weResizeCanvas sizes the
 *  buffer to window.innerWidth/Height once, but the CSS box is 100% of
 *  the overlay, and on mobile the URL-bar viewport dynamics (and DPR
 *  variants) stretch the box after the fact. screenToTile expects
 *  INTERNAL pixels; the old raw clientXY−rect math fed it CSS pixels,
 *  so every tap landed progressively LOWER than the finger (user
 *  report: "never selects or places points where I press — much
 *  lower"), which also drove the wrong-lane snaps on mobile. Same
 *  buffer/rect scale fix the game HUD tap router uses. */
function _weClientToCanvas(
  c: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): { sx: number; sy: number } {
  const rect = c.getBoundingClientRect();
  const kx = rect.width > 0 ? c.width / rect.width : 1;
  const ky = rect.height > 0 ? c.height / rect.height : 1;
  return { sx: (clientX - rect.left) * kx, sy: (clientY - rect.top) * ky };
}

/** Re-export so callers can import the click projection type from
 *  one place. */
export type { TilePoint };
