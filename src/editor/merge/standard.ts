/**
 * World Editor — STANDARD bond-endpoint smoothing.
 *
 * mergeType=0 (the default). Both endpoints of a draft road can bond
 * onto the nearest baseline road; this function rewrites the endpoints
 * with a single coordinated cubic Bezier so the tangent at each bonded
 * end matches the destination road's tangent.
 *
 * REFACTOR HISTORY:
 *
 * - v8.99.126.10/11 (BROKEN, fixed in 12): each endpoint smoothed in an
 *   independent pass. Pass 1 placed a Bezier from anchor (3 segments
 *   back) to bonded-end. Pass 2 placed a new Bezier whose anchor was a
 *   sample from pass 1's already-baked curve. The two Beziers had no
 *   awareness of each other — when the two destinations' tangents
 *   pointed in mismatched directions, pass 2 forced a counter-curve to
 *   meet its tangent constraint, producing a visible S-shape. The
 *   user's correct mental model is "ONE smooth curve, both endpoints
 *   constrained" — not two independent smoothings.
 *
 * - v8.99.126.12 (CURRENT): single coordinated cubic Bezier when both
 *   endpoints bond. Tangent constraints at both ends drive a single
 *   curve through the interior, eliminating the S-shape.
 *
 * Ported from monolith L13346-L14172.
 */

import type { TilePoint } from '../stamp';
import { _sampleCubic, _catmullRomThroughKnots } from './curves';

/** Shared baseline-road shape used by every bond-detection routine. */
export interface BondTargetRoad {
  pts: TilePoint[];
  w: number;
  [k: string]: unknown;
}

/** Per-merge inputs. The merge-align integer (default 4) selects which
 *  perpendicular side of the destination road the taper lands on (and
 *  is purely visual — geometry is symmetric otherwise). */
export interface StandardMergeOpts {
  /** Draft road's centerline points (in tile coords). */
  pts: TilePoint[];
  /** Draft road's full width (tiles). */
  dW: number;
  /** Visual side. Carried from draftProps.mergeAlign. Default 4. */
  mergeAlign: number;
  /** H888: ramp elevation — bonds prefer same-z destinations. */
  rampZ?: number;
}

/** Road-profile slice the bond detector needs. `getRoadProfile` returning
 *  null falls back to width-fraction heuristics (`r.w * 0.425` /
 *  `r.w * 0.85` / `lps = 1`) so the rest of the pipeline never has to
 *  null-check. */
export interface DestProfile {
  totalW: number;
  laneW: number;
  lps: number;
}

/** Host bindings — the bond detector needs access to candidate roads. */
export interface MergeDeps {
  /** Source-defined majorRoads array. Bond detection scans all of these
   *  except the road being edited itself. */
  getMajorRoads(): BondTargetRoad[];
  /** Lane geometry for the destination road. Returning null mirrors the
   *  monolith's `if(typeof getRoadProfile === 'function')` guard and the
   *  width-fraction fallback at L13433-L13435. */
  getRoadProfile?(road: BondTargetRoad): DestProfile | null;
}

/** Standard merge bond-detection scan radius. The cloverleaf and
 *  stop/yield branches use 16 tiles (`CLOVERLEAF_SEARCH_R` /
 *  `STOP_SEARCH_R`); the standard branch deliberately keeps the
 *  pre-v126.38 tighter 8-tile radius — Standard is the default mode,
 *  used when the user expects a literal connection to the road right
 *  under their click, so a tight radius prevents stray bonds onto
 *  unrelated roads passing nearby. */
export const STANDARD_SEARCH_R = 8;

/** What the bond detector returns when it finds a candidate. `bondedTip`
 *  already includes the alignment-based lane offset; `destTangent` is
 *  the destination road's unit tangent at the projected segment;
 *  `origTip` is the polyline endpoint the detector was invoked on; and
 *  `road` is the destination road identity (used by the smoother to
 *  detect the U-loop / same-destination case at L13573). */
export interface StandardBondInfo {
  endIdx: number;
  bondedTip: TilePoint;
  destTangent: [number, number];
  origTip: TilePoint;
  road: BondTargetRoad;
  /** H887: resolved attach side relative to the destination's
   *  direction-of-travel. +1 / -1 once a side was picked (from the
   *  click's signed perpendicular), 0 when no side resolved (Center on a
   *  lane boundary, or perpSigned === 0). The caller turns this + the
   *  destTangent into a persisted inward (toward-destination) unit vector
   *  so the merge's side survives a rebuild instead of being re-guessed.
   *  See memory road-model-redesign Phase 2. */
  alignSide: number;
}

