/**
 * World Editor — selection lookup, hit-test, vertex move, polygon
 * smoothing, point-in-polygon.
 *
 * `_weGetSelectedItem` is the discriminated-union accessor every other
 * select helper builds on. It returns one of:
 *
 *   { kind: 'baselineRoad', baseRoadIdx }     ← {pts:[[x,y],...]} object format
 *   { kind: 'road',     row, xStart }         ← flat array, xStart = 4 or 5
 *   { kind: 'surface',  row, xStart: 2 }
 *   { kind: 'building', row, xStart: 2 }
 *   { kind: 'river',    row, xStart: 2 }
 *   { kind: 'lake',     row, xStart: 1 }
 *
 * BASELINE ROADS USE A DIFFERENT SHAPE (v8.99.126.46): they're the
 * source-defined major roads in {pts: [[x,y],...]} object form, NOT
 * flat arrays. They don't fit the {row, xStart} contract, so the
 * accessor returns a distinct shape and every downstream helper
 * branches on `kind` to handle it. This keeps the rest of the code
 * blissfully unaware of the storage-shape duality.
 *
 * MERGE-AWARE xStart FOR OVERLAY ROADS (v8.99.126.00): the row schema
 * uses parity as the discriminator — odd row.length means 5-meta merge
 * row (coords start at index 5), even means 4-meta legacy (coords
 * start at index 4). Every vertex-edit helper reads xStart to target
 * the actual coordinate pairs in either schema.
 *
 * POINT/SECTION GLOBAL PICK (v8.99.126.47): _weFindNearestVertex and
 * _weFindNearestSegment scan EVERY road — both baseline (i<baseLen)
 * and overlay (i>=baseLen) — so a single tap can both identify which
 * road owns the hit AND identify the precise vertex/segment within it.
 * Returns null if nothing is within the click threshold. Width-aware
 * segment threshold (max(baseThresh, r.w * 0.4)) so wide highways stay
 * pickable from anywhere on the visible asphalt.
 *
 * BASELINE-ROAD VERTEX MOVE (v8.99.126.46): mutates
 * _weBaselineMajorRoads (the LIVE baseline) so the change persists
 * across _weApplyOverlay rebuilds, then mirrors the full edited pts
 * array into WORLD_EDITOR.baselineEdits and writes that to localStorage
 * via _weSaveBaselineEdits. _weRebuildWorld at the end forces a full
 * rebuild — same path overlay edits take, so semantics match.
 *
 * POLYGON SMOOTHING (`_weSmoothSelectedPolygon`): closed-polygon Bezier
 * smoothing. Appends first point as a closure target, runs the same
 * _weCurvePoints sampler used for road/river arc bake, then drops the
 * duplicated tail if _weCurvePoints leaves the closure point at both
 * ends. Surface/building/lake only — roads have their own arc baking
 * path at commit time.
 *
 * Ported from monolith L15668-15848.
 */

import type { WorldEditorState } from './index';
import type { TilePoint } from './stamp';

/** Discriminated union returned by _weGetSelectedItem. */
export type SelectedItem =
  | { kind: 'baselineRoad'; baseRoadIdx: number }
  | { kind: 'road'; row: unknown[]; xStart: 4 | 5 }
  | { kind: 'surface'; row: unknown[]; xStart: 2 }
  | { kind: 'building'; row: unknown[]; xStart: 2 }
  | { kind: 'river'; row: unknown[]; xStart: 2 }
  | { kind: 'lake'; row: unknown[]; xStart: 1 };

/** Pick result from the global Point/Section search helpers. */
export type PickResult = {
  kind: 'baselineRoad' | 'road';
  /** For baseline: index into majorRoads / _weBaselineMajorRoads.
   *  For overlay: index into WORLD_EDITOR.overlay. */
  roadIdx: number;
  vertexIdx?: number;
  segmentIdx?: number;
};

/** Host bindings for select helpers. */
export interface SelectDeps {
  getMajorRoads(): Array<{ pts: number[][]; w: number; [k: string]: unknown }>;
  getBaselineLength(): number;
  /** Live baseline copy — vertex moves mutate this. */
  getBaselineMajorRoads(): Array<{ pts: number[][] }>;
  /** Persists baseline edits after a vertex move on a baseline road. */
  saveBaselineEdits(): void;
  rebuildWorld(): void;
  /** Curve sampler shared with editor/draft.ts. */
  curvePoints(pts: TilePoint[], curve: number): TilePoint[];
}

/** Get the currently selected item. Returns null when nothing is
 *  selected. xStart for road branches on row-length parity (4-meta
 *  legacy vs 5-meta merge). Ported 1:1 from monolith L15668-15691. */
