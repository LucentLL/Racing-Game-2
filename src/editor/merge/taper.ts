/**
 * World Editor — auto-taper polygon + tapered merge edges.
 *
 * Two related polygon-building helpers used by the merge render pass.
 *
 * `_weBuildAutoTaperPolygon` walks a fixed arc-length back from a
 * joined endpoint and builds four parallel polylines that share that
 * walk's samples:
 *
 *   outer / inner        — FULL half-width polygon edges (filled with
 *                         asphalt; no green showing through)
 *   outerStripe / innerStripe — STRIPE-OFFSET polylines, inset
 *                         (1.7/TILE) from outer/inner so edge stripes
 *                         align continuously with the peer roads'
 *                         normal edge stripes
 *
 * Half-width at the joined endpoint is peerHalfW (matches the wider
 * road's edge); half-width at the interior end of the taper is
 * currentHalfW (matches the narrower road's edge). Linear interpolation
 * by arc-length ratio between them.
 *
 * REFACTOR HISTORY:
 *
 * - v8.99.126.64: introduced stripe-offset polylines. Before this fix
 *   the polygon's outer/inner were stroked directly at full hw, but
 *   the road's normal edge stripe (prof.edgeOffsets) sits INSET
 *   1.7/TILE from the asphalt edge — so at the junction, the wider
 *   road's normal stripe ended at halfW-1.7/TILE while the taper's
 *   outer stripe started at peerHalfW, producing a 1.7-px perpendicular
 *   step that grew to ~4.7 screen px at zoom 50. STRIPE_INSET = 1.7/TILE
 *   captures this in code.
 *
 * - v8.99.126.65: joinedTangent parameter. At sample[0] (the joined
 *   endpoint), the polygon's perpendicular was computed from the
 *   NARROW road's tangent (samples[0]→samples[1]), but the wide
 *   road's edge stripe ends at the junction using the WIDE road's
 *   perpendicular. Even with stripe-offset polylines (the v64 fix),
 *   a small tangent-angle difference Δθ between the two roads at the
 *   shared vertex created a perpendicular offset = halfW·sin(Δθ) — for
 *   halfW=2.5 tiles and Δθ=5°, ~4 screen px at z=40. By using the peer
 *   road's tangent at sample[0], the taper's stripe endpoint aligns
 *   EXACTLY with the wide road's edge-stripe endpoint. Sample[1] onward
 *   still use the narrow road's tangent, so the perp smoothly
 *   transitions.
 *
 * `_weBuildTaperedMergeEdges` is the higher-level builder used by the
 * editor's merge render. It calls _weBuildAutoTaperPolygon at each
 * end as needed and concatenates with the interior centerline edges.
 *
 * REFACTOR HISTORY (v8.99.126.09, current):
 *
 * - CONSTANT ONE-LANE-WIDE MERGE POLYGON. v126.04–08 tapered the
 *   polygon from full road width down to lane width, treating the
 *   merge ramp as a "road" whose width was determined by road.w —
 *   so a 4-lane merge ramp polygon started at FULL 4-lane width then
 *   tapered (user feedback: "lane should remain one lane wide, this
 *   lane seems much larger then flips and becomes a line"). The
 *   user's correct mental model: a merge ramp is, by definition, a
 *   SINGLE LANE that branches off from a multi-lane road. The polygon
 *   width is now constant at one lane regardless of road.w.
 *
 * Ported from monolith L10902-11335.
 *
 * SCAFFOLD status: type contract + entry points stubbed with TODO line refs.
 */

import type { TilePoint } from '../stamp';
import { TILE } from '@/config/world/tiles';

/** Stripe inset constant — the perpendicular gap between the asphalt
 *  edge and the painted edge stripe, in tiles. Matches the value used
 *  by the road profile's edgeOffsets (prof.edgeOffsets[k] = halfW -
 *  STRIPE_INSET). v8.99.126.64. */
export const STRIPE_INSET_TILES = 1.7;

/** Which side of the polyline the taper anchors on. */
export type TaperSide = 'start' | 'end';