/** Scan every baseline road for the closest segment to the polyline's
 *  `endIdx` endpoint, then return the bond projection + destination
 *  tangent + alignment-aware `bondedTip` placement. Returns `null` when
 *  no candidate sits within `STANDARD_SEARCH_R` tiles.
 *
 *  PIPELINE — three stages:
 *
 *  1. NEAREST-SEGMENT SCAN. For every candidate road skip the SELF-
 *     IDENTITY case three ways: array-identity (`r.pts === pts`),
 *     deep-coord match (same length and every point within 0.01 tiles —
 *     the editor deep-copies the polyline before passing it through
 *     the bond pipeline, so identity equality alone misses the
 *     self-skip), and finally a `len < 2` defensive guard.
 *
 *  2. DESTINATION TANGENT + PROFILE. Tangent is the unit vector along
 *     the matched segment; profile reads `totalW` / `laneW` / `lps` if
 *     `getRoadProfile` is available, else falls back to width-fraction
 *     heuristics matching the monolith's L13433-L13435 fallback.
 *
 *  3. ALIGNMENT BRANCH — `mergeAlign` ∈ {1, 2, 3, 4} picks the perp
 *     direction (`alignDx`/`alignDy`) and offset magnitude:
 *
 *       1 (C — auto):       pick side from polyline's perpendicular
 *                           displacement; snap to NEAREST LANE CENTER.
 *       2 (L — legacy):     fixed left; UI button removed in v126.16
 *                           but kept for back-compat with stored data.
 *                           offset = OUTERMOST LANE CENTER.
 *       3 (R — auto):       auto-detect side from click (v126.20 fix
 *                           for "left merge to wrong side when road
 *                           drawn N→S vs S→N"); offset = OUTER-EDGE
 *                           STRIPE (destHalfW − 1.7/TILE) so the
 *                           polygon inner edge sits pixel-perfect on
 *                           the destination's stripe and the dashed
 *                           channelizing pattern is visible (v126.18).
 *       4 (Click-bonded):   v126.23 NEW DEFAULT. perpSigned of click
 *                           drives side AND lane; bondedTip ends on
 *                           the outer-edge stripe (v126.26) so the
 *                           asymmetric polygon construction in
 *                           `_weBuildTaperedMergeEdges` places the
 *                           auxiliary lane OUTSIDE the destination's
 *                           outer lane.
 *
 *     mergeAlign === 0 / unrecognized leaves alignSide = 0 → offsetMag
 *     stays 0 → bondedTip lands at `(projX, projY)` (centerline).
 *
 *  Returning the destination road `r` lets the caller compare
 *  `startBond.road === endBond.road` to detect the U-loop / service-
 *  road same-destination case (v126.14/.15 fixes at L13573).
 *
 *  Ported 1:1 from monolith `_detectBond` (nested helper at L13389-
 *  L13579 inside `_weMergeBondEndpoints_standard`). The version here
 *  takes the draft polyline and `mergeAlign` as explicit parameters
 *  since the standalone export can't capture them from a parent's
 *  scope.
 */
