/**
 * World Editor — delete / split / trim + per-segment material overrides.
 *
 * Three responsibilities, grouped because they all mutate overlay rows
 * (and baseline mirrors) in response to selection state:
 *
 *  1. SPLIT/TRIM (`_weSplitOrTrimOverlayRow`): given an overlay road
 *     row and a segment index, decode meta+pts via the parity-based
 *     schema and return one of:
 *       - []          → row fully consumed (single-segment delete)
 *       - [row]       → trimmed (first or last segment dropped, outer
 *                       endpoint removed)
 *       - [rowA, rowB] → interior split (both halves inherit meta)
 *
 *  2. MATERIAL/AGE EFFECTIVE LOOKUP + SCOPE WRITE (v8.99.126.50): the
 *     Section sub-mode lets the user paint per-segment material/age
 *     overrides on a road without affecting the rest of the road. The
 *     effective lookup honors overrides; the apply helper writes to
 *     the right scope based on selection mode:
 *       Section selected (selectedSegmentIdx>=0)
 *         → road.materialOverrides[seg] + sidecar mirror.
 *           For baseline roads, mirror to BOTH the live
 *           _weBaselineMajorRoads[idx] AND
 *           WORLD_EDITOR.baselineMaterialOverrides[idx] so the deep-
 *           copy path in _weApplyOverlay picks it up.
 *       Road selected (whole/point mode)
 *         → road[field] + sidecar.
 *       Nothing selected
 *         → draftProps[field]. Newly-drawn roads inherit.
 *     Override entries with age='auto' fall through to road-level age —
 *     only explicit 'new'/'old' actually overrides.
 *
 *  3. DELETE (`_weDeleteSelected`): v8.99.124.22 removed confirm()
 *     because many mobile webviews silently return false from confirm()
 *     without showing any dialog, which made the Delete button appear
 *     non-functional on mobile. Single-item delete is recoverable via
 *     redrawing or reloading — the safety net the confirm provided
 *     wasn't worth the mobile UX loss.
 *
 *     Behavior branches on selectedKind + selectMode:
 *       Point mode + road  → splice the single vertex out of pts. If
 *                            pts goes below 2, drop the row entirely.
 *       Section mode + road → call _weSplitOrTrimOverlayRow, splice the
 *                             original row out, insert the returned 0-2
 *                             survivors.
 *       Whole mode + road  → delete the row entirely.
 *       Surface/building/river/lake → row delete.
 *       Baseline road      → push idx into baselineDeletes (v126.47);
 *                            DON'T mutate pts — the slot must be kept
 *                            for pick-index alignment.
 *
 * Ported from monolith L15336-15642.
 *
 * SCAFFOLD status: type contract + entry points stubbed with TODO line refs.
 */

import type { WorldEditorState } from './index';

/** Material/age scope value pair. */
export interface MaterialAge {
  material: 'asphalt' | 'concrete';
  age: 'new' | 'old' | 'auto';
}

/** Per-segment override entry. age='auto' = fall through to road-level. */
export interface MaterialOverride {
  seg: number;
  material?: 'asphalt' | 'concrete';
  age?: 'new' | 'old' | 'auto';
}

/** Shape the lookup expects. road.material / road.age default when no
 *  override entry exists for the queried segment. */
export interface MaterialBearingRoad {
  material?: 'asphalt' | 'concrete';
  age?: 'new' | 'old' | 'auto';
  materialOverrides?: MaterialOverride[];
}

/** Live baseline road shape needed by the delete + material paths. Adds
 *  the structural fields (pts/w/maj/name/z) on top of MaterialBearingRoad
 *  so the section-delete branch can read+slice baseline geometry as well
 *  as mutate material overrides. */
export interface BaselineRoadEntry extends MaterialBearingRoad {
  pts: number[][];
  w: number;
  maj: number;
  name: string;
  z: number;
}