export function _weGetSelectedItem(state: WorldEditorState): SelectedItem | null {
  if (state.selectedKind === 'baselineRoad' && state.selectedBaselineRoad >= 0) {
    return { kind: 'baselineRoad', baseRoadIdx: state.selectedBaselineRoad };
  }
  if (state.selectedKind === 'road' && state.selected >= 0) {
    const row = state.overlay[state.selected] as unknown[];
    const xStart: 4 | 5 = (row && (row.length & 1) === 1) ? 5 : 4;
    return { kind: 'road', row, xStart };
  }
  if (state.selectedKind === 'surface' && state.selectedSurface >= 0) {
    return { kind: 'surface', row: state.surfaces[state.selectedSurface] as unknown[], xStart: 2 };
  }
  if (state.selectedKind === 'building' && state.selectedBuilding >= 0) {
    return { kind: 'building', row: state.buildings[state.selectedBuilding] as unknown[], xStart: 2 };
  }
  if (state.selectedKind === 'river' && state.selectedRiver >= 0) {
    return { kind: 'river', row: state.rivers[state.selectedRiver] as unknown[], xStart: 2 };
  }
  if (state.selectedKind === 'lake' && state.selectedLake >= 0) {
    return { kind: 'lake', row: state.lakes[state.selectedLake] as unknown[], xStart: 1 };
  }
  return null;
}

/** Hit-test the nearest vertex of the currently selected item against
 *  a tile-coord click. Returns the vertex index, or -1 if no vertex is
 *  within max(1.5, 14/zoom) tile radius. Branches on kind for baseline
 *  vs flat-array row. Ported 1:1 from monolith L15692-15723. */
export function _weHitTestSelectedVertex(
  tx: number,
  ty: number,
  state: WorldEditorState,
  deps: SelectDeps,
): number {
  const sel = _weGetSelectedItem(state);
  if (!sel) return -1;
  const tileR = Math.max(1.5, 14 / state.view.zoom);
  if (sel.kind === 'baselineRoad') {
    const idx = sel.baseRoadIdx;
    const majorRoads = deps.getMajorRoads();
    if (!majorRoads || idx < 0 || idx >= majorRoads.length) return -1;
    const pts = majorRoads[idx].pts;
    if (!Array.isArray(pts)) return -1;
    let bestI = -1, bestD = tileR;
    for (let i = 0; i < pts.length; i++) {
      const d = Math.hypot(pts[i][0] - tx, pts[i][1] - ty);
      if (d < bestD) { bestD = d; bestI = i; }
    }
    return bestI;
  }
  if (!Array.isArray(sel.row)) return -1;
  const r = sel.row as number[], start = sel.xStart;
  let bestI = -1, bestD = tileR;
  let vi = 0;
  for (let i = start; i + 1 < r.length; i += 2) {
    const d = Math.hypot(r[i] - tx, r[i + 1] - ty);
    if (d < bestD) { bestD = d; bestI = vi; }
    vi++;
  }
  return bestI;
}

/** Move the vertex at vIdx of the selected item to (tx, ty) tile coords.
 *  Returns true on success. For baseline roads, mirrors the edit into
 *  WORLD_EDITOR.baselineEdits and persists. Triggers _weRebuildWorld.
 *  Coordinates are stored .toFixed(2). Ported 1:1 from monolith
 *  L15724-15754. */
export function _weMoveSelectedVertex(
  vIdx: number,
  tx: number,
  ty: number,
  state: WorldEditorState,
  deps: SelectDeps,
): boolean {
  const sel = _weGetSelectedItem(state);
  if (!sel || vIdx < 0) return false;
  if (sel.kind === 'baselineRoad') {
    const idx = sel.baseRoadIdx;
    const baseline = deps.getBaselineMajorRoads();
    if (!baseline || idx < 0 || idx >= baseline.length) return false;
    const base = baseline[idx];
    if (!Array.isArray(base.pts) || vIdx >= base.pts.length) return false;
    base.pts[vIdx][0] = +tx.toFixed(2);
    base.pts[vIdx][1] = +ty.toFixed(2);
    state.baselineEdits[idx] = base.pts.map(p => [p[0], p[1]]);
    deps.saveBaselineEdits();
    deps.rebuildWorld();
    return true;
  }
  if (!Array.isArray(sel.row)) return false;
  const r = sel.row as number[], start = sel.xStart;
  const xi = start + vIdx * 2, yi = xi + 1;
  if (xi + 1 >= r.length) return false;
  r[xi] = +tx.toFixed(2);
  r[yi] = +ty.toFixed(2);
  deps.rebuildWorld();
  return true;
}

/** Global Point-mode pick: find the nearest vertex across all roads.
 *  Returns kind + (road index relative to its source array) +
 *  vertexIdx, or null if nothing is in range. Ported 1:1 from monolith
 *  L15761-15783. */