export function _detectBondStandard(
  endIdx: number,
  draftPts: ReadonlyArray<TilePoint>,
  mergeAlign: number,
  deps: MergeDeps,
  /** H888: elevation of the ramp being bonded. When provided, the scan
   *  PREFERS a destination road at the same z (bonds to the bridge deck,
   *  not the ground road directly beneath it), falling back to any-z only
   *  when no same-z road sits within range. Undefined → no z preference
   *  (pre-H888 behavior). */
  rampZ?: number,
): StandardBondInfo | null {
  const majorRoads = deps.getMajorRoads();
  if (!majorRoads || !majorRoads.length) return null;
  const pts = draftPts;
  if (endIdx < 0 || endIdx >= pts.length) return null;
  const ex = pts[endIdx][0];
  const ey = pts[endIdx][1];
  const SEARCH_R2 = STANDARD_SEARCH_R * STANDARD_SEARCH_R;
  let bestD2 = SEARCH_R2;
  let bestRoad: BondTargetRoad | null = null;
  let bestSegI = -1;
  let bestProjX = 0;
  let bestProjY = 0;
  // H888: parallel same-elevation best. wantZ === null disables the
  // preference entirely (no behavior change for callers that omit rampZ).
  const wantZ = rampZ === undefined ? null : (rampZ | 0);
  let bestSameD2 = SEARCH_R2;
  let bestSameRoad: BondTargetRoad | null = null;
  let bestSameSegI = -1;
  let bestSameProjX = 0;
  let bestSameProjY = 0;

  for (const r of majorRoads) {
    if (!r.pts || r.pts.length < 2) continue;
    // Self-skip three ways: array identity (cheap), then deep coord
    // match (the editor deep-copies the polyline before invoking the
    // bond pipeline so identity equality alone misses the self-skip),
    // then fall through to the per-segment scan.
    if (r.pts === (pts as unknown as TilePoint[])) continue;
    let allMatch = r.pts.length === pts.length;
    if (allMatch) {
      for (let i = 0; i < r.pts.length; i++) {
        if (
          Math.abs(r.pts[i][0] - pts[i][0]) > 0.01 ||
          Math.abs(r.pts[i][1] - pts[i][1]) > 0.01
        ) {
          allMatch = false;
          break;
        }
      }
    }
    if (allMatch) continue;
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
      const ddx = ex - px;
      const ddy = ey - py;
      const d2 = ddx * ddx + ddy * ddy;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestRoad = r;
        bestSegI = i;
        bestProjX = px;
        bestProjY = py;
      }
      // H888: track the closest SAME-elevation candidate independently.
      if (wantZ !== null && d2 < bestSameD2 && (Number(r.z) | 0) === wantZ) {
        bestSameD2 = d2;
        bestSameRoad = r;
        bestSameSegI = i;
        bestSameProjX = px;
        bestSameProjY = py;
      }
    }
  }
  // H888: prefer the same-elevation bond when one exists in range, so a
  // bridge-deck ramp (rampZ ≥ 2) bonds to the deck instead of the nearer
  // ground road beneath it. Falls through to the any-z best otherwise.
  if (wantZ !== null && bestSameRoad) {
    bestRoad = bestSameRoad;
    bestSegI = bestSameSegI;
    bestProjX = bestSameProjX;
    bestProjY = bestSameProjY;
  }
  if (!bestRoad) return null;

  // Destination tangent at the matched segment (unit vector).
  const r = bestRoad;
  const i = bestSegI;
  const ax = r.pts[i][0];
  const ay = r.pts[i][1];
  const bx = r.pts[i + 1][0];
  const by = r.pts[i + 1][1];
  let tdx = bx - ax;
  let tdy = by - ay;
  const tlen = Math.hypot(tdx, tdy) || 1;
  tdx /= tlen;
  tdy /= tlen;

  // Destination geometry — totalW for stripe-inset placement, laneW + lps
  // for lane-center snap on C alignment. Width-fraction fallbacks match
  // the monolith's L13433-L13435.
  const dProf = deps.getRoadProfile ? deps.getRoadProfile(r) : null;
  const destHalfW = dProf ? dProf.totalW * 0.5 : r.w * 0.425;
  const destLaneW = dProf ? dProf.laneW : r.w * 0.85;
  const lps = dProf ? dProf.lps : 1;

  // Alignment branch — pick perpendicular direction (alignDx/alignDy)
  // and offset magnitude based on mergeAlign mode.
  let alignDx = 0;
  let alignDy = 0;
  let alignSide = 0;
  let clickOffsetMag = 0; // v126.23 click-bonded computes offset alongside direction
  const STRIPE_INSET = 1.7 / 18; // matches getRoadProfile eo (TILE = 18)

  if (mergeAlign === 4) {
    const perpSigned = (ex - bestProjX) * -tdy + (ey - bestProjY) * tdx;
    if (perpSigned > 0) {
      alignDx = -tdy;
      alignDy = tdx;
      alignSide = +1;
    } else if (perpSigned < 0) {
      alignDx = tdy;
      alignDy = -tdx;
      alignSide = -1;
    }
    clickOffsetMag = Math.max(0, destHalfW - STRIPE_INSET);
  } else if (mergeAlign === 2) {
    alignDx = tdy;
    alignDy = -tdx;
    alignSide = -1;
  } else if (mergeAlign === 3) {
    // v8.99.126.20 fix: auto-detect side from user click (was fixed
    // tangent winding which flipped for roads drawn opposite-direction).
    const perpDist = (ex - bestProjX) * -tdy + (ey - bestProjY) * tdx;
    if (perpDist >= 0) {
      alignDx = -tdy;
      alignDy = tdx;
      alignSide = +1;
    } else {
      alignDx = tdy;
      alignDy = -tdx;
      alignSide = -1;
    }
  } else {
    // mergeAlign 1 (C auto). Pick side from polyline displacement.
    const perpDist = (ex - bestProjX) * -tdy + (ey - bestProjY) * tdx;
    if (perpDist > 0) {
      alignDx = -tdy;
      alignDy = tdx;
      alignSide = +1;
    } else if (perpDist < 0) {
      alignDx = tdy;
      alignDy = -tdx;
      alignSide = -1;
    }
  }

  let offsetMag = 0;
  if (alignSide !== 0) {
    if (mergeAlign === 4) {
      offsetMag = clickOffsetMag;
    } else if (mergeAlign === 1) {
      // C: snap to NEAREST lane center on the auto-detected side.
      const perpDistAbs = Math.abs(
        (ex - bestProjX) * -tdy + (ey - bestProjY) * tdx,
      );
      let bestLaneDist = 0;
      let bestDelta = Infinity;
      for (let k = 1; k <= lps; k++) {
        const laneCenterDist = (k - 0.5) * destLaneW;
        const delta = Math.abs(perpDistAbs - laneCenterDist);
        if (delta < bestDelta) {
          bestDelta = delta;
          bestLaneDist = laneCenterDist;
        }
      }
      offsetMag = bestLaneDist;
    } else if (mergeAlign === 3) {
      // v8.99.126.18 outer-edge-stripe placement (was destHalfW pre-v126.18).
      offsetMag = Math.max(0, destHalfW - STRIPE_INSET);
    } else {
      // Legacy L (mergeAlign === 2): outermost lane center.
      offsetMag = Math.max(0, destHalfW - destLaneW * 0.5);
    }
  }

  return {
    endIdx,
    bondedTip: [bestProjX + alignDx * offsetMag, bestProjY + alignDy * offsetMag],
    destTangent: [tdx, tdy],
    origTip: [ex, ey],
    road: bestRoad,
    alignSide,
  };
}

