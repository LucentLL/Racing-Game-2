/**
 * World Editor — SPAN select ops (H991).
 *
 * Span mode: the user clicks TWO arbitrary points along ONE road (not
 * necessarily existing vertices). The stretch between them becomes the
 * operand for:
 *
 *   - DELETE          → cut the stretch out (road splits into ≤2 pieces)
 *   - ✂ SPLIT         → cut at both points, keep all ≤3 pieces
 *   - Z / BRIDGE      → split, middle piece gets the new z (bridge = z≥2;
 *                       apply.ts Phase 6 then auto-computes bridgePts and
 *                       bridgeRuntime builds the collision structure — the
 *                       shared different-z endpoints are exactly what
 *                       creates the layer-transition triggers)
 *   - MATERIAL / AGE  → NO split: cut vertices are inserted in-place and
 *                       per-segment materialOverrides cover the span
 *                       (survives ⟳ Rebuild Roads byte-verbatim, and the
 *                       road stays ONE road — no fuse-back risk)
 *
 * STRUCTURAL MODEL. All split ops share one primitive: materialize the two
 * cut points as vertices (snapping to an existing vertex when the cut lands
 * within SNAP tolerance), then slice the polyline into A=[0..vA],
 * M=[vA..vB], C=[vB..end]. Both neighbours share the EXACT same cut vertex
 * coords (quantized once) so computeEndCaps sees connected termini → butt
 * caps, invisible seam (the "road connections always smooth" rule).
 *
 * BASELINE roads: structural span ops use the promote-to-overlay pattern
 * (delete.ts section-delete precedent) but FIX its historical prop drop —
 * material/age/oneway props and per-segment overrides are carried onto the
 * new overlay rows. Material span ops do NOT promote: cut vertices go into
 * baselineEdits and overrides into baselineMaterialOverrides.
 *
 * SIDECAR RE-KEYING. Overlay splices shift row indices; both sidecar maps
 * (overlayRoadProps / overlayMaterialOverrides) are re-keyed for the
 * replace-1-row-with-N case, and the split row's own per-segment overrides
 * are partitioned + re-based per piece (delete.ts's section split predates
 * this and never re-keyed — span ops don't inherit that bug).
 *
 * MERGE ROWS (odd length / 5-meta) are ATOMIC (H952): their centerline is
 * bonder output, not user geometry. The span pick flow refuses to arm a
 * span on them; every op here re-checks defensively.
 */

import type { WorldEditorState, SpanCut } from './index';
import type { TilePoint } from './stamp';
import type { DeleteDeps } from './delete';
import { _weSnapshotForUndo } from './undo';
import { BASELINE_ROADS } from '@/config/world/baselineRoads';

/** Span ops need everything delete/material ops need, plus the bridge
 *  auto-Z scan (owned by the host — same dep the Bridge checkbox uses). */
export interface SpanDeps extends DeleteDeps {
  computeMaxCrossedZ(road: { pts: number[][] }): number;
}

/** Cut-to-vertex snap: parameter tolerance + absolute tile tolerance.
 *  Either triggers a snap so we never create micro-segments beside an
 *  existing vertex. */
const SNAP_T = 0.02;
const SNAP_TILES = 0.5;
/** Minimum euclidean distance between the two cuts (tiles). */
const MIN_SPAN_TILES = 1.0;

function flash(state: WorldEditorState, msg: string): void {
  state.statusFlash = { msg, until: Date.now() + 4000 };
  state.needsRedraw = true;
}

/** True when both span cut points are armed. */
export function _weSpanComplete(state: WorldEditorState): boolean {
  return state.selectMode === 'span' && !!state.spanA && !!state.spanB;
}

/** Clear the armed span (both cut points). */
export function _weClearSpan(state: WorldEditorState): void {
  state.spanA = null;
  state.spanB = null;
}

