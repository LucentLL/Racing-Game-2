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
 *  live draft fields if a draft is in flight. Ported 1:1 from monolith
 *  L16379-16454. */
export function _weReadProps(state: WorldEditorState): void {
  // v8.99.124.23: wePropW removed in favor of lane buttons. draftProps.w is
  // driven by the lane button click handler in ui.ts; this function reads
  // everything else.
  const nEl = document.getElementById(PROP_INPUT_IDS.name) as HTMLInputElement | null;
  const zEl = document.getElementById(PROP_INPUT_IDS.z) as HTMLInputElement | null;
  const mEl = document.getElementById(PROP_INPUT_IDS.major) as HTMLInputElement | null;
  const brEl = document.getElementById(PROP_INPUT_IDS.bridge) as HTMLInputElement | null;
  void brEl; // v126.42: kept symmetric with monolith; brEl is read in the Bridge change handler in ui.ts, not here.
  const tEl: HTMLInputElement | null = null;
  // v126.42: wePropType input removed (was dead UI). buildingProps.type stays
  // at default 'house' from initializer. tEl retained as null to preserve the
  // 1:1 monolith structure of this block.
  const dwEl = document.getElementById(PROP_INPUT_IDS.driveway) as HTMLInputElement | null;
  if (nEl) {
    const nv = (nEl.value || 'New Road').slice(0, NAME_MAX_LEN);
    state.draftProps.name = nv;
    state.surfaceProps.name = nv;
    state.buildingProps.name = nv;
  }
  if (zEl) {
    // v8.99.124.39: clamp upper bound bumped 3 → 10 to allow stacked bridges
    // (a user bridge over a z=4 baseline highway gets z=6, a bridge over
    // that gets z=8, etc.).
    const zv = Math.max(Z_MIN, Math.min(Z_MAX, parseInt(zEl.value) || 0));
    state.draftProps.z = zv;
    state.surfaceProps.z = zv;
    // Note: NOT syncing Bridge from Z here. The Bridge → Z direction lives
    // in the Bridge change handler in ui.ts; reverse-syncing would race
    // with that handler's own input event.
  }
  if (mEl) state.draftProps.maj = mEl.checked ? 1 : 0;
  // v8.99.126.00: read the Merge checkbox into draftProps. The Merge change
  // handler in ui.ts handles the mutation of any selected row — this read
  // only updates draftProps for the next draft, mirroring how Major works.
  const mgEl = document.getElementById(PROP_INPUT_IDS.merge) as HTMLInputElement | null;
  if (mgEl) state.draftProps.merge = !!mgEl.checked;
  if (tEl) state.buildingProps.type = ((tEl as HTMLInputElement).value || 'house').slice(0, TYPE_MAX_LEN);
  if (dwEl) state.buildingProps.autoDriveway = !!dwEl.checked;
  // v8.99.124.30: Arc + Curve. These live on draftProps (not surface/lake/etc
  // because Arc currently only applies to road and river drafts). Read every
  // input event so the user can scrub the Curve number while drafting and
  // see the preview shape update live.
  const arcEl = document.getElementById(PROP_INPUT_IDS.arc) as HTMLInputElement | null;
  const curveEl = document.getElementById(PROP_INPUT_IDS.curve) as HTMLInputElement | null;
  if (arcEl) state.draftProps.arc = !!arcEl.checked;
  if (curveEl) {
    const cv = parseFloat(curveEl.value);
    state.draftProps.curve = isFinite(cv) ? Math.max(CURVE_MIN, Math.min(CURVE_MAX, cv)) : 0;
  }
  // v8.99.126.39: read Loop Diameter input (used only when mergeType=1).
  const ldEl = document.getElementById(PROP_INPUT_IDS.loopDiam) as HTMLInputElement | null;
  if (ldEl) {
    const ld = parseFloat(ldEl.value);
    state.draftProps.loopDiameter = isFinite(ld) ? Math.max(LOOP_DIAM_MIN, Math.min(LOOP_DIAM_MAX, ld)) : 0;
  }
  if (state.draft) {
    if (state.draft.kind === 'road') {
      state.draft.w = state.draftProps.w;
      state.draft.name = state.draftProps.name;
      state.draft.z = state.draftProps.z;
      state.draft.maj = state.draftProps.maj;
      // v8.99.126.00: keep draft.merge in sync with the live checkbox so the
      // schema-version chosen at commit time matches what the user last
      // selected (no surprise downgrade after a mid-draft toggle).
      state.draft.merge = !!state.draftProps.merge;
      // v8.99.126.05: sync mergeAlign too so live L/C/R changes reflect
      // immediately in the draft preview.
      state.draft.mergeAlign = state.draftProps.mergeAlign || 1;
    } else if (state.draft.kind === 'surface') {
      state.draft.name = state.surfaceProps.name;
      state.draft.z = state.surfaceProps.z;
    } else if (state.draft.kind === 'building') {
      state.draft.name = state.buildingProps.name;
      state.draft.type = state.buildingProps.type;
      state.draft.autoDriveway = state.buildingProps.autoDriveway;
    }
    state.needsRedraw = true;
  }
}

