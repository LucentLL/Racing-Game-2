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

/** Load overlay from v4 → v3 → v2 → v1, migrating forward each step.
 *  Each fallback that hits writes the migrated v4 payload back, so the
 *  next load skips straight to the v4 path. Returns an empty payload if
 *  no key is present. TODO(E33-followup): port from L9854-9917. */
export function _weLoadOverlayFromStorage(): OverlayPayload {
  // TODO: L9854-9917. Try-catch each version probe; on hit, normalize to
  // OverlayPayload and (for v3/v2/v1) call _weSaveOverlayToStorage to write
  // back the migrated shape. Default: {roads:[], surfaces:[], buildings:[],
  // rivers:[], lakes:[], roadProps:{}, materialOverrides:{}}.
  return { roads: [], surfaces: [], buildings: [], rivers: [], lakes: [], roadProps: {}, materialOverrides: {} };
}

/** Save overlay to WE_STORAGE_KEY (v4). Pulls sidecar maps (roadProps,
 *  materialOverrides) off WORLD_EDITOR — they aren't on the row-arrays-only
 *  `state` payload. Try-catch swallows quota-exceeded. TODO(E33-followup):
 *  port from L9918-9935. */
export function _weSaveOverlayToStorage(_state: OverlayPayload, _editor: WorldEditorState): void {
  // TODO: L9918-9935. JSON.stringify {version:4, roads, surfaces, buildings,
  // rivers, lakes, roadProps: editor.overlayRoadProps||{}, materialOverrides:
  // editor.overlayMaterialOverrides||{}}.
}

/** Load baseline edits payload. Forward-additive — missing fields
 *  default to empty. TODO(E33-followup): port from L9953-9969. */
export function _weLoadBaselineEdits(): BaselineEditsPayload {
  // TODO: L9953-9969. version===1 guard, edits must be a plain object,
  // deletes must be an array of finite >=0 indices.
  return { edits: {}, deletes: [], roadProps: {}, materialOverrides: {} };
}

/** Save baseline edits + deletes + sidecar prop maps to
 *  WE_BASELINE_EDITS_KEY. TODO(E33-followup): port from L9970-9980. */
export function _weSaveBaselineEdits(_editor: WorldEditorState): void {
  // TODO: L9970-9980. JSON.stringify {version:1, edits: editor.baselineEdits||{},
  // deletes: editor.baselineDeletes||[], roadProps: editor.baselineRoadProps||{},
  // materialOverrides: editor.baselineMaterialOverrides||{}}.
}
