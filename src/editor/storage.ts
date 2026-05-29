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
  /** H693: parking-lot polygon rows. Empty array on any older save —
   *  forward-additive within the v4 key, no schema-version bump. */
  parkingLots: unknown[];
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
    parkingLots: [],
    roadProps: {}, materialOverrides: {},
  };
}

/** Safe-parse a localStorage key. Returns the parsed JSON or `null` on
 *  any failure (missing key, JSON syntax error, etc.). Used by both
 *  the v4 read and each fallback path so they all share identical
 *  defensive semantics. Never throws. */
function tryReadJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Migrate a parsed v3 payload (no rivers / lakes / sidecars) into a
 *  v4-shaped OverlayPayload. v3 → v4 is purely additive: rivers and
 *  lakes default to empty, the two sidecar maps default to {}. The
 *  caller is responsible for re-saving to bump the persisted schema.
 *  v3 schema lived at the v3 key only — there are no in-place readers
 *  of v3 left in the codebase. Matches monolith L9881-L9884. */
function migrateV3ToV4(d: Record<string, unknown>): OverlayPayload {
  return {
    roads:             Array.isArray(d.roads)     ? d.roads     : [],
    surfaces:          Array.isArray(d.surfaces)  ? d.surfaces  : [],
    buildings:         Array.isArray(d.buildings) ? d.buildings : [],
    rivers: [],
    lakes: [],
    parkingLots: [],
    roadProps: {},
    materialOverrides: {},
  };
}

/** Migrate a parsed v2 payload (no buildings either) into a v4-shaped
 *  OverlayPayload. v2 → v4 layers two additive jumps: v2 → v3 added
 *  buildings, then v3 → v4 added rivers / lakes / sidecars. Matches
 *  monolith L9896-L9898. */
function migrateV2ToV4(d: Record<string, unknown>): OverlayPayload {
  return {
    roads:    Array.isArray(d.roads)    ? d.roads    : [],
    surfaces: Array.isArray(d.surfaces) ? d.surfaces : [],
    buildings: [],
    rivers: [],
    lakes: [],
    parkingLots: [],
    roadProps: {},
    materialOverrides: {},
  };
}

/** Migrate the v1 payload — a BARE ARRAY of road rows, predating any
 *  surfaces / buildings / rivers / lakes — into a v4-shaped
 *  OverlayPayload. v1 is the only schema whose top-level value isn't
 *  an object; all newer reads expect `{ version: N, ... }`. Matches
 *  monolith L9910. */
function migrateV1ToV4(arr: unknown[]): OverlayPayload {
  return {
    roads: arr,
    surfaces: [],
    buildings: [],
    rivers: [],
    lakes: [],
    parkingLots: [],
    roadProps: {},
    materialOverrides: {},
  };
}

/** Normalize a parsed v4 record into the strict OverlayPayload shape —
 *  every collection field defaults to its empty form so the caller
 *  never has to null-check the result. Matches monolith L9861-L9871. */
function normalizeV4(d: Record<string, unknown>): OverlayPayload {
  const roadProps         = d.roadProps;
  const materialOverrides = d.materialOverrides;
  return {
    roads:     Array.isArray(d.roads)     ? d.roads     : [],
    surfaces:  Array.isArray(d.surfaces)  ? d.surfaces  : [],
    buildings: Array.isArray(d.buildings) ? d.buildings : [],
    rivers:    Array.isArray(d.rivers)    ? d.rivers    : [],
    lakes:     Array.isArray(d.lakes)     ? d.lakes     : [],
    // H693: parkingLots is forward-additive within v4 — old saves load
    // with []. No schema bump because old readers ignore unknown fields.
    // H695/H699: migrate older parking-lot rows up to the H699 schema
    //   [name, material, stallW, stallL, aisleW, x1, y1, ...]   (odd len)
    // forward-additive within the v4 key, no schema-version bump.
    //   H693: [name, x1, y1, ...]           (odd, row[1] number)
    //   H695: [name, material, x1, y1, ...] (even)
    //   H699: already current               (odd, row[1] string)
    parkingLots: Array.isArray(d.parkingLots)
      ? d.parkingLots.map((row) => {
          if (!Array.isArray(row) || row.length < 7) return row;
          const isEven = (row.length & 1) === 0;
          if (isEven) {
            // H695 → H699: splice in defaults after material.
            return [row[0], row[1], 1.0, 2.0, 2.0, ...row.slice(2)];
          }
          if (typeof row[1] === 'string') {
            // Already H699.
            return row;
          }
          // H693 → H699: insert material + defaults.
          return [row[0], 'asphalt', 1.0, 2.0, 2.0, ...row.slice(1)];
        })
      : [],
    roadProps:         typeof roadProps === 'object' && roadProps
      ? (roadProps as OverlayPayload['roadProps']) : {},
    materialOverrides: typeof materialOverrides === 'object' && materialOverrides
      ? (materialOverrides as OverlayPayload['materialOverrides']) : {},
  };
}

