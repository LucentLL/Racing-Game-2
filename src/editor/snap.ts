/**
 * World Editor — click/tap snap targets + endpoint snap pass.
 *
 * Two snap surfaces:
 *
 *  1. INTERACTIVE SNAP (`_weFindSnap`): called per pointer-move / tap
 *     while drafting. Returns the best snap target for the current
 *     click position, or null. The returned snap target replaces the
 *     raw click position before the draft point is placed.
 *
 *  2. EXPLICIT SNAP PASS (`_weSnapSelectedEndpoints`,
 *     `_weSnapDraftLastPoint`): triggered by the Snap toolbar button.
 *     Pulls the selected item's endpoints (or the active draft's last
 *     point) onto the nearest nearby geometry within a 50-tile radius.
 *
 * WIDTH-AWARE SNAP RADIUS (v8.99.124.25): the old fixed thresh =
 * max(2, 12/zoom) was always ~2 tiles, but a major highway with w=12
 * renders asphalt ~10 tiles wide (5 each side of center). Clicking on
 * the visible asphalt put the user 5 tiles from centerline — outside
 * the 2-tile snap window — so clicks landed in floating space and the
 * new road's endpoint never recalibrated to the highway centerline.
 * Fix: per-road threshold = max(baseThresh, r.w * widthFactor) with
 * SEGMENT_WIDTH_FACTOR = 0.55 (just past the visible asphalt edge so
 * the snap still triggers if the user clicks slightly outside the
 * pavement) and ENDPOINT_WIDTH_FACTOR = 0.4 (tighter feel near
 * terminals).
 *
 * LANE-CENTER SNAP FOR MERGE DRAFTS (v8.99.124.26+):
 *
 *  v8.99.126.24: ROOT CAUSE of "merge picks wrong lane on one end" —
 *  the click placement system snapped to segment PROJECTION
 *  (perpendicular foot on centerline). The bonding code in _detectBond
 *  then snapped that to nearest lane center using the perpendicular
 *  distance from the ORIGINAL CLICK to the centerline. But because the
 *  placement already moved the click TO the centerline, the
 *  perpendicular distance was effectively zero by the time _detectBond
 *  ran — lane index always defaulted to lane 1.
 *
 *  v8.99.126.26: ROOT CAUSE of "lane taper not adding a lane, angling
 *  INTO current lanes" — the v126.24 snap returned lane CENTER coords,
 *  so _detectBond placed bondedTip on lane center. The polygon
 *  (symmetric ±halfLane around polyline) then physically OCCUPIED the
 *  chosen lane — overlapping the destination's lane geometry. Real-
 *  world DOT MUTCD entrance/exit ramps don't go INTO a specific lane;
 *  they ADD an auxiliary lane OUTSIDE the destination's outermost lane.
 *  FIX: snap target = edge stripe position on the click's side
 *  (destHalfW − STRIPE_INSET inset, matching getRoadProfile's edgeOffsets).
 *  Lane index is still computed and stored for visualization (the
 *  magenta L1/L2 label) but the returned coords are the edge stripe.
 *
 *  Active for ROAD-PLACE drafts only (not surface/building/river/lake),
 *  and only when draftProps.merge is true. Endpoint and segment-
 *  centerline snap remain available as fallbacks for clicks outside
 *  any road's footprint.
 *
 * RIVER SNAP (`_weFindRiverSnap`): mirrors road snap but operates on
 * the rivers row array. Used when the River tool is active.
 *
 * SELF-SNAP FOR LOOP CLOSURE (v8.99.124.31): the explicit snap pass
 * ALSO considers the row's own opposite endpoint as a snap target. For
 * a near-closed loop, this lets the start snap to where the end is (or
 * vice-versa), closing the gap. dSelf > 0.01 guard avoids degenerate
 * cases where the endpoints are already coincident.
 *
 * Ported from monolith L11972-15295.
 *
 * SCAFFOLD status: type contract + entry points stubbed with TODO line refs.
 */

import type { WorldEditorState } from './index';
import type { TilePoint } from './stamp';

