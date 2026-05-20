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
  /** Snap kind — drives downstream bonding behavior. */
  kind: 'segment' | 'endpoint' | 'laneEdge' | 'self';
  /** Index into majorRoads (-1 if not a road snap). */
  roadIdx: number;
  /** Segment index within that road or river. For endpoint snaps this
   *  is the endpoint index (0 = first vertex, pts.length-1 = last). */
  segIdx: number;
  /** Lane index relative to the destination road's centerline
   *  (positive = right side, negative = left, 0 = centerline). Used
   *  for the magenta L1/L2 label even though the coords now point at
   *  edge stripe — v8.99.126.26 split. */
  laneIdx?: number;
  /** Index into WORLD_EDITOR.rivers (populated by river-snap only —
   *  v8.99.124.28). Set to undefined for road snaps. */
  riverIdx?: number;
}

/** Host bindings for snap. The snap module reads from the live
 *  geometry arrays (majorRoads + WORLD_EDITOR.rivers etc.) and from
 *  getRoadProfile. */
export interface SnapDeps {
  getMajorRoads(): Array<{ pts: number[][]; w: number; [k: string]: unknown }>;
  getRoadProfile(road: { pts: number[][]; w: number }): {
    lps: number[];
    laneW: number;
    totalW: number;
    edgeOffsets?: number[];
  } | null;
  TILE: number;
  /** Trigger world rebuild after the explicit snap pass mutates rows. */
  rebuildWorld(): void;
}

/** Find the best snap target for a click at (tx, ty) in tile coords.
 *  Returns null if nothing is in range. TODO(E35-followup): port from
 *  L11972-12130. */
export function _weFindSnap(
  _tx: number,
  _ty: number,
  _state: WorldEditorState,
  _deps: SnapDeps,
): SnapResult | null {
  // TODO: L11972-12130.
  //   1. baseThresh = max(SNAP_BASE_THRESH_MIN, SNAP_BASE_THRESH_ZOOM_DENOM/zoom).
  //   2. isMergeDraft = tool==='place' && draftProps.merge. If true,
  //      run LANE-EDGE-STRIPE branch first (v126.26).
  //   3. Iterate majorRoads. Per road, compute per-road threshold =
  //      max(baseThresh, r.w * SEGMENT_WIDTH_FACTOR).
  //   4. Test each segment via parametric projection; t clamped [0,1].
  //      Endpoint snap uses ENDPOINT_WIDTH_FACTOR threshold.
  //   5. Return best by distance.
  return null;
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
 *  + surfaces + buildings + lakes + the draft's own earlier points (so
 *  polygons can close by tapping near the start vertex and then Snap).
 *  TODO(E35-followup): port from L15258-15335. */
export function _weSnapDraftLastPoint(
  _state: WorldEditorState,
  _deps: SnapDeps,
): void {
  // TODO: L15258-15335. Same 50-tile radius. Self-points contribute as
  // additional snap targets so closed polygons can be finalized cleanly.
}
