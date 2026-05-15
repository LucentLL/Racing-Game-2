/**
 * World Editor — read DOM props + export to clipboard + reload baseline.
 *
 * Three responsibilities, grouped because they all bridge the editor's
 * row-array state to the outside world (DOM inputs in / clipboard out /
 * full-state reset).
 *
 * READ PROPS (`_weReadProps`):
 * Pulls every DOM input value (#wePropName, #wePropZ, #wePropMaj,
 * #wePropMerge, #wePropDriveway, #wePropArc, #wePropCurve,
 * #wePropLoopDiam) into the right *Props bag on WORLD_EDITOR. The
 * Z value clamps to [0, 10] (v8.99.124.39 bump from [0, 3] to allow
 * stacked bridges — a bridge over a z=4 baseline gets z=6, over that
 * z=8, etc.). Curve clamps to [-200, 200], loopDiameter to [0, 200].
 * Name clamps to 40 chars. The wePropW input was removed in
 * v8.99.124.23 in favor of lane buttons; draftProps.w is now driven
 * by the lane button click handler in editor/ui.ts. wePropType was
 * removed in v126.42 (dead UI; buildingProps.type stays at default
 * 'house' from initializer).
 *
 * DRAFT MID-EDIT SYNC: if a draft is in flight, ReadProps also syncs
 * the relevant fields onto the live draft so user setting changes
 * reflect in the next preview frame. v126.00 syncs draft.merge so the
 * schema-version chosen at commit time matches what the user last
 * selected (no surprise downgrade after a mid-draft toggle). v126.05
 * syncs draft.mergeAlign so live L/C/R changes reflect in the
 * preview. v126.36 syncs draft.mergeType in the same way (handled in
 * the merge-type button handler in ui.ts).
 *
 * BRIDGE/Z ONE-WAY SYNC: this function does NOT reverse-sync Bridge
 * from Z. The Bridge → Z direction lives in the Bridge change handler
 * (ui.ts); reverse-syncing here would race with that handler's own
 * input event.
 *
 * EXPORT (`_weExport`):
 * Emits a copy-paste-able JS-array text dump of every overlay row,
 * organized into five blocks: roads (_rp format), surfaces, buildings,
 * rivers (v124.28), lakes (v124.28). Roads use parity-based detection
 * — odd row.length emits the 5-meta merge schema with the merge column
 * present; even emits the 4-meta legacy schema. Coordinates serialize
 * as integers when v%1===0, otherwise .toFixed(2). The text lands in
 * #weExportArea (a hidden textarea), which is then revealed +
 * focused + selected + document.execCommand('copy') for clipboard.
 * showNotif('Overlay copied to clipboard.') confirms success (when
 * available — guarded by typeof check).
 *
 * RELOAD BASELINE (`_weReloadBaseline`):
 * Full editor-state reset. Confirms first (this one HAS the confirm —
 * unlike _weDeleteSelected — because reloading wipes ALL overlay
 * content + baseline edits + sidecar maps, and is genuinely
 * non-recoverable without an export). Clears every overlay row array,
 * every selection index, every active vertex, plus:
 *
 *   v8.99.126.46: deep-copies _weBaselineMajorRoadsOriginal back over
 *     _weBaselineMajorRoads so vertex edits revert. The original is
 *     the IMMUTABLE snapshot captured once at editor init.
 *   v8.99.126.47: clears WORLD_EDITOR.baselineDeletes so deleted
 *     permanent roads return to their slots.
 *   v8.99.126.50: clears baseline + overlay sidecar maps
 *     (baselineRoadProps, baselineMaterialOverrides, overlayRoadProps,
 *     overlayMaterialOverrides) so per-road/per-section material/age
 *     overrides revert.
 *
 * _weRebuildWorld at the end persists the empty state via
 * _weSaveOverlayToStorage. _weSaveBaselineEdits also writes the empty
 * baseline state so the revert survives reload.
 *
 * Ported from monolith L16379-16609.
 *
 * SCAFFOLD status: type contract + entry points stubbed with TODO line refs.
 */

import type { WorldEditorState } from './index';

/** DOM input id → editor-state field map. Exported so editor/ui.ts can
 *  reuse this mapping when wiring change listeners. */
export const PROP_INPUT_IDS = {
  name: 'wePropName',
  z: 'wePropZ',
  major: 'wePropMaj',
  bridge: 'wePropBridge',
  driveway: 'wePropDriveway',
  merge: 'wePropMerge',
  arc: 'wePropArc',
  curve: 'wePropCurve',
  loopDiam: 'wePropLoopDiam',
  angle: 'wePropAngle',
} as const;

/** Z input clamp range. v8.99.124.39 bumped upper bound 3 → 10 to
 *  allow stacked bridges. */
export const Z_MIN = 0;
export const Z_MAX = 10;

/** Curve input clamp range. */
export const CURVE_MIN = -200;
export const CURVE_MAX = 200;

