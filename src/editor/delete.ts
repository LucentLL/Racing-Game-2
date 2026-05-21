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

/** Host bindings for delete + material apply. */
export interface DeleteDeps {
  /** Live majorRoads array (mutated by overlay-row deletes). */
  getMajorRoads(): Array<{ pts: number[][]; w: number; [k: string]: unknown }>;
  /** Baseline length so the apply helper can locate overlay roads as
   *  majorRoads[baseLen + selected]. */
  getBaselineLength(): number;
  /** Live baseline copy (for baseline-road material writes). */
  getBaselineMajorRoads(): MaterialBearingRoad[];
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
 *  three-mode road delete matrix. TODO(E36-followup): port from
 *  L15472-15641. */
export function _weDeleteSelected(
  _state: WorldEditorState,
  _deps: DeleteDeps,
): void {
  // TODO: L15472-15641.
  //   Baseline road: push idx into baselineDeletes (v126.47), DO NOT
  //   mutate pts; rebuildWorld.
  //   Overlay road, Point mode: splice activeVertex out of pts. If
  //   N<2, drop the row. Else encode coords back into row.
  //   Overlay road, Section mode: _weSplitOrTrimOverlayRow at
  //   selectedSegmentIdx; replace original with 0/1/2 survivors.
  //   Overlay road, Whole mode: overlay.splice(selected, 1).
  //   Surface/building/river/lake: row-array splice at the appropriate
  //   selection index.
  //   All paths: clear selection state, _weRebuildWorld.
}