/** Host bindings for delete + material apply. */
export interface DeleteDeps {
  /** Live majorRoads array (mutated by overlay-row deletes). */
  getMajorRoads(): Array<{ pts: number[][]; w: number; [k: string]: unknown }>;
  /** Baseline length so the apply helper can locate overlay roads as
   *  majorRoads[baseLen + selected]. */
  getBaselineLength(): number;
  /** Live baseline copy. Carries pts/w/maj/name/z plus the optional
   *  material/age/materialOverrides fields the apply helper writes. */
  getBaselineMajorRoads(): BaselineRoadEntry[];
  /** Persistence triggers — keep the live state in sync with storage. */
  saveBaselineEdits(): void;
  saveOverlayToStorage(state: WorldEditorState): void;
  /** Default road-level material/age resolution when nothing is set.
   *  Mirrors the source's _roadMaterial / _roadAge helpers which apply
   *  v126.50 defaults (asphalt + auto). */
  defaultMaterial(road: MaterialBearingRoad): 'asphalt' | 'concrete';
  defaultAge(road: MaterialBearingRoad): 'new' | 'old' | 'auto';
  rebuildWorld(): void;
}

/** Split or trim an overlay road row at segment index si. Returns:
 *    - []         → fully consumed (caller deletes the row)
 *    - [row]      → trimmed (caller replaces original with this)
 *    - [rowA, rowB] → split (caller replaces original with both)
 *    - null       → invalid si (caller leaves row untouched)
 *
 *  Schema:
 *    Even-length row → 4-meta [w, maj, name, z, x1, y1, x2, y2, ...].
 *    Odd-length row  → 5-meta [w, maj, name, z, mergeFlag, x1, y1, ...].
 *  Parity bit on `row.length & 1` decides which prefix applies.
 *
 *  Behavior:
 *    - Single-segment input (N === 2) → return [] (caller deletes
 *      the row entirely; trimming either end leaves nothing).
 *    - si === 0       → drop pts[0], keep pts[1..N-1] (trim front).
 *    - si === N-2     → drop pts[N-1], keep pts[0..N-2] (trim back).
 *    - 0 < si < N-2   → split into [meta + pts[0..si]] and
 *                       [meta + pts[si+1..N-1]]. Both inherit the
 *                       original meta prefix (including the merge
 *                       flag when present). Each piece is guaranteed
 *                       ≥ 2 pts since si is strictly interior.
 *
 *  Invalid si (< 0 or >= N-1) returns null so the caller can leave
 *  the row untouched.
 *
 *  Ported 1:1 from monolith _weSplitOrTrimOverlayRow (L15336-15363). */
export function _weSplitOrTrimOverlayRow(row: unknown[], si: number): unknown[][] | null {
  const hasMerge = (row.length & 1) === 1;
  const ptStart = hasMerge ? 5 : 4;
  const meta = row.slice(0, ptStart);
  const pts: Array<[unknown, unknown]> = [];
  for (let i = ptStart; i + 1 < row.length; i += 2) pts.push([row[i], row[i + 1]]);
  const N = pts.length;
  if (si < 0 || si >= N - 1) return null;
  if (N === 2) return [];
  if (si === 0) {
    const survivor = meta.concat(pts.slice(1).flat());
    return [survivor];
  }
  if (si === N - 2) {
    const survivor = meta.concat(pts.slice(0, N - 1).flat());
    return [survivor];
  }
  const rowA = meta.concat(pts.slice(0, si + 1).flat());
  const rowB = meta.concat(pts.slice(si + 1).flat());
  return [rowA, rowB];
}

/** Look up effective (material, age) for a given segment of a road,
 *  honoring per-section overrides if any. Mirrors monolith
 *  L15370-L15385 _weEffectiveMaterialAge. Override entries with
 *  age='auto' fall through to road-level age — only explicit
 *  'new'/'old' actually overrides; same for material (only explicit
 *  'asphalt'/'concrete' overrides; anything else leaves the road
 *  default in place). */
export function _weEffectiveMaterialAge(
  road: MaterialBearingRoad,
  segIdx: number,
  deps: DeleteDeps,
): MaterialAge {
  let material: 'asphalt' | 'concrete' = road.material ?? deps.defaultMaterial(road);
  let age: 'new' | 'old' | 'auto' = road.age ?? deps.defaultAge(road);
  if (Array.isArray(road.materialOverrides)) {
    for (const o of road.materialOverrides) {
      if (o && o.seg === segIdx) {
        if (o.material === 'asphalt' || o.material === 'concrete') material = o.material;
        if (o.age === 'new' || o.age === 'old') age = o.age;
        break;
      }
    }
  }
  return { material, age };
}

/** Apply a material or age value to the right scope based on selection.
 *  Mirrors monolith L15396-L15471. Three branches:
 *    1. No road selected → writes to draftProps (newly-drawn roads
 *       inherit).
 *    2. Section mode (selectedSegmentIdx >= 0) → upserts an entry in
 *       road.materialOverrides keyed by seg, mirrors to sidecar map.
 *    3. Whole / Point mode → writes road[field] directly + sidecar.
 *  All paths trigger the appropriate storage save and a redraw. */
