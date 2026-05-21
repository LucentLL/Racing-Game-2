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
import { _sweepArc } from './curves';

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

/** Result of an arc-construction attempt. `null` means the geometry
 *  is degenerate (parallel destination tangents, R out of bounds, etc.)
 *  and the caller should fall through to the next case in the 4-case
 *  arc generator. */
export type ArcAttempt = ReadonlyArray<TilePoint> | null;

/** Reasonable-loop-radius bounds. Both arc constructors (diameter mode
 *  and the v126.38 4-case generator) sanity-check R against these
 *  before sampling. Outside the band the result is either a
 *  microscopic curl that looks like a kink (R < 1 tile) or a giant
 *  arc that overshoots the entire viewport (R >= 200 tiles), so we
 *  fall through to the next case instead of producing visual garbage. */
export const CLOVERLEAF_R_MIN = 1.0;
export const CLOVERLEAF_R_MAX = 200.0;

/** v8.99.126.39 diameter-driven tangential arc.
 *
 *  When loopDiameter > 0 AND both ends bond, place the loop arc so
 *  its circular asphalt sits TANGENTIALLY to both lane outer-stripes
 *  at the user-specified diameter. The user's exact along-road click
 *  positions are intentionally discarded; the clicks only tell the
 *  function which side of which road the loop sits on. Result: an
 *  arc whose shape depends only on diameter + bond geometry, not on
 *  where exactly on each road the user happened to tap.
 *
 *  GEOMETRY (per the monolith comment block at L14361-L14376):
 *    R   = loopDiameter / 2
 *    L1  = lane-1 outer-stripe line: parallel to D1, offset offsetMag1
 *          from road1 centerline on the click side (= sUV1 direction).
 *    L1' = parallel to D1, offset (offsetMag1 + R) — the locus of
 *          centers of circles of radius R tangent to L1 on the click
 *          side. For US RHD this is the right of D1, which is where
 *          the loop curls.
 *    L2', L2 similarly for the destination.
 *    C   = unique intersection of L1' and L2' (for non-parallel D1,D2).
 *    p0  = foot of perpendicular from C onto L1 = C − R·sUV1.
 *    pE  = C − R·sUV2.
 *
 *  LINEAR SYSTEM. C is the unique point with
 *      (C − A) parallel to D1  AND  (C − B) parallel to D2
 *  where A is the L1'-anchor (proj1 + (off1 + R)·sUV1) and B is the
 *  L2'-anchor. Equivalent dual form using left-perpendiculars:
 *      leftPerp(D1) · (C − A) = 0
 *      leftPerp(D2) · (C − B) = 0
 *  That's a 2×2 linear system in (C_x, C_y) with determinant
 *  cross(D1, D2). The closed-form Cramer solution at L14399-L14406
 *  short-circuits to "no arc" when `|det| <= 0.001` — i.e. when the
 *  two destination tangents are parallel (no unique intersection).
 *
 *  REASONABLE-R GUARD. Even though R = loopDiameter/2 is user-set, we
 *  sanity-check `R > 1 && R < 200` because the diameter input field
 *  isn't clamped at the UI layer and pathological values would
 *  produce visual garbage. Outside the band → fall through to the
 *  v126.38 4-case generator at the caller.
 *
 *  Returns the 25-point arc polyline (including both endpoints — see
 *  `_sweepArc`) on success, or `null` on any failure mode (parallel
 *  destinations, R out of band, R = 0). The caller threads the result
 *  through the 4-case fallback: a null here means "diameter mode
 *  declined — try the v126.38 generator next."
 *
 *  Ported 1:1 from monolith L14377-L14414 (the `_useDiamMode` block
 *  inside `_weMergeBondEndpoints_cloverleaf`).
 */
