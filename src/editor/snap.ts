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

/** Returned by _weFindSnap when a snap target is found. Coordinates are
 *  in tile space. Includes contextual info the bonding code needs. */
export interface SnapResult {
  tx: number;
  ty: number;
  /** Snap kind — drives downstream bonding behavior. */
  kind: 'segment' | 'endpoint' | 'laneEdge' | 'self';
  /** Index into majorRoads (-1 if not a road snap). */
  roadIdx: number;
  /** Segment index within that road (-1 if endpoint snap). */
  segIdx: number;
  /** Lane index relative to the destination road's centerline
   *  (positive = right side, negative = left, 0 = centerline). Used
   *  for the magenta L1/L2 label even though the coords now point at
   *  edge stripe — v8.99.126.26 split. */
  laneIdx?: number;
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

/** River-targeted snap, mirroring _weFindSnap but iterating
 *  WORLD_EDITOR.rivers. TODO(E35-followup): port from L12131-12169. */
export function _weFindRiverSnap(
  _tx: number,
  _ty: number,
  _state: WorldEditorState,
): SnapResult | null {
  // TODO: L12131-12169. Same projection algorithm as _weFindSnap but
  // over rivers rows (decoded from [w, name, x1, y1, ...]).
  return null;
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
