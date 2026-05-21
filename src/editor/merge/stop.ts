/**
 * World Editor — STOP / YIELD bond-endpoint smoothing.
 *
 * mergeType=2 (Stop) and mergeType=3 (Yield) share a single function
 * with a per-type internal branch (v8.99.126.53 split).
 *
 *   Stop (2)  → destination side terminates PERPENDICULAR at the cross-
 *               road's outer edge. No destination-side taper. Models a
 *               T-intersection where the ramp ends and the driver stops
 *               at a sign before turning onto the cross-road.
 *               (User reference: W.T. Harris Blvd exit ramp from I-485.)
 *
 *   Yield (3) → destination side has a parallel-then-taper extension
 *               that merges INTO the cross-road's flow lane. Models the
 *               typical US entrance ramp (cf. DOT MUTCD diagram with a
 *               yield sign at the merge point). The taper extends in
 *               the cross-road's direction-of-travel, so the ramp
 *               visually accelerates into adjacent traffic.
 *
 * Unrecognized mergeType values default to Stop — safer if a caller
 * forgets to pass the type, since "ends abruptly at the road" is less
 * dangerous than "merges into traffic that may not be there".
 *
 * SOURCE side (the parent highway / ramp start) is handled identically
 * for both Stop and Yield: a deceleration-lane taper extending back
 * along the parent highway, decoupled from the destination-side
 * termination.
 *
 * v8.99.126.58 CLICK-ORDER CONVENTION: the user clicks the STOP /
 * destination FIRST and the SOURCE / intake LAST. So in the input pts
 * array, pts[0] is the DESTINATION and pts[N-1] is the SOURCE. The
 * variable names below still say "Start" / "End" matching the indices
 * of the polyline; the role mapping (which side gets the perpendicular
 * landing vs. the taper) is applied in the assembly block.
 *
 * Pre-v126.53 these two types produced identical geometry; the v126.53
 * split introduced the destination-side branch above. mergeType is the
 * 4th arg so the function can pick the right termination geometry
 * without needing two separate top-level entry points.
 *
 * Ported from monolith L14701-15024.
 */

import type { TilePoint } from '../stamp';
import type { MergeDeps, BondTargetRoad } from './standard';

/** Per-merge inputs for stop/yield. mergeType drives the
 *  destination-side termination geometry. */
export interface StopMergeOpts {
  pts: TilePoint[];
  dW: number;
  mergeAlign: number;
  /** 2 = Stop, 3 = Yield. Any other value treated as Stop. */
  mergeType: 2 | 3 | number;
}

/** Same SEARCH_R convention as cloverleaf (v126.38). */
export const STOP_SEARCH_R = 16;

/** Bond detection result shape — what detectBondStop returns. */
interface BondInfo {
  endIdx: number;
  proj: [number, number];
  destTangent: [number, number];
  direction: [number, number];
  sUV: [number, number];
  offsetMag: number;
  destHalfW: number;
  origTip: [number, number];
  road: BondTargetRoad;
}

/** Rewrite a draft road's endpoints for a Stop or Yield termination.
 *  Returns a new pts array (input is not mutated). Ported 1:1 from
 *  monolith _weMergeBondEndpoints_stop (L14701-15024). */
