/**
 * World Editor — draft lifecycle (begin / commit / cancel) + curve
 * sampling + merge-flag encoding helpers.
 *
 * A draft is the in-flight content the user is drawing — a road
 * polyline, surface/building/lake polygon, or river polyline. Drafts
 * carry copies of the relevant *Props so user setting changes mid-draft
 * don't retroactively mutate the in-flight piece.
 *
 * COMMIT SCHEMA (per row kind, all coords serialized to .toFixed(2)):
 *
 *   road (legacy, 4 meta):
 *     [w, maj, name, z, x1, y1, ...]                       (even length)
 *
 *   road (merge, 5 meta — v8.99.126.00):
 *     [w, maj, name, z, mergeFlag, x1, y1, ...]            (odd length)
 *
 *   surface:  [name, z, x1, y1, ...]
 *   river:    [w, name, x1, y1, ...]       (v8.99.124.28)
 *   lake:     [name, x1, y1, ...]          (v8.99.124.28)
 *   building: [name, type, x1, y1, ...]
 *
 * The legacy/merge schema split is detected at decode time by row parity
 * — even length → legacy, odd length → merge. This is why we can add
 * the merge flag without bumping the storage schema version.
 *
 * MERGE FLAG ENCODING (v8.99.126.05 / .36):
 *
 *   row[4] when present packs (mergeType, mergeAlign) as one integer:
 *     tens digit  → mergeType (0 = Standard, 1 = Cloverleaf, 2 = Stop,
 *                              3 = Yield, 4..9 reserved)
 *     ones digit  → mergeAlign (1=C, 2=L legacy, 3=R, 4=Auto)
 *
 *   Backward-compat: pre-v126.05 saves stored row[4]=1, which the
 *   decode now reads as "center alignment, Standard type" — same
 *   visual behavior as before.
 *
 * ARC MODE (v8.99.124.30): if WORLD_EDITOR.draftProps.arc is true AND
 * curve != 0, road and river drafts replace their user-clicked control
 * points with the densely-sampled Bezier polyline BEFORE serializing.
 * This bakes the arc into the stored row so the rendering / physics
 * pipelines see it as just a longer polyline — no schema change, no
 * render-side awareness needed. Surface / lake / building stay
 * straight (arcs would be over-scoped for closed polygons).
 *
 * MERGE BONDING AT COMMIT (v8.99.126.03 / .36 / .39): for any
 * d.merge === true road, both endpoints get GEOMETRICALLY BONDED to
 * the nearest destination road via _weMergeBondEndpoints (editor/merge/*).
 * Non-merge roads skip this entirely — pre-v126.03 byte-identical.
 *
 * SIDECAR INHERITANCE (v8.99.126.50): the new overlay row inherits
 * WORLD_EDITOR.draftProps.material and .age onto overlayRoadProps
 * keyed by the new row's index. Only explicit (non-default) values
 * are written, keeping the sidecar map sparse.
 *
 * Ported from monolith L13194-15155.
 *
 * SCAFFOLD status: type contract + entry points stubbed with TODO line refs.
 */

import type { WorldEditorState, DraftKind, EditorDraft } from './index';
import type { TilePoint } from './stamp';

/** Host bindings for draft commit — pulls in the merge dispatcher and
 *  the world rebuild so draft.ts doesn't depend on apply.ts directly. */
export interface DraftDeps {
  /** Call the merge dispatcher (editor/merge/*). */
  mergeBondEndpoints(
    pts: TilePoint[],
    dW: number,
    mergeAlign: number,
    mergeType: number,
    loopDiameter: number,
  ): TilePoint[];
  /** Auto-driveway polygon for a committed building. */
  makeDriveway(buildingPts: TilePoint[]): TilePoint[] | null;
  /** Trigger world rebuild after commit. */
  rebuildWorld(): void;
}

/** Start a new draft of the given kind. Clears any prior selection.
 *  Defaults to 'road' if kind is empty/unknown. Carries draftProps onto
 *  the draft (merge flag — v126.00, mergeAlign — v126.05, mergeType —
 *  v126.36 — all surface here). TODO(E35-followup): port from L13194-13260. */
export function _weBeginDraft(
  _state: WorldEditorState,
  _kind?: DraftKind,
): void {
  // TODO: L13194-13260. Branch on kind. Default road = pull all
  // draftProps fields. Other kinds pull only the *Props bag for that
  // kind. Clear all selection indices + selectedKind. needsRedraw=true.
}

/** Commit the active draft to its overlay row array. Bakes arcs (road
 *  / river only), runs merge bonding (merge roads only), serializes
 *  with .toFixed(2) coords, inherits draftProps material/age sidecar
 *  (overlay roads only). TODO(E35-followup): port from L15026-15123. */
export function _weCommitDraft(
  _state: WorldEditorState,
  _deps: DraftDeps,
): void {
  // TODO: L15026-15123.
  //   1. Guard: no draft → return.
  //   2. arcOn = draftProps.arc && curve != 0. If arcOn and kind is
  //      road/river, ptsForCommit = _weCurvePoints(d.pts, curve).
  //   3. Per kind: min-pts check (road/river>=2, polygons>=3), early
  //      return on too-few. Build the row array per schema above,
  //      append .toFixed(2) coords, push to the correct row array.
  //   4. Merge roads: run mergeBondEndpoints first, encode merge flag
  //      via _encodeMergeFlag(mergeType, mergeAlign) into row[4].
  //   5. Building autoDriveway: emit driveway as a surface row.
  //   6. v126.50 sidecar inheritance for road overlay rows.
  //   7. Clear draft, rebuildWorld().
}

/** Discard the active draft without committing. Single-line in source
 *  but exported for parity with the public API. TODO(E35-followup): port
 *  from L15124-15155. */
export function _weCancelDraft(_state: WorldEditorState): void {
  // TODO: L15124-15155. draft=null; needsRedraw=true.
}

/** Densely sample a cubic-Bezier-shaped polyline from the user's
 *  control points. `curve` is the bow height in tiles (negative = bow
 *  the other way). Returns a new pts array; input is not mutated.
 *  TODO(E35-followup): port from L15642 (_weCurvePoints). */
export function _weCurvePoints(_pts: TilePoint[], _curve: number): TilePoint[] {
  // TODO: L15642. Cubic Bezier with control points offset perpendicular
  // to the chord by `curve` tiles. Sample density ~1 tile per output point.
  return _pts.map(p => [p[0], p[1]] as TilePoint);
}

/** Pack (mergeType, mergeAlign) into one integer for row[4] storage.
 *  Schema: tens digit = mergeType, ones digit = mergeAlign.
 *  e.g. _encodeMergeFlag(1, 3) = 13 (Cloverleaf + Right). */
export function _encodeMergeFlag(mergeType: number, mergeAlign: number): number {
  const _mt = (mergeType | 0) % 10;
  const _ma = (mergeAlign | 0) % 10 || 1;
  return _mt * 10 + _ma;
}

/** Unpack row[4] into {mergeType, mergeAlign}. Backward-compat: pre-
 *  v126.36 stored values 1/2/3 (mergeAlign only); these decode as
 *  mergeType=0 (Standard) with the correct alignment. */
export function _decodeMergeFlag(flag: number): { mergeType: number; mergeAlign: number } {
  const _f = (flag | 0) || 0;
  if (_f <= 0) return { mergeType: 0, mergeAlign: 1 };
  return { mergeType: Math.floor(_f / 10), mergeAlign: _f % 10 || 1 };
}

/** Convenience re-export — DraftKind comes from index.ts but draft.ts is
 *  the natural home for callers to import the type from. */
export type { DraftKind, EditorDraft };
