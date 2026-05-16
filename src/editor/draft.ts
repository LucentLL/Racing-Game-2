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

/** Start a new draft of the given kind. H118 minimal port — handles
 *  road only (other kinds land with their respective tool ports).
 *  Carries draftProps onto the draft snapshot so user changes mid-
 *  draft don't retroactively mutate the in-flight road. Clears all
 *  selection state. */
export function _weBeginDraft(
  state: WorldEditorState,
  kind: DraftKind = 'road',
): void {
  if (kind === 'road') {
    const p = state.draftProps;
    state.draft = {
      kind: 'road',
      pts: [],
      w: p.w,
      maj: p.maj,
      name: p.name,
      z: p.z,
      arc: p.arc,
      curve: p.curve,
      merge: p.merge,
      mergeAlign: p.mergeAlign,
      mergeType: p.mergeType,
      material: p.material,
      age: p.age,
    };
  } else {
    // Other kinds (surface / building / river / lake) port with their
    // respective tool implementations. For now, just allocate an empty
    // draft so input.ts can push vertices without crashing.
    state.draft = { kind, pts: [] };
  }
  // Clear all selection.
  state.selected = -1;
  state.selectedSurface = -1;
  state.selectedBuilding = -1;
  state.selectedRiver = -1;
  state.selectedLake = -1;
  state.selectedBaselineRoad = -1;
  state.selectedSegmentIdx = -1;
  state.selectedKind = null;
  state.activeVertex = -1;
  state.needsRedraw = true;
}

/** Commit the active draft to its overlay row array. H118 minimal —
 *  handles road only, with the legacy 4-meta schema:
 *    [w, maj, name, z, x1, y1, x2, y2, ...]
 *  No arc baking (defer), no merge bonding (defer), no sidecar
 *  inheritance (defer), no rebuildWorld call (modular doesn't have
 *  a rebuild dispatcher yet). All those layer on in follow-up H
 *  commits as their dependencies port. */
export function _weCommitDraft(
  state: WorldEditorState,
  _deps: DraftDeps,
): void {
  const d = state.draft;
  if (!d) return;
  if (d.kind === 'road') {
    if (d.pts.length < 2) {
      // Single-point road — discard rather than commit a degenerate row.
      state.draft = null;
      state.needsRedraw = true;
      return;
    }
    // Legacy row schema: [w, maj, name, z, x1, y1, x2, y2, ...].
    // Merge schema (odd-length with row[4] = encoded merge flag) ports
    // when the merge dispatcher lands.
    const row: (string | number)[] = [
      d.w ?? state.draftProps.w,
      d.maj ?? state.draftProps.maj,
      d.name ?? state.draftProps.name,
      d.z ?? state.draftProps.z,
    ];
    for (const pt of d.pts) {
      row.push(Number(pt[0].toFixed(2)));
      row.push(Number(pt[1].toFixed(2)));
    }
    (state.overlay as unknown[]).push(row);
  }
  // Other kinds discard for now until their commit branches port.
  state.draft = null;
  state.needsRedraw = true;
}

/** Discard the active draft without committing. 1:1 port of monolith
 *  L15124-15155. */
export function _weCancelDraft(state: WorldEditorState): void {
  state.draft = null;
  state.needsRedraw = true;
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