/** Helper that takes a migrator + a v4 normalized result and persists
 *  the upgrade back to WE_STORAGE_KEY before returning. Mirrors the
 *  monolith's `_weSaveOverlayToStorage(out); return out;` pattern at
 *  L9885-L9887 / L9899-L9900 / L9911-L9912. Re-saving on every load
 *  ensures the next session reads the modern key directly.
 *
 *  NOTE: monolith pulls sidecar maps off the global WORLD_EDITOR
 *  during save. The migrate path can't reach the editor state (it's
 *  called BEFORE the editor opens), so the migration write uses {}
 *  sidecars regardless. Migration outputs already default the sidecar
 *  fields to {}, so the persisted v4 record is semantically the same
 *  as the in-memory result — just with no editor-runtime sidecar yet
 *  merged in. Once the editor opens and the user makes any change,
 *  the normal save path will overwrite with the editor's sidecars. */
function persistMigrated(payload: OverlayPayload): OverlayPayload {
  try {
    const out = {
      version: 4,
      roads: payload.roads,
      surfaces: payload.surfaces,
      buildings: payload.buildings,
      rivers: payload.rivers,
      lakes: payload.lakes,
      parkingLots: payload.parkingLots,
      roadProps: payload.roadProps,
      materialOverrides: payload.materialOverrides,
    };
    localStorage.setItem(WE_STORAGE_KEY, JSON.stringify(out));
  } catch {
    // Quota exceeded etc. — migration result is still returned in-memory.
  }
  return payload;
}

/** H120: load overlay from WE_STORAGE_KEY with full v3 / v2 / v1
 *  forward migration. Tries each schema version in descending order;
 *  the first match normalizes (v4) or migrates-and-persists (v3/v2/v1)
 *  and returns. Returns an empty payload on missing key, JSON parse
 *  failure, or schema-version mismatch (defensive — never throws).
 *
 *  Per-version reads are independent try/catch chains in the monolith
 *  so a corrupted v3 record (for example) doesn't prevent the v2 / v1
 *  fallback from running. The `tryReadJson` helper preserves that —
 *  each per-version block can null-coalesce without affecting later
 *  reads.
 *
 *  Ported 1:1 from monolith L9854-L9917. */
export function _weLoadOverlayFromStorage(): OverlayPayload {
  const v4 = tryReadJson(WE_STORAGE_KEY);
  if (v4 && typeof v4 === 'object' && (v4 as Record<string, unknown>).version === 4) {
    return normalizeV4(v4 as Record<string, unknown>);
  }
  const v3 = tryReadJson(WE_STORAGE_KEY_V3);
  if (v3 && typeof v3 === 'object' && (v3 as Record<string, unknown>).version === 3) {
    return persistMigrated(migrateV3ToV4(v3 as Record<string, unknown>));
  }
  const v2 = tryReadJson(WE_STORAGE_KEY_V2);
  if (v2 && typeof v2 === 'object' && (v2 as Record<string, unknown>).version === 2) {
    return persistMigrated(migrateV2ToV4(v2 as Record<string, unknown>));
  }
  const v1 = tryReadJson(WE_STORAGE_KEY_V1);
  if (Array.isArray(v1)) {
    return persistMigrated(migrateV1ToV4(v1));
  }
  return emptyOverlay();
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
      parkingLots: state.parkingLots,
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
