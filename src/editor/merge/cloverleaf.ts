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

/** Cloverleaf bond record. Richer than the standard branch's
 *  StandardBondInfo because the loop-arc constructor downstream needs
 *  the destination's UNIT TANGENT (`destTangent`), the SIGNED DIRECTION
 *  OF TRAVEL through the merge (`direction` — destTangent flipped to
 *  point AWAY from the gore on the click side), the raw projection
 *  point on the destination centerline (`proj`), the perpendicular
 *  unit vector toward the click side (`sUV` — drives the lane-line
 *  construction at v8.99.126.39), and the magnitude of the bondedTip
 *  offset from the centerline (`offsetMag`).
 *
 *  These are pre-derived once during detection so the arc / parallel /
 *  taper passes don't each re-do tangent normalization. */
export interface CloverleafBondInfo {
  endIdx: number;
  bondedTip: TilePoint;
  destTangent: [number, number];
  direction: [number, number];
  proj: [number, number];
  origTip: TilePoint;
  road: BondTargetRoad;
  /** Right-perpendicular unit vector of `direction`. Used by the
   *  diameter-driven tangential placement at v8.99.126.39 to build
   *  the inner / outer lane lines. Equals `[alignDx, alignDy]` from
   *  the detection internals — same perpendicular the bondedTip was
   *  offset along. */
  sUV: [number, number];
  /** Magnitude of the bondedTip offset off the centerline. The arc
   *  builder uses this to size the loop's far-edge offset (the loop's
   *  inner / outer asphalt boundaries flare to / from this offset on
   *  each side). */
  offsetMag: number;
}

/** Cloverleaf-specific bond detector. Same nearest-segment scan as
 *  `_detectBondStandard` (with self-skip three ways and the v126.38
 *  16-tile radius), but the alignment branch is COLLAPSED — cloverleaf
 *  always uses the v8.99.126.23 click-bonded path, and the bondedTip
 *  always sits on the destination's outer-edge stripe (`destHalfW −
 *  1.7/TILE`).
 *
 *  WHY THE COLLAPSE. Cloverleaf has a single semantic mode — connect
 *  the loop ramp to the destination's outer asphalt. The C / L / R
 *  alignment options that drive the standard branch's lane-snap have
 *  no analog for a loop ramp (the loop's interior tangent is set by
 *  curvature, not by which lane of the destination it lands in). So
 *  rather than re-running the standard branch's alignment dispatcher
 *  and ignoring three of the four results, cloverleaf hard-wires the
 *  click-bonded behavior — simpler, faster, and one less place to keep
 *  in sync when alignment semantics change.
 *
 *  EXTRA RETURN FIELDS vs StandardBondInfo:
 *    - direction:  destTangent flipped to point AWAY from the gore on
 *                  the click side. The loop arc's signed-traversal
 *                  direction (start → end) needs this to disambiguate
 *                  arc winding (CW vs CCW).
 *    - proj:       raw projection point on the destination centerline.
 *                  bondedTip = proj + sUV*offsetMag; the arc builder
 *                  re-uses `proj` for the loop's edge-line construction
 *                  at v8.99.126.39.
 *    - sUV:        right-perpendicular unit vector of `direction`.
 *                  Equals `[alignDx, alignDy]` from detection — same
 *                  perpendicular the bondedTip was offset along.
 *    - offsetMag:  scalar offset distance from centerline to bondedTip.
 *                  Lets the loop arc size its far-edge offsets without
 *                  re-deriving them.
 *
 *  Returns `null` when no candidate sits within CLOVERLEAF_SEARCH_R
 *  tiles, OR when the click is exactly on the destination centerline
 *  (perpSigned === 0 → no direction-of-travel signal, can't build a
 *  loop ramp without an offset side). In the on-centerline case the
 *  monolith leaves alignDx/alignDy at zero so bondedTip sits AT
 *  best.proj — practically harmless since the loop arc downstream
 *  falls through to "neither bonded" (Case D) and returns user clicks
 *  unsmoothed. The port preserves that exact behavior — a non-null
 *  return with zero direction-perp.
 *
 *  Ported 1:1 from monolith `_detectBondCL` (nested helper at L14265-
 *  L14326 inside `_weMergeBondEndpoints_cloverleaf`). Takes the draft
 *  polyline as an explicit parameter since the standalone export can't
 *  capture it from a parent's scope.
 */
export function _detectBondCL(
  endIdx: number,
  draftPts: ReadonlyArray<TilePoint>,
  deps: MergeDeps,
): CloverleafBondInfo | null {
  const majorRoads = deps.getMajorRoads();
  if (!majorRoads || !majorRoads.length) return null;
  const pts = draftPts;
  if (endIdx < 0 || endIdx >= pts.length) return null;
  const ex = pts[endIdx][0];
  const ey = pts[endIdx][1];
  const SEARCH_R2 = CLOVERLEAF_SEARCH_R * CLOVERLEAF_SEARCH_R;
  let bestD2 = SEARCH_R2;
  let bestRoad: BondTargetRoad | null = null;
  let bestSegI = -1;
  let bestProjX = 0;
  let bestProjY = 0;

  for (const r of majorRoads) {
    if (!r.pts || r.pts.length < 2) continue;
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

  const dProf = deps.getRoadProfile ? deps.getRoadProfile(r) : null;
  const destHalfW = dProf ? dProf.totalW * 0.5 : r.w * 0.425;
  const STRIPE_INSET = 1.7 / 18;
  const offsetMag = Math.max(0, destHalfW - STRIPE_INSET);

  // Click-bonded direction. perpSigned > 0 → click is on +perp side
  // (rotate destTangent 90° CCW); < 0 → −perp side. perpSigned === 0
  // is preserved by the monolith — alignDx/alignDy stay zero so the
  // returned bondedTip sits at the centerline projection. The arc
  // builder downstream falls through to "neither bonded" in that case,
  // matching v126.23 semantics.
  const perpSigned = (ex - bestProjX) * -tdy + (ey - bestProjY) * tdx;
  let alignDx = 0;
  let alignDy = 0;
  if (perpSigned > 0) {
    alignDx = -tdy;
    alignDy = tdx;
  } else if (perpSigned < 0) {
    alignDx = tdy;
    alignDy = -tdx;
  }
  // Signed direction-of-travel through the merge. perpSigned >= 0 →
  // destTangent direction; negative → flip. (perpSigned === 0 maps to
  // +1 because >= 0 — same as monolith.)
  const dirSign: 1 | -1 = perpSigned >= 0 ? 1 : -1;

  return {
    endIdx,
    bondedTip: [bestProjX + alignDx * offsetMag, bestProjY + alignDy * offsetMag],
    destTangent: [tdx, tdy],
    direction: [dirSign * tdx, dirSign * tdy],
    proj: [bestProjX, bestProjY],
    origTip: [ex, ey],
    road: bestRoad,
    sUV: [alignDx, alignDy],
    offsetMag,
  };
}

/** Rewrite a draft road's endpoints to form a smooth cloverleaf-style
 *  loop between two baseline roads. Returns a new pts array.
 *  TODO(E34-followup): port from L14216-14550 — bond detection now
 *  wired in (H341); the 4-case arc generator + parallel/taper
 *  extensions follow. */
export function _weMergeBondEndpoints_cloverleaf(
  _opts: CloverleafMergeOpts,
  _deps: MergeDeps,
): TilePoint[] {
  // TODO: L14216-14550.
  //   1. _detectBondCL at each endpoint (DONE — H341).
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