/** Tunable thresholds, exported so they're discoverable in one place. */
export const SNAP_BASE_THRESH_MIN = 2;
export const SNAP_BASE_THRESH_ZOOM_DENOM = 12;
export const SEGMENT_WIDTH_FACTOR = 0.55;
export const ENDPOINT_WIDTH_FACTOR = 0.4;
export const EXPLICIT_SNAP_MAX_DIST = 50;
/** Stripe inset matches editor/merge/taper.ts STRIPE_INSET_TILES.
 *  Duplicated as a constant here (not imported) to keep snap module
 *  free of a dep on merge geometry. */
export const SNAP_STRIPE_INSET_TILES = 1.7;

/** Returned by _weFindSnap / _weFindRiverSnap when a snap target is
 *  found. Coordinates are in tile space. Includes contextual info the
 *  bonding code needs. Road snaps populate `roadIdx`; river snaps
 *  populate `riverIdx` — exactly one of the two carries the index,
 *  matching the monolith's discriminator-by-which-field-is-set shape. */
export interface SnapResult {
  tx: number;
  ty: number;
  /** Snap kind — drives downstream bonding behavior. 'lane' matches
   *  the monolith's 'lane' string (NOT 'laneEdge') so downstream
   *  _detectBond can branch identically. */
  kind: 'segment' | 'endpoint' | 'lane' | 'self';
  /** Index into majorRoads (-1 if not a road snap). */
  roadIdx: number;
  /** Segment index within that road or river. For endpoint snaps this
   *  is the endpoint index (0 = first vertex, pts.length-1 = last). */
  segIdx: number;
  /** Lane number relative to the destination road's centerline
   *  (1-based, always positive — `side` carries the L/R sign). Used
   *  for the magenta L1/L2 label even though the coords now point at
   *  the edge stripe — v8.99.126.26 split. */
  laneIdx?: number;
  /** +1 = click on right side of raw segment tangent, -1 = left side.
   *  Stored separately from laneIdx (matches monolith) so downstream
   *  callers can read side without re-deriving from a signed lane
   *  index. v8.99.126.24/.26. */
  side?: 1 | -1;
  /** Index into WORLD_EDITOR.rivers (populated by river-snap only —
   *  v8.99.124.28). Set to undefined for road snaps. */
  riverIdx?: number;
}

/** Host bindings for snap. The snap module reads from the live
 *  geometry arrays (majorRoads + WORLD_EDITOR.rivers etc.) and from
 *  getRoadProfile. */
export interface SnapDeps {
  getMajorRoads(): Array<{ pts: number[][]; w: number; name?: string; [k: string]: unknown }>;
  /** Minimal lane geometry the merge / lane-edge-stripe branch needs.
   *  Matches the subset of the monolith's getRoadProfile fields the
   *  merge branch reads (`lps`, `laneW`, `totalW`). Returning null
   *  short-circuits the merge branch's per-road inner loop (mirrors
   *  the monolith's `if(!dProf) continue` guard). */
  getRoadProfile(road: { pts: number[][]; w: number; name?: string }): {
    lps: number;
    laneW: number;
    totalW: number;
  } | null;
  TILE: number;
  /** Trigger world rebuild after the explicit snap pass mutates rows. */
  rebuildWorld(): void;
}

/** Find the best snap target for a click at (tx, ty) in tile coords.
 *  Returns null if nothing is in range.
 *
 *  H316 ports the NON-MERGE branch (L12092-12126): a two-pass scan
 *  across majorRoads. Pass 1 visits every road's first+last endpoint;
 *  if anything hits within `max(baseThresh, w * ENDPOINT_WIDTH_FACTOR)`
 *  the function returns immediately — endpoints take precedence over
 *  segments globally. Pass 2 (only reached when no endpoint matched)
 *  projects (tx,ty) onto every segment of every road and picks the
 *  closest segment hit within `max(baseThresh, w * SEGMENT_WIDTH_FACTOR)`.
 *
 *  H317 will fill in the MERGE branch (L12012-12091) — when
 *  draftProps.merge is on, an early lane-edge-stripe pass runs first
 *  and returns its hit instead of falling through to endpoints. Until
 *  then the merge guard sits as a no-op so unmerged drafts already
 *  benefit from snap. */
