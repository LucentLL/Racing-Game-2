/**
 * World Editor — localStorage persistence.
 *
 * Two independent keys, by deliberate design (v8.99.126.46):
 *  - WE_STORAGE_KEY (v4)              — overlay content (drawn roads,
 *    surfaces, buildings, rivers, lakes + their sidecar prop maps)
 *  - WE_BASELINE_EDITS_KEY (v1)       — baseline (PERMANENT) road vertex
 *    edits, baseline deletes, baseline per-road material/age, and
 *    per-segment material overrides
 *
 * Separate keys mean a corrupted overlay save can't take baseline edits
 * down with it (and vice versa). This matters because baseline edits
 * carry the user's hand-tuning of the source-defined road grid — losing
 * them silently because an unrelated surface polygon got malformed would
 * be a much worse failure than losing one drawing session's overlay.
 *
 * Schema is forward-additive — each new minor version adds fields
 * (roadProps, materialOverrides, deletes) and old readers ignore them.
 * v3, v2, v1 fallbacks still load and migrate forward on first save.
 *
 * Ported from monolith L9729-9980.
 *
 * SCAFFOLD status: type contract + entry points stubbed with TODO line refs.
 */

import type { WorldEditorState } from './index';

/** Schema versions — all four kept as string constants for the
 *  migration path in _weLoadOverlayFromStorage. */
export const WE_STORAGE_KEY_V1 = 'driverCity_worldEditor_overlay_v1' as const;
export const WE_STORAGE_KEY_V2 = 'driverCity_worldEditor_v2' as const;
export const WE_STORAGE_KEY_V3 = 'driverCity_worldEditor_v3' as const;
/** v8.99.124.28: schema v4 adds rivers (polylines) and lakes (polygons).
 *  Both stamp tile=9 (water), which already has full GBC pixel-art
 *  rendering in the terrain pass and is already classified as off-road
 *  by physics (50% top speed) — so adding water requires NO changes to
 *  the game-side render or physics paths. */
export const WE_STORAGE_KEY = 'driverCity_worldEditor_v4' as const;

/** v8.99.126.46: separate key for baseline (permanent) road vertex
 *  overrides. Schema: {version:1, edits:{[roadIdx]:[[x,y],...]}, deletes:[...],
 *  roadProps:{[idx]:{material,age}}, materialOverrides:{[idx]:[{seg,material,age},...]}}.
 *  Each entry stores the FULL edited pts array so reapplication is just
 *  an overwrite. */
export const WE_BASELINE_EDITS_KEY = 'driverCity_baselineEdits_v1' as const;

/** Shape returned from _weLoadOverlayFromStorage (and from each v3/v2/v1
 *  fallback path after migration normalization). */
export interface OverlayPayload {
  roads: unknown[];
  surfaces: unknown[];
  buildings: unknown[];
  rivers: unknown[];   // empty array on v3/v2/v1 → v4 migration
  lakes: unknown[];    // empty array on v3/v2/v1 → v4 migration
  /** v8.99.126.50: per-overlay-road {material, age}. Keyed by row idx. */
  roadProps: Record<string, { material?: string; age?: string }>;
  /** v8.99.126.50: per-overlay-row per-segment overrides. */
  materialOverrides: Record<string, Array<{ seg: number; material?: string; age?: string }>>;
}

/** Shape returned from _weLoadBaselineEdits. */
export interface BaselineEditsPayload {
  edits: Record<string, number[][]>;
  /** v8.99.126.47: additively added. Old saves load with []. */
  deletes: number[];
  /** v8.99.126.50: per-baseline-road material/age. */
  roadProps: Record<string, { material?: string; age?: string }>;
  /** v8.99.126.50: per-baseline-road per-segment overrides. */
  materialOverrides: Record<string, Array<{ seg: number; material?: string; age?: string }>>;
}

/** Empty payload used as the default when no save key is present. */
function emptyOverlay(): OverlayPayload {
  return {
    roads: [], surfaces: [], buildings: [], rivers: [], lakes: [],
    roadProps: {}, materialOverrides: {},
  };
}

/** H120: load overlay from WE_STORAGE_KEY. Minimal port — handles v4
 *  only. The v3/v2/v1 migration paths from monolith L9854-9917 fold
 *  in later when the modular has actual users with legacy saves.
 *  Returns an empty payload on missing key, JSON parse failure, or
 *  schema-version mismatch (defensive — never throws). */
