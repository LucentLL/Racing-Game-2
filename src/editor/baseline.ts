/**
 * World Editor — baseline (permanent) road snapshot + edit application.
 *
 * The baseline is the source-defined majorRoads array (I-485, Trade St,
 * Tryon St, etc.) — the hardcoded backbone of the city that exists before
 * the user has drawn anything in the editor.
 *
 * Two snapshots are captured, by deliberate design (v8.99.126.46):
 *  - _weBaselineMajorRoads          — LIVE baseline; mutated by vertex edits
 *  - _weBaselineMajorRoadsOriginal  — IMMUTABLE; never modified after capture
 *
 * Without the second copy, once a vertex moves there would be no way to
 * recover the source-defined geometry without a full page reload — and
 * "Reload Baseline" must work without losing the rest of the editor
 * session. The two arrays are deep-copied independently so mutations
 * never bleed between them.
 *
 * Map bytes and roadCrossings are also captured so _weApplyOverlay
 * (editor/apply.ts) can restore the world to baseline before re-stamping
 * the overlay each time. This keeps stamping idempotent and lets the
 * editor be toggled on/off without accumulating state.
 *
 * Ported from monolith L9744-10021.
 *
 * SCAFFOLD status: type contract + entry points stubbed with TODO line refs.
 */

import type { WorldEditorState } from './index';

/** Baseline road snapshot — a deep-copy of one majorRoads entry. */
export interface BaselineRoad {
  w: number;
  maj: number;
  name: string;
  z: number;
  pts: number[][];
  /** Bridges (deck spans) attached to this road, deep-copied. */
  bridgePts?: Array<{ x: number; y: number }>;
}

/** Baseline crossing snapshot — a deep-copy of one roadCrossings entry. */
export interface BaselineCrossing {
  [key: string]: unknown;
}

/** The module-level baseline state. Three deep-copies of the source-
 *  defined world, captured once at editor init. _weBaselineMajorRoads is
 *  the LIVE copy (mutated by vertex edits); the *Original is the
 *  immutable revert source. */
export interface BaselineSnapshot {
  liveMajorRoads: BaselineRoad[] | null;
  originalMajorRoads: BaselineRoad[] | null;
  mapBytes: Uint8Array | null;
  crossings: BaselineCrossing[] | null;
}

/** Host bindings for capture/apply. The baseline module reads from the
 *  game's source-of-truth arrays (majorRoads, map, roadCrossings) at
 *  capture time — passing them in via deps keeps this module free of a
 *  direct dependency on the world data layer. */
export interface BaselineDeps {
  /** The source-defined majorRoads array (read-only from baseline's POV). */
  getMajorRoads(): BaselineRoad[];
  /** The world tile array, viewed as a Uint8Array. */
  getMap(): Uint8Array;
  /** The source-defined roadCrossings array. */
  getRoadCrossings(): BaselineCrossing[];
}

/** Capture all three baseline copies. Called once after the world is
 *  generated and before _weApplyOverlay runs for the first time.
 *  Mutates the supplied snapshot in place. TODO(E33-followup): port
 *  from L9981-9997. */
export function _weCaptureBaseline(_snap: BaselineSnapshot, _deps: BaselineDeps): void {
  // TODO: L9981-9997. Deep-copy majorRoads twice (live + original),
  // independently — never share references. Capture map.slice() into
  // mapBytes (or new Uint8Array(map)) and roadCrossings.map(c=>({...c})).
}

/** Apply persisted baseline vertex edits to the LIVE baseline copy.
 *  Idempotent — overwrites pts arrays in place. The ORIGINAL copy is
 *  never touched so revert still works.
 *
 *  Defensive guards (v8.99.126.47):
 *   - skips entries whose roadIdx is out of bounds (schema drift)
 *   - length>=2 minimum (point-delete can shorten pts; strict equality
 *     would have rejected those edits on reload)
 *
 *  TODO(E33-followup): port from L10008-10019.
 */
export function _weApplyBaselineEdits(_snap: BaselineSnapshot, _editor: WorldEditorState): void {
  // TODO: L10008-10019. For each [idxStr, editedPts] in editor.baselineEdits:
  // bounds-check idx, length>=2 guard, then base.pts = editedPts.map(p=>[+p[0],+p[1]]).
}
