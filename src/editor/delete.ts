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
 *  Parity bit on row.length decides 4-meta vs 5-meta schema.
 *  TODO(E36-followup): port from L15336-15363. */
export function _weSplitOrTrimOverlayRow(_row: unknown[], _si: number): unknown[][] | null {
  // TODO: L15336-15363.
  //   hasMerge = (row.length & 1) === 1. ptStart = hasMerge ? 5 : 4.
  //   Decode pts as N=(row.length-ptStart)/2 pairs. Single-segment
  //   (N===2) → []. si===0 → trim front. si===N-2 → trim back.
  //   Interior → split into two meta-prefixed rows.
  return null;
}

/** Look up effective (material, age) for a given segment of a road,
 *  honoring per-section overrides if any. TODO(E36-followup): port
 *  from L15370-15385. */
export function _weEffectiveMaterialAge(
  _road: MaterialBearingRoad,
  _segIdx: number,
  _deps: DeleteDeps,
): MaterialAge {
  // TODO: L15370-15385. Start with road-level defaults; if
  // road.materialOverrides contains an entry with .seg === segIdx,
  // apply material (asphalt|concrete only) and age (new|old only;
  // 'auto' falls through to road age).
  return { material: 'asphalt', age: 'auto' };
}

/** Apply a material or age value to the right scope based on selection.
 *  TODO(E36-followup): port from L15396-15471. */
export function _weApplyMaterialOrAge(
  _field: 'material' | 'age',
  _value: 'asphalt' | 'concrete' | 'new' | 'old' | 'auto',
  _state: WorldEditorState,
  _deps: DeleteDeps,
): void {
  // TODO: L15396-15471.
  //   1. Locate selected road (overlay = majorRoads[baseLen+selected];
  //      baseline = _weBaselineMajorRoads[selectedBaselineRoad]).
  //   2. No road → draftProps[field] = value; return.
  //   3. Section mode (selectedSegmentIdx >= 0) → push/find entry in
  //      road.materialOverrides; mirror to sidecar maps (and to
  //      _weBaselineMajorRoads[idx] for baseline).
  //   4. Whole/Point mode → road[field] = value; mirror to sidecar.
  //   5. Save the relevant storage (baseline vs overlay).
  //   6. needsRedraw = true.
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