export function _weLoadOverlayFromStorage(): OverlayPayload {
  try {
    const raw = localStorage.getItem(WE_STORAGE_KEY);
    if (!raw) return emptyOverlay();
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 4) return emptyOverlay();
    return {
      roads:             Array.isArray(parsed.roads)             ? parsed.roads             : [],
      surfaces:          Array.isArray(parsed.surfaces)          ? parsed.surfaces          : [],
      buildings:         Array.isArray(parsed.buildings)         ? parsed.buildings         : [],
      rivers:            Array.isArray(parsed.rivers)            ? parsed.rivers            : [],
      lakes:             Array.isArray(parsed.lakes)             ? parsed.lakes             : [],
      roadProps:         typeof parsed.roadProps === 'object' && parsed.roadProps ? parsed.roadProps : {},
      materialOverrides: typeof parsed.materialOverrides === 'object' && parsed.materialOverrides ? parsed.materialOverrides : {},
    };
  } catch {
    return emptyOverlay();
  }
}

/** H120: save overlay to WE_STORAGE_KEY (v4 schema). 1:1 port of
 *  monolith L9918-9935. Try-catch swallows quota-exceeded so a full
 *  storage doesn't throw mid-render — the save is best-effort and
 *  the user can clear other localStorage entries to retry. Pulls
 *  sidecar maps off the WorldEditorState (overlayRoadProps,
 *  overlayMaterialOverrides) since OverlayPayload's input shape
 *  doesn't carry them. */
export function _weSaveOverlayToStorage(state: OverlayPayload, editor: WorldEditorState): void {
  try {
    const payload = {
      version: 4,
      roads: state.roads,
      surfaces: state.surfaces,
      buildings: state.buildings,
      rivers: state.rivers,
      lakes: state.lakes,
      roadProps: editor.overlayRoadProps ?? {},
      materialOverrides: editor.overlayMaterialOverrides ?? {},
    };
    localStorage.setItem(WE_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Quota exceeded or storage unavailable — best-effort save.
  }
}

/** Empty payload used as the default when no baseline-edits key is present. */
function emptyBaselineEdits(): BaselineEditsPayload {
  return { edits: {}, deletes: [], roadProps: {}, materialOverrides: {} };
}

/** H121: load baseline edits + deletes + sidecar maps from
 *  WE_BASELINE_EDITS_KEY. Forward-additive — missing fields default
 *  to empty so old saves load cleanly. Defensive parse with version
 *  guard. */
export function _weLoadBaselineEdits(): BaselineEditsPayload {
  try {
    const raw = localStorage.getItem(WE_BASELINE_EDITS_KEY);
    if (!raw) return emptyBaselineEdits();
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1) return emptyBaselineEdits();
    return {
      edits:             typeof parsed.edits === 'object' && parsed.edits ? parsed.edits : {},
      deletes:           Array.isArray(parsed.deletes) ? parsed.deletes.filter((n: unknown) => typeof n === 'number' && n >= 0) : [],
      roadProps:         typeof parsed.roadProps === 'object' && parsed.roadProps ? parsed.roadProps : {},
      materialOverrides: typeof parsed.materialOverrides === 'object' && parsed.materialOverrides ? parsed.materialOverrides : {},
    };
  } catch {
    return emptyBaselineEdits();
  }
}

/** H121: save baseline edits + deletes + sidecar prop maps to
 *  WE_BASELINE_EDITS_KEY. 1:1 port of monolith L9970-9980. Separate
 *  key from the overlay save so a corrupted overlay can't take
 *  baseline edits down with it. */
export function _weSaveBaselineEdits(editor: WorldEditorState): void {
  try {
    const payload = {
      version: 1,
      edits: editor.baselineEdits ?? {},
      deletes: editor.baselineDeletes ?? [],
      roadProps: editor.baselineRoadProps ?? {},
      materialOverrides: editor.baselineMaterialOverrides ?? {},
    };
    localStorage.setItem(WE_BASELINE_EDITS_KEY, JSON.stringify(payload));
  } catch {
    // Quota exceeded or storage unavailable — best-effort save.
  }
}