export function _weApplyMaterialOrAge(
  field: 'material' | 'age',
  value: 'asphalt' | 'concrete' | 'new' | 'old' | 'auto',
  state: WorldEditorState,
  deps: DeleteDeps,
): void {
  // ---- Locate the selected road (baseline vs overlay) ------------------
  const isBaseline =
    state.selectedKind === 'baselineRoad' && state.selectedBaselineRoad >= 0;
  const isOverlay =
    state.selectedKind === 'road' && state.selected >= 0;

  // Branch 1 — nothing selected → write to draftProps so the NEXT
  // drawn road inherits this material/age.
  if (!isBaseline && !isOverlay) {
    if (field === 'material' && (value === 'asphalt' || value === 'concrete')) {
      state.draftProps.material = value;
    } else if (field === 'age' && (value === 'new' || value === 'old' || value === 'auto')) {
      state.draftProps.age = value;
    }
    state.needsRedraw = true;
    return;
  }

  // Resolve the live road object + the sidecar bucket we'll mirror to.
  const baseLen = deps.getBaselineLength();
  let road: MaterialBearingRoad | null = null;
  let idxKey: string;
  let sidecarProps: Record<string, { material?: string; age?: string }>;
  let sidecarOverrides: Record<string, Array<{ seg: number; material?: string; age?: string }>>;
  let save: () => void;
  if (isBaseline) {
    road = deps.getBaselineMajorRoads()[state.selectedBaselineRoad] ?? null;
    idxKey = String(state.selectedBaselineRoad);
    sidecarProps = state.baselineRoadProps ?? (state.baselineRoadProps = {});
    sidecarOverrides = state.baselineMaterialOverrides ?? (state.baselineMaterialOverrides = {});
    save = deps.saveBaselineEdits;
  } else {
    // Overlay: live state has baseline + overlay merged into majorRoads;
    // overlay roads sit past the baseline slice.
    road = (deps.getMajorRoads()[baseLen + state.selected] as MaterialBearingRoad) ?? null;
    idxKey = String(state.selected);
    sidecarProps = state.overlayRoadProps ?? (state.overlayRoadProps = {});
    sidecarOverrides = state.overlayMaterialOverrides ?? (state.overlayMaterialOverrides = {});
    save = () => deps.saveOverlayToStorage(state);
  }
  if (!road) return;

  // Branch 2 — section selected → upsert in road.materialOverrides.
  if (state.selectMode === 'section' && state.selectedSegmentIdx >= 0) {
    const seg = state.selectedSegmentIdx;
    const list = road.materialOverrides ?? (road.materialOverrides = []);
    let entry = list.find((o) => o.seg === seg);
    if (!entry) {
      entry = { seg };
      list.push(entry);
    }
    if (field === 'material' && (value === 'asphalt' || value === 'concrete')) {
      entry.material = value;
    } else if (field === 'age' && (value === 'new' || value === 'old' || value === 'auto')) {
      entry.age = value;
    }
    // Mirror the FULL override list onto the sidecar (the storage layer
    // reads the sidecar, not the road object, when serializing).
    sidecarOverrides[idxKey] = list.slice();
    save();
    state.needsRedraw = true;
    return;
  }

  // Branch 3 — whole / point mode → write road-level + mirror.
  if (field === 'material' && (value === 'asphalt' || value === 'concrete')) {
    road.material = value;
    const props = sidecarProps[idxKey] ?? (sidecarProps[idxKey] = {});
    props.material = value;
  } else if (field === 'age' && (value === 'new' || value === 'old' || value === 'auto')) {
    road.age = value;
    const props = sidecarProps[idxKey] ?? (sidecarProps[idxKey] = {});
    props.age = value;
  }
  save();
  state.needsRedraw = true;
}