/** Project a click onto a polyline: nearest segment + clamped t + the
 *  projected point. Returns null for degenerate polylines. */
export function _weProjectOntoPts(
  pts: readonly TilePoint[],
  tx: number,
  ty: number,
): SpanCut | null {
  let best: SpanCut | null = null;
  let bestD2 = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const ax = pts[i][0], ay = pts[i][1];
    const bx = pts[i + 1][0], by = pts[i + 1][1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = 0;
    if (len2 >= 1e-9) {
      t = ((tx - ax) * dx + (ty - ay) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
    }
    const cx = ax + t * dx, cy = ay + t * dy;
    const ddx = tx - cx, ddy = ty - cy;
    const d2 = ddx * ddx + ddy * ddy;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = { seg: i, t, x: cx, y: cy };
    }
  }
  return best;
}

/** Read the SELECTED road's pts (span ops only care about roads). */
function selectedRoadPts(state: WorldEditorState, deps: DeleteDeps): TilePoint[] | null {
  if (state.selectedKind === 'road' && state.selected >= 0) {
    const row = state.overlay[state.selected] as readonly (string | number)[] | undefined;
    if (!row || row.length < 6) return null;
    const xStart = (row.length & 1) === 1 ? 5 : 4;
    const pts: TilePoint[] = [];
    for (let i = xStart; i + 1 < row.length; i += 2) {
      pts.push([row[i] as number, row[i + 1] as number]);
    }
    return pts;
  }
  if (state.selectedKind === 'baselineRoad' && state.selectedBaselineRoad >= 0) {
    const base = deps.getBaselineMajorRoads()[state.selectedBaselineRoad];
    if (!base || !base.pts || base.pts.length < 2) return null;
    return base.pts.map((p) => [p[0], p[1]] as TilePoint);
  }
  return null;
}

/** True when the selected road is a MERGE row (odd length — atomic). */
function selectedIsMergeRow(state: WorldEditorState): boolean {
  if (state.selectedKind !== 'road' || state.selected < 0) return false;
  const row = state.overlay[state.selected] as unknown[] | undefined;
  return !!row && (row.length & 1) === 1;
}

/** One snapped cut: either an existing vertex or a mid-segment point. */
type SnappedCut =
  | { kind: 'vertex'; vi: number; pos: number }
  | { kind: 'mid'; seg: number; t: number; x: number; y: number; pos: number };

function snapCut(pts: readonly TilePoint[], cut: SpanCut): SnappedCut {
  const a = pts[cut.seg];
  const b = pts[cut.seg + 1];
  const dA = Math.hypot(cut.x - a[0], cut.y - a[1]);
  const dB = Math.hypot(cut.x - b[0], cut.y - b[1]);
  if (cut.t <= SNAP_T || dA <= SNAP_TILES) {
    return { kind: 'vertex', vi: cut.seg, pos: cut.seg };
  }
  if (cut.t >= 1 - SNAP_T || dB <= SNAP_TILES) {
    return { kind: 'vertex', vi: cut.seg + 1, pos: cut.seg + 1 };
  }
  return { kind: 'mid', seg: cut.seg, t: cut.t, x: cut.x, y: cut.y, pos: cut.seg + cut.t };
}

/** Result of materializing both cuts as vertices on a pts COPY. */
export interface MaterializedSpan {
  /** Polyline with cut vertices inserted (coords of inserted vertices
   *  quantized toFixed(2), matching commit-path quantization). */
  pts: TilePoint[];
  /** Vertex indices of cut A / cut B in `pts`; 0 < span, vA < vB. */
  vA: number;
  vB: number;
  /** Vertex indices (into `pts`) where NEW vertices were inserted,
   *  ascending — for the caller's materialOverrides re-basing. */
  inserted: number[];
}

/** PURE core: order the two cuts, snap to vertices where close, insert
 *  mid-segment cut vertices into a copy. Returns null when the span is
 *  degenerate (cuts coincide / too short). Exported for harness tests. */