/** Single-end smoothing path for the standard merge — v8.99.126.10 algo.
 *  Mutates `out` IN PLACE: snaps the bonded endpoint to `bond.bondedTip`,
 *  replaces the polyline interior between the bonded end and an anchor
 *  three segments back with a 7-sample cubic Bezier, then appends (or
 *  prepends) a 5-tile auxiliary-lane extension past the bondedTip along
 *  the destination tangent (v8.99.126.15).
 *
 *  ANCHOR-BACK SELECTION. The Bezier's start point is the polyline
 *  vertex three indices away from the bonded end (clamped — short
 *  polylines anchor at the opposite endpoint). The anchor's tangent
 *  comes from the polyline neighbor on the FAR side of the anchor
 *  (`anchorIdx + 1` when endIdx === N-1, `anchorIdx - 1` when endIdx
 *  === 0). When the polyline is too short for a neighbor we fall back
 *  to the straight-line direction anchor → endpoint so the curve still
 *  has a defined tangent.
 *
 *  TANGENT SIGN. The destination tangent at `bond.destTangent` is a
 *  unit vector along the destination's segment-of-bond, oriented by
 *  the segment's drawing direction — which is NOT necessarily the
 *  direction the smoothed curve should ENTER from. We dot the anchor
 *  tangent against destTangent and flip when the dot is negative, so
 *  the curve approaches `bondedTip` heading the same way the anchor
 *  is heading. Without this sign-fix the curve would loop back on
 *  itself when the destination was drawn opposite to the draft.
 *
 *  BEZIER CONTROL POINTS. Standard formulation:
 *    P0 = anchor
 *    P1 = anchor + anchorTangent * 0.40 * |endpoint - anchor|
 *    P2 = endpoint - destDir * 0.50 * |endpoint - anchor|
 *    P3 = endpoint (= bondedTip)
 *  The 0.40 / 0.50 ratios are the v126.10 tuning — pulling the curve
 *  ~40% toward the anchor's intrinsic tangent and ~50% toward the
 *  destination tangent gives a visually pleasing arc without
 *  overshoot.
 *
 *  AUXILIARY-LANE EXTENSION (v8.99.126.15). The Bezier ends at
 *  bondedTip heading in destDir (because the tangent of a cubic at
 *  t=1 is proportional to P3 − P2 = +destDir). Adding a 5-tile
 *  extension along destDir past the bondedTip lets the downstream
 *  polygon builder `_weBuildTaperedMergeEdges` carry the auxiliary
 *  lane INTO the destination's outermost lane, producing the
 *  characteristic merge-ramp visual where the ramp asphalt slides
 *  alongside the destination before tapering. For endIdx === 0 the
 *  extension goes BEFORE the polyline (unshift); for endIdx ===
 *  N-1 it goes AFTER (push).
 *
 *  Returns the mutated `out` for chaining. Caller is responsible for
 *  short-circuiting (return passthrough) when length < 2 or neither
 *  bond candidate fired.
 *
 *  Ported 1:1 from monolith L14100-L14170 (the one-end-bonded branch
 *  inside `_weMergeBondEndpoints_standard`).
 */
/** H884: auxiliary-lane geometry lengths (tiles), compressed from DOT
 *  (~1200ft accel / ~300ft taper) to fit the arcade map while keeping the
 *  parallel-alongside : taper proportion. Tunable in one place. */
export const AUX_PARALLEL_LEN = 24;
export const AUX_TAPER_LEN = 12;
const AUX_PARALLEL_SAMPLES = 4;

export function _smoothOneEndBondedStandard(
  out: TilePoint[],
  bond: StandardBondInfo,
): TilePoint[] {
  if (out.length < 2) return out;
  // Snap the bonded endpoint to the bondedTip.
  out[bond.endIdx][0] = bond.bondedTip[0];
  out[bond.endIdx][1] = bond.bondedTip[1];

  const endIdx = bond.endIdx;
  const targetBack = 3;
  const availableBack = endIdx === 0 ? out.length - 1 : endIdx;
  const ANCHOR_BACK = Math.min(targetBack, availableBack);
  const anchorIdx = endIdx === 0 ? ANCHOR_BACK : endIdx - ANCHOR_BACK;
  const anchor = out[anchorIdx];
  const endpoint = out[endIdx];

  // Anchor tangent — direction the curve approaches the anchor from.
  let anchorTanX: number;
  let anchorTanY: number;
  if (endIdx === 0) {
    const neighborIdx = Math.max(0, anchorIdx - 1);
    anchorTanX = out[neighborIdx][0] - anchor[0];
    anchorTanY = out[neighborIdx][1] - anchor[1];
  } else {
    const neighborIdx = Math.min(out.length - 1, anchorIdx + 1);
    anchorTanX = out[neighborIdx][0] - anchor[0];
    anchorTanY = out[neighborIdx][1] - anchor[1];
  }
  const atLen = Math.hypot(anchorTanX, anchorTanY);
  if (atLen > 0.001) {
    anchorTanX /= atLen;
    anchorTanY /= atLen;
  } else {
    // Fallback: anchor → endpoint direction. Used when the anchor and
    // its neighbor coincide (very short polylines).
    const dxe = endpoint[0] - anchor[0];
    const dye = endpoint[1] - anchor[1];
    const dle = Math.hypot(dxe, dye) || 1;
    anchorTanX = dxe / dle;
    anchorTanY = dye / dle;
  }

  // Flip destination tangent so the curve approaches bondedTip heading
  // the same way the anchor is heading — without this the curve loops
  // back on itself when the destination was drawn opposite the draft.
  const tdx = bond.destTangent[0];
  const tdy = bond.destTangent[1];
  const sgn = anchorTanX * tdx + anchorTanY * tdy >= 0 ? 1 : -1;
  const destDirX = sgn * tdx;
  const destDirY = sgn * tdy;

  const dist = Math.hypot(endpoint[0] - anchor[0], endpoint[1] - anchor[1]);
  const L1 = dist * 0.4;
  const L2 = dist * 0.5;
  const p1: TilePoint = [anchor[0] + anchorTanX * L1, anchor[1] + anchorTanY * L1];
  const p2: TilePoint = [endpoint[0] - destDirX * L2, endpoint[1] - destDirY * L2];

  const baked = _sampleCubic(anchor, p1, p2, endpoint, 7);

  // Splice the interior between anchor and endpoint with the baked
  // samples. For endIdx === 0 the polyline reads endpoint → anchor →
  // tail, so the new samples are inserted at index 1 (just past the
  // endpoint) in REVERSED order (because they were sampled anchor →
  // endpoint). For endIdx === N-1 the polyline reads head → anchor →
  // endpoint, so samples go right after anchorIdx in natural order.
  if (endIdx === 0) {
    out.splice(1, Math.max(0, anchorIdx - 1), ...baked.slice().reverse());
  } else {
    out.splice(anchorIdx + 1, Math.max(0, endIdx - anchorIdx - 1), ...baked);
  }

  // H884: auxiliary-lane PARALLEL run + taper (DOT acceleration/deceleration
  // lane). The Bezier's tangent at bondedTip is +destDir, so past the tip the
  // aux lane runs ALONGSIDE the destination at full width for AUX_PARALLEL_LEN,
  // then tapers to a point (apex) over AUX_TAPER_LEN. The apex becomes the new
  // bonded-end vertex (it sits alongside the destination, so bond detection
  // still flags it), which the polygon builder collapses to _vwOut=0; the
  // bondedTip + parallel samples keep full lane width. Net: the ramp runs
  // beside the highway and tapers to merge, instead of meeting it as the
  // pre-H884 single 5-tile stub that read as a slab across the lanes.
  const aux: TilePoint[] = [];
  for (let k = 1; k <= AUX_PARALLEL_SAMPLES; k++) {
    const d = (AUX_PARALLEL_LEN * k) / AUX_PARALLEL_SAMPLES;
    aux.push([endpoint[0] + destDirX * d, endpoint[1] + destDirY * d]);
  }
  aux.push([
    endpoint[0] + destDirX * (AUX_PARALLEL_LEN + AUX_TAPER_LEN),
    endpoint[1] + destDirY * (AUX_PARALLEL_LEN + AUX_TAPER_LEN),
  ]);
  if (endIdx === 0) {
    // Polyline reads [bondedTip, anchor, …]; prepend [apex, parK…par1] so the
    // order becomes apex → parallel → bondedTip → … and index 0 is the apex.
    out.unshift(...aux.slice().reverse());
  } else {
    out.push(...aux);
  }
  return out;
}

