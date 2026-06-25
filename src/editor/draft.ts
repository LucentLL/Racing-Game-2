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

import type { WorldEditorState, DraftKind, EditorDraft, BondTarget } from './index';
import type { TilePoint } from './stamp';
import { smoothPolyline, smoothClosedPolygon } from '@/render/pathSmoothing';
import { _hermiteSplineThroughKnots } from './merge/curves';
import { _weSnapshotForUndo } from './undo';

/** Host bindings for draft commit — pulls in the merge dispatcher and
 *  the world rebuild so draft.ts doesn't depend on apply.ts directly. */
export interface DraftDeps {
  /** Call the merge dispatcher (editor/merge/*). H887: optional sideOut
   *  accumulator captures each bonded endpoint's resolved inward (toward-
   *  destination) unit vector so the commit can persist the merge side. */
  mergeBondEndpoints(
    pts: TilePoint[],
    dW: number,
    mergeAlign: number,
    mergeType: number,
    loopDiameter: number,
    sideOut?: { start?: [number, number]; end?: [number, number] },
    rampZ?: number,
    /** H902: explicit clicked-lane targets for the start / end endpoints
     *  (the standard branch bonds to exactly these instead of re-scanning). */
    startTarget?: BondTarget | null,
    endTarget?: BondTarget | null,
  ): TilePoint[];
  /** Auto-driveway polygon for a committed building. */
  makeDriveway(buildingPts: TilePoint[]): TilePoint[] | null;
  /** Trigger world rebuild after commit. */
  rebuildWorld(): void;
  /** H932: live road set (baseline + overlay), for junction-aware road
   *  smoothing — the commit pins a road endpoint's tangent to a coincident
   *  road's tangent so the join is collinear (no sharp angle). Optional so
   *  callers/tests without road access fall back to natural-end smoothing. */
  getMajorRoads?(): ReadonlyArray<{ pts: ReadonlyArray<readonly number[]> }>;
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
      // H902: per-point clicked-lane targets, aligned with pts.
      ptSnaps: [],
      w: p.w,
      maj: p.maj,
      name: p.name,
      z: p.z,
      arc: p.arc,
      curve: p.curve,
      merge: p.merge,
      mergeAlign: p.mergeAlign,
      mergeType: p.mergeType,
      // H914: seed the loop diameter so the LIVE loop preview honors the menu
      // value from frame 1 (commit already read draftProps.loopDiameter; only
      // the in-draft preview was reading an unset field and falling back to the
      // drawn-extent radius).
      loopDiameter: p.loopDiameter,
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
      // H699: bake per-row stall/aisle dimensions at draft-start —
      // same logic as material; mid-draft slider tweaks flow into
      // the live draft via _weReadProps.
      stallW: state.parkingLotProps.stallW,
      stallL: state.parkingLotProps.stallL,
      aisleW: state.parkingLotProps.aisleW,
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

/** H932: unit vector, guarding the zero-length case. */
function _unit(dx: number, dy: number): [number, number] {
  const L = Math.hypot(dx, dy) || 1;
  return [dx / L, dy / L];
}

/** H932: if `pt` coincides (within ~2 tiles) with another road's ENDPOINT,
 *  return the unit direction pointing AWAY from that road's body
 *  (endpoint − interior neighbour) — the direction along which a road
 *  connecting here continues PAST the join, collinear with it. Returns null
 *  when no road endpoint is near (a free end). Picks the nearest endpoint
 *  across all roads. Roads shorter than 2 points are skipped. */
function _junctionAwayDir(
  pt: TilePoint,
  roads: ReadonlyArray<{ pts: ReadonlyArray<readonly number[]> }>,
): [number, number] | null {
  const THRESH2 = 2.0 * 2.0;
  let best: [number, number] | null = null;
  let bestD2 = THRESH2;
  for (const r of roads) {
    const rp = r.pts;
    if (!rp || rp.length < 2) continue;
    for (const k of [0, rp.length - 1]) {
      const ex = rp[k][0];
      const ey = rp[k][1];
      const ddx = ex - pt[0];
      const ddy = ey - pt[1];
      const d2 = ddx * ddx + ddy * ddy;
      if (d2 < bestD2) {
        bestD2 = d2;
        const adj = k === 0 ? rp[1] : rp[rp.length - 2];
        best = _unit(ex - adj[0], ey - adj[1]);
      }
    }
  }
  return best;
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

  // H892: snapshot the editable collections BEFORE committing so Back can
  // undo this placement.
  _weSnapshotForUndo(state);

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
  } else if (d.kind === 'road' && !d.merge && d.pts.length >= 2) {
    // H932 / H934: smooth a plain road through its clicked vertices AND fuse it
    // smoothly into any road it connects to — so there is NEVER a sharp angle,
    // whether WITHIN a road or where one road JOINS another (user, repeatedly).
    //
    // A clamped Hermite passes exactly through every click (the road stays where
    // drawn), has no overshoot, and PRESERVES the endpoints (bonding/connections
    // unaffected). Each end's tangent is:
    //   - if the endpoint coincides with another road's endpoint → pinned to
    //     that road's direction, so the join is COLLINEAR (the two roads read as
    //     one continuous smooth curve, no corner);
    //   - otherwise → the natural drawn direction (smooth interior, free end).
    //
    // H934: this now fires for a 2-POINT straight section too, but ONLY when an
    // endpoint connects to another road (startAway/endAway resolved) — so
    // "adding a new section of road" to an existing road bends that section
    // tangentially into the join instead of meeting it at a corner. A 2-point
    // section with no junction stays straight (nothing to smooth). Merge roads
    // keep raw clicks (the merge bonder smooths them); arc-on roads keep the
    // explicit _weCurvePoints bow above.
    const raw = d.pts.map((p) => [p[0], p[1]] as TilePoint);
    const N = raw.length;
    const roads = deps.getMajorRoads ? deps.getMajorRoads() : [];
    const startAway = _junctionAwayDir(raw[0], roads);
    const endAway = _junctionAwayDir(raw[N - 1], roads);
    if (N >= 3 || startAway || endAway) {
      const tanStart: [number, number] =
        startAway ?? _unit(raw[1][0] - raw[0][0], raw[1][1] - raw[0][1]);
      // At the END the curve must ARRIVE heading INTO the joined road's body,
      // i.e. the negative of "away from its body".
      const tanEnd: [number, number] = endAway
        ? [-endAway[0], -endAway[1]]
        : _unit(raw[N - 1][0] - raw[N - 2][0], raw[N - 1][1] - raw[N - 2][1]);
      ptsForCommit = _hermiteSplineThroughKnots(raw, 8, tanStart, tanEnd);
    } else {
      // 2-point straight section with no junction → leave straight.
      ptsForCommit = raw;
    }
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
    // H887: capture the resolved bond side(s) so the merge attaches to —
    // and stays on — the side the user drew toward, instead of being
    // re-guessed (or collapsing to a centerline straddle) on rebuild.
    const bondSideOut: { start?: [number, number]; end?: [number, number] } = {};
    // H902: the lane the user CLICKED for each bonded endpoint (captured at
    // placement). ptSnaps is aligned with d.pts, whose first/last entries
    // map to the committed polyline's first/last even through arc baking
    // (_weCurvePoints preserves endpoints).
    const _snaps = d.ptSnaps;
    const _startTarget = _snaps?.[0] ?? null;
    const _endTarget = _snaps && _snaps.length ? _snaps[_snaps.length - 1] : null;
    const ptsBonded: [number, number][] = d.merge
      ? deps.mergeBondEndpoints(
          ptsForCommit.map((p) => [p[0], p[1]] as [number, number]),
          d.w ?? state.draftProps.w,
          // H887: default to Auto (4 — click-bonded outboard) not Center
          // (1 — centerline straddle). Matches the toolbar's already-
          // highlighted Auto default (index.html ROW 7).
          d.mergeAlign ?? state.draftProps.mergeAlign ?? 4,
          d.mergeType ?? state.draftProps.mergeType ?? 0,
          state.draftProps.loopDiameter || 0,
          bondSideOut,
          // H888: ramp elevation — bonds prefer a same-z destination so a
          // bridge-deck merge attaches to the deck, not the ground below.
          d.z ?? state.draftProps.z,
          // H902: bind each end to the clicked lane/side (no re-guessing).
          _startTarget,
          _endTarget,
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
            // H887: Auto (4) default, matching the bonded-pts call above.
            d.mergeAlign ?? state.draftProps.mergeAlign ?? 4,
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
    // H886: one-way is a directional flag, not a surface — inherit it onto
    // the new row's sidecar whenever the draft toggle is on (mirrors the
    // material/age inheritance just above).
    const onewayExplicit = state.draftProps.oneway === true;
    // H887: persist the resolved bond side(s) on the same sidecar so the
    // merge geometry stops re-deriving the side every rebuild.
    const hasBondSide = !!(bondSideOut.start || bondSideOut.end);
    if (matExplicit || ageExplicit || onewayExplicit || hasBondSide) {
      state.overlayRoadProps = state.overlayRoadProps ?? {};
      state.overlayRoadProps[newIdx] = state.overlayRoadProps[newIdx] ?? {};
      if (matExplicit) state.overlayRoadProps[newIdx].material = dpMat;
      if (ageExplicit) state.overlayRoadProps[newIdx].age = dpAge;
      if (onewayExplicit) state.overlayRoadProps[newIdx].oneway = true;
      if (bondSideOut.start) state.overlayRoadProps[newIdx].bondInnerStart = bondSideOut.start;
      if (bondSideOut.end) state.overlayRoadProps[newIdx].bondInnerEnd = bondSideOut.end;
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
    // Parking-lot commit. Row schema by hop:
    //   - H693 legacy: [name, x1, y1, ...]                                    (odd, row[1] number)
    //   - H695: [name, material, x1, y1, ...]                                 (even)
    //   - H699: [name, material, stallW, stallL, aisleW, x1, y1, ...]         (odd, row[1] string)
    // New rows always write H699. Legacy decoders live in
    // _weParseParkingLotMeta (stamp.ts); storage.ts migrates old rows
    // to H699 on load.
    if (ptsForCommit.length < 3) {
      state.draft = null;
      state.needsRedraw = true;
      return;
    }
    const mat: 'asphalt' | 'concrete' =
      d.material === 'concrete' ? 'concrete' : 'asphalt';
    const stallW = d.stallW ?? state.parkingLotProps.stallW;
    const stallL = d.stallL ?? state.parkingLotProps.stallL;
    const aisleW = d.aisleW ?? state.parkingLotProps.aisleW;
    const row: (string | number)[] = [
      d.name || 'Parking Lot',
      mat,
      Number(stallW.toFixed(2)),
      Number(stallL.toFixed(2)),
      Number(aisleW.toFixed(2)),
    ];
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
  let _ma = (mergeAlign | 0) % 10 || 1;
  // H786: cloverleaf loops always store click-bonded asymmetric — the
  // loop lane sits fully outboard of the destinations' edge stripes by
  // construction, so the Center default (symmetric band straddling the
  // stripe, half a lane overlapping the highway) is never the intended
  // geometry. The render side coerces too (legacy rows heal on draw);
  // encoding it here keeps the stored data truthful for new commits.
  if (_mt === 1) _ma = 4;
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
