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
 * Ported from monolith L13346-14215.
 *
 * SCAFFOLD status: bond detection + one-bonded path ported (H338, H340);
 * the both-bonded coordinated-Bezier path still TODO at the entry
 * function.
 */

import type { TilePoint } from '../stamp';
import { _sampleCubic } from './curves';

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
    }
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

  // v8.99.126.15: auxiliary-lane extension. The Bezier's tangent at
  // endpoint is +destDir, so the polyline at bondedTip is heading along
  // destDir; the extension continues 5 tiles further so the polygon
  // builder can extend the auxiliary lane INTO the destination's outer
  // lane.
  const EXT_LEN = 5.0;
  const extPoint: TilePoint = [
    endpoint[0] + destDirX * EXT_LEN,
    endpoint[1] + destDirY * EXT_LEN,
  ];
  if (endIdx === 0) {
    out.unshift(extPoint);
  } else {
    out.push(extPoint);
  }
  return out;
}

/** Rewrite both endpoints of a draft road to bond onto nearby baseline
 *  roads, using a single coordinated cubic Bezier through the interior.
 *  Returns a new pts array (input is not mutated).
 *  TODO(E34-followup): port from L13346-14215 — the bond detection
 *  helper `_detectBondStandard` and one-bonded smoother
 *  `_smoothOneEndBondedStandard` above are wired in; the both-bonded
 *  coordinated-Bezier path (v126.13+ U-shape preservation, control-
 *  points-from-clicks logic, same-destination loop guard) still TODO
 *  at L13685-14099. */
export function _weMergeBondEndpoints_standard(
  _opts: StandardMergeOpts,
  _deps: MergeDeps,
): TilePoint[] {
  // TODO: L13346-14215.
  //   1. _detectBondStandard at start endpoint (DONE — H338).
  //   2. _detectBondStandard at end endpoint.
  //   3. If both bond: build single cubic Bezier with tangent constraints
  //      at both ends (the v8.99.126.12 fix). Sample it to replace
  //      the relevant pts prefix + suffix.
  //   4. If only one bonds: single-end smoothing (DONE — H340).
  //   5. If neither: return pts unchanged (caller falls back to user clicks).
  return _opts.pts.map((p) => [p[0], p[1]]);
}
