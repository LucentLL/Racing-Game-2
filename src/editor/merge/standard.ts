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
 * SCAFFOLD status: type contract + entry point stubbed with TODO line refs.
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

/** Host bindings — the bond detector needs access to candidate roads. */
export interface MergeDeps {
  /** Source-defined majorRoads array. Bond detection scans all of these
   *  except the road being edited itself. */
  getMajorRoads(): BondTargetRoad[];
}

/** Rewrite both endpoints of a draft road to bond onto nearby baseline
 *  roads, using a single coordinated cubic Bezier through the interior.
 *  Returns a new pts array (input is not mutated).
 *  TODO(E34-followup): port from L13346-14215. */
export function _weMergeBondEndpoints_standard(
  _opts: StandardMergeOpts,
  _deps: MergeDeps,
): TilePoint[] {
  // TODO: L13346-14215.
  //   1. Detect bond at start endpoint (SEARCH_R=16 scan over baseline
  //      roads), pull projection + destination tangent.
  //   2. Same for end endpoint.
  //   3. If both bond: build single cubic Bezier with tangent constraints
  //      at both ends (the v8.99.126.12 fix). Sample it to replace
  //      the relevant pts prefix + suffix.
  //   4. If only one bonds: single-end smoothing (no coordination needed).
  //   5. If neither: return pts unchanged (caller falls back to user clicks).
  return _opts.pts.map(p => [p[0], p[1]]);
}