export function _weSpanMaterializeCuts(
  ptsIn: readonly TilePoint[],
  cutA: SpanCut,
  cutB: SpanCut,
): MaterializedSpan | null {
  if (ptsIn.length < 2) return null;
  if (Math.hypot(cutA.x - cutB.x, cutA.y - cutB.y) < MIN_SPAN_TILES) return null;
  let s1 = snapCut(ptsIn, cutA);
  let s2 = snapCut(ptsIn, cutB);
  if (s2.pos < s1.pos) { const tmp = s1; s1 = s2; s2 = tmp; }
  const pts: TilePoint[] = ptsIn.map((p) => [p[0], p[1]]);
  const inserted: number[] = [];
  // Insert the LATER cut first so the earlier one's indices stay valid.
  let vB: number;
  if (s2.kind === 'mid') {
    vB = s2.seg + 1;
    pts.splice(vB, 0, [+s2.x.toFixed(2), +s2.y.toFixed(2)]);
    inserted.push(vB);
  } else {
    vB = s2.vi;
  }
  let vA: number;
  if (s1.kind === 'mid') {
    vA = s1.seg + 1;
    pts.splice(vA, 0, [+s1.x.toFixed(2), +s1.y.toFixed(2)]);
    // A sits before B — B's index (and any recorded insert ≥ vA) shifts.
    for (let i = 0; i < inserted.length; i++) {
      if (inserted[i] >= vA) inserted[i] += 1;
    }
    if (vB >= vA) vB += 1;
    inserted.unshift(vA);
  } else {
    vA = s1.vi;
  }
  if (vB <= vA) return null; // both cuts collapsed onto the same vertex
  return { pts, vA, vB, inserted };
}

/** Re-base a per-segment override list for ONE inserted vertex at index
 *  `vi` (splitting old segment vi-1 into segments vi-1 and vi). Entries
 *  on the split segment are duplicated to cover both halves. Returns a
 *  new list; input untouched. */
function shiftOverridesForInsert(
  list: ReadonlyArray<{ seg: number; material?: string; age?: string }>,
  vi: number,
): Array<{ seg: number; material?: string; age?: string }> {
  const out: Array<{ seg: number; material?: string; age?: string }> = [];
  for (const o of list) {
    if (!o) continue;
    if (o.seg < vi - 1) out.push({ ...o });
    else if (o.seg === vi - 1) {
      out.push({ ...o, seg: vi - 1 });
      out.push({ ...o, seg: vi });
    } else out.push({ ...o, seg: o.seg + 1 });
  }
  return out;
}

/** Re-base an override list for ALL inserted vertices (ascending order,
 *  matching _weSpanMaterializeCuts's final indices: apply lowest first,
 *  where each recorded index is already in FINAL coordinates — so apply
 *  in ascending order without further adjustment). */
function shiftOverridesForInserts(
  list: ReadonlyArray<{ seg: number; material?: string; age?: string }>,
  inserted: readonly number[],
): Array<{ seg: number; material?: string; age?: string }> {
  let cur = list.map((o) => ({ ...o }));
  for (const vi of inserted) cur = shiftOverridesForInsert(cur, vi);
  return cur;
}

/** Partition a (re-based) override list across the three pieces.
 *  Piece segment ranges in materialized space: A=[0..vA-1], M=[vA..vB-1],
 *  C=[vB..]. Returns per-piece lists with seg re-based to piece space. */
function partitionOverrides(
  list: ReadonlyArray<{ seg: number; material?: string; age?: string }>,
  vA: number,
  vB: number,
): {
  a: Array<{ seg: number; material?: string; age?: string }>;
  m: Array<{ seg: number; material?: string; age?: string }>;
  c: Array<{ seg: number; material?: string; age?: string }>;
} {
  const a: Array<{ seg: number; material?: string; age?: string }> = [];
  const m: Array<{ seg: number; material?: string; age?: string }> = [];
  const c: Array<{ seg: number; material?: string; age?: string }> = [];
  for (const o of list) {
    if (o.seg < vA) a.push({ ...o });
    else if (o.seg < vB) m.push({ ...o, seg: o.seg - vA });
    else c.push({ ...o, seg: o.seg - vB });
  }
  return { a, m, c };
}