/** Minimal road row shape consumed by _computeMergeInnerDir — only the
 *  `pts` polyline is touched. Both editor overlay rows and baseline
 *  rows satisfy this (overlay rows after coordinate decoding). */
export interface InnerDirRoad {
  pts: ReadonlyArray<readonly [number, number]>;
}

/** Compute the inner direction at a merge road's bonded endpoint.
 *
 *  "Inner direction" = the unit vector pointing FROM the endpoint
 *  TOWARD the nearest centerline point on any OTHER road within the
 *  search radius. For an entrance ramp this is the direction from the
 *  ramp's tip into the highway's body — used by the asymmetric taper
 *  algorithm in _weBuildTaperedMergeEdges to keep the inner edge
 *  parallel to the destination while only the outer edge tapers in
 *  (matches DOT MUTCD Figure 3B-9 type B).
 *
 *  Algorithm:
 *    1. Iterate every segment of every road in `allRoads` except
 *       `selfRoad`. Project the endpoint onto the segment (clamped to
 *       [0, 1]) and measure squared distance to the foot.
 *    2. Keep the closest foot within SEARCH_R = 5.0 tiles. The radius
 *       is intentionally LARGER than the 3.5-tile bonding radius so
 *       this still resolves even when the bonded endpoint has been
 *       pulled inward by the lane-center alignment offset.
 *    3. Return the unit vector from endpoint to that foot.
 *
 *  Returns null when:
 *    - inputs are degenerate (missing pts, endIdx past the end),
 *    - no other road's segment falls within the search radius,
 *    - the endpoint sits essentially ON the nearest centerline
 *      (CENTER alignment) — distance < 0.01 tiles. A degenerate
 *      direction would push the taper sideways at random; null
 *      signals "fall back to symmetric taper" to the caller, which
 *      is the correct behavior for "entire road continues into
 *      destination" semantics.
 *
 *  Ported 1:1 from monolith _computeMergeInnerDir (L10800-10862). */
export function _computeMergeInnerDir(
  roadPts: ReadonlyArray<readonly [number, number]> | null | undefined,
  endIdx: number,
  allRoads: ReadonlyArray<InnerDirRoad> | null | undefined,
  selfRoad: InnerDirRoad,
): [number, number] | null {
  if (!roadPts || endIdx >= roadPts.length || !allRoads) return null;
  const SEARCH_R = 5.0;
  const SEARCH_R2 = SEARCH_R * SEARCH_R;
  const ex = roadPts[endIdx][0];
  const ey = roadPts[endIdx][1];
  let bestDx = 0;
  let bestDy = 0;
  let bestD2 = SEARCH_R2;
  let found = false;
  for (const r of allRoads) {
    if (r === selfRoad) continue;
    if (!r.pts || r.pts.length < 2) continue;
    for (let i = 0; i < r.pts.length - 1; i++) {
      const ax = r.pts[i][0];
      const ay = r.pts[i][1];
      const bx = r.pts[i + 1][0];
      const by = r.pts[i + 1][1];
      const dx = bx - ax;
      const dy = by - ay;
      const lenSq = dx * dx + dy * dy;
      if (lenSq < 0.0001) continue;
      let t = ((ex - ax) * dx + (ey - ay) * dy) / lenSq;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const px = ax + dx * t;
      const py = ay + dy * t;
      const ddx = px - ex;
      const ddy = py - ey;
      const d2 = ddx * ddx + ddy * ddy;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestDx = ddx;
        bestDy = ddy;
        found = true;
      }
    }
  }
  if (!found) return null;
  const dist = Math.sqrt(bestD2);
  if (dist < 0.01) return null;
  return [bestDx / dist, bestDy / dist];
}

/** Output of _weBuildAutoTaperPolygon — four parallel polylines that
 *  share the same arc-length walk. Polygon fill uses outer + inner;
 *  edge stripes stroke outerStripe / innerStripe. */
export interface TaperPolygon {
  outer: TilePoint[];
  inner: TilePoint[];
  /** v8.99.126.64: outer inset by STRIPE_INSET_TILES/TILE for stripe
   *  continuity with the peer road's normal edge stripe. */
  outerStripe: TilePoint[];
  /** v8.99.126.64: inner equivalent. */
  innerStripe: TilePoint[];
}