/** Delete whatever is currently selected. v8.99.124.22: no confirm()
 *  (silent-false on mobile webviews). Behavior branches on
 *  selectedKind + selectMode — see module-level docstring for the
 *  three-mode road delete matrix.
 *
 *  Polygon kinds (surface / building / river / lake) ignore selectMode
 *  and always perform a whole-row delete — the section/point sub-modes
 *  exist for road geometry only.
 *
 *  Road kinds branch on selectMode:
 *    Point   — splice the single vertex out of pts. If pts goes below
 *              2 (overlay) or 2 (baseline), drop the road entirely
 *              (overlay row splice / baseline pushed to baselineDeletes).
 *    Section — overlay: _weSplitOrTrimOverlayRow at selectedSegmentIdx,
 *              splice the original out, insert 0/1/2 survivors.
 *              baseline: promote the surviving pieces to overlay rows
 *              (legacy 4-meta schema) so the structural change persists
 *              cleanly, then mark the baseline deleted.
 *    Whole   — overlay.splice(selected, 1) / baselineDeletes.push(idx).
 *
 *  All paths clear selection state and rebuildWorld() at the end.
 *  Baseline paths additionally call saveBaselineEdits(); the baseline
 *  section→overlay promotion ALSO calls saveOverlayToStorage(state)
 *  because the new overlay rows need to survive the next reload.
 *
 *  Ported 1:1 from monolith _weDeleteSelected (L15472-15625). */
