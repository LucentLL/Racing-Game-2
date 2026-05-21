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
 * SCAFFOLD status: bond detection ported (H338); the smoothing pipeline
 * + tip placement orchestrator still TODO at the entry function.
 */

import type { TilePoint } from '../stamp';

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

/** Rewrite both endpoints of a draft road to bond onto nearby baseline
 *  roads, using a single coordinated cubic Bezier through the interior.
 *  Returns a new pts array (input is not mutated).
 *  TODO(E34-followup): port from L13346-14215 — the bond detection
 *  helper `_detectBondStandard` above is the first piece; the
 *  smoothing pipeline (both-bonded coordinated Bezier, one-bonded
 *  single-end Bezier, neither-bonded passthrough) follows. */
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
  //   4. If only one bonds: single-end smoothing (no coordination needed).
  //   5. If neither: return pts unchanged (caller falls back to user clicks).
  return _opts.pts.map((p) => [p[0], p[1]]);
}
