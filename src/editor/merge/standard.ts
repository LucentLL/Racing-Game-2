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
import { _sampleCubic, _hermiteSplineThroughKnots } from './curves';

/** Shared baseline-road shape used by every bond-detection routine. */
export interface BondTargetRoad {
  pts: TilePoint[];
  w: number;
  [k: string]: unknown;
}

/** H902: the destination lane an endpoint was CLICKED onto (captured from
 *  the snap at placement). Structurally matches editor/index `BondTarget`;
 *  defined here so the merge modules stay free of an editor/index import.
 *  When present, the bond uses this road/side directly instead of
 *  re-scanning and re-deriving the side from geometry (the "wrong side"
 *  bug). `roadIdx`/`segIdx` index getMajorRoads() at click time. */
export interface MergeBondTarget {
  roadIdx: number;
  segIdx: number;
  side: 1 | -1;
  laneIdx: number;
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
  /** H902: explicit clicked-lane targets for the start / end endpoints. */
  startTarget?: MergeBondTarget | null;
  endTarget?: MergeBondTarget | null;
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
  /** H902: the lane the user CLICKED for this endpoint. When valid, the
   *  bond uses this exact road/segment + side instead of re-scanning and
   *  re-deriving the side from geometry. Out-of-range / stale → ignored
   *  (falls back to the scan). */
  target?: MergeBondTarget | null,
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