/** Serialize a row coordinate value: integer if whole, else .toFixed(2);
 *  any non-number value passes through JSON.stringify. Shared by every
 *  block in _weExport. */
function fmtCoord(v: unknown): string {
  if (typeof v === 'number') return v % 1 === 0 ? v.toString() : v.toFixed(2);
  return JSON.stringify(v);
}

/** Export the overlay to a copy-paste-able JS-array text dump and
 *  copy to clipboard via document.execCommand('copy'). Five blocks:
 *  roads, surfaces, buildings, rivers, lakes. Ported 1:1 from monolith
 *  L16456-16559. */
export function _weExport(state: WorldEditorState, deps: ExportDeps): void {
  const lines: string[] = [];
  lines.push('// === World Editor — overlay export ===');
  // Roads block
  if (state.overlay.length) {
    lines.push('// Roads (paste rows into _rp array):');
    for (const r of state.overlay as unknown[][]) {
      const w = r[0] as number, maj = r[1] as number;
      const name = r[2] as string, z = r[3] as number;
      // v8.99.126.00: merge-aware export. Detect schema by length parity
      // (matches _weApplyOverlay + _rp loader) and emit the merge column
      // when present so paste-back preserves the merge designation.
      const hasMerge126 = (r.length & 1) === 1;
      const merge = hasMerge126 ? !!r[4] : false;
      const ptStart126 = hasMerge126 ? 5 : 4;
      const ptsStr: string[] = [];
      for (let i = ptStart126; i < r.length; i++) ptsStr.push(fmtCoord(r[i]));
      const head = merge
        ? '[' + w + ',' + (maj ? 1 : 0) + ',' + JSON.stringify(name) + ',' + z + ',1,'
        : '[' + w + ',' + (maj ? 1 : 0) + ',' + JSON.stringify(name) + ',' + z + ',';
      lines.push(head + ptsStr.join(',') + '],');
    }
  } else {
    lines.push('// (no overlay roads)');
  }
  // Surfaces block
  lines.push('');
  if (state.surfaces.length) {
    lines.push('// Surfaces — closed polygon footprints (paste into a _surfaces array):');
    lines.push('// Format: [name, z, x1,y1, x2,y2, ...]');
    for (const s of state.surfaces as unknown[][]) {
      const name = s[0] as string, z = s[1] as number;
      const ptsStr: string[] = [];
      for (let i = 2; i < s.length; i++) ptsStr.push(fmtCoord(s[i]));
      lines.push('[' + JSON.stringify(name) + ',' + z + ',' + ptsStr.join(',') + '],');
    }
  } else {
    lines.push('// (no surfaces)');
  }
  // Buildings block
  lines.push('');
  if (state.buildings.length) {
    lines.push('// Buildings — closed polygon footprints (paste into a _buildings array):');
    lines.push('// Format: [name, type, x1,y1, x2,y2, ...]');
    for (const b of state.buildings as unknown[][]) {
      const name = b[0] as string, type = b[1] as string;
      const ptsStr: string[] = [];
      for (let i = 2; i < b.length; i++) ptsStr.push(fmtCoord(b[i]));
      lines.push('[' + JSON.stringify(name) + ',' + JSON.stringify(type) + ',' + ptsStr.join(',') + '],');
    }
  } else {
    lines.push('// (no buildings)');
  }
  // Rivers block (v8.99.124.28)
  lines.push('');
  if (state.rivers.length) {
    lines.push('// Rivers — open polylines stamped as tile=9 water (paste into a _rivers array):');
    lines.push('// Format: [w, name, x1,y1, x2,y2, ...]');
    for (const rv of state.rivers as unknown[][]) {
      const w = rv[0] as number, name = rv[1] as string;
      const ptsStr: string[] = [];
      for (let i = 2; i < rv.length; i++) ptsStr.push(fmtCoord(rv[i]));
      lines.push('[' + w + ',' + JSON.stringify(name) + ',' + ptsStr.join(',') + '],');
    }
  } else {
    lines.push('// (no rivers)');
  }
  // Lakes block (v8.99.124.28)
  lines.push('');
  if (state.lakes.length) {
    lines.push('// Lakes — closed polygons stamped as tile=9 water (paste into a _lakes array):');
    lines.push('// Format: [name, x1,y1, x2,y2, ...]');
    for (const lk of state.lakes as unknown[][]) {
      const name = lk[0] as string;
      const ptsStr: string[] = [];
      for (let i = 1; i < lk.length; i++) ptsStr.push(fmtCoord(lk[i]));
      lines.push('[' + JSON.stringify(name) + ',' + ptsStr.join(',') + '],');
    }
  } else {
    lines.push('// (no lakes)');
  }
  const text = lines.join('\n');
  const ta = document.getElementById('weExportArea') as HTMLTextAreaElement | null;
  if (ta) {
    ta.value = text;
    ta.style.display = 'block';
    ta.focus();
    ta.select();
    try {
      document.execCommand('copy');
      if (deps.showNotif) deps.showNotif('Overlay copied to clipboard.');
    } catch {
      // execCommand can throw in iframes without focus; swallow exactly
      // like the monolith does (the text is still selected in the
      // textarea so the user can Ctrl+C manually).
    }
  }
}