/** Influence function for the 2-click both-bonded fallback. Returns 0
 *  when |d| <= 0.3 (destination near-perpendicular to the bond chord —
 *  using a tangent-derived control point would produce an S-shape), 1
 *  when |d| >= 1.0 (destination near-parallel — use the destination
 *  tangent at full strength), and a linear ramp between. Matches
 *  monolith `_influence2` inline at L13813. */
function _influence2(d: number): number {
  const a = Math.abs(d);
  return a <= 0.3 ? 0 : Math.min(1, (a - 0.3) / 0.7);
}

/** v126.35 auxiliary-lane extension lengths for the BOTH-BONDED path
 *  (different from the one-bonded path's 5-tile extension at H340).
 *  Total per-end extension is 6 tiles, intentionally less than
 *  d_aux_s ≥ 8 (the v126.32 aux-knot distance) so extStart doesn't
 *  coincide with aux_start at the polygon's tapered-tip vertex. The
 *  6-tile total leaves a 2-tile margin to the aux knot. */
const BOTH_BONDED_TAPER_LEN = 3.0;
const BOTH_BONDED_PARALLEL_LEN = 3.0;
const BOTH_BONDED_EXT_LEN = BOTH_BONDED_TAPER_LEN + BOTH_BONDED_PARALLEL_LEN;