  // H902: an explicit clicked-lane target OVERRIDES the scan — bond to
  // exactly the road/segment the user clicked (the scan above still ran so
  // a stale/out-of-range target degrades to the legacy nearest-road bond).
  // `forcedSide` carries the clicked L/R sign into the alignment branch so
  // the side is NOT re-derived from perpSigned (the "wrong side" bug).
  let forcedSide: 1 | -1 | 0 = 0;
  let forcedLaneIdx = 1; // H903: clicked lane → bond at that lane's center
  if (target && target.roadIdx >= 0 && target.roadIdx < majorRoads.length) {
    const tr = majorRoads[target.roadIdx];
    if (
      tr && tr.pts && target.segIdx >= 0 && target.segIdx + 1 < tr.pts.length &&
      tr.pts !== (pts as unknown as TilePoint[])
    ) {
      const ax = tr.pts[target.segIdx][0];
      const ay = tr.pts[target.segIdx][1];
      const bx = tr.pts[target.segIdx + 1][0];
      const by = tr.pts[target.segIdx + 1][1];
      const dx = bx - ax;
      const dy = by - ay;
      const lenSq = dx * dx + dy * dy;
      if (lenSq >= 0.0001) {
        let t = ((ex - ax) * dx + (ey - ay) * dy) / lenSq;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
        bestRoad = tr;
        bestSegI = target.segIdx;
        bestProjX = ax + dx * t;
        bestProjY = ay + dy * t;
        forcedSide = target.side;
        forcedLaneIdx = target.laneIdx > 0 ? target.laneIdx : 1;
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

  if (forcedSide !== 0) {
    // H902/H903: bind to the clicked LANE on the clicked SIDE — the tip sits
    // at that lane's CENTER (not the outer edge), so the merge connects to
    // exactly the lane the user selected. Side comes from the click, not a
    // perpSigned re-derivation (which flips at intersections / angled roads).
    alignSide = forcedSide;
    if (forcedSide > 0) { alignDx = -tdy; alignDy = tdx; }
    else { alignDx = tdy; alignDy = -tdx; }
    clickOffsetMag = Math.max(0, (forcedLaneIdx - 0.5) * destLaneW);
  } else if (mergeAlign === 4) {
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
    if (forcedSide !== 0 || mergeAlign === 4) {
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

  // H891: no auxiliary-lane extension. The Bezier interior already gives a
  // smooth curve from the anchor into the bonded tip; the old H884 run
  // ALONGSIDE the destination (then taper) doubled the centerline back on
  // itself and read as jagged/disjointed. A connection should be a smooth
  // drive into the lane — see _smoothBothEndsBondedStandard for the same
  // change on the both-ends path.
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


/** Both-ends-bonded smoothing path for the standard merge.
 *
 *  TWO regimes, split on whether the two endpoints bond onto the SAME
 *  road or DIFFERENT roads (`startBond.road === endBond.road`):
 *
 *  DIFFERENT destinations (the normal merge — H899) — a clamped-Hermite
 *  spline (`_hermiteSplineThroughKnots`) through [p0, …user mids, p3]
 *  whose end tangents are PINNED to each bonded destination's tangent
 *  (sign-corrected to point along travel). The ramp therefore LEAVES the
 *  start road and ARRIVES at the end road running parallel to each — the
 *  "start and end tangential to roads" the user asked for — curving
 *  smoothly through any intermediate clicks between. This replaces a
 *  succession of earlier attempts that all met the road off-tangent:
 *    - v126.12 influence-Bezier: dropped the destination tangent toward
 *      0 whenever the road ran ACROSS the bond chord, so a ramp into a
 *      steeply-crossing road hit it at 80°+ (measured).
 *    - v126.14 tangent-aligned control points + v126.27-35 auxiliary
 *      knots + extensions: bulged the centerline backward along each
 *      road and doubled it over itself (the jagged/disjoint look).
 *    - H891 natural-phantom Catmull-Rom: smooth, but free to meet the
 *      road at whatever angle the user happened to draw.
 *  The Hermite pins the tangent EXACTLY while staying a single smooth
 *  forward curve, so neither failure recurs.
 *
 *  SAME destination (U-loop / service road) — pinning both tangents to
 *  the one shared road would flatten the loop's perpendicular bow, so
 *  this regime keeps the v126.12/.13 cubic Bezier: control points are
 *  the user's intermediate clicks (3+ click) or the influence-tangent
 *  fallback (bare 2-click). Detected by reference equality on `road`.
 *
 *  No auxiliary-lane extension is appended in either regime — the smooth
 *  curve IS the merge centerline; the one-lane gore taper is applied
 *  downstream by `_weBuildTaperedMergeEdges`.
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

  // H899 — DIFFERENT destinations: a clamped-Hermite spline through
  // [p0, …user mids, p3] whose END TANGENTS are pinned to each bonded
  // destination's tangent. The ramp therefore LEAVES p0 running parallel
  // to the start road and ARRIVES at p3 running parallel to the end road
  // (the user's "start and end tangential to roads"), curving smoothly
  // through any intermediate clicks in between. This supersedes BOTH the
  // 2-click influence-Bezier (which dropped the destination tangent to
  // ~0 whenever the road ran across the bond chord — measured 80°+
  // off-tangent) AND the H891 natural-phantom Catmull-Rom (which let the
  // curve meet the road at whatever angle the user happened to draw).
  // The U-loop (same-destination) path below is untouched — pinning both
  // tangents to one shared road would flatten the loop's bow.
  if (!sameDest) {
    const mids: TilePoint[] = [];
    for (let mi = 1; mi < out.length - 1; mi++) mids.push([out[mi][0], out[mi][1]]);
    const sTan = startBond.destTangent;
    const eTan = endBond.destTangent;
    // Sign each destination tangent so it points ALONG travel: start
    // tangent toward the first interior knot (or p3), end tangent toward p3.
    const refS = mids.length ? mids[0] : p3;
    const refE = mids.length ? mids[mids.length - 1] : p0;
    const sgnS = (refS[0] - p0[0]) * sTan[0] + (refS[1] - p0[1]) * sTan[1] >= 0 ? 1 : -1;
    const sgnE = (p3[0] - refE[0]) * eTan[0] + (p3[1] - refE[1]) * eTan[1] >= 0 ? 1 : -1;
    const tanStart: [number, number] = [sgnS * sTan[0], sgnS * sTan[1]];
    const tanEnd: [number, number] = [sgnE * eTan[0], sgnE * eTan[1]];
    // H900: the "drive-onto" parallel-along-the-road length is provided by
    // the gore EXTENSIONS in taper.ts (_buildStandardGoreEdges), which run
    // along each road from the bonded tip. So the centerline stays a single
    // tangent-pinned Hermite through the user's knots — no inserted parallel
    // knots, which on steeply-angled connectors overshot into a tall hump.
    const knots: TilePoint[] = [[p0[0], p0[1]]];
    for (const m of mids) knots.push(m);
    knots.push([p3[0], p3[1]]);
    return _hermiteSplineThroughKnots(knots, 10, tanStart, tanEnd);
  }

  // SAME-DESTINATION (U-loop / service road) — both tips bond onto the
  // SAME road, so the curve must keep its perpendicular bow (a U-turn);
  // tangent-pinning both ends to the one shared road would flatten it.
  // p1 / p2 are the user's intermediate clicks verbatim (v126.13); a
  // bare 2-click U-loop falls back to the influence-tangent control
  // points (v126.12) since there are no mids to bow through.
  let p1: TilePoint;
  let p2: TilePoint;
  if (out.length >= 3) {
    const userP1 = out[1];
    const userP2 = out[out.length - 2];
    p1 = [userP1[0], userP1[1]];
    p2 = [userP2[0], userP2[1]];
  } else {
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
  return [p0, ...samples, p3];
}

/** Rewrite both endpoints of a draft road to bond onto nearby baseline
 *  roads. Composes the three sub-stages:
 *
 *    1. Detect bonds at both endpoints (`_detectBondStandard`).
 *    2. Branch on which ends bonded:
 *         BOTH    → `_smoothBothEndsBondedStandard` (H899 tangential
 *                   Hermite for different dests / Bezier U-loop for same).
 *         ONE     → `_smoothOneEndBondedStandard` (v126.10 single-end algo).
 *         NEITHER → return polyline unchanged.
 *
 *  Same defensive guards as the monolith: short polyline (<2 pts) or
 *  empty majorRoads → passthrough.
 *
 *  Originally ported 1:1 from monolith `_weMergeBondEndpoints_standard`
 *  (L13346-L14172); the both-ends centerline was redesigned in H899
 *  (clamped-tangent Hermite + downstream gore taper, see
 *  `_smoothBothEndsBondedStandard`).
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
  // H902: bind each endpoint to the lane the user clicked (opts.start/endTarget).
  const startBond = _detectBondStandard(0, out, mergeAlign, deps, rampZ, opts.startTarget);
  const endBond = _detectBondStandard(out.length - 1, out, mergeAlign, deps, rampZ, opts.endTarget);

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
