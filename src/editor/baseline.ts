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
 *  Mutates the supplied snapshot in place.
 *
 *  Two deep-copies of majorRoads, by deliberate design (v8.99.126.46):
 *    • liveMajorRoads      — mutable; receives vertex edits
 *    • originalMajorRoads  — immutable; never modified after capture
 *  The Reload Baseline path restores from `originalMajorRoads` into
 *  `liveMajorRoads`. Each copy is built independently (NOT via slice
 *  of the other) so mutations never bleed between them.
 *
 *  bridgePts is also deep-copied per road when present — sharing
 *  bridge-point references would let a vertex move in the live copy
 *  follow through to the original.
 *
 *  mapBytes captures the world tile array as a fresh Uint8Array view
 *  so _weApplyOverlay can restore the world to baseline before
 *  re-stamping the overlay each time (idempotent re-stamping).
 *
 *  roadCrossings copied with `{...c}` — one level of shallow spread
 *  per entry. Mirrors monolith — crossings are flat objects, no
 *  deeper structure to walk.
 *
 *  Ported 1:1 from monolith L9981-9997. */
export function _weCaptureBaseline(snap: BaselineSnapshot, deps: BaselineDeps): void {
  const majorRoads = deps.getMajorRoads();
  const cloneRoad = (r: BaselineRoad): BaselineRoad => ({
    w: r.w,
    maj: r.maj,
    name: r.name,
    z: r.z,
    pts: r.pts.map((p) => [p[0], p[1]]),
    bridgePts: r.bridgePts ? r.bridgePts.map((p) => ({ x: p.x, y: p.y })) : undefined,
  });
  snap.liveMajorRoads = majorRoads.map(cloneRoad);
  snap.originalMajorRoads = majorRoads.map(cloneRoad);
  snap.mapBytes = new Uint8Array(deps.getMap());
  snap.crossings = deps.getRoadCrossings().map((c) => ({ ...c }));
}

/** Apply persisted baseline vertex edits to the LIVE baseline copy.
 *  Idempotent — overwrites pts arrays in place. The ORIGINAL copy is
 *  never touched so revert still works.
 *
 *  Defensive guards (v8.99.126.47):
 *   - skips entries whose roadIdx is out of bounds (schema drift —
 *     stale localStorage edits surviving a hardcoded-majorRoads change)
 *   - length>=2 minimum: v126.47 RELAXED the prior length-equality
 *     check after point-delete (Patch 11) made it legal to shorten
 *     pts. 2 keeps the polyline structurally valid (one segment).
 *
 *  No-ops when snap.liveMajorRoads is null (baseline never captured)
 *  or when editor.baselineEdits is empty / missing.
 *
 *  Ported 1:1 from monolith L10008-10019. */
export function _weApplyBaselineEdits(snap: BaselineSnapshot, editor: WorldEditorState): void {
  if (!snap.liveMajorRoads) return;
  const editsMap = (editor.baselineEdits as Record<string, unknown>) || {};
  for (const idxStr of Object.keys(editsMap)) {
    const idx = +idxStr;
    if (!Number.isFinite(idx) || idx < 0 || idx >= snap.liveMajorRoads.length) continue;
    const editedPts = editsMap[idxStr];
    if (!Array.isArray(editedPts) || editedPts.length < 2) continue;
    const base = snap.liveMajorRoads[idx];
    base.pts = editedPts.map((p) => [+(p as number[])[0], +(p as number[])[1]]);
  }
}