export function _weMergeBondEndpoints_stop(
  opts: StopMergeOpts,
  deps: MergeDeps,
): TilePoint[] {
  const mergeType = opts.mergeType | 0;
  const isYield = mergeType === 3;
  const mergeAlign = opts.mergeAlign || 4;
  const pts = opts.pts;
  const dW = opts.dW;
  if (!Array.isArray(pts) || pts.length < 2) return pts;
  const majorRoads = deps.getMajorRoads();
  if (!majorRoads || !majorRoads.length) return pts;
  const SEARCH_R = STOP_SEARCH_R;
  const SEARCH_R2 = SEARCH_R * SEARCH_R;
  const out: TilePoint[] = pts.map((p) => [p[0], p[1]] as TilePoint);

  // Bond detection — same algorithm as cloverleaf's _detectBondCL.
  // Returns projection, dest tangent, signed direction-of-travel based
  // on click side (US RHD), sUV (perpendicular toward click side), and
  // offsetMag for placing bondedTip on outer-edge stripe.
  const detectBondStop = (endIdx: number): BondInfo | null => {
    const ex = out[endIdx][0];
    const ey = out[endIdx][1];
    let best: {
      d2: number;
      road: BondTargetRoad | null;
      segI: number;
      projX: number;
      projY: number;
    } = { d2: SEARCH_R2, road: null, segI: -1, projX: 0, projY: 0 };
    for (const r of majorRoads) {
      if (!r.pts || r.pts.length < 2) continue;
      // Identity-skip: the road being edited shows up in majorRoads too;
      // its pts may share array identity with the input. Defensive
      // coord-match skip handles the deep-copy case where identities
      // diverge but values are still the same polyline.
      if (r.pts === (pts as unknown as number[][])) continue;
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
        t = Math.max(0, Math.min(1, t));
        const px = ax + dx * t;
        const py = ay + dy * t;
        const ddx = ex - px;
        const ddy = ey - py;
        const d2 = ddx * ddx + ddy * ddy;
        if (d2 < best.d2) {
          best = { d2, road: r, segI: i, projX: px, projY: py };
        }
      }
    }
    if (!best.road) return null;
    const r = best.road;
    const i = best.segI;
    const ax = r.pts[i][0];
    const ay = r.pts[i][1];
    const bx = r.pts[i + 1][0];
    const by = r.pts[i + 1][1];
    let tdx = bx - ax;
    let tdy = by - ay;
    const tlen = Math.hypot(tdx, tdy) || 1;
    tdx /= tlen;
    tdy /= tlen;
    const dProf = deps.getRoadProfile ? deps.getRoadProfile(r) : null;
    const destHalfW = dProf ? dProf.totalW * 0.5 : r.w * 0.425;
    // STRIPE_INSET: 1.7 / TILE (TILE=18) — outer-edge stripe sits 1.7
    // canvas px inside the asphalt edge; offsetMag puts bondedTip
    // exactly on that stripe (used by other variants — Stop only reads
    // destHalfW directly, but keeping the field on BondInfo preserves
    // the contract).
    const STRIPE_INSET = 1.7 / 18;
    const offsetMag = Math.max(0, destHalfW - STRIPE_INSET);
    // Click side determines:
    //   - sUV: perpendicular pointing TOWARD click side (used for
    //     bondedTip placement on outer-edge stripe).
    //   - direction: signed unit tangent — for US RHD, click on right of
    //     dest tangent means direction-of-travel = +tangent. The source
    //     extension goes BACKWARD along this direction (decel lane apex
    //     extends back along the highway).
    const perpSigned = (ex - best.projX) * -tdy + (ey - best.projY) * tdx;
    let sUVx: number;
    let sUVy: number;
    let dirSign: number;
    if (perpSigned >= 0) {
      sUVx = -tdy;
      sUVy = tdx;
      dirSign = +1;
    } else {
      sUVx = tdy;
      sUVy = -tdx;
      dirSign = -1;
    }
    return {
      endIdx,
      proj: [best.projX, best.projY],
      destTangent: [tdx, tdy],
      direction: [dirSign * tdx, dirSign * tdy],
      sUV: [sUVx, sUVy],
      offsetMag,
      destHalfW,
      origTip: [ex, ey],
      road: r,
    };
  };

  const startBond = detectBondStop(0);
  const endBond = detectBondStop(out.length - 1);

  // v8.99.126.57: honor mergeAlign L (2) / R (3) to OVERRIDE the click-side
  // sUV that detectBondStop computed via perpSigned. For Stop/Yield:
  //   2 = L → bondedTip on parent road's LEFT side (relative to its
  //           direction-of-travel = its polyline winding direction)
  //   3 = R → bondedTip on parent road's RIGHT side
  //   1 = C → keep click-side (no meaningful "center" for terminus geometry)
  //   4 = Auto → keep click-side (user clicks on the side they want)
  // L-perpendicular to (tdx,tdy) is (-tdy, tdx); R-perpendicular is (tdy, -tdx).
  // Mutate sUV in place so all downstream code uses the corrected side.
  // Pre-v126.57 the R button was visually selected but had no effect.
  const applyAlignOverride = (bond: BondInfo | null): void => {
    if (!bond) return;
    if (mergeAlign === 2) {
      // L → force ramp to LEFT side of direction-of-travel.
      bond.sUV[0] = bond.destTangent[1];
      bond.sUV[1] = -bond.destTangent[0];
    } else if (mergeAlign === 3) {
      // R → force ramp to RIGHT side of direction-of-travel.
      bond.sUV[0] = -bond.destTangent[1];
      bond.sUV[1] = bond.destTangent[0];
    }
    // 1 (C) and 4 (Auto) leave sUV as the click-side default.
  };
  applyAlignOverride(startBond);
  applyAlignOverride(endBond);

  // Compute terminus and bondedTip positions.
  const rampHalfW = dW * 0.425;
  // v8.99.126.57: bondedTip and terminus are placed so the ramp's INNER
  // EDGE meets the parent road's OUTER EDGE — they sit ALONGSIDE each
  // other, NOT overlapping. Offset = destHalfW + rampHalfW.
  //
  // History of this offset across versions (load-bearing for understanding
  // why this is NOT offsetMag or destHalfW - laneW/2):
  //   v126.51: offsetMag + halfLane          — wrong (ramp covered lanes)
  //   v126.52: destHalfW + rampHalfW + 0.05  — almost-right, tiny gap
  //   v126.55: same as v126.52, source taper removed
  //   v126.56: destHalfW - laneW/2           — pushed INTO parent lane (overlap)
  //   v126.57: destHalfW + rampHalfW         — alongside, no overlap
  //     [USER: "Why is the additional lane INSIDE of an existing lane?"]
  let bondedTipStart: [number, number] | null = null;
  if (startBond) {
    const sb = startBond;
    const bondOff = sb.destHalfW + rampHalfW;
    bondedTipStart = [
      sb.proj[0] + sb.sUV[0] * bondOff,
      sb.proj[1] + sb.sUV[1] * bondOff,
    ];
  }
  let terminusEnd: [number, number] | null = null;
  if (endBond) {
    const eb = endBond;
    const termOff = eb.destHalfW + rampHalfW;
    terminusEnd = [
      eb.proj[0] + eb.sUV[0] * termOff,
      eb.proj[1] + eb.sUV[1] * termOff,
    ];
  }

  // Path reference: destination (start) → source (end). Used by the
  // source-taper direction-sign calc (and by the Yield destination-side
  // taper, which mirrors it). Recomputed at the assembly sites for
  // readability.
  const refTipEnd: [number, number] =
    endBond && terminusEnd ? terminusEnd : (out[out.length - 1] as [number, number]);
  const refTipStart: [number, number] =
    startBond && bondedTipStart ? bondedTipStart : (out[0] as [number, number]);

  // v8.99.126.58: CONVENTION CLARIFICATION (effective swap from v126.57).
  // The user's annotated reference shows: for a Stop merge, the user
  // CLICKS the destination/stop-bar FIRST, then drags BACKWARD along
  // the ramp to the source/intake. So:
  //   pts[0]    = DESTINATION (perpendicular stop, no extra geometry
  //               past terminus)
  //   pts[N-1]  = SOURCE      (intake taper extends along source road
  //               in vehicle-approach direction)
  // Variable naming kept ("Start"/"End") because downstream code already
  // uses these tokens; only assembly order in `result` reflects the swap.
  const result: TilePoint[] = [];

  // pts[0] = DESTINATION: perpendicular approach + terminus FIRST.
  if (startBond && bondedTipStart) {
    const sb = startBond;
    const approachLen = 5.0;
    // approachApex is 5 tiles back from bondedTipStart along sUV (same
    // side the ramp comes from), so the FIRST segment of the polyline
    // lands perpendicular to the destination road.
    const approachApex: [number, number] = [
      bondedTipStart[0] + sb.sUV[0] * approachLen,
      bondedTipStart[1] + sb.sUV[1] * approachLen,
    ];
    result.push(bondedTipStart, approachApex);
  } else {
    result.push(out[0]);
  }

  // Interior user clicks (preserved verbatim).
  for (let i = 1; i < out.length - 1; i++) {
    result.push(out[i]);
  }

  // pts[N-1] = SOURCE: intake TAPER. The source taper sits alongside the
  // source road, extending in the direction OPPOSITE the path-from-source
  // -to-destination (vehicles approach from upstream and slide into the
  // taper before peeling off into the ramp).
  if (endBond && terminusEnd) {
    const eb = endBond;
    const approachLen = 5.0;
    // Approach apex on source side too — keeps the last interior click
    // from creating a wild bend right before the taper.
    const approachApex: [number, number] = [
      terminusEnd[0] + eb.sUV[0] * approachLen,
      terminusEnd[1] + eb.sUV[1] * approachLen,
    ];
    const lastInterior = result[result.length - 1];
    const dApproach = Math.hypot(
      lastInterior[0] - approachApex[0],
      lastInterior[1] - approachApex[1],
    );
    if (dApproach > 1.0) result.push(approachApex);
    result.push(terminusEnd);

    // SOURCE TAPER at endBond. Direction along source road tangent,
    // OPPOSITE the path direction from destination to source (so the
    // taper extends BEHIND the bondedTip relative to source-road
    // traffic flow).
    const eTan = eb.destTangent;
    // path from destination (start) → source (end)
    const yDx = refTipEnd[0] - refTipStart[0];
    const yDy = refTipEnd[1] - refTipStart[1];
    const eDot = eTan[0] * yDx + eTan[1] * yDy;
    // Same direction as path = where vehicles approach FROM, which is
    // where the taper extends to.
    const eSgn = eDot >= 0 ? +1 : -1;
    const eDx = eSgn * eTan[0];
    const eDy = eSgn * eTan[1];
    const taperLen = 5.0;
    const extLen = taperLen + 5.0; // 10 tiles total
    const taperEndS: [number, number] = [
      terminusEnd[0] + eDx * taperLen,
      terminusEnd[1] + eDy * taperLen,
    ];
    const extS: [number, number] = [
      terminusEnd[0] + eDx * extLen,
      terminusEnd[1] + eDy * extLen,
    ];
    result.push(taperEndS, extS);

    if (isYield && startBond && bondedTipStart) {
      // For YIELD: also add a destination-side merge taper (extending in
      // destination-road's flow direction past the perpendicular T).
      // Real Yield-style entrance ramps merge INTO traffic on the
      // destination, not stop perpendicular. Since we're assembling
      // destination → source, the yield taper PREPENDS to the result
      // (it should appear FIRST in time order, before the destination
      // terminus).
      const sTan = startBond.destTangent;
      // path destination → source negated (so the taper extends FORWARD
      // along destination-road's flow, away from the ramp).
      const sDot = sTan[0] * -yDx + sTan[1] * -yDy;
      const sSgn = sDot >= 0 ? +1 : -1;
      const sDx = sSgn * sTan[0];
      const sDy = sSgn * sTan[1];
      const taperEndYD: [number, number] = [
        bondedTipStart[0] + sDx * 5.0,
        bondedTipStart[1] + sDy * 5.0,
      ];
      const extYD: [number, number] = [
        bondedTipStart[0] + sDx * 10.0,
        bondedTipStart[1] + sDy * 10.0,
      ];
      result.unshift(extYD, taperEndYD);
    }
  } else {
    result.push(out[out.length - 1]);
  }

  return result;
}