export function _weFindSnap(
  tx: number,
  ty: number,
  state: WorldEditorState,
  deps: SnapDeps,
): SnapResult | null {
  const baseThresh = Math.max(
    SNAP_BASE_THRESH_MIN,
    SNAP_BASE_THRESH_ZOOM_DENOM / state.view.zoom,
  );

  const roads = deps.getMajorRoads();

  // H317: MERGE / LANE-EDGE-STRIPE early-return (v8.99.126.24/.26).
  // Active for road-place drafts only, when draftProps.merge is on.
  //
  // v8.99.126.24 root cause: pre-fix, the merge snap returned segment
  // centerline coords and _detectBond later snapped to nearest lane
  // center using the click's perp distance — but the click was ALREADY
  // moved to centerline by the projection step, so perp distance was
  // zero and lane index always defaulted to 1.
  //
  // v8.99.126.26 root cause: that fix returned lane CENTER coords, so
  // _detectBond's bondedTip landed on lane center. The merge polygon
  // (symmetric ±halfLane around polyline) then physically OCCUPIED
  // the chosen lane — overlapping destination lane geometry. Real
  // DOT MUTCD ramps don't merge INTO a lane; they ADD an auxiliary
  // lane OUTSIDE the destination's outermost lane.
  //
  // v126.26 fix: snap target = EDGE STRIPE on the click's side
  // (destHalfW − SNAP_STRIPE_INSET_TILES / TILE inset, matching
  // getRoadProfile's edgeOffsets). Lane index is still computed and
  // returned for the magenta L1/L2 label, but the (tx, ty) coords are
  // the edge stripe — _detectBond uses those verbatim.
  const isMergeDraft = state.tool === 'place' && !!state.draftProps?.merge;
  if (isMergeDraft) {
    let mergeBestD = Infinity;
    let mergeBest: SnapResult | null = null;
    for (let i = 0; i < roads.length; i++) {
      const r = roads[i];
      if (!r.pts || r.pts.length < 2) continue;
      const dProf = deps.getRoadProfile(r);
      if (!dProf) continue;
      const lps = dProf.lps;
      const laneW = dProf.laneW;
      // Lane snap radius: 60% of total road width (generous enough that
      // any click within the asphalt picks SOME lane). Floored at half
      // baseThresh so very-zoomed-out users still get some snap window.
      const laneSnapR = Math.max(baseThresh * 0.5, dProf.totalW * 0.6);
      for (let s = 0; s < r.pts.length - 1; s++) {
        const ax = r.pts[s][0], ay = r.pts[s][1];
        const bx = r.pts[s + 1][0], by = r.pts[s + 1][1];
        const vx = bx - ax, vy = by - ay;
        const len2 = vx * vx + vy * vy;
        if (len2 < 0.0001) continue;
        let t = ((tx - ax) * vx + (ty - ay) * vy) / len2;
        t = Math.max(0, Math.min(1, t));
        const projX = ax + t * vx, projY = ay + t * vy;
        const segLen = Math.sqrt(len2);
        const tdx = vx / segLen, tdy = vy / segLen;
        // perpSigned > 0 → click on right of raw tangent.
        const perpSigned = (tx - projX) * (-tdy) + (ty - projY) * tdx;
        const sgn = perpSigned >= 0 ? 1 : -1;
        // STRIPE_INSET matches getRoadProfile's edgeOffsets calc:
        // halfW − 1.7/TILE (1.7 px stripe inset at TILE=18 = 0.094
        // tiles). Same as the SNAP_STRIPE_INSET_TILES constant.
        const stripeInset = SNAP_STRIPE_INSET_TILES / deps.TILE;
        const edgeOff = Math.max(0, dProf.totalW * 0.5 - stripeInset);
        const stripeX = projX + sgn * (-tdy) * edgeOff;
        const stripeY = projY + sgn * tdx * edgeOff;
        // Lane the click is closest to (informational only — drives
        // the magenta L1/L2 label even though coords point at edge).
        let bestLane = 1;
        let bestDelta = Math.abs(Math.abs(perpSigned) - 0.5 * laneW);
        for (let k = 2; k <= lps; k++) {
          const laneOff = (k - 0.5) * laneW;
          const delta = Math.abs(Math.abs(perpSigned) - laneOff);
          if (delta < bestDelta) {
            bestDelta = delta;
            bestLane = k;
          }
        }
        const d = Math.hypot(stripeX - tx, stripeY - ty);
        if (d < laneSnapR && d < mergeBestD) {
          mergeBestD = d;
          mergeBest = {
            tx: stripeX,
            ty: stripeY,
            kind: 'lane',
            roadIdx: i,
            segIdx: s,
            laneIdx: bestLane,
            side: sgn >= 0 ? 1 : -1,
          };
        }
      }
    }
    // If the merge branch found a hit, return it. Otherwise fall
    // through to the standard endpoint/segment scan — clicks far from
    // any road's footprint (e.g. extending the merge polyline well
    // past either destination) still benefit from the regular snap.
    if (mergeBest) return mergeBest;
  }

  let bestD = Infinity;
  let bestSnap: SnapResult | null = null;

  // Pass 1 — endpoints across ALL roads. Return early if any matched.
  for (let i = 0; i < roads.length; i++) {
    const r = roads[i];
    if (!r.pts || r.pts.length < 2) continue;
    const epThresh = Math.max(baseThresh, (r.w || 4) * ENDPOINT_WIDTH_FACTOR);
    const eps: Array<[number[], number]> = [
      [r.pts[0], 0],
      [r.pts[r.pts.length - 1], r.pts.length - 1],
    ];
    for (let k = 0; k < eps.length; k++) {
      const [p, segIdx] = eps[k];
      const d = Math.hypot(p[0] - tx, p[1] - ty);
      if (d < epThresh && d < bestD) {
        bestD = d;
        bestSnap = {
          tx: p[0],
          ty: p[1],
          kind: 'endpoint',
          roadIdx: i,
          segIdx,
        };
      }
    }
  }
  if (bestSnap) return bestSnap;

  // Pass 2 — segment projections. Only runs when no endpoint matched.
  for (let i = 0; i < roads.length; i++) {
    const r = roads[i];
    if (!r.pts || r.pts.length < 2) continue;
    const segThresh = Math.max(baseThresh, (r.w || 4) * SEGMENT_WIDTH_FACTOR);
    for (let s = 0; s < r.pts.length - 1; s++) {
      const ax = r.pts[s][0], ay = r.pts[s][1];
      const bx = r.pts[s + 1][0], by = r.pts[s + 1][1];
      const vx = bx - ax, vy = by - ay;
      const len2 = vx * vx + vy * vy;
      if (len2 < 0.0001) continue;
      let t = ((tx - ax) * vx + (ty - ay) * vy) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = ax + t * vx, py = ay + t * vy;
      const d = Math.hypot(px - tx, py - ty);
      if (d < segThresh && d < bestD) {
        bestD = d;
        bestSnap = {
          tx: px,
          ty: py,
          kind: 'segment',
          roadIdx: i,
          segIdx: s,
        };
      }
    }
  }
  return bestSnap;
}

