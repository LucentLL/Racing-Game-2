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
 * Pre-v126.53 these two types produced identical geometry; the v126.53
 * split introduced the destination-side branch above. mergeType is the
 * 4th arg so the function can pick the right termination geometry
 * without needing two separate top-level entry points.
 *
 * Ported from monolith L14701-15025.
 *
 * SCAFFOLD status: type contract + entry point stubbed with TODO line refs.
 */

import type { TilePoint } from '../stamp';
import type { MergeDeps } from './standard';

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

/** Rewrite a draft road's endpoints for a Stop or Yield termination.
 *  Returns a new pts array. TODO(E34-followup): port from L14701-15025. */
export function _weMergeBondEndpoints_stop(
  _opts: StopMergeOpts,
  _deps: MergeDeps,
): TilePoint[] {
  // TODO: L14701-15025.
  //   1. isYield = (mergeType === 3); any other value treated as Stop.
  //   2. _detectBondStop at each endpoint (same algorithm as cloverleaf's
  //      _detectBondCL but extracts the perpendicular toward-click-side
  //      vector and offsetMag for placing bondedTip on outer-edge stripe).
  //   3. Source side: build decel-lane taper extending back along parent
  //      highway. Same for both Stop and Yield.
  //   4. Destination side: branch on isYield:
  //        Stop  → perpendicular landing at cross-road outer edge.
  //        Yield → parallel-then-taper extension in cross-road's
  //                direction-of-travel (the v126.53 addition).
  //   5. Concatenate the source taper + interior + destination
  //      termination.
  return _opts.pts.map(p => [p[0], p[1]]);
}