export function _weFindNearestVertex(
  tx: number,
  ty: number,
  state: WorldEditorState,
  deps: SelectDeps,
): PickResult | null {
  const majorRoads = deps.getMajorRoads();
  if (!majorRoads) return null;
  const baseLen = deps.getBaselineLength();
  const tileR = Math.max(2, 14 / state.view.zoom);
  let best: PickResult | null = null;
  let bestD = tileR;
  for (let i = 0; i < majorRoads.length; i++) {
    const r = majorRoads[i];
    if (!r.pts || r.pts.length < 2) continue;
    for (let v = 0; v < r.pts.length; v++) {
      const d = Math.hypot(r.pts[v][0] - tx, r.pts[v][1] - ty);
      if (d < bestD) {
        bestD = d;
        const isBase = i < baseLen;
        best = {
          kind: isBase ? 'baselineRoad' : 'road',
          roadIdx: isBase ? i : (i - baseLen),
          vertexIdx: v,
        };
      }
    }
  }
  return best;
}

/** Global Section-mode pick: find the nearest segment across all
 *  roads. Width-aware threshold = max(baseThresh, r.w * 0.4). Ported
 *  1:1 from monolith L15784-15817. */
export function _weFindNearestSegment(
  tx: number,
  ty: number,
  state: WorldEditorState,
  deps: SelectDeps,
): PickResult | null {
  const majorRoads = deps.getMajorRoads();
  if (!majorRoads) return null;
  const baseLen = deps.getBaselineLength();
  const baseThresh = Math.max(3, 10 / state.view.zoom);
  let best: PickResult | null = null;
  let bestD = Infinity;
  for (let i = 0; i < majorRoads.length; i++) {
    const r = majorRoads[i];
    if (!r.pts || r.pts.length < 2) continue;
    const segThresh = Math.max(baseThresh, (r.w || 4) * 0.4);
    for (let s = 0; s < r.pts.length - 1; s++) {
      const ax = r.pts[s][0], ay = r.pts[s][1];
      const bx = r.pts[s + 1][0], by = r.pts[s + 1][1];
      const vx = bx - ax, vy = by - ay;
      const len2 = vx * vx + vy * vy;
      if (len2 < 0.0001) continue;
      let t = ((tx - ax) * vx + (ty - ay) * vy) / len2;
      t = Math.max(0, Math.min(1, t));
      const ppx = ax + t * vx, ppy = ay + t * vy;
      const d = Math.hypot(ppx - tx, ppy - ty);
      if (d < segThresh && d < bestD) {
        bestD = d;
        const isBase = i < baseLen;
        best = {
          kind: isBase ? 'baselineRoad' : 'road',
          roadIdx: isBase ? i : (i - baseLen),
          segmentIdx: s,
        };
      }
    }
  }
  return best;
}

/** Re-sample the selected closed polygon (surface/building/lake) with
 *  Bezier smoothing using draftProps.curve. No-op if curve is 0, or
 *  if the selection isn't a closed polygon. Ported 1:1 from monolith
 *  L15818-15840. */
export function _weSmoothSelectedPolygon(
  state: WorldEditorState,
  deps: SelectDeps,
): void {
  const sel = _weGetSelectedItem(state);
  if (!sel) return;
  if (sel.kind !== 'surface' && sel.kind !== 'building' && sel.kind !== 'lake') return;
  const r = sel.row as number[], start = sel.xStart;
  const pts: TilePoint[] = [];
  for (let i = start; i + 1 < r.length; i += 2) pts.push([r[i], r[i + 1]]);
  if (pts.length < 3) return;
  const curve = state.draftProps.curve || 0;
  if (curve === 0) return;
  const closed: TilePoint[] = pts.concat([[pts[0][0], pts[0][1]]]);
  const curved = deps.curvePoints(closed, curve);
  if (curved.length >= 2) {
    const a = curved[0], b = curved[curved.length - 1];
    if (Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01) curved.pop();
  }
  r.length = start;
  for (const p of curved) r.push(+p[0].toFixed(2), +p[1].toFixed(2));
  state.activeVertex = -1;
  deps.rebuildWorld();
}

/** Standard ray-cast point-in-polygon. Even-odd rule. The (yj-yi)||1e-9
 *  guard avoids divide-by-zero on horizontal edges (treats them as
 *  off-by-an-epsilon non-zero rather than skipping, which preserves
 *  the standard algorithm's edge-grazing behavior). */
export function _wePointInPolygon(px: number, py: number, pts: TilePoint[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1];
    const xj = pts[j][0], yj = pts[j][1];
    const intersect = ((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / ((yj - yi) || 1e-9) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}
