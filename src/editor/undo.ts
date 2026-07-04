/**
 * World Editor — lightweight undo (H892).
 *
 * The editor had no undo at all (only the nuclear "Reset to baseline").
 * This adds a bounded snapshot stack of the EDITABLE collections, captured
 * at the start of each structural mutation (draft commit + delete), so the
 * "Back" button can step the last action back.
 *
 * Scope is deliberately the overlay + baseline-edit collections — the same
 * data the save round-trips. Per-action property tweaks (material/age/etc.)
 * are not snapshotted yet; commit + delete cover the actions a user most
 * wants to undo. JSON deep-copy keeps it simple and dependency-free; user
 * actions are infrequent so the copy cost is irrelevant.
 */

import type { WorldEditorState } from './index';

/** The slice of editor state an undo snapshot captures + restores. */
type UndoSnapshot = Pick<
  WorldEditorState,
  | 'overlay'
  | 'surfaces'
  | 'buildings'
  | 'rivers'
  | 'lakes'
  | 'parkingLots'
  | 'intersections'
  | 'overlayRoadProps'
  | 'overlayMaterialOverrides'
  | 'baselineEdits'
  | 'baselineDeletes'
  | 'baselineRoadProps'
  | 'baselineMaterialOverrides'
>;

export interface UndoDeps {
  /** Re-apply the overlay on top of the baseline after a restore. */
  rebuildWorld(): void;
}

/** Max snapshots retained — old actions past this drop off the bottom. */
const UNDO_CAP = 25;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v ?? null)) as T;
}

function snapshotOf(state: WorldEditorState): UndoSnapshot {
  return {
    overlay: clone(state.overlay),
    surfaces: clone(state.surfaces),
    buildings: clone(state.buildings),
    rivers: clone(state.rivers),
    lakes: clone(state.lakes),
    parkingLots: clone(state.parkingLots),
    intersections: clone(state.intersections),
    overlayRoadProps: clone(state.overlayRoadProps ?? {}),
    overlayMaterialOverrides: clone(state.overlayMaterialOverrides ?? {}),
    baselineEdits: clone(state.baselineEdits ?? {}),
    baselineDeletes: clone(state.baselineDeletes ?? []),
    baselineRoadProps: clone(state.baselineRoadProps ?? {}),
    baselineMaterialOverrides: clone(state.baselineMaterialOverrides ?? {}),
  };
}

function getStack(state: WorldEditorState): UndoSnapshot[] {
  const s = state as WorldEditorState & { undoStack?: UndoSnapshot[] };
  if (!s.undoStack) s.undoStack = [];
  return s.undoStack;
}

/** Capture the editable collections BEFORE a structural mutation so a later
 *  _weUndo can restore them. Call at the very top of commit / delete. */
export function _weSnapshotForUndo(state: WorldEditorState): void {
  const stack = getStack(state);
  stack.push(snapshotOf(state));
  if (stack.length > UNDO_CAP) stack.shift();
}

/** Restore the most recent snapshot — undo the last structural action.
 *  Returns false (no-op) when the stack is empty. Clears selection + any
 *  in-flight draft, then rebuilds the world. */
export function _weUndo(state: WorldEditorState, deps: UndoDeps): boolean {
  const stack = getStack(state);
  const snap = stack.pop();
  if (!snap) return false;
  state.overlay = snap.overlay;
  state.surfaces = snap.surfaces;
  state.buildings = snap.buildings;
  state.rivers = snap.rivers;
  state.lakes = snap.lakes;
  state.parkingLots = snap.parkingLots;
  state.intersections = snap.intersections;
  state.overlayRoadProps = snap.overlayRoadProps;
  state.overlayMaterialOverrides = snap.overlayMaterialOverrides;
  state.baselineEdits = snap.baselineEdits;
  state.baselineDeletes = snap.baselineDeletes;
  state.baselineRoadProps = snap.baselineRoadProps;
  state.baselineMaterialOverrides = snap.baselineMaterialOverrides;
  // Selection indices may now point past the end of the restored arrays.
  state.selected = -1;
  state.selectedSurface = -1;
  state.selectedBuilding = -1;
  state.selectedRiver = -1;
  state.selectedLake = -1;
  state.selectedParkingLot = -1;
  state.selectedBaselineRoad = -1;
  state.selectedSegmentIdx = -1;
  state.selectedKind = null;
  state.activeVertex = -1;
  state.spanA = null;
  state.spanB = null;
  state.draft = null;
  deps.rebuildWorld();
  state.needsRedraw = true;
  return true;
}