export function _buildDiameterArc(
  startBond: CloverleafBondInfo,
  endBond: CloverleafBondInfo,
  loopDiameter: number,
): ArcAttempt {
  if (!(loopDiameter > 0)) return null;
  const R = loopDiameter * 0.5;
  const D1 = startBond.direction;
  const D2 = endBond.direction;
  const sUV1 = startBond.sUV;
  const sUV2 = endBond.sUV;
  const proj1 = startBond.proj;
  const proj2 = endBond.proj;
  const off1 = startBond.offsetMag;
  const off2 = endBond.offsetMag;

  // L1'-anchor (proj1 + (off1 + R)·sUV1) and L2'-anchor.
  const A_x = proj1[0] + (off1 + R) * sUV1[0];
  const A_y = proj1[1] + (off1 + R) * sUV1[1];
  const B_x = proj2[0] + (off2 + R) * sUV2[0];
  const B_y = proj2[1] + (off2 + R) * sUV2[1];

  // 2x2 linear system det = D1 × D2. Near-zero det → parallel
  // destination tangents → no unique intersection → fail.
  const det = D1[0] * D2[1] - D1[1] * D2[0];
  if (Math.abs(det) <= 0.001) return null;

  // p1 := leftPerp(D1), p2 := leftPerp(D2).
  const p1x = -D1[1];
  const p1y = D1[0];
  const p2x = -D2[1];
  const p2y = D2[0];
  const p1A = p1x * A_x + p1y * A_y;
  const p2B = p2x * B_x + p2y * B_y;
  const C_x = (p1A * p2y - p2B * p1y) / det;
  const C_y = (p1x * p2B - p2x * p1A) / det;

  // Reasonable-R sanity check — the diameter input field isn't UI-
  // clamped so pathological values land here.
  if (!(R > CLOVERLEAF_R_MIN && R < CLOVERLEAF_R_MAX)) return null;

  const p0: TilePoint = [C_x - R * sUV1[0], C_y - R * sUV1[1]];
  const pE: TilePoint = [C_x - R * sUV2[0], C_y - R * sUV2[1]];
  return _sweepArc(p0, pE, [C_x, C_y], R);
}

/** v8.99.126.38 4-case fallback arc generator — runs when diameter
 *  mode declines (loopDiameter = 0, parallel destinations, R out of
 *  band, or only one end bonded). Uses bondedTip / user-click positions
 *  to build the loop arc; the result is determined by which end(s)
 *  bond.
 *
 *  Cases:
 *
 *    A / B (start bonded). Tangent constraint at `p0` (= bondedTip
 *      of startBond), endpoint constraint at `pE` (= bondedTip of
 *      endBond when both bond, else user's last click). Replaces the
 *      v126.37 dual-tangent least-squares formula, which minimized
 *      residual over two overdetermined constraints but satisfied
 *      neither exactly — so for inconsistent click pairs (e.g. user
 *      clicks (-15,-15) on a horizontal road AND (-2,-8) on a
 *      vertical) the v126.37 arc end landed at C + R·(cos θ_B,
 *      sin θ_B) ≠ pE, producing the "loop doesn't reach the third
 *      click" bug. Tangent-endpoint guarantees the arc reaches pE
 *      EXACTLY.
 *
 *      Closed form: R = |u|² / (2·sRP·u) with u = pE − p0 (from
 *      |C − pE|² = R² and C = p0 + R·sRP, where sRP = leftPerp of
 *      startBond.direction). Valid (R > 0, visual CW arc) iff
 *      sRP·u > 0 — i.e., pE sits on the right of sourceDir, which is
 *      the natural side for a US-RHD cloverleaf loop. dotSrPu ≤ 0.0001
 *      → null (pE is on the wrong side or collinear; can't fit a CW
 *      arc).
 *
 *      TRADE-OFF: the arc's tangent at pE is whatever the geometry
 *      produces, NOT guaranteed to match endBond.destTangent. For
 *      perpendicular roads with reasonable click positions this
 *      still aligns naturally; for skewed clicks the gore angle
 *      slightly diverges from destDir. Acceptable trade vs not
 *      reaching pE at all.
 *
 *    C (end only). Symmetric to A/B with the roles of p0 / pE
 *      swapped: tangent at pE (= endBond.bondedTip), endpoint at p0
 *      (= user's first click). R = |v|² / (2·eRP·v) with
 *      v = p0 − pE, eRP = leftPerp of endBond.direction.
 *
 *    D (neither). startBond AND endBond both null. Returns null;
 *      caller falls back to the user's original click polyline
 *      unmodified.
 *
 *  R-BAND GUARD. Same (CLOVERLEAF_R_MIN, CLOVERLEAF_R_MAX) sanity
 *  check as `_buildDiameterArc` — out-of-band → null. The radius
 *  comes from the constraint geometry here (not user input), so
 *  out-of-band typically means the user's clicks degenerated to a
 *  near-straight line or a near-zero chord; falling through to the
 *  user clicks unmodified is the cleanest recovery.
 *
 *  Returns the 25-point arc polyline (from `_sweepArc`) on success,
 *  or null on any failure mode. `out` is the current polyline (after
 *  endpoint snapping by the caller) — used to read the user's last /
 *  first click when one end of the bond is null.
 *
 *  Ported 1:1 from monolith L14418-L14471 (the `if(!arcPts)` block
 *  inside `_weMergeBondEndpoints_cloverleaf`).
 */