/** Loop diameter clamp range. v8.99.126.39. */
export const LOOP_DIAM_MIN = 0;
export const LOOP_DIAM_MAX = 200;

/** Name input character limit. */
export const NAME_MAX_LEN = 40;

/** Building type input character limit. (Currently dead UI per
 *  v126.42 but the clamp is retained for the type-from-initializer
 *  path.) */
export const TYPE_MAX_LEN = 20;

/** Host bindings for export. */
export interface ExportDeps {
  /** Live baseline ORIGINAL snapshot (immutable). Used by
   *  _weReloadBaseline to deep-copy back to the live baseline. */
  getBaselineMajorRoadsOriginal(): Array<{
    w: number;
    maj: number;
    name: string;
    z: number;
    pts: number[][];
    bridgePts?: Array<{ x: number; y: number }>;
  }> | null;
  /** Setter for the live baseline copy (so reload can swap it). */
  setBaselineMajorRoads(roads: Array<{
    w: number;
    maj: number;
    name: string;
    z: number;
    pts: number[][];
    bridgePts?: Array<{ x: number; y: number }>;
  }>): void;
  saveBaselineEdits(): void;
  rebuildWorld(): void;
  /** Native confirm. Stubbed in tests / headless contexts. */
  confirm(msg: string): boolean;
  /** Optional notification helper (showNotif). Called after successful
   *  clipboard copy. The export still works without this — it's purely
   *  cosmetic. */
  showNotif?(msg: string): void;
}

/** Read DOM input values into WORLD_EDITOR.*Props bags. Also syncs
 *  live draft fields if a draft is in flight. TODO(E37-followup): port
 *  from L16379-16454. */
export function _weReadProps(_state: WorldEditorState): void {
  // TODO: L16379-16454.
  //   1. For each PROP_INPUT_IDS, lookup the element; if present, parse
  //      + clamp into the right *Props bag (draftProps for road-y
  //      values, surfaceProps for surface name+z, buildingProps for
  //      building name+type+driveway).
  //   2. Z clamp via Z_MIN/Z_MAX; curve via CURVE_MIN/CURVE_MAX;
  //      loopDiam via LOOP_DIAM_MIN/LOOP_DIAM_MAX; name via NAME_MAX_LEN.
  //   3. NAME is shared across draftProps, surfaceProps, buildingProps
  //      (one source of truth for the name input).
  //   4. NO reverse-sync of Bridge from Z (race avoidance — see ui.ts
  //      Bridge handler).
  //   5. Live draft sync: if state.draft, copy the relevant fields
  //      from draftProps/surfaceProps/buildingProps onto state.draft.
  //   6. needsRedraw = true if a draft was synced.
}

/** Export the overlay to a copy-paste-able JS-array text dump and
 *  copy to clipboard via document.execCommand('copy'). Five blocks:
 *  roads, surfaces, buildings, rivers, lakes. TODO(E37-followup): port
 *  from L16456-16559. */
export function _weExport(_state: WorldEditorState, _deps: ExportDeps): void {
  // TODO: L16456-16559.
  //   1. Build a lines: string[] array.
  //   2. ROADS: parity-detect (r.length & 1)===1 for 5-meta merge
  //      schema. Emit `[w, maj, name, z, 1, ...pts]` with merge column;
  //      else `[w, maj, name, z, ...pts]`.
  //   3. SURFACES: `[name, z, ...pts]` (xStart=2).
  //   4. BUILDINGS: `[name, type, ...pts]` (xStart=2).
  //   5. RIVERS: `[w, name, ...pts]` (xStart=2).
  //   6. LAKES: `[name, ...pts]` (xStart=1).
  //   7. Coord serialization: integer if v%1===0, else v.toFixed(2).
  //   8. Push text into #weExportArea, focus + select + execCommand copy,
  //      try deps.showNotif on success.
}

/** Full editor-state reset: clears all overlay row arrays, reverts
 *  baseline geometry to original, clears baselineDeletes + sidecar
 *  maps, persists empty state. Confirms first (genuinely non-
 *  recoverable). TODO(E37-followup): port from L16561-16609. */
export function _weReloadBaseline(_state: WorldEditorState, _deps: ExportDeps): void {
  // TODO: L16561-16609.
  //   1. deps.confirm with the explicit warning; bail on false.
  //   2. Clear overlay/surfaces/buildings/rivers/lakes.
  //   3. Clear every selected* index + selectedKind + activeVertex.
  //   4. Deep-copy deps.getBaselineMajorRoadsOriginal() → live baseline
  //      via deps.setBaselineMajorRoads (v126.46).
  //   5. Clear baselineEdits, baselineDeletes (v126.47),
  //      baselineRoadProps, baselineMaterialOverrides, overlayRoadProps,
  //      overlayMaterialOverrides (v126.50).
  //   6. deps.saveBaselineEdits + deps.rebuildWorld (which itself runs
  //      _weSaveOverlayToStorage with the empty arrays).
}