/** Full editor-state reset: clears all overlay row arrays, reverts
 *  baseline geometry to original, clears baselineDeletes + sidecar
 *  maps, persists empty state. Confirms first (genuinely non-
 *  recoverable). Ported 1:1 from monolith L16561-16609. */
export function _weReloadBaseline(state: WorldEditorState, deps: ExportDeps): void {
  if (!deps.confirm(
    'Clear ALL overlay roads, surfaces, buildings, rivers, and lakes and restore baseline? ' +
    'This cannot be undone (export first to keep a copy).',
  )) return;
  state.overlay = [];
  state.surfaces = [];
  state.buildings = [];
  state.rivers = [];
  state.lakes = [];
  state.selected = -1;
  state.selectedSurface = -1;
  state.selectedBuilding = -1;
  state.selectedRiver = -1;
  state.selectedLake = -1;
  // v8.99.126.46: also revert baseline (permanent) road vertex edits.
  // baselineMajorRoadsOriginal is the IMMUTABLE snapshot captured once at
  // startup; deep-copy it back over baselineMajorRoads (the LIVE baseline
  // that vertex edits mutate) so the geometry returns to source-defined
  // state. Then clear the persisted edits map and write that back to
  // localStorage so the revert survives reload.
  state.selectedBaselineRoad = -1;
  const original = deps.getBaselineMajorRoadsOriginal();
  if (original) {
    deps.setBaselineMajorRoads(original.map((r) => ({
      w: r.w,
      maj: r.maj,
      name: r.name,
      z: r.z,
      pts: r.pts.map((p) => [p[0], p[1]]),
      bridgePts: r.bridgePts ? r.bridgePts.map((p) => ({ x: p.x, y: p.y })) : undefined,
    })));
  }
  state.baselineEdits = {};
  // v8.99.126.47: also clear deleted-baseline list. After this Reset, every
  // permanent road returns to its source-defined state — both moved vertices
  // and "deleted" markers are cleared, and the localStorage write below
  // mirrors that empty state to disk.
  state.baselineDeletes = [];
  // v8.99.126.50: also clear baseline + overlay sidecar maps. Reload Baseline
  // returns ALL permanent roads to source state (geometry, deleted-flag,
  // surface choice, per-segment material) AND wipes the overlay sidecars
  // because the overlay arrays themselves were already emptied at the top
  // of this function. _weSaveOverlayToStorage runs inside rebuildWorld and
  // persists the empty state.
  state.baselineRoadProps = {};
  state.baselineMaterialOverrides = {};
  state.overlayRoadProps = {};
  state.overlayMaterialOverrides = {};
  state.selectedSegmentIdx = -1;
  deps.saveBaselineEdits();
  state.activeVertex = -1;
  state.selectedKind = null;
  state.draft = null;
  deps.rebuildWorld();
}