export function _build4CaseFallbackArc(
  startBond: CloverleafBondInfo | null,
  endBond: CloverleafBondInfo | null,
  out: ReadonlyArray<TilePoint>,
): ArcAttempt {
  // Case D — neither bonded. Caller falls back to user clicks.
  if (!startBond && !endBond) return null;

  const p0: TilePoint = startBond
    ? [startBond.bondedTip[0], startBond.bondedTip[1]]
    : [out[0][0], out[0][1]];
  const pE: TilePoint = endBond
    ? [endBond.bondedTip[0], endBond.bondedTip[1]]
    : [out[out.length - 1][0], out[out.length - 1][1]];

  if (startBond) {
    // Cases A & B — start bonded. Tangent at p0, endpoint at pE.
    const sd = startBond.direction;
    const sRP: [number, number] = [-sd[1], sd[0]];
    const ux = pE[0] - p0[0];
    const uy = pE[1] - p0[1];
    const dotSrPu = sRP[0] * ux + sRP[1] * uy;
    if (dotSrPu > 0.0001) {
      const R = (ux * ux + uy * uy) / (2 * dotSrPu);
      if (R > CLOVERLEAF_R_MIN && R < CLOVERLEAF_R_MAX) {
        const C: TilePoint = [p0[0] + R * sRP[0], p0[1] + R * sRP[1]];
        return _sweepArc(p0, pE, C, R);
      }
    }
    return null;
  }

  // Case C — end only (startBond null, endBond non-null per the Case
  // D early return above).
  if (endBond) {
    const ed = endBond.direction;
    const eRP: [number, number] = [-ed[1], ed[0]];
    const vx = p0[0] - pE[0];
    const vy = p0[1] - pE[1];
    const dotErPv = eRP[0] * vx + eRP[1] * vy;
    if (dotErPv > 0.0001) {
      const R = (vx * vx + vy * vy) / (2 * dotErPv);
      if (R > CLOVERLEAF_R_MIN && R < CLOVERLEAF_R_MAX) {
        const C: TilePoint = [pE[0] + R * eRP[0], pE[1] + R * eRP[1]];
        return _sweepArc(p0, pE, C, R);
      }
    }
  }
  return null;
}

/** Rewrite a draft road's endpoints to form a smooth cloverleaf-style
 *  loop between two baseline roads. Returns a new pts array.
 *  TODO(E34-followup): port from L14216-14550 — bond detection (H341)
 *  and the v126.39 diameter-mode arc (H343) now wired in; the v126.38
 *  4-case arc generator + parallel/taper extensions follow. */
export function _weMergeBondEndpoints_cloverleaf(
  _opts: CloverleafMergeOpts,
  _deps: MergeDeps,
): TilePoint[] {
  // TODO: L14216-14550.
  //   1. _detectBondCL at each endpoint (DONE — H341).
  //   2. v126.39 diameter-mode arc (DONE — H343).
  //   3. v126.38 4-case fallback arc generator (DONE — H344).
  //   4. Build parallel + taper extensions (5+5 each side).
  //   5. Concatenate: startExt + parallelStart + taperStart + arc +
  //                   taperEnd + parallelEnd + endExt.
  return _opts.pts.map(p => [p[0], p[1]]);
}

/** Re-export so cloverleaf callers don't need to depend on standard.ts
 *  for shared bond-detection types. */
export type { BondTargetRoad, MergeDeps };
