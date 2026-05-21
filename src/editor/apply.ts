/**
 * World Editor — overlay application + world rebuild.
 *
 * `_weApplyOverlay` is the central reconciliation step that takes the
 * current overlay state and re-stamps the world. It is idempotent by
 * deliberate design — every call:
 *
 *  1. Restores majorRoads / map[] / roadCrossings from the baseline
 *     snapshot (editor/baseline.ts).
 *  2. Re-pushes each overlay road into majorRoads, stamping its tiles.
 *  3. Re-stamps surfaces, buildings, rivers, lakes.
 *  4. Re-runs gas station + crossing detection passes the game-side
 *     world generation depended on (so post-overlay traffic and
 *     intersections behave the same as pre-overlay).
 *
 * Idempotence matters because the editor calls _weApplyOverlay every
 * time anything changes (vertex move, draft commit, road delete, etc.)
 * — if the function were not idempotent, those calls would accumulate.
 *
 * BASELINE DELETES (v8.99.126.47):
 * Roads marked for deletion in WORLD_EDITOR.baselineDeletes are pushed
 * with EMPTY pts so they keep their slot in majorRoads (preserving
 * i==0..baseLen-1 index alignment that pick logic depends on) but
 * vanish from render and pick. Every render/pick path already short-
 * circuits on r.pts.length<2. The underlying map tile imprint and
 * original crossings stay — gameplay still treats those tiles as road —
 * so the user can draw an overlay on top to "replace" the baseline
 * visually. Reload Baseline reverts the delete set.
 *
 * Ported from monolith L10201-10470.
 *
 * SCAFFOLD status: type contract + entry points stubbed with TODO line refs.
 */

import type { WorldEditorState } from './index';
import type { BaselineSnapshot } from './baseline';
import type { StampDeps } from './stamp';

/** Host bindings for applying the overlay. */
export interface ApplyDeps extends StampDeps {
  /** The live majorRoads array — _weApplyOverlay mutates this directly
   *  (.length=0 then push). */
  majorRoads: Array<{ pts: number[][]; w: number; maj: number; name: string; z: number; bridgePts?: Array<{ x: number; y: number }> }>;
  /** The live roadCrossings array — same pattern (clear + repopulate). */
  roadCrossings: Array<Record<string, unknown>>;
  /** Restores world tile bytes from the baseline snapshot. */
  restoreMapBytes(bytes: Uint8Array): void;
  /** Re-runs gas-station-placement-along-roads and any other
   *  post-road-generation passes that depend on majorRoads being final. */
  rebuildWorldDerivatives(): void;
  /** Persist the overlay to localStorage. Called by _weRebuildWorld
   *  before re-applying so a crashing apply step doesn't leave a
   *  stale localStorage record. */
  saveOverlayToStorage(state: WorldEditorState): void;
  /** Rebuild the game-side render caches (per-road _mainPath / _bbox /
   *  _prof / _chunks / _dividerPaths and _sortedRoadsByZ). Optional
   *  because the editor can run with a no-op caches step during early
   *  porting; the monolith's call site at L10467 also guards on
   *  `typeof preprocessRoadsForRender === 'function'`. */
  preprocessRoadsForRender?(): void;
  /** Set the editor's redraw flag. The state itself owns `needsRedraw`
   *  but going through deps keeps the call ordering explicit at the
   *  edge of the module (matches the existing `needsRedraw=true` line
   *  at monolith L10468). */
  markNeedsRedraw(state: WorldEditorState): void;
}

/** Re-apply the entire overlay on top of the baseline. The single entry
 *  point for everything that mutates the visible world from the editor.
 *  TODO(E33-followup): port from L10201-10459. */
export function _weApplyOverlay(
  _state: WorldEditorState,
  _baseline: BaselineSnapshot,
  _deps: ApplyDeps,
): void {
  // TODO: L10201-10459.
  //   1. Guard on baseline snapshot non-null.
  //   2. majorRoads.length = 0; restore from baseline.liveMajorRoads
  //      with baselineDeletes producing empty-pts placeholders to keep
  //      index alignment stable (v8.99.126.47).
  //   3. Restore map bytes via deps.restoreMapBytes(baseline.mapBytes).
  //   4. roadCrossings.length = 0; restore baseline crossings.
  //   5. For each overlay road row: push to majorRoads + _weStampRoadTiles.
  //   6. For each surface / building / river / lake row: stamp via the
  //      corresponding editor/stamp.ts helper.
  //   7. Auto-driveways: for each building with autoDriveway==true,
  //      _weMakeDriveway + push the polygon as a surface row.
  //   8. deps.rebuildWorldDerivatives().
}

/** Save the overlay to storage, re-apply it on top of the baseline,
 *  then re-build the game-side per-road render caches and mark the
 *  editor for redraw. Called every time an editor mutation should
 *  produce visible output — vertex drag commit, draft commit, road
 *  delete, baseline-vertex move, etc.
 *
 *  Why save BEFORE apply: if `_weApplyOverlay` crashes (a malformed
 *  overlay row, a stamp helper throwing), the on-disk state is
 *  already at the new shape so the user's edit survives the reload.
 *  The monolith uses this ordering for exactly this reason (L10460-
 *  L10462).
 *
 *  Render caches (v8.99.124.22): `preprocessRoadsForRender` builds
 *  per-road _mainPath / _bbox / _prof / _chunks / _dividerPaths
 *  AND the _sortedRoadsByZ array that the actual stroke renderer
 *  iterates. Without this call, user-added roads only render their
 *  jagged Bresenham tile=1 stamps with no smooth asphalt stroke.
 *  Optional in deps because the modular tree may not have the
 *  game-side renderer wired up yet during early porting; the
 *  monolith call site at L10467 also guards on
 *  `typeof preprocessRoadsForRender === 'function'`.
 *
 *  BaselineSnapshot is currently accepted but unused — kept on the
 *  signature for parity with `_weApplyOverlay` so callers can thread
 *  the same snapshot through both functions without forking the
 *  call shape. Will become load-bearing if a future hop folds an
 *  apply-overlay invocation into this function directly (the
 *  monolith currently calls `_weApplyOverlay()` with no args; the
 *  modular port threads state + baseline through the helper).
 *
 *  Ported 1:1 from monolith _weRebuildWorld (L10460-10469). */
export function _weRebuildWorld(
  state: WorldEditorState,
  baseline: BaselineSnapshot,
  deps: ApplyDeps,
): void {
  deps.saveOverlayToStorage(state);
  _weApplyOverlay(state, baseline, deps);
  if (deps.preprocessRoadsForRender) deps.preprocessRoadsForRender();
  deps.markNeedsRedraw(state);
}