/** River-targeted snap. Mirrors _weFindSnap's endpoint/segment shape
 *  but iterates `state.rivers` (no merge / lane-edge-stripe branch —
 *  rivers don't carry lane geometry). Same width-aware threshold rules:
 *  endpoint = max(baseThresh, w * 0.4), segment = max(baseThresh, w *
 *  0.55). Endpoints take precedence over segments WITHIN the same river
 *  iteration (`continue` short-circuits the segment scan after a closer
 *  endpoint wins for that river), but a later river's segment can still
 *  beat an earlier river's endpoint if it's closer overall.
 *
 *  Ported 1:1 from monolith L12131-12169. */
export function _weFindRiverSnap(
  tx: number,
  ty: number,
  state: WorldEditorState,
): SnapResult | null {
  const baseThresh = Math.max(
    SNAP_BASE_THRESH_MIN,
    SNAP_BASE_THRESH_ZOOM_DENOM / state.view.zoom,
  );
  let bestD = Infinity;
  let bestSnap: SnapResult | null = null;
  for (let i = 0; i < state.rivers.length; i++) {
    const rv = state.rivers[i];
    if (!Array.isArray(rv) || rv.length < 6) continue;
    const rvArr = rv as unknown[];
    const w = (rvArr[0] as number) || 4;
    const pts: Array<[number, number]> = [];
    for (let k = 2; k < rvArr.length; k += 2) {
      pts.push([rvArr[k] as number, rvArr[k + 1] as number]);
    }
    if (pts.length < 2) continue;
    const epThresh = Math.max(baseThresh, w * ENDPOINT_WIDTH_FACTOR);
    const segThresh = Math.max(baseThresh, w * SEGMENT_WIDTH_FACTOR);
    // Endpoints first.
    for (const k of [0, pts.length - 1]) {
      const p = pts[k];
      const d = Math.hypot(p[0] - tx, p[1] - ty);
      if (d < epThresh && d < bestD) {
        bestD = d;
        bestSnap = {
          tx: p[0],
          ty: p[1],
          kind: 'endpoint',
          roadIdx: -1,
          segIdx: k,
          riverIdx: i,
        };
      }
    }
    // Monolith's `if(best.snap && best.snap.kind==='endpoint') continue`
    // checks the GLOBAL best — not a per-iteration flag. Once any
    // endpoint becomes the global best, ALL subsequent rivers' segment
    // scans are skipped too (endpoints stay sticky). Endpoints from
    // later rivers can still displace it via the bestD running minimum.
    if (bestSnap && bestSnap.kind === 'endpoint') continue;
    for (let s = 0; s < pts.length - 1; s++) {
      const ax = pts[s][0], ay = pts[s][1];
      const bx = pts[s + 1][0], by = pts[s + 1][1];
      const vx = bx - ax, vy = by - ay;
      const len2 = vx * vx + vy * vy;
      if (len2 < 0.0001) continue;
      let t = ((tx - ax) * vx + (ty - ay) * vy) / len2;
      t = Math.max(0, Math.min(1, t));
      const ppx = ax + t * vx, ppy = ay + t * vy;
      const d = Math.hypot(ppx - tx, ppy - ty);
      if (d < segThresh && d < bestD) {
        bestD = d;
        bestSnap = {
          tx: ppx,
          ty: ppy,
          kind: 'segment',
          roadIdx: -1,
          segIdx: s,
          riverIdx: i,
        };
      }
    }
  }
  return bestSnap;
}

