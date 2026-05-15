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

/** Re-run world generation from scratch, then re-apply the overlay.
 *  Called when the user toggles "Reload Baseline" or when a baseline-
 *  level edit happens. Effectively a hard reset that respects baseline
 *  edits but discards transient overlay state in flight.
 *  TODO(E33-followup): port from L10460-10470. */
export function _weRebuildWorld(
  _state: WorldEditorState,
  _baseline: BaselineSnapshot,
  _deps: ApplyDeps,
): void {
  // TODO: L10460-10470. Re-capture baseline, re-apply baseline edits,
  // then _weApplyOverlay.
}