/** Both-ends-bonded smoothing path for the standard merge.
 *
 *  Composes three sub-stages:
 *
 *  STAGE 1 — CONTROL-POINT SELECTION (sets p1, p2 of the cubic Bezier
 *  or, equivalently, the user-knot inputs to the Catmull-Rom curve).
 *
 *    - 3+ click case, DIFFERENT destinations (v8.99.126.14
 *      tangent-aligned):
 *        p1 = p0 + sSgn·sTan · |userP1 - p0|
 *        p2 = p3 + eSgn·eTan · |userP2 - p3|
 *      where sSgn / eSgn flip the destination tangent so it points
 *      INTO the curve (toward the user's intermediate click). The
 *      cubic enters/exits its bonded tips PARALLEL to each
 *      destination — the smooth S-bend geometry shown in DOT MUTCD
 *      ramp figures. Without this fix the cubic's tangent at p0 is
 *      exactly (userP1 - p0) — whatever angle the user happened to
 *      draw — so the ramp meets the highway at 30-50° instead of
 *      parallel.
 *
 *    - 3+ click case, SAME destination (U-loop service road):
 *        p1 = userP1, p2 = userP2 (v126.13 verbatim).
 *      Tangent alignment would collapse the U-loop's perpendicular
 *      bow into a flat line along the destination. Detected by
 *      reference equality `startBond.road === endBond.road`.
 *
 *    - 2-click case (no intermediate clicks): v8.99.126.12
 *      destination-tangent-derived with influence threshold.
 *      `startInfluence = _influence2(startDotRaw)` — destinations
 *      near-perpendicular to the bond chord (|dot| <= 0.3) get 0
 *      influence (using their tangent would produce an S-shape);
 *      near-parallel (|dot| >= 1.0) get full influence. Control
 *      points sit at 40% of the bond chord length along the
 *      sign-corrected destination tangent.
 *
 *  STAGE 2 — CURVE CONSTRUCTION (builds baseResult, the
 *  bondedTip-to-bondedTip polyline before extensions).
 *
 *    - 3+ clicks, DIFFERENT destinations (v8.99.126.27/30/32):
 *        knots = [p0, aux_start, ...userMids, aux_end, p3]
 *      where aux_start / aux_end are tangent-aligned auxiliary knots
 *      at distance max(8, |userMid - bondedTip| * 0.35) from the
 *      bonded tip along the destination tangent (sign-corrected to
 *      point AWAY from the other bond). v126.32 ALWAYS inserts these
 *      regardless of user click count — without them, the
 *      Catmull-Rom tangent at bondedStart was determined by the
 *      first user mid click which (for clicks into the loop
 *      interior) produced a curve LEAVING bondedStart heading INTO
 *      the loop instead of along the source road tangent.
 *
 *      Phantom-before / phantom-after points continue along the
 *      destination tangent past each bonded tip at distance
 *      max(3, |knot[1] - knot[0]| * 0.5). These set the
 *      Catmull-Rom's tangent AT bondedStart / bondedEnd so the
 *      curve enters / exits parallel to the destination.
 *
 *      Catmull-Rom samplesPerSeg = 10. Final knot count K → roughly
 *      (K-1)*10 + 1 polyline points.
 *
 *    - 2 clicks OR same-destination: cubic Bezier samples between p0
 *      and p3 with the p1/p2 chosen in stage 1. baseResult = [p0,
 *      ...samples (11), p3].
 *
 *  STAGE 3 — AUXILIARY-LANE EXTENSIONS (v8.99.126.15 / .35).
 *
 *    Skipped entirely on SAME-DESTINATION (no meaningful destination
 *    tangents to extend along — both bondedTips are on the same
 *    road, extending in the Bezier-tangent direction would pull the
 *    polyline perpendicular to the road for the U-loop bow case).
 *
 *    For different destinations:
 *      ext direction = +sSgn·sTan / +eSgn·eTan (same side as
 *      aux_start / aux_end — AWAY from the other bond). v126.35
 *      reverse from v126.34 which placed extensions on the SAME side
 *      as bondedEnd; that aimed both extensions INWARD toward the
 *      intersection in tight cloverleafs, producing parallel zones
 *      that cut across the cross road's lanes.
 *
 *      Final assembly:
 *        [extStart, taperEndStart, ...baseResult, taperEndEnd, extEnd]
 *
 *      Polyline has a 180° kink at each bondedTip vertex — handled
 *      downstream by `_weBuildTaperedMergeEdges` (v126.35) which
 *      overrides perpendicular at the bondedTip vertices to
 *      perpendicular-of-destination-tangent and uses TWO ASYM_SGNs
 *      (extension portion vs. curve portion).
 *
 *  Ported 1:1 from monolith L13685-L14098 (the
 *  `if(startBond && endBond)` block inside
 *  `_weMergeBondEndpoints_standard`).
 */
