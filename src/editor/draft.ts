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
 * ARC MODE (v8.99.124.30 + H696): if WORLD_EDITOR.draftProps.arc is
 * true AND curve != 0, road, river, AND closed-polygon (surface,
 * building, lake, parkingLot) drafts replace their user-clicked
 * control points with the densely-sampled Bezier polyline BEFORE
 * serializing. This bakes the arc into the stored row so the
 * rendering / physics pipelines see it as just a longer polyline —
 * no schema change, no render-side awareness needed. Closed polygons
 * close-on-wrap before sampling and strip the trailing duplicate
 * after (H696, addresses user-reported "lakes don't auto-round").
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
 */

import type { WorldEditorState, DraftKind, EditorDraft } from './index';
import type { TilePoint } from './stamp';
import { smoothPolyline, smoothClosedPolygon } from '@/render/pathSmoothing';

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

/** Start a new draft of the given kind. Carries the appropriate per-
 *  kind props bag onto the draft snapshot so user changes mid-draft
 *  don't retroactively mutate the in-flight shape. Clears all
 *  selection state. Ported 1:1 from monolith L13194-13253. */
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
  } else if (kind === 'surface') {
    state.draft = {
      kind: 'surface',
      pts: [],
      name: state.surfaceProps.name,
      z: state.surfaceProps.z,
    };
  } else if (kind === 'river') {
    // v8.99.124.28: rivers reuse draftProps.w via the lane buttons so
    // riverProps.w stays in sync with the lane-button UI. Mirror to the
    // draft snapshot so the commit width matches what the user last
    // selected with the Lanes group.
    state.draft = {
      kind: 'river',
      pts: [],
      w: state.riverProps.w,
      name: state.riverProps.name,
    };
  } else if (kind === 'lake') {
    state.draft = {
      kind: 'lake',
      pts: [],
      name: state.lakeProps.name,
    };
  } else if (kind === 'parkingLot') {
    state.draft = {
      kind: 'parkingLot',
      pts: [],
      name: state.parkingLotProps.name,
      // H695: bake material at draft-start so mid-draft material
      // toggles update the draft snapshot (via _weReadProps) but
      // don't retroactively mutate previously committed lots.
      material: state.parkingLotProps.material,
    };
  } else {
    // building
    state.draft = {
      kind: 'building',
      pts: [],
      name: state.buildingProps.name,
      type: state.buildingProps.type,
      autoDriveway: state.buildingProps.autoDriveway,
    };
  }
  // Clear all selection.
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
  state.needsRedraw = true;
}

/** Commit the active draft to its overlay row array. Ported 1:1 from
 *  monolith _weCommitDraft (L15026-15123). Five branches keyed on
 *  draft kind:
 *    - road     → [w, maj, name, z, (mergeFlag,)? x1, y1, ...] into
 *                 state.overlay. Arc baking via _weCurvePoints when
 *                 draftProps.arc + curve are set. Merge bonding via
 *                 deps.mergeBondEndpoints when d.merge. Material/age
 *                 inheritance onto state.overlayRoadProps sidecar.
 *    - surface  → [name, z, x1, y1, ...] into state.surfaces. ≥3 pts.
 *    - river    → [w, name, x1, y1, ...] into state.rivers. ≥2 pts.
 *                 Arc baking applies.
 *    - lake     → [name, x1, y1, ...] into state.lakes. ≥3 pts.
 *    - building → [name, type, x1, y1, ...] into state.buildings.
 *                 ≥3 pts. Auto-driveway via deps.makeDriveway when
 *                 d.autoDriveway: appends a synthesized surface row
 *                 to state.surfaces. */