/** Build a tapered polygon at one end of a polyline.
 *
 *  - tilePts:        polyline being tapered (tile coords).
 *  - side:           'start' or 'end' — which endpoint anchors the taper.
 *  - currentHalfW:   half-width at the INTERIOR end of the taper
 *                    (narrower road's halfW).
 *  - peerHalfW:      half-width at the JOINED endpoint
 *                    (wider road's halfW).
 *  - taperLen:       arc length of the taper, in tiles.
 *  - joinedTangent:  v8.99.126.65 — unit tangent of the peer (wider)
 *                    road at the joined endpoint. Used at sample[0]
 *                    only; sample[1]+ use the polyline's own tangent.
 *                    Pass null/undefined to fall back to the polyline's
 *                    own tangent at sample[0] (pre-v126.65 behavior).
 *
 *  Two-phase algorithm:
 *
 *    Phase 1 (arc-length walk) — start at the chosen endpoint and step
 *    along the polyline INWARD (walkStep = -1 for 'end', +1 for 'start').
 *    Push samples[i] = [x, y, arcFromEndpoint] until the cumulative
 *    arc reaches taperLen, at which point we splice in a final clipped
 *    sample at exactly taperLen so the last sample's ratio == 1 (no
 *    overshoot — the interior end of the taper aligns with where the
 *    narrow road's normal asphalt picks up).
 *
 *    Phase 2 (perpendicular offsets) — for each sample compute a unit
 *    tangent (peer at sample[0] when joinedTangent supplied; forward-
 *    difference samples[i]→samples[i+1] for i<last; backward-difference
 *    samples[last-1]→samples[last] for the last). Perpendicular =
 *    rotate +90° CCW (-ty, tx). Half-width interpolates linearly by
 *    ratio = samples[i].arc / taperLen — peerHalfW at the joined
 *    endpoint, currentHalfW at the interior. Outer = sample + perp*hw;
 *    inner = sample - perp*hw. Stripe variants use (hw - STRIPE_INSET)
 *    clamped to >= 0 so the painted edge stripe of the taper lines up
 *    with each peer road's normal edge stripe.
 *
 *  STRIPE_INSET = 1.7 / TILE — the same perpendicular gap (1.7 screen px)
 *  that getRoadProfile uses for the road's normal edge stripe
 *  (prof.edgeOffsets[k] = halfW - 1.7/TILE at monolith L18305). Without
 *  this inset the wider road's stripe ends at halfW-1.7/TILE but the
 *  taper's outer stripe begins at peerHalfW — a 1.7-px perpendicular
 *  step at the junction (~4.7 screen px at zoom 50, very visible).
 *
 *  Returns null on degenerate inputs — empty pts, taperLen <= 0, fewer
 *  than 2 samples collected (very short polyline), or a zero-length
 *  tangent at any sample (collinear duplicates).
 *
 *  Ported 1:1 from monolith _weBuildAutoTaperPolygon (L10902-11007). */