export function _smoothBothEndsBondedStandard(
  out: ReadonlyArray<TilePoint>,
  startBond: StandardBondInfo,
  endBond: StandardBondInfo,
): TilePoint[] {
  const p0: TilePoint = [startBond.bondedTip[0], startBond.bondedTip[1]];
  const p3: TilePoint = [endBond.bondedTip[0], endBond.bondedTip[1]];
  const fwdX = p3[0] - p0[0];
  const fwdY = p3[1] - p0[1];
  const fwdLen = Math.hypot(fwdX, fwdY) || 1;

  const sameDest = startBond.road === endBond.road;

  // STAGE 1 — control-point selection (p1, p2).
  let p1: TilePoint;
  let p2: TilePoint;
  if (out.length >= 3) {
    const userP1 = out[1];
    const userP2 = out[out.length - 2];
    if (sameDest) {
      p1 = [userP1[0], userP1[1]];
      p2 = [userP2[0], userP2[1]];
    } else {
      const sTan = startBond.destTangent;
      const eTan = endBond.destTangent;
      const sUx = userP1[0] - p0[0];
      const sUy = userP1[1] - p0[1];
      const sUd = Math.hypot(sUx, sUy);
      const sSgn = sUx * sTan[0] + sUy * sTan[1] >= 0 ? 1 : -1;
      p1 = [p0[0] + sSgn * sTan[0] * sUd, p0[1] + sSgn * sTan[1] * sUd];
      const eUx = userP2[0] - p3[0];
      const eUy = userP2[1] - p3[1];
      const eUd = Math.hypot(eUx, eUy);
      const eSgn = eUx * eTan[0] + eUy * eTan[1] >= 0 ? 1 : -1;
      p2 = [p3[0] + eSgn * eTan[0] * eUd, p3[1] + eSgn * eTan[1] * eUd];
    }
  } else {
    // 2 user clicks ONLY — destination-tangent-derived with influence
    // threshold (v126.12).
    const startTan = startBond.destTangent;
    const endTan = endBond.destTangent;
    const fwdNX = fwdX / fwdLen;
    const fwdNY = fwdY / fwdLen;
    const startDotRaw = startTan[0] * fwdNX + startTan[1] * fwdNY;
    const endDotRaw = endTan[0] * fwdNX + endTan[1] * fwdNY;
    const startSgn = startDotRaw >= 0 ? 1 : -1;
    const endSgn = endDotRaw >= 0 ? 1 : -1;
    const startDirX = startSgn * startTan[0];
    const startDirY = startSgn * startTan[1];
    const endDirX = endSgn * endTan[0];
    const endDirY = endSgn * endTan[1];
    const startInfluence = _influence2(startDotRaw);
    const endInfluence = _influence2(endDotRaw);
    const startL = fwdLen * 0.4 * startInfluence;
    const endL = fwdLen * 0.4 * endInfluence;
    p1 = [p0[0] + startDirX * startL, p0[1] + startDirY * startL];
    p2 = [p3[0] - endDirX * endL, p3[1] - endDirY * endL];
  }

  const samples = _sampleCubic(p0, p1, p2, p3, 11);

  // STAGE 2 — curve construction.
  let baseResult: TilePoint[];
  if (out.length >= 3 && !sameDest) {
    // v126.27/30/32 Catmull-Rom-through-knots path with v126.32
    // always-inserted tangent-aligned auxiliary knots.
    const sTan = startBond.destTangent;
    const eTan = endBond.destTangent;
    const sePathDx = p3[0] - p0[0];
    const sePathDy = p3[1] - p0[1];
    const knots: TilePoint[] = [];
    knots.push([p0[0], p0[1]]);

    // aux_start — tangent-aligned auxiliary knot at distance
    // max(8, |userP1 - p0| * 0.35) along sTan, sign-corrected to
    // point AWAY from bondedEnd (sTan · (p0 - p3) > 0).
    {
      const d_aux_s = Math.max(8.0, Math.hypot(out[1][0] - p0[0], out[1][1] - p0[1]) * 0.35);
      const sDirDot = sTan[0] * -sePathDx + sTan[1] * -sePathDy;
      const sSgn = sDirDot >= 0 ? 1 : -1;
      knots.push([p0[0] + sSgn * sTan[0] * d_aux_s, p0[1] + sSgn * sTan[1] * d_aux_s]);
    }
    for (let mi = 1; mi < out.length - 1; mi++) {
      knots.push([out[mi][0], out[mi][1]]);
    }
    // aux_end — symmetric to aux_start at distance
    // max(8, |userP_{N-2} - p3| * 0.35) along eTan, sign-corrected
    // to point AWAY from bondedStart (eTan · (p3 - p0) > 0).
    {
      const lastUser = out[out.length - 2];
      const d_aux_e = Math.max(8.0, Math.hypot(lastUser[0] - p3[0], lastUser[1] - p3[1]) * 0.35);
      const eDirDot = eTan[0] * sePathDx + eTan[1] * sePathDy;
      const eSgn = eDirDot >= 0 ? 1 : -1;
      knots.push([p3[0] + eSgn * eTan[0] * d_aux_e, p3[1] + eSgn * eTan[1] * d_aux_e]);
    }
    knots.push([p3[0], p3[1]]);

    // Phantom points — continue along the destination tangent past
    // each bonded tip at distance max(3, |knot[1] - knot[0]| * 0.5).
    const phantomD_s = Math.max(
      3.0,
      Math.hypot(knots[1][0] - knots[0][0], knots[1][1] - knots[0][1]) * 0.5,
    );
    const phantomD_e = Math.max(
      3.0,
      Math.hypot(
        knots[knots.length - 1][0] - knots[knots.length - 2][0],
        knots[knots.length - 1][1] - knots[knots.length - 2][1],
      ) * 0.5,
    );
    const sCurveDx = knots[1][0] - knots[0][0];
    const sCurveDy = knots[1][1] - knots[0][1];
    const sLen = Math.hypot(sCurveDx, sCurveDy) || 1;
    const phantom_before: TilePoint = [
      knots[0][0] - (sCurveDx / sLen) * phantomD_s,
      knots[0][1] - (sCurveDy / sLen) * phantomD_s,
    ];
    const eCurveDx = knots[knots.length - 1][0] - knots[knots.length - 2][0];
    const eCurveDy = knots[knots.length - 1][1] - knots[knots.length - 2][1];
    const eLen = Math.hypot(eCurveDx, eCurveDy) || 1;
    const phantom_after: TilePoint = [
      knots[knots.length - 1][0] + (eCurveDx / eLen) * phantomD_e,
      knots[knots.length - 1][1] + (eCurveDy / eLen) * phantomD_e,
    ];

    baseResult = _catmullRomThroughKnots(knots, 10, phantom_before, phantom_after);
  } else {
    // 2-click or same-destination — cubic Bezier samples between
    // p0 and p3 with the stage-1 p1/p2.
    baseResult = [p0, ...samples, p3];
  }

  // STAGE 3 — auxiliary-lane extensions. Skip when same-destination.
  if (sameDest) return baseResult;

  // Recompute sSgn / eSgn here — they may not be in scope from the
  // earlier stage (the aux-knot block declared them locally; the
  // cubic-Bezier path didn't compute them at all).
  const vSTan = startBond.destTangent;
  const vETan = endBond.destTangent;
  const bN = baseResult.length;
  const vSePathDx = baseResult[bN - 1][0] - baseResult[0][0];
  const vSePathDy = baseResult[bN - 1][1] - baseResult[0][1];
  const vSDirDot = vSTan[0] * -vSePathDx + vSTan[1] * -vSePathDy;
  const vSSgn = vSDirDot >= 0 ? 1 : -1;
  const vEDirDot = vETan[0] * vSePathDx + vETan[1] * vSePathDy;
  const vESgn = vEDirDot >= 0 ? 1 : -1;
  // v126.35: extension direction is AWAY from the other bond
  // (+vSSgn*vSTan / +vESgn*vETan). Creates a 180° polyline kink at
  // each bondedTip vertex — handled in `_weBuildTaperedMergeEdges`
  // which overrides perpendicular at those vertices.
  const extDirSx = vSSgn * vSTan[0];
  const extDirSy = vSSgn * vSTan[1];
  const extDirEx = vESgn * vETan[0];
  const extDirEy = vESgn * vETan[1];
  const extStart: TilePoint = [
    baseResult[0][0] + extDirSx * BOTH_BONDED_EXT_LEN,
    baseResult[0][1] + extDirSy * BOTH_BONDED_EXT_LEN,
  ];
  const taperEndStart: TilePoint = [
    baseResult[0][0] + extDirSx * BOTH_BONDED_PARALLEL_LEN,
    baseResult[0][1] + extDirSy * BOTH_BONDED_PARALLEL_LEN,
  ];
  const extEnd: TilePoint = [
    baseResult[bN - 1][0] + extDirEx * BOTH_BONDED_EXT_LEN,
    baseResult[bN - 1][1] + extDirEy * BOTH_BONDED_EXT_LEN,
  ];
  const taperEndEnd: TilePoint = [
    baseResult[bN - 1][0] + extDirEx * BOTH_BONDED_PARALLEL_LEN,
    baseResult[bN - 1][1] + extDirEy * BOTH_BONDED_PARALLEL_LEN,
  ];
  return [extStart, taperEndStart, ...baseResult, taperEndEnd, extEnd];
}