/** Explicit snap pass for the currently selected road / river. Pulls
 *  both endpoints onto the nearest geometry within EXPLICIT_SNAP_MAX_DIST
 *  tiles, snapping to (in order of precedence): the row's OWN opposite
 *  endpoint (for closure — v8.99.124.31), other rows' endpoints, other
 *  rows' segment projections. Triggers rebuildWorld if anything moved.
 *  When a draft is in flight, delegates to _weSnapDraftLastPoint instead.
 *  TODO(E35-followup): port from L15156-15257. */
export function _weSnapSelectedEndpoints(
  _state: WorldEditorState,
  _deps: SnapDeps,
): void {
  // TODO: L15156-15257.
  //   Branch on draft-present-OR-selectedKind:
  //     draft present → delegate to _weSnapDraftLastPoint.
  //     road selected → parity-based epStart (4 or 5 meta), candidates
  //       = majorRoads with skipIdx = baseLen + selected.
  //     river selected → epStart=2, candidates = WORLD_EDITOR.rivers.
  //   For each endpoint: scan SELF opposite endpoint first, then other
  //   candidates' endpoints, then segment projections. Snap if best
  //   distance < EXPLICIT_SNAP_MAX_DIST. needsRedraw + rebuildWorld if
  //   anything moved.
}

/** Snap the active draft's last placed point. Iterates roads + rivers
 *  (polyline endpoint + segment projection) and surfaces + buildings +
 *  lakes (polygon vertex-only) plus the draft's own earlier points
 *  (so a polygon draft can close by tapping near the start vertex and
 *  then Snap). Generous EXPLICIT_SNAP_MAX_DIST radius — this is a
 *  manual action, the user has already chosen which point to fix.
 *  Modifies draft.pts in place and sets needsRedraw — no commit /
 *  rebuild needed since the draft is still uncommitted.
 *
 *  Ported 1:1 from monolith L15258-15323. Returns void; the early-exit
 *  guards no-op when there's no draft or fewer than one point. */
