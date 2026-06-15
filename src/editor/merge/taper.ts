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
 *  `pts` polyline is touched. The element type is intentionally
 *  permissive (`readonly number[]`) so both `[number, number]` tuples
 *  and the looser `number[]` rows in the editor's RenderDeps / draft
 *  overlay shapes satisfy it. Only indices 0 and 1 are read. */
export interface InnerDirRoad {
  pts: ReadonlyArray<readonly number[]>;
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
  roadPts: ReadonlyArray<readonly number[]> | null | undefined,
  endIdx: number,
  allRoads: ReadonlyArray<InnerDirRoad> | null | undefined,
  selfRoad: InnerDirRoad,
  /** H786: optional search-radius override (tiles). The 5.0 default
   *  covers destinations up to ~w=8; bonded tips on wider highways sit
   *  past it (tip offset ≈ destHalfW), so callers that already know
   *  the bonded road pass its halfW + slack. Default preserves the
   *  pre-H786 behavior for all other call sites. */
  searchR: number = 5.0,
): [number, number] | null {
  if (!roadPts || endIdx >= roadPts.length || !allRoads) return null;
  const SEARCH_R = searchR;
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

/** H887: resolve the inner (toward-destination) direction for a bonded
 *  merge endpoint, preferring the side that was STORED at commit (from
 *  the bond detector's resolved click side) over the per-rebuild
 *  geometric re-derivation.
 *
 *  The stored vector is the SAME quantity _computeMergeInnerDir returns
 *  when the bonded tip sits off the destination centerline — but it is
 *  also valid in the degenerate on-centerline case (where
 *  _computeMergeInnerDir returns null and the side is otherwise lost),
 *  and it survives a later edit to the destination road. So a merge with
 *  a stored side renders identically to the legacy path where that path
 *  worked, and correctly where it didn't.
 *
 *  Cloverleaf (mergeType === 1) is excluded so loop sidedness keeps its
 *  forced convention (cloverleaf.ts). Rows without a stored vector fall
 *  back to `legacy()` verbatim — preserving every pre-H887 merge.
 *
 *  Both render consumers (editor render.ts + game worldMap.ts) call this
 *  so their side-resolution logic stays identical by construction. */
export function _resolveMergeInnerDir(
  stored: readonly number[] | undefined | null,
  mergeType: number,
  legacy: () => [number, number] | null,
): [number, number] | null {
  if (mergeType !== 1 && stored && stored.length === 2) {
    const dx = stored[0];
    const dy = stored[1];
    if (Number.isFinite(dx) && Number.isFinite(dy) && (dx !== 0 || dy !== 0)) {
      return [dx, dy];
    }
  }
  return legacy();
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
 *  polygon constant one-lane-wide regardless of road.w — `prof` is
 *  accepted for caller-symmetry with the v126.04-08 signature but
 *  isn't actually consulted (the constant LANE_W_STD = 1.275 tiles
 *  is used instead). Kept on the interface so callers that already
 *  thread road profile through can keep doing so without an extra
 *  call-site change when the body landed. */
export interface TaperedMergeEdgesOpts {
  tilePts: ReadonlyArray<readonly number[]>;
  /** Road profile (informational only — v126.09 ignores lane width
   *  from prof and uses LANE_W_STD). Pass null to skip. */
  prof: { laneW?: number; edgeOffsets?: number[]; [k: string]: unknown } | null;
  /** True if the start endpoint participates in a bond. Coerced from
   *  any truthy value at the top of the function. */
  bondedStart: boolean;
  /** True if the end endpoint participates in a bond. */
  bondedEnd: boolean;
  /** Inner direction-of-travel unit vector at the bonded start (peer
   *  road's tangent toward its centerline). Null if not bonded or
   *  the peer is too far to resolve. */
  innerDirStart: readonly [number, number] | null;
  /** Same at the bonded end. */
  innerDirEnd: readonly [number, number] | null;
  /** Visual alignment (carried from draft): 1=Center, 2=Legacy-L,
   *  3=R-asymmetric, 4=Click-bonded asymmetric. */
  mergeAlign: number;
  /** Merge type: 0=Standard, 1=Cloverleaf, 2=Stop, 3=Yield. Influences
   *  the terminus geometry — Stop/Yield + bondedEnd flatten the last
   *  two vertices to a symmetric halfLane band for a 90° stop face. */
  mergeType: number;
}

/** Two-polyline output of the merge-edge builder. Caller walks `outer`
 *  forward then `inner` backward to form a closed fillable polygon
 *  ("stadium" loop), or strokes each polyline separately for the
 *  channelizing edge marks. */
export interface MergeRoadEdges {
  outer: TilePoint[];
  inner: TilePoint[];
}

/** Build the polygon edges for a merge road's pavement.
 *
 *  THE V126.09 INVARIANT — merge polygon is ALWAYS one lane wide
 *  (LANE_W_STD = 1.275 tiles, US 12 ft @ ~9.4 ft/tile). Width does
 *  not vary with road.w or with the prof argument; a 4-lane merge
 *  ramp draws as a 1-lane strip. The user's mental model: a merge
 *  ramp is by definition a single auxiliary lane that runs alongside
 *  the destination then diverges, not a "narrowing road."
 *
 *  Construction is per-vertex {innerOffset, outerOffset} multiplied
 *  by the per-vertex perpendicular and an alignment-driven sign:
 *
 *    mergeAlign 1 (Center) / 2 (Legacy-L):
 *      symmetric — _vwIn = _vwOut = halfLane → polygon ±halfLane
 *      around the polyline.
 *
 *    mergeAlign 3 (R) / 4 (Click-bonded):
 *      asymmetric — _vwIn = 0 (inner edge AT the polyline, which the
 *      v126.26 bonding logic puts on the destination's outer-edge
 *      stripe), _vwOut = LANE_W_STD (one full lane outward). At
 *      bonded extension tips _vwOut collapses to 0 so the polygon
 *      comes to a point on the stripe — DOT-MUTCD aux-lane apex.
 *
 *    mergeType 2 (Stop) / 3 (Yield) with bondedEnd:
 *      hybrid — source-side keeps the mergeAlign=4 aux-lane taper,
 *      but the last two vertices switch to symmetric halfLane on
 *      both sides so the terminus is a flat 90° face hitting the
 *      destination road's edge. Without this the last vertex would
 *      collapse to a degenerate point (v126.43 bug).
 *
 *  PER-PORTION SIGN (v126.35 dual asymSgn) — when both ends are
 *  bonded AND N >= 7 there's an "extension layout" (vertex 2 / N-3
 *  are bondedTips with 180° polyline kinks). A single sign picked at
 *  vertex 0 would assign the wrong outboard side to the curve interior
 *  and produce a self-intersecting polygon. The function computes
 *  TWO signs:
 *
 *    ASYM_SGN_ext   — from vertex-0 perpendicular vs activeInner.
 *                     Applied to indices [0,1,2] and [N-3,N-2,N-1].
 *    ASYM_SGN_curve — from vertex-3 perpendicular vs activeInner.
 *                     Applied to indices [3..N-4].
 *
 *  These generally have OPPOSITE signs (the perpendicular flips
 *  across the bondedTip kink) but combined with opposite
 *  perpendiculars they land both portions' outer edges on the same
 *  OUTBOARD side. The override at vertex 2 / N-3 (use extension
 *  segment's perpendicular instead of averaged) gives a continuous
 *  polygon edge across the kink.
 *
 *  PERPENDICULAR OVERRIDE — at the bondedTip vertex of an extension
 *  layout (index 2 / N-3) the averaged perpendicular is degenerate
 *  (incoming + outgoing segments are anti-parallel and cancel). The
 *  override substitutes the EXTENSION segment's perpendicular so the
 *  bondedTip vertex's polygon edge aligns with vertex 1 / N-2 and
 *  the polygon is continuous from extension into curve.
 *
 *  activeInner is the blended unit vector toward the destination
 *  centerline — innerDirStart and innerDirEnd averaged when both
 *  present, else whichever single one was supplied. Used only for
 *  the ASYM_SGN computation (the polygon's geometry is determined
 *  entirely by per-vertex perp × per-vertex {in,out}-width × sign).
 *
 *  Returns null on degenerate input — fewer than 2 polyline points
 *  or null prof. The prof argument's body content is unused by
 *  v126.09; it's still required to flag missing-prof callers early.
 *
 *  Ported 1:1 from monolith _weBuildTaperedMergeEdges (L11009-11334). */
export function _weBuildTaperedMergeEdges(
  opts: TaperedMergeEdgesOpts,
): MergeRoadEdges | null {
  const { tilePts, prof, innerDirStart, innerDirEnd } = opts;
  const bondedStart = opts.bondedStart !== false;
  const bondedEnd = opts.bondedEnd !== false;
  const mergeAlign = opts.mergeAlign || 1;
  const _mt = (opts.mergeType | 0) || 0;
  const N = tilePts.length;
  if (N < 2 || !prof) return null;

  const LANE_W_STD = 1.275;
  const halfLane = LANE_W_STD * 0.5;

  const _vwIn = new Array<number>(N).fill(halfLane);
  const _vwOut = new Array<number>(N).fill(halfLane);

  if (mergeAlign === 3) {
    for (let i = 0; i < N; i++) {
      _vwIn[i] = 0;
      _vwOut[i] = LANE_W_STD;
    }
    if (bondedStart && N >= 2) _vwOut[0] = 0;
    if (bondedEnd && N >= 2) _vwOut[N - 1] = 0;
  }
  if (mergeAlign === 4) {
    for (let i = 0; i < N; i++) {
      _vwIn[i] = 0;
      _vwOut[i] = LANE_W_STD;
    }
    if (bondedStart && N >= 2) _vwOut[0] = 0;
    if (bondedEnd && N >= 2) _vwOut[N - 1] = 0;
  }
  if ((_mt === 2 || _mt === 3) && bondedEnd && N >= 2) {
    _vwIn[N - 1] = halfLane;
    _vwOut[N - 1] = halfLane;
    if (N >= 3) {
      _vwIn[N - 2] = halfLane;
      _vwOut[N - 2] = halfLane;
    }
  }

  let activeInner: [number, number] | null = null;
  if (innerDirStart && innerDirEnd) {
    const w = 0.5;
    const ix = innerDirStart[0] * (1 - w) + innerDirEnd[0] * w;
    const iy = innerDirStart[1] * (1 - w) + innerDirEnd[1] * w;
    const ilen = Math.hypot(ix, iy);
    if (ilen > 0.01) activeInner = [ix / ilen, iy / ilen];
  } else if (innerDirStart) {
    activeInner = [innerDirStart[0], innerDirStart[1]];
  } else if (innerDirEnd) {
    activeInner = [innerDirEnd[0], innerDirEnd[1]];
  }

  const _hasExtLayout = bondedStart && bondedEnd && N >= 7;
  let ASYM_SGN_ext = 1;
  let ASYM_SGN_curve = 1;
  if (activeInner && N >= 2) {
    const dx0 = tilePts[1][0] - tilePts[0][0];
    const dy0 = tilePts[1][1] - tilePts[0][1];
    const L0 = Math.hypot(dx0, dy0) || 1;
    const nx0 = -dy0 / L0;
    const ny0 = dx0 / L0;
    const dotPerp0 = nx0 * activeInner[0] + ny0 * activeInner[1];
    ASYM_SGN_ext = dotPerp0 >= 0 ? 1 : -1;
    if (_hasExtLayout && N >= 5) {
      const i = 3;
      const dxa = tilePts[i][0] - tilePts[i - 1][0];
      const dya = tilePts[i][1] - tilePts[i - 1][1];
      const La = Math.hypot(dxa, dya) || 1;
      const dxb = tilePts[i + 1][0] - tilePts[i][0];
      const dyb = tilePts[i + 1][1] - tilePts[i][1];
      const Lb = Math.hypot(dxb, dyb) || 1;
      let nxc = (-dya / La + -dyb / Lb) * 0.5;
      let nyc = (dxa / La + dxb / Lb) * 0.5;
      const Lc = Math.hypot(nxc, nyc) || 1;
      nxc /= Lc; nyc /= Lc;
      const dotPerpC = nxc * activeInner[0] + nyc * activeInner[1];
      ASYM_SGN_curve = dotPerpC >= 0 ? 1 : -1;
    } else {
      ASYM_SGN_curve = ASYM_SGN_ext;
    }
  }

  const outer: TilePoint[] = new Array(N);
  const inner: TilePoint[] = new Array(N);
  for (let i = 0; i < N; i++) {
    let nx: number;
    let ny: number;
    if (_hasExtLayout && i === 2) {
      const dx = tilePts[1][0] - tilePts[0][0];
      const dy = tilePts[1][1] - tilePts[0][1];
      const L = Math.hypot(dx, dy) || 1;
      nx = -dy / L; ny = dx / L;
    } else if (_hasExtLayout && i === N - 3) {
      const dx = tilePts[N - 1][0] - tilePts[N - 2][0];
      const dy = tilePts[N - 1][1] - tilePts[N - 2][1];
      const L = Math.hypot(dx, dy) || 1;
      nx = -dy / L; ny = dx / L;
    } else if (i === 0) {
      const dx = tilePts[1][0] - tilePts[0][0];
      const dy = tilePts[1][1] - tilePts[0][1];
      const L = Math.hypot(dx, dy) || 1;
      nx = -dy / L; ny = dx / L;
    } else if (i === N - 1) {
      const dx = tilePts[N - 1][0] - tilePts[N - 2][0];
      const dy = tilePts[N - 1][1] - tilePts[N - 2][1];
      const L = Math.hypot(dx, dy) || 1;
      nx = -dy / L; ny = dx / L;
    } else {
      const dxa = tilePts[i][0] - tilePts[i - 1][0];
      const dya = tilePts[i][1] - tilePts[i - 1][1];
      const La = Math.hypot(dxa, dya) || 1;
      const dxb = tilePts[i + 1][0] - tilePts[i][0];
      const dyb = tilePts[i + 1][1] - tilePts[i][1];
      const Lb = Math.hypot(dxb, dyb) || 1;
      nx = (-dya / La + -dyb / Lb) * 0.5;
      ny = (dxa / La + dxb / Lb) * 0.5;
      const L = Math.hypot(nx, ny) || 1;
      nx /= L; ny /= L;
    }
    const _isExtPortion = _hasExtLayout && (i <= 2 || i >= N - 3);
    const ASYM_SGN = _isExtPortion ? ASYM_SGN_ext : ASYM_SGN_curve;
    inner[i] = [
      tilePts[i][0] + ASYM_SGN * nx * _vwIn[i],
      tilePts[i][1] + ASYM_SGN * ny * _vwIn[i],
    ];
    outer[i] = [
      tilePts[i][0] - ASYM_SGN * nx * _vwOut[i],
      tilePts[i][1] - ASYM_SGN * ny * _vwOut[i],
    ];
  }
  // Suppress "unused" warning — prof is intentionally accepted for
  // call-site symmetry but unused per v126.09's lane-width override.
  void prof;
  return { outer, inner };
}