export function _weBuildAutoTaperPolygon(
  tilePts: ReadonlyArray<readonly [number, number]>,
  side: TaperSide,
  currentHalfW: number,
  peerHalfW: number,
  taperLen: number,
  joinedTangent: readonly [number, number] | null | undefined,
): TaperPolygon | null {
  if (!tilePts || tilePts.length < 2) return null;
  if (!(taperLen > 0)) return null;
  const N = tilePts.length;
  const walkStep = side === 'end' ? -1 : +1;
  const walkIdx = side === 'end' ? N - 1 : 0;
  const samples: Array<[number, number, number]> = [
    [tilePts[walkIdx][0], tilePts[walkIdx][1], 0],
  ];
  let arc = 0;
  let prevX = tilePts[walkIdx][0];
  let prevY = tilePts[walkIdx][1];
  let cur = walkIdx;
  while (true) {
    const nxt = cur + walkStep;
    if (nxt < 0 || nxt >= N) break;
    const nx = tilePts[nxt][0];
    const ny = tilePts[nxt][1];
    const segLen = Math.hypot(nx - prevX, ny - prevY);
    if (segLen < 1e-6) { cur = nxt; prevX = nx; prevY = ny; continue; }
    if (arc + segLen >= taperLen) {
      const remain = taperLen - arc;
      const t = remain / segLen;
      samples.push([prevX + t * (nx - prevX), prevY + t * (ny - prevY), taperLen]);
      break;
    }
    samples.push([nx, ny, arc + segLen]);
    arc += segLen;
    cur = nxt;
    prevX = nx; prevY = ny;
  }
  if (samples.length < 2) return null;

  const outer: TilePoint[] = [];
  const inner: TilePoint[] = [];
  const outerStripe: TilePoint[] = [];
  const innerStripe: TilePoint[] = [];
  const STRIPE_INSET = 1.7 / TILE;
  const M = samples.length;
  for (let i = 0; i < M; i++) {
    let tx: number;
    let ty: number;
    if (i === 0 && joinedTangent) {
      tx = joinedTangent[0]; ty = joinedTangent[1];
    } else if (i < M - 1) {
      tx = samples[i + 1][0] - samples[i][0];
      ty = samples[i + 1][1] - samples[i][1];
    } else {
      tx = samples[i][0] - samples[i - 1][0];
      ty = samples[i][1] - samples[i - 1][1];
    }
    const tLen = Math.hypot(tx, ty);
    if (tLen < 1e-6) return null;
    tx /= tLen; ty /= tLen;
    const px = -ty;
    const py =  tx;
    const ratio = samples[i][2] / taperLen;
    const hw = peerHalfW * (1 - ratio) + currentHalfW * ratio;
    outer.push([samples[i][0] + px * hw, samples[i][1] + py * hw]);
    inner.push([samples[i][0] - px * hw, samples[i][1] - py * hw]);
    const hwStripe = Math.max(0, hw - STRIPE_INSET);
    outerStripe.push([samples[i][0] + px * hwStripe, samples[i][1] + py * hwStripe]);
    innerStripe.push([samples[i][0] - px * hwStripe, samples[i][1] - py * hwStripe]);
  }
  return { outer, inner, outerStripe, innerStripe };
}

/** Inputs for the merge-edge polygon builder. v126.09 made the merge
 *  polygon constant one-lane-wide regardless of road.w — `prof` is read
 *  for that lane-width value, not for road.w-driven sizing. */
export interface TaperedMergeEdgesOpts {
  tilePts: TilePoint[];
  /** Road profile (lane geometry). Provides the constant lane width. */
  prof: { laneW: number; edgeOffsets?: number[]; [k: string]: unknown };
  /** True if the start endpoint participates in a bond. */
  bondedStart: boolean;
  /** True if the end endpoint participates in a bond. */
  bondedEnd: boolean;
  /** Inner direction-of-travel unit vector at the bonded start (peer
   *  road's tangent). Null if not bonded. */
  innerDirStart: [number, number] | null;
  /** Same at the bonded end. */
  innerDirEnd: [number, number] | null;
  /** Visual alignment (carried from draft). */
  mergeAlign: number;
  /** 0=Standard, 1=Cloverleaf, 2=Stop, 3=Yield. mergeType=1 forces
   *  ASYM_SGN=+1 (polygon sidedness override). */
  mergeType: number;
}

/** Build the full set of polygon edges for a merge road — interior
 *  centerline edges plus tapered ends where bonded. The result is
 *  consumed by the merge render path (editor/render.ts). Returns null
 *  for degenerate inputs. TODO(E34-followup): port from L11009-11335. */
export function _weBuildTaperedMergeEdges(
  _opts: TaperedMergeEdgesOpts,
): TaperPolygon | null {
  // TODO: L11009-11335.
  //   1. Constant lane-width polygon along the interior centerline
  //      (v126.09 fix — one lane wide regardless of road.w).
  //   2. At each bonded end: _weBuildAutoTaperPolygon with the peer
  //      road's halfW + tangent. Splice into the interior edges.
  //   3. mergeType=1 → ASYM_SGN=+1 forces polygon side regardless of
  //      bond direction. Other types use natural sidedness.
  return null;
}