export function _weSnapDraftLastPoint(
  state: WorldEditorState,
  deps: SnapDeps,
): void {
  const d = state.draft;
  if (!d || !d.pts || d.pts.length < 1) return;
  const lastIdx = d.pts.length - 1;
  const last = d.pts[lastIdx];
  const ex = last[0], ey = last[1];

  let bestD = EXPLICIT_SNAP_MAX_DIST;
  let bestX: number | null = null;
  let bestY: number | null = null;

  // Helper: endpoint + segment projection for any polyline. Accepts
  // both tuple `[number, number]` arrays (from river decode) and the
  // looser `number[]` shape (from getMajorRoads) — only reads .0 / .1.
  const testPolyline = (pts: ReadonlyArray<ReadonlyArray<number>>): void => {
    if (!pts || pts.length < 1) return;
    const eps = pts.length >= 2 ? [pts[0], pts[pts.length - 1]] : [pts[0]];
    for (const p of eps) {
      const dist = Math.hypot(p[0] - ex, p[1] - ey);
      if (dist < bestD) { bestD = dist; bestX = p[0]; bestY = p[1]; }
    }
    for (let s = 0; s < pts.length - 1; s++) {
      const ax = pts[s][0], ay = pts[s][1];
      const bx = pts[s + 1][0], by = pts[s + 1][1];
      const vx = bx - ax, vy = by - ay;
      const len2 = vx * vx + vy * vy;
      if (len2 < 0.0001) continue;
      let t = ((ex - ax) * vx + (ey - ay) * vy) / len2;
      t = Math.max(0, Math.min(1, t));
      const projX = ax + t * vx, projY = ay + t * vy;
      const dist = Math.hypot(projX - ex, projY - ey);
      if (dist < bestD) { bestD = dist; bestX = projX; bestY = projY; }
    }
  };

  // Helper: polygon vertex-only (no segment projections — polygons
  // are typically smaller and vertex-snap is the natural intent).
  const testPolygonVerts = (row: unknown, startK: number): void => {
    if (!Array.isArray(row)) return;
    const r = row as unknown[];
    for (let k = startK; k + 1 < r.length; k += 2) {
      const px = r[k];
      const py = r[k + 1];
      if (typeof px === 'number' && typeof py === 'number') {
        const dist = Math.hypot(px - ex, py - ey);
        if (dist < bestD) { bestD = dist; bestX = px; bestY = py; }
      }
    }
  };

  // Roads (baseline + overlay — getMajorRoads adapts both).
  for (const r of deps.getMajorRoads()) {
    if (!r.pts) continue;
    testPolyline(r.pts);
  }
  // Rivers — decode [w, name, x1, y1, ...] into pts.
  for (const rv of state.rivers) {
    if (!Array.isArray(rv) || rv.length < 6) continue;
    const rvArr = rv as unknown[];
    const pts: Array<[number, number]> = [];
    for (let k = 2; k < rvArr.length; k += 2) {
      pts.push([rvArr[k] as number, rvArr[k + 1] as number]);
    }
    testPolyline(pts);
  }
  // Polygon vertices: surfaces (startK=2), buildings (startK=2), lakes
  // (startK=1 — lakes have no `z` meta slot). startK matches monolith.
  for (const s of state.surfaces) testPolygonVerts(s, 2);
  for (const b of state.buildings) testPolygonVerts(b, 2);
  for (const lk of state.lakes) testPolygonVerts(lk, 1);

  // Same draft's earlier points — lets a polygon close by snapping the
  // last vertex to the first.
  for (let i = 0; i < lastIdx; i++) {
    const p = d.pts[i];
    const dist = Math.hypot(p[0] - ex, p[1] - ey);
    if (dist < bestD) { bestD = dist; bestX = p[0]; bestY = p[1]; }
  }

  if (bestX !== null && bestY !== null) {
    // Skip the write if the snap target is effectively the current
    // position (0.001-tile tolerance) — avoids spurious redraws.
    if (Math.abs(bestX - ex) > 0.001 || Math.abs(bestY - ey) > 0.001) {
      d.pts[lastIdx] = [bestX, bestY];
      state.needsRedraw = true;
    }
  }
}