export function _weCommitDraft(
  state: WorldEditorState,
  deps: DraftDeps,
): void {
  const d = state.draft;
  if (!d) return;

  // Arc / smoothing — replaces user-clicked control points with denser
  // sampled curves BEFORE serializing the row, baking the curve into
  // the stored polyline so the existing render + physics pipelines see
  // it as a longer polyline (no schema change).
  //
  //   ROADS (open polyline)
  //     v8.99.124.30: bake when Arc is on AND curve is nonzero, via the
  //     perpendicular-offset _weCurvePoints. Default off. Roads need
  //     precise control for AI / traffic / merge bonding, so smoothing
  //     stays opt-in.
  //
  //   RIVERS (open polyline)
  //     H698: ALWAYS smooth at commit via smoothPolyline (the same
  //     midpoint-Bezier smoother roads render with). Addresses user
  //     feedback that rivers don't visibly arc by default — they shipped
  //     requiring the Arc toggle which most users never noticed.
  //
  //   CLOSED POLYGONS (lake, surface, building, parkingLot)
  //     H698: ALWAYS smooth at commit via smoothClosedPolygon (tripled
  //     smoothPolyline with middle-third extraction so every vertex
  //     gets the same treatment, no kink at the start/end). Replaces
  //     the H696 close-on-wrap+_weCurvePoints path that bowed each
  //     segment but kept sharp vertices — the very thing the user
  //     reported still looked angular.
  const arcOn = !!state.draftProps.arc && (state.draftProps.curve || 0) !== 0;
  const isClosedPath =
    d.kind === 'surface' || d.kind === 'building' || d.kind === 'lake' ||
    d.kind === 'parkingLot';
  let ptsForCommit: TilePoint[];
  if (d.kind === 'road' && arcOn) {
    ptsForCommit = _weCurvePoints(
      d.pts.map((p) => [p[0], p[1]] as TilePoint),
      state.draftProps.curve,
    );
  } else if (d.kind === 'river' && d.pts.length >= 3) {
    ptsForCommit = smoothPolyline(
      d.pts.map((p) => [p[0], p[1]] as [number, number]),
      4,
    ).map((p) => [p[0], p[1]] as TilePoint);
  } else if (isClosedPath && d.pts.length >= 3) {
    ptsForCommit = smoothClosedPolygon(
      d.pts.map((p) => [p[0], p[1]] as [number, number]),
      4,
    ).map((p) => [p[0], p[1]] as TilePoint);
  } else {
    ptsForCommit = d.pts.map((p) => [p[0], p[1]] as TilePoint);
  }

  if (d.kind === 'road') {
    if (ptsForCommit.length < 2) {
      state.draft = null;
      state.needsRedraw = true;
      return;
    }
    // v8.99.126.03: merge roads bond endpoints to nearby destination
    // roads via the dispatcher. Non-merge roads pass through verbatim.
    const ptsBonded: [number, number][] = d.merge
      ? deps.mergeBondEndpoints(
          ptsForCommit.map((p) => [p[0], p[1]] as [number, number]),
          d.w ?? state.draftProps.w,
          d.mergeAlign ?? state.draftProps.mergeAlign ?? 1,
          d.mergeType ?? state.draftProps.mergeType ?? 0,
          state.draftProps.loopDiameter || 0,
        )
      : ptsForCommit.map((p) => [p[0], p[1]] as [number, number]);
    // v8.99.126.00 + .05 + .36: merge → 5-meta row with encoded
    // (mergeType, mergeAlign) at row[4]; non-merge → legacy 4-meta.
    const row: (string | number)[] = d.merge
      ? [
          d.w ?? state.draftProps.w,
          d.maj ?? state.draftProps.maj,
          d.name || 'Unnamed',
          d.z ?? state.draftProps.z,
          _encodeMergeFlag(
            d.mergeType ?? state.draftProps.mergeType ?? 0,
            d.mergeAlign ?? state.draftProps.mergeAlign ?? 1,
          ),
        ]
      : [
          d.w ?? state.draftProps.w,
          d.maj ?? state.draftProps.maj,
          d.name || 'Unnamed',
          d.z ?? state.draftProps.z,
        ];
    for (const p of ptsBonded) {
      row.push(Number(p[0].toFixed(2)));
      row.push(Number(p[1].toFixed(2)));
    }
    (state.overlay as unknown[]).push(row);
    // v8.99.126.50: inherit draftProps material/age onto the new
    // overlay row's sidecar entry. Keyed by overlay index — the row we
    // just pushed is at overlay.length - 1.
    const newIdx = (state.overlay as unknown[]).length - 1;
    const dpMat = state.draftProps.material;
    const dpAge = state.draftProps.age;
    const matExplicit = dpMat === 'asphalt' || dpMat === 'concrete';
    const ageExplicit = dpAge === 'new' || dpAge === 'old';
    if (matExplicit || ageExplicit) {
      state.overlayRoadProps = state.overlayRoadProps ?? {};
      state.overlayRoadProps[newIdx] = state.overlayRoadProps[newIdx] ?? {};
      if (matExplicit) state.overlayRoadProps[newIdx].material = dpMat;
      if (ageExplicit) state.overlayRoadProps[newIdx].age = dpAge;
    }
  } else if (d.kind === 'surface') {
    if (ptsForCommit.length < 3) {
      state.draft = null;
      state.needsRedraw = true;
      return;
    }
    const row: (string | number)[] = [d.name || 'Lot', d.z ?? 0];
    for (const p of ptsForCommit) {
      row.push(Number(p[0].toFixed(2)));
      row.push(Number(p[1].toFixed(2)));
    }
    (state.surfaces as unknown[]).push(row);
  } else if (d.kind === 'river') {
    if (ptsForCommit.length < 2) {
      state.draft = null;
      state.needsRedraw = true;
      return;
    }
    // v8.99.124.28: river row = [w, name, x1, y1, ...].
    const row: (string | number)[] = [d.w ?? state.riverProps.w, d.name || 'River'];
    for (const p of ptsForCommit) {
      row.push(Number(p[0].toFixed(2)));
      row.push(Number(p[1].toFixed(2)));
    }
    (state.rivers as unknown[]).push(row);
  } else if (d.kind === 'lake') {
    if (ptsForCommit.length < 3) {
      state.draft = null;
      state.needsRedraw = true;
      return;
    }
    const row: (string | number)[] = [d.name || 'Lake'];
    for (const p of ptsForCommit) {
      row.push(Number(p[0].toFixed(2)));
      row.push(Number(p[1].toFixed(2)));
    }
    (state.lakes as unknown[]).push(row);
  } else if (d.kind === 'parkingLot') {
    // H693: parking-lot commit. Row schema:
    //   - H693 legacy: [name, x1, y1, ...]                  (odd length)
    //   - H695 with material: [name, material, x1, y1, ...] (even length)
    // Length parity distinguishes the two at decode time (every consumer
    // checks `(row.length & 1) === 0` to detect the H695 schema). New
    // rows always write the H695 form; the legacy decode keeps any saves
    // from the morning of H693 loading cleanly. Mirrors the road
    // 4-meta-vs-5-meta-merge parity trick at L13-25.
    if (ptsForCommit.length < 3) {
      state.draft = null;
      state.needsRedraw = true;
      return;
    }
    const mat: 'asphalt' | 'concrete' =
      d.material === 'concrete' ? 'concrete' : 'asphalt';
    const row: (string | number)[] = [d.name || 'Parking Lot', mat];
    for (const p of ptsForCommit) {
      row.push(Number(p[0].toFixed(2)));
      row.push(Number(p[1].toFixed(2)));
    }
    (state.parkingLots as unknown[]).push(row);
  } else if (d.kind === 'building') {
    if (ptsForCommit.length < 3) {
      state.draft = null;
      state.needsRedraw = true;
      return;
    }
    const row: (string | number)[] = [d.name || 'Building', d.type || 'house'];
    for (const p of ptsForCommit) {
      row.push(Number(p[0].toFixed(2)));
      row.push(Number(p[1].toFixed(2)));
    }
    (state.buildings as unknown[]).push(row);
    // Auto-driveway: emit a surface polygon connecting the building
    // footprint to the nearest road. Stub deps return null when no
    // road is in range or the modular tree doesn't have a driveway
    // builder wired — both cases gracefully skip the surface push.
    if (d.autoDriveway) {
      const dwPts = deps.makeDriveway(ptsForCommit);
      if (dwPts && dwPts.length >= 3) {
        const sRow: (string | number)[] = [`${d.name || 'Building'} driveway`, 0];
        for (const p of dwPts) {
          sRow.push(Number(p[0].toFixed(2)));
          sRow.push(Number(p[1].toFixed(2)));
        }
        (state.surfaces as unknown[]).push(sRow);
      }
    }
  }

  state.draft = null;
  deps.rebuildWorld();
  state.needsRedraw = true;
}