/** Rewrite both endpoints of a draft road to bond onto nearby baseline
 *  roads. Composes the three sub-stages:
 *
 *    1. Detect bonds at both endpoints (`_detectBondStandard`).
 *    2. Branch on which ends bonded:
 *         BOTH    → `_smoothBothEndsBondedStandard` (Bezier or
 *                   Catmull-Rom + v126.15/.35 extensions).
 *         ONE     → `_smoothOneEndBondedStandard` (v126.10 single-
 *                   end algo + v126.15 extension).
 *         NEITHER → return polyline unchanged.
 *
 *  Same defensive guards as the monolith: short polyline (<2 pts) or
 *  empty majorRoads → passthrough.
 *
 *  Ported 1:1 from monolith `_weMergeBondEndpoints_standard`
 *  (L13346-L14172). All sub-pieces ported in earlier hops:
 *    H336 — `_sampleCubic`
 *    H337 — `_catmullRomThroughKnots`
 *    H338 — `_detectBondStandard`
 *    H340 — `_smoothOneEndBondedStandard`
 *    H346 — `_smoothBothEndsBondedStandard` (this hop)
 *    H346 — `_weMergeBondEndpoints_standard` (this hop: assembly)
 */
export function _weMergeBondEndpoints_standard(
  opts: StandardMergeOpts,
  deps: MergeDeps,
  /** H887: optional accumulator — populated with each bonded endpoint's
   *  resolved inward (toward-destination) unit vector so the commit can
   *  persist the side. */
  sideOut?: { start?: [number, number]; end?: [number, number] },
): TilePoint[] {
  const mergeAlign = opts.mergeAlign || 1;
  const pts = opts.pts;
  if (!Array.isArray(pts) || pts.length < 2) return pts.map((p) => [p[0], p[1]]);
  const majorRoads = deps.getMajorRoads();
  if (!majorRoads || !majorRoads.length) return pts.map((p) => [p[0], p[1]]);

  const out: TilePoint[] = pts.map((p) => [p[0], p[1]]);

  const rampZ = opts.rampZ;
  const startBond = _detectBondStandard(0, out, mergeAlign, deps, rampZ);
  const endBond = _detectBondStandard(out.length - 1, out, mergeAlign, deps, rampZ);

  // H887: capture the inward (toward-destination) unit vector for each
  // resolved side. bondedTip = proj + alignDir*offset, so the inward dir
  // is -alignDir = alignSide * [tdy, -tdx] (destTangent = [tdx, tdy]).
  // This equals what _computeMergeInnerDir re-derives when the tip sits
  // off-centerline, but is also valid in the degenerate on-centerline
  // case (offset === 0) where _computeMergeInnerDir returns null.
  if (sideOut) {
    if (startBond) sideOut.start = _bondInwardDir(startBond);
    if (endBond) sideOut.end = _bondInwardDir(endBond);
  }

  if (startBond && endBond) {
    return _smoothBothEndsBondedStandard(out, startBond, endBond);
  }
  if (startBond || endBond) {
    const bond = (startBond ?? endBond) as StandardBondInfo;
    return _smoothOneEndBondedStandard(out, bond);
  }
  return out;
}

/** H887: inward (toward-destination) unit vector for a resolved bond, or
 *  undefined when no side was picked (alignSide === 0). */
function _bondInwardDir(bond: StandardBondInfo): [number, number] | undefined {
  const s = bond.alignSide | 0;
  if (s === 0) return undefined;
  const [tdx, tdy] = bond.destTangent;
  return [s * tdy, -s * tdx];
}
