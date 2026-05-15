/**
 * World Editor — CLOVERLEAF bond-endpoint smoothing.
 *
 * mergeType=1. Produces a smooth circular-arc loop ramp between two
 * baseline roads, with parallel-then-taper extensions at each end so
 * the ramp visibly runs ALONGSIDE the destination roads before peeling
 * off into the loop.
 *
 * REFACTOR HISTORY (v8.99.126.38, current):
 *
 * - SEARCH_R bumped from 8 → 16 tiles. The 8-tile radius was
 *   unforgivingly tight for imprecise touches; v126.37 users saw
 *   "loop terminates wherever I tapped, not on the road I intended"
 *   because endBond fell to null and the function returned user
 *   clicks unsmoothed.
 *
 * - 4-CASE ARC GENERATION (replaces v126.37 two-case):
 *     Case A: both bonded   → tangent-tangent arc (v126.37 logic).
 *                             C = p0 + R·sRP = pE + R·eRP, R from
 *                             least-squares.
 *     Case B: only START bonded → tangent-endpoint at p0, user's last
 *                             click as pE. R = |u|²/(2·sRP·u) where
 *                             u = pE - p0. Valid (R>0, CW-visual arc)
 *                             iff sRP·u > 0 — i.e., pE is on the right
 *                             of sourceDir, the natural side for a
 *                             US-RHD cloverleaf loop.
 *     Case C: only END bonded   → symmetric to Case B with v = p0 - pE.
 *                             C = pE + R·eRP. Sweep from p0 to pE with
 *                             the same dTheta-forced-long-way logic.
 *     Case D: neither bonded → fall through to user clicks.
 *
 * - Parallel-tangent extension: 3 → 5 tiles per side. Total per-end
 *   extension is now 10 tiles (5 parallel + 5 taper).
 *
 * - mergeType=1 forces ASYM_SGN to +1 (polygon sidedness override —
 *   used by the polygon edge builder, not the bond function itself).
 *
 * KNOWN-DEFERRED (v126.38+ backlog, not regressions of E34):
 *  - "Extra stripes inside the lane" at the gore where merge edge-
 *    stripes overlap destination edge-stripes.
 *  - "True adjacent aux lane" — needs destination-side lane-count
 *    changes near the merge.
 *
 * Ported from monolith L14216-14550.
 *
 * SCAFFOLD status: type contract + entry point stubbed with TODO line refs.
 */

import type { TilePoint } from '../stamp';
import type { BondTargetRoad, MergeDeps } from './standard';

/** Per-merge inputs for cloverleaf. loopDiameter sizes the arc when
 *  both ends can't constrain R via tangent-tangent. */
export interface CloverleafMergeOpts {
  pts: TilePoint[];
  dW: number;
  mergeAlign: number;
  /** Diameter of the loop arc (tiles). Drives R when only one end
   *  bonds, or as a fallback sanity check when both bond. */
  loopDiameter: number;
}

/** SEARCH_R is documented at the module level so other merge variants
 *  reading from this convention stay consistent. v126.38 bumped from 8. */
export const CLOVERLEAF_SEARCH_R = 16;

/** Parallel-tangent + taper extension lengths (tiles, per side). */
export const CLOVERLEAF_PARALLEL_LEN = 5;
export const CLOVERLEAF_TAPER_LEN = 5;

/** Rewrite a draft road's endpoints to form a smooth cloverleaf-style
 *  loop between two baseline roads. Returns a new pts array.
 *  TODO(E34-followup): port from L14216-14550. */
export function _weMergeBondEndpoints_cloverleaf(
  _opts: CloverleafMergeOpts,
  _deps: MergeDeps,
): TilePoint[] {
  // TODO: L14216-14550.
  //   1. _detectBondCL at each endpoint (SEARCH_R=16, also extracts
  //      direction-of-travel from click side).
  //   2. Branch on which ends bonded:
  //        A: both     → tangent-tangent arc, R from least-squares
  //        B: start    → tangent-endpoint at p0, R = |u|²/(2·sRP·u)
  //        C: end      → symmetric
  //        D: neither  → return user clicks
  //   3. Build arc samples + parallel + taper extensions (5+5 each side).
  //   4. Concatenate: startExt + parallelStart + taperStart + arc +
  //                   taperEnd + parallelEnd + endExt.
  return _opts.pts.map(p => [p[0], p[1]]);
}

/** Re-export so cloverleaf callers don't need to depend on standard.ts
 *  for shared bond-detection types. */
export type { BondTargetRoad, MergeDeps };