/** Discard the active draft without committing. 1:1 port of monolith
 *  L15124-15155. */
export function _weCancelDraft(state: WorldEditorState): void {
  state.draft = null;
  state.needsRedraw = true;
}

/** Densely sample a quadratic-Bezier-shaped polyline from the user's
 *  control points. `curve` is the bow height in tiles (negative = bow
 *  the other way). Per-segment control point sits at the chord midpoint
 *  offset by `curve` along the perpendicular "right" of travel. Sample
 *  count clamped to [4, 20] per segment, scaling with chord length.
 *  Input is never mutated; first point is copied verbatim into the
 *  output and each segment appends its samples plus the segment
 *  endpoint. Returns the original points (sliced) when curve===0 or
 *  pts is degenerate. Ported 1:1 from monolith L15642-15666. */
export function _weCurvePoints(pts: TilePoint[], curve: number): TilePoint[] {
  if (!pts || pts.length < 2) return pts ? pts.map((p) => [p[0], p[1]] as TilePoint) : [];
  if (!curve) return pts.map((p) => [p[0], p[1]] as TilePoint);
  const out: TilePoint[] = [[pts[0][0], pts[0][1]]];
  for (let i = 0; i < pts.length - 1; i++) {
    const A = pts[i], B = pts[i + 1];
    const dx = B[0] - A[0], dy = B[1] - A[1];
    const chordLen = Math.hypot(dx, dy);
    if (chordLen < 0.01) { out.push([B[0], B[1]]); continue; }
    const ux = dx / chordLen, uy = dy / chordLen;
    const nx = -uy, ny = ux;            // perpendicular, "right" of travel
    const mx = (A[0] + B[0]) / 2 + nx * curve;
    const my = (A[1] + B[1]) / 2 + ny * curve;
    const numSamples = Math.max(4, Math.min(20, Math.ceil(chordLen / 8)));
    for (let s = 1; s < numSamples; s++) {
      const t = s / numSamples;
      const u = 1 - t;
      const px = u * u * A[0] + 2 * u * t * mx + t * t * B[0];
      const py = u * u * A[1] + 2 * u * t * my + t * t * B[1];
      out.push([px, py]);
    }
    out.push([B[0], B[1]]);
  }
  return out;
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