export function _weDeleteSelected(
  state: WorldEditorState,
  deps: DeleteDeps,
): void {
  // === Polygon / non-road kinds: unchanged behavior (Whole-mode equivalent) ===
  if (state.selectedKind === 'surface' && state.selectedSurface >= 0) {
    state.surfaces.splice(state.selectedSurface, 1);
    state.selectedSurface = -1;
    state.selectedKind = null;
    state.activeVertex = -1;
    deps.rebuildWorld();
    return;
  }
  if (state.selectedKind === 'building' && state.selectedBuilding >= 0) {
    state.buildings.splice(state.selectedBuilding, 1);
    state.selectedBuilding = -1;
    state.selectedKind = null;
    state.activeVertex = -1;
    deps.rebuildWorld();
    return;
  }
  if (state.selectedKind === 'river' && state.selectedRiver >= 0) {
    state.rivers.splice(state.selectedRiver, 1);
    state.selectedRiver = -1;
    state.selectedKind = null;
    state.activeVertex = -1;
    deps.rebuildWorld();
    return;
  }
  if (state.selectedKind === 'lake' && state.selectedLake >= 0) {
    state.lakes.splice(state.selectedLake, 1);
    state.selectedLake = -1;
    state.selectedKind = null;
    state.activeVertex = -1;
    deps.rebuildWorld();
    return;
  }

  // === Road kinds (overlay + baseline) — branch on selectMode ===
  const isOverlay =
    state.selectedKind === 'road' && state.selected >= 0;
  const isBaseline =
    state.selectedKind === 'baselineRoad' && state.selectedBaselineRoad >= 0;
  if (!isOverlay && !isBaseline) return;
  const mode = state.selectMode || 'whole';

  // -------- POINT mode: delete one vertex --------
  if (mode === 'point') {
    if (state.activeVertex < 0) return;
    if (isOverlay) {
      const row = state.overlay[state.selected] as number[];
      const hasMerge = (row.length & 1) === 1;
      const ptStart = hasMerge ? 5 : 4;
      const ptCount = (row.length - ptStart) >> 1;
      const v = state.activeVertex;
      if (v < 0 || v >= ptCount) return;
      // 2 vertices → removing one leaves a degenerate single-point road.
      // Drop the whole row instead of leaving a malformed entry.
      if (ptCount <= 2) {
        state.overlay.splice(state.selected, 1);
        state.selected = -1;
        state.selectedKind = null;
      } else {
        const xi = ptStart + v * 2;
        row.splice(xi, 2);
      }
      state.activeVertex = -1;
      state.selectedSegmentIdx = -1;
      deps.rebuildWorld();
      return;
    }
    // Baseline point delete: shorten the live baseline pts; if down to 1
    // vertex, mark as deleted. Persist via baselineEdits / baselineDeletes.
    const idx = state.selectedBaselineRoad;
    const baseline = deps.getBaselineMajorRoads();
    if (!baseline || idx < 0 || idx >= baseline.length) return;
    const base = baseline[idx];
    const v = state.activeVertex;
    if (v < 0 || v >= base.pts.length) return;
    if (base.pts.length <= 2) {
      // Removing one leaves <2 → degenerate. Mark whole baseline deleted.
      if (!state.baselineDeletes.includes(idx)) state.baselineDeletes.push(idx);
      delete state.baselineEdits[String(idx)];
      state.selectedBaselineRoad = -1;
      state.selectedKind = null;
    } else {
      base.pts.splice(v, 1);
      state.baselineEdits[String(idx)] = base.pts.map((p) => [p[0], p[1]]);
    }
    deps.saveBaselineEdits();
    state.activeVertex = -1;
    state.selectedSegmentIdx = -1;
    deps.rebuildWorld();
    return;
  }

  // -------- SECTION mode: delete one segment (split / trim / collapse) --------
  if (mode === 'section') {
    if (state.selectedSegmentIdx < 0) return;
    const si = state.selectedSegmentIdx;
    if (isOverlay) {
      const row = state.overlay[state.selected] as unknown[];
      const result = _weSplitOrTrimOverlayRow(row, si);
      if (result === null) return;
      if (result.length === 0) {
        state.overlay.splice(state.selected, 1);
        state.selected = -1;
        state.selectedKind = null;
      } else {
        // Replace original with 1 (trim) or 2 (split) survivors. After
        // a split, selection lands on the FIRST piece (which keeps the
        // original index); we drop the section highlight either way.
        state.overlay.splice(state.selected, 1, ...result);
      }
      state.selectedSegmentIdx = -1;
      state.activeVertex = -1;
      deps.rebuildWorld();
      return;
    }
    // Baseline section delete: convert to overlay form. Slice the live
    // (possibly-edited) pts into surviving pieces, push each as a new
    // overlay row preserving w/maj/name/z, then mark the baseline
    // deleted. Equivalent of "promote this permanent road to user-
    // managed so the structural change persists cleanly across reloads."
    const idx = state.selectedBaselineRoad;
    const baseline = deps.getBaselineMajorRoads();
    if (!baseline || idx < 0 || idx >= baseline.length) return;
    const base = baseline[idx];
    const N = base.pts.length;
    if (si < 0 || si >= N - 1) return;
    const w = base.w;
    const maj = base.maj ? 1 : 0;
    const name = base.name || '';
    const z = base.z || 0;
    const pieces: number[][][] = [];
    if (N === 2) {
      // Single segment → no surviving pieces. Just mark deleted.
    } else if (si === 0) {
      pieces.push(base.pts.slice(1));
    } else if (si === N - 2) {
      pieces.push(base.pts.slice(0, N - 1));
    } else {
      pieces.push(base.pts.slice(0, si + 1));
      pieces.push(base.pts.slice(si + 1));
    }
    if (!state.baselineDeletes.includes(idx)) state.baselineDeletes.push(idx);
    delete state.baselineEdits[String(idx)];
    for (const piece of pieces) {
      if (piece.length < 2) continue;
      // Legacy 4-meta (no merge) overlay row schema:
      //   [w, maj, name, z, x1, y1, x2, y2, ...].
      // toFixed(2) matches the monolith's coord-quantization on insert
      // (keeps storage round-trip stable and bounded).
      const row: Array<number | string> = [w, maj, name, z];
      for (const p of piece) {
        row.push(+p[0].toFixed(2), +p[1].toFixed(2));
      }
      state.overlay.push(row);
    }
    deps.saveBaselineEdits();
    // Persist overlay too — rebuildWorld picks up the new rows but the
    // overlay storage save is normally driven from elsewhere; mirror
    // the monolith's explicit save here so a reload survives the
    // baseline-promote operation.
    deps.saveOverlayToStorage(state);
    state.selectedBaselineRoad = -1;
    state.selectedKind = null;
    state.selectedSegmentIdx = -1;
    state.activeVertex = -1;
    deps.rebuildWorld();
    return;
  }

  // -------- WHOLE mode (default): delete the entire road --------
  if (isOverlay) {
    state.overlay.splice(state.selected, 1);
    state.selected = -1;
    state.selectedKind = null;
    state.activeVertex = -1;
    state.selectedSegmentIdx = -1;
    deps.rebuildWorld();
    return;
  }
  // Baseline whole delete: add to baselineDeletes; clear any vertex edits.
  // The slot stays in majorRoads (pushed with empty pts by _weApplyOverlay)
  // so pick-loop indexing remains stable.
  const idx = state.selectedBaselineRoad;
  if (!state.baselineDeletes.includes(idx)) state.baselineDeletes.push(idx);
  delete state.baselineEdits[String(idx)];
  deps.saveBaselineEdits();
  state.selectedBaselineRoad = -1;
  state.selectedKind = null;
  state.activeVertex = -1;
  state.selectedSegmentIdx = -1;
  deps.rebuildWorld();
}