type RoadProps = {
  material?: string; age?: string; oneway?: boolean;
  bondInnerStart?: [number, number]; bondInnerEnd?: [number, number];
  laneCentered?: boolean; builderV?: number;
};

/** Clone road-level props for a piece: only the piece containing the
 *  original START keeps bondInnerStart; only the original END piece keeps
 *  bondInnerEnd (the vectors are per-terminus and meaningless mid-road). */
function propsForPiece(src: RoadProps | undefined, isFirst: boolean, isLast: boolean): RoadProps | undefined {
  if (!src) return undefined;
  const out: RoadProps = { ...src };
  if (!isFirst) delete out.bondInnerStart;
  if (!isLast) delete out.bondInnerEnd;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Shared structural apply. Splits the SELECTED road at the armed span
 *  and applies `opts` to the middle piece. Handles overlay rows in place
 *  (with sidecar re-keying) and baseline roads via promote-to-overlay.
 *  Returns the overlay index of the middle piece (null when dropped /
 *  failed). Snapshot + save + rebuild + span/selection reset included. */
function applySpanSplit(
  state: WorldEditorState,
  deps: DeleteDeps,
  opts: { dropMiddle?: boolean; midZ?: number; noSnapshot?: boolean },
): { ok: boolean; midIdx: number | null } {
  if (!_weSpanComplete(state) || !state.spanA || !state.spanB) {
    flash(state, '⧉ span: pick 2 points on one road first');
    return { ok: false, midIdx: null };
  }
  if (selectedIsMergeRow(state)) {
    flash(state, '⧉ merge lanes are atomic — use Whole mode');
    return { ok: false, midIdx: null };
  }
  const pts = selectedRoadPts(state, deps);
  if (!pts) return { ok: false, midIdx: null };
  const mat = _weSpanMaterializeCuts(pts, state.spanA, state.spanB);
  if (!mat) {
    flash(state, '⧉ span too short — pick points further apart');
    return { ok: false, midIdx: null };
  }
  const { pts: pts2, vA, vB, inserted } = mat;
  const last = pts2.length - 1;
  const hasA = vA >= 1;
  const hasC = vB <= last - 1;

  // Snapshot unless the caller (toolbar Delete) already took one — a
  // double snapshot would make the first Back press a visible no-op.
  if (!opts.noSnapshot) _weSnapshotForUndo(state);

  // Piece point ranges (shared cut vertices belong to BOTH neighbours).
  const sliceFlat = (from: number, to: number): number[] => {
    const flat: number[] = [];
    for (let i = from; i <= to; i++) flat.push(pts2[i][0], pts2[i][1]);
    return flat;
  };

  let midOverlayIdx: number | null = null;

  if (state.selectedKind === 'road') {
    const rowIdx = state.selected;
    const row = state.overlay[rowIdx] as (string | number)[];
    const meta = row.slice(0, 4);
    const oldProps = (state.overlayRoadProps?.[String(rowIdx)] ?? undefined) as RoadProps | undefined;
    const oldOv = state.overlayMaterialOverrides?.[String(rowIdx)] ?? [];
    const shifted = shiftOverridesForInserts(oldOv, inserted);
    const parts = partitionOverrides(shifted, vA, vB);

    // Build piece rows + parallel sidecar payloads, then drop the middle
    // if requested.
    type Piece = { row: (string | number)[]; props?: RoadProps; ov: Array<{ seg: number; material?: string; age?: string }>; isMid: boolean };
    const pieces: Piece[] = [];
    if (hasA) pieces.push({ row: meta.slice().concat(sliceFlat(0, vA)), props: propsForPiece(oldProps, true, false), ov: parts.a, isMid: false });
    pieces.push({ row: meta.slice().concat(sliceFlat(vA, vB)), props: propsForPiece(oldProps, !hasA, !hasC), ov: parts.m, isMid: true });
    if (hasC) pieces.push({ row: meta.slice().concat(sliceFlat(vB, last)), props: propsForPiece(oldProps, false, true), ov: parts.c, isMid: false });
    for (const p of pieces) {
      if (p.isMid && opts.midZ !== undefined) p.row[3] = opts.midZ;
    }
    const kept = opts.dropMiddle ? pieces.filter((p) => !p.isMid) : pieces;

    state.overlay.splice(rowIdx, 1, ...kept.map((p) => p.row));

    // Re-key BOTH sidecar maps: rows after rowIdx shift by (kept-1); the
    // split row's own entries are replaced by per-piece payloads.
    const delta = kept.length - 1;
    for (const map of [state.overlayRoadProps, state.overlayMaterialOverrides] as Array<Record<string, unknown> | undefined>) {
      if (!map) continue;
      const next: Record<string, unknown> = {};
      for (const key of Object.keys(map)) {
        const i = Number(key);
        if (i === rowIdx) continue;
        next[i > rowIdx ? String(i + delta) : key] = map[key];
      }
      for (const k of Object.keys(map)) delete map[k];
      Object.assign(map, next);
    }
    kept.forEach((p, j) => {
      const key = String(rowIdx + j);
      if (p.props) {
        (state.overlayRoadProps ?? (state.overlayRoadProps = {}))[key] = p.props;
      }
      if (p.ov.length > 0) {
        (state.overlayMaterialOverrides ?? (state.overlayMaterialOverrides = {}))[key] = p.ov;
      }
      if (p.isMid) midOverlayIdx = rowIdx + j;
    });
    deps.saveOverlayToStorage(state);
  } else {
    // Baseline → promote pieces to overlay rows (delete.ts precedent),
    // carrying props + overrides the historical promotion dropped.
    const idx = state.selectedBaselineRoad;
    const base = deps.getBaselineMajorRoads()[idx];
    if (!base) return { ok: false, midIdx: null };
    const meta: (string | number)[] = [base.w, base.maj ? 1 : 0, base.name || '', base.z || 0];
    const baseProps = (state.baselineRoadProps?.[String(idx)] ?? undefined) as RoadProps | undefined;
    const baseOv = state.baselineMaterialOverrides?.[String(idx)] ?? [];
    const shifted = shiftOverridesForInserts(baseOv, inserted);
    const parts = partitionOverrides(shifted, vA, vB);

    type Piece = { flat: number[]; props?: RoadProps; ov: Array<{ seg: number; material?: string; age?: string }>; isMid: boolean };
    const pieces: Piece[] = [];
    if (hasA) pieces.push({ flat: sliceFlat(0, vA), props: propsForPiece(baseProps, true, false), ov: parts.a, isMid: false });
    pieces.push({ flat: sliceFlat(vA, vB), props: propsForPiece(baseProps, !hasA, !hasC), ov: parts.m, isMid: true });
    if (hasC) pieces.push({ flat: sliceFlat(vB, last), props: propsForPiece(baseProps, false, true), ov: parts.c, isMid: false });
    const kept = opts.dropMiddle ? pieces.filter((p) => !p.isMid) : pieces;

    if (!state.baselineDeletes.includes(idx)) state.baselineDeletes.push(idx);
    delete state.baselineEdits[String(idx)];
    for (const p of kept) {
      const newIdx = state.overlay.length;
      const row: (string | number)[] = meta.slice();
      // Quantize promoted coords like the section-delete promotion does.
      for (let i = 0; i < p.flat.length; i += 2) {
        row.push(+p.flat[i].toFixed(2), +p.flat[i + 1].toFixed(2));
      }
      if (p.isMid && opts.midZ !== undefined) row[3] = opts.midZ;
      state.overlay.push(row);
      if (p.props) {
        (state.overlayRoadProps ?? (state.overlayRoadProps = {}))[String(newIdx)] = p.props;
      }
      if (p.ov.length > 0) {
        (state.overlayMaterialOverrides ?? (state.overlayMaterialOverrides = {}))[String(newIdx)] = p.ov;
      }
      if (p.isMid) midOverlayIdx = newIdx;
    }
    deps.saveBaselineEdits();
    deps.saveOverlayToStorage(state);
  }

  // Selection: land on the middle piece (the thing the user is operating
  // on); a dropped middle clears the road selection entirely.
  _weClearSpan(state);
  state.selectedSegmentIdx = -1;
  state.activeVertex = -1;
  if (midOverlayIdx !== null) {
    state.selected = midOverlayIdx;
    state.selectedBaselineRoad = -1;
    state.selectedKind = 'road';
  } else {
    state.selected = -1;
    state.selectedBaselineRoad = -1;
    state.selectedKind = null;
  }
  deps.rebuildWorld();
  return { ok: true, midIdx: midOverlayIdx };
}

/** DELETE the span: road splits into the surviving outer pieces.
 *  `noSnapshot` when the caller already pushed the undo snapshot. */
export function _weSpanDelete(state: WorldEditorState, deps: DeleteDeps, noSnapshot = false): boolean {
  const r = applySpanSplit(state, deps, { dropMiddle: true, noSnapshot });
  if (r.ok) flash(state, '⧉ span deleted');
  return r.ok;
}

/** ✂ SPLIT only: cut at both points, keep everything, select the middle. */
export function _weSpanSplitOnly(state: WorldEditorState, deps: DeleteDeps): void {
  const r = applySpanSplit(state, deps, {});
  if (r.ok) flash(state, '⧉ road split — middle piece selected');
}

/** Set the span's Z: split, middle piece gets `z`. Returns applied z or
 *  null when refused (no-op z, merge row, incomplete span). */
export function _weSpanSetZ(state: WorldEditorState, deps: SpanDeps, z: number): number | null {
  const curZ = currentSpanRoadZ(state, deps);
  if (curZ !== null && curZ === z) {
    flash(state, '⧉ span is already z=' + z);
    return null;
  }
  const r = applySpanSplit(state, deps, { midZ: z });
  if (!r.ok) return null;
  flash(state, '⧉ span z=' + z + (z >= 2 ? ' (bridge)' : ''));
  return z;
}

/** Bridge-checkbox semantics for a span: checked → split with middle at
 *  maxCrossedZ+2 (computed over the MIDDLE piece only); unchecked → z=0.
 *  Returns the applied z or null when refused. */
export function _weSpanBridge(state: WorldEditorState, deps: SpanDeps, checked: boolean): number | null {
  if (!checked) return _weSpanSetZ(state, deps, 0);
  if (!_weSpanComplete(state) || !state.spanA || !state.spanB) {
    flash(state, '⧉ span: pick 2 points on one road first');
    return null;
  }
  const pts = selectedRoadPts(state, deps);
  if (!pts) return null;
  const mat = _weSpanMaterializeCuts(pts, state.spanA, state.spanB);
  if (!mat) {
    flash(state, '⧉ span too short — pick points further apart');
    return null;
  }
  const midPts = mat.pts.slice(mat.vA, mat.vB + 1).map((p) => [p[0], p[1]]);
  const z = deps.computeMaxCrossedZ({ pts: midPts }) + 2;
  return _weSpanSetZ(state, deps, z);
}

/** Materialize the span cuts IN PLACE on the selected road (no split) so
 *  material/age overrides can cover exactly the span. Overlay: vertices
 *  spliced into the row; baseline: into baselineEdits (road STAYS
 *  baseline — geometry edits are a supported baseline mechanism). The
 *  road's existing sidecar override list is re-based for the inserts.
 *  spanA/spanB are re-armed on the new vertices (t=0) so repeated
 *  material/age clicks are idempotent (cuts snap to the same vertices).
 *  Returns the cut vertex range or null when refused. Caller is
 *  responsible for the undo snapshot. */
export function _weSpanEnsureCuts(
  state: WorldEditorState,
  deps: DeleteDeps,
): { vA: number; vB: number } | null {
  if (!_weSpanComplete(state) || !state.spanA || !state.spanB) return null;
  if (selectedIsMergeRow(state)) return null;
  const pts = selectedRoadPts(state, deps);
  if (!pts) return null;
  const mat = _weSpanMaterializeCuts(pts, state.spanA, state.spanB);
  if (!mat) return null;
  const { pts: pts2, vA, vB, inserted } = mat;

  if (inserted.length > 0) {
    if (state.selectedKind === 'road') {
      const row = state.overlay[state.selected] as (string | number)[];
      const flat: number[] = [];
      for (const p of pts2) flat.push(p[0], p[1]);
      row.splice(4, row.length - 4, ...flat); // plain 4-meta row (merge refused above)
      const ovMap = state.overlayMaterialOverrides;
      const key = String(state.selected);
      if (ovMap?.[key]?.length) ovMap[key] = shiftOverridesForInserts(ovMap[key], inserted);
    } else {
      const idx = state.selectedBaselineRoad;
      if (idx < 0 || idx >= BASELINE_ROADS.length) return null;
      state.baselineEdits[String(idx)] = pts2.map((p) => [p[0], p[1]]);
      const ovMap = state.baselineMaterialOverrides;
      const key = String(idx);
      if (ovMap?.[key]?.length) ovMap[key] = shiftOverridesForInserts(ovMap[key], inserted);
    }
  }
  // Re-arm the span ON the cut vertices (t=0 snaps back to them).
  state.spanA = { seg: vA, t: 0, x: pts2[vA][0], y: pts2[vA][1] };
  state.spanB = { seg: vB, t: 0, x: pts2[vB][0], y: pts2[vB][1] };
  return { vA, vB };
}

/** Current z of the span's road (overlay row[3] / baseline z). */
function currentSpanRoadZ(state: WorldEditorState, deps: DeleteDeps): number | null {
  if (state.selectedKind === 'road' && state.selected >= 0) {
    const row = state.overlay[state.selected] as (string | number)[] | undefined;
    return row ? ((row[3] as number) || 0) : null;
  }
  if (state.selectedKind === 'baselineRoad' && state.selectedBaselineRoad >= 0) {
    const base = deps.getBaselineMajorRoads()[state.selectedBaselineRoad];
    return base ? (base.z || 0) : null;
  }
  return null;
}

/** Span sub-polyline (partial end segments + interior vertices) for the
 *  render highlight. When only spanA is armed, returns the single cut
 *  point. Works off the RAW polyline (the wide semi-transparent stroke
 *  masks smoothing divergence on curves). */
export function _weSpanHighlightPts(
  state: WorldEditorState,
  pts: readonly TilePoint[],
): TilePoint[] {
  const a = state.spanA;
  const b = state.spanB;
  if (!a) return [];
  if (!b) return [[a.x, a.y]];
  let lo = a, hi = b;
  if (hi.seg + hi.t < lo.seg + lo.t) { lo = b; hi = a; }
  const out: TilePoint[] = [[lo.x, lo.y]];
  for (let v = lo.seg + 1; v <= hi.seg; v++) {
    if (v >= 0 && v < pts.length) out.push([pts[v][0], pts[v][1]]);
  }
  out.push([hi.x, hi.y]);
  return out;
}
