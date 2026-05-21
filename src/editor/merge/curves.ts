/**
 * World Editor — merge-curve sampling primitives.
 *
 * Pure geometry utilities the standard / cloverleaf bond endpoint
 * smoothers compose. Pulled into its own module so the merge ports
 * (`_weMergeBondEndpoints_standard`, `_cloverleaf`, `_stop`) and any
 * future merge variants (Diamond, SPDI, DDI, etc.) can import the
 * same primitives without each re-introducing its own copy.
 *
 * No runtime deps: everything here is point-and-number arithmetic.
 */

import type { TilePoint } from '../stamp';

/** Sample a cubic Bezier defined by `p0..p3` and return `N` intermediate
 *  points, uniformly spaced in `t = 1/(N+1) … N/(N+1)`. Endpoints `p0`
 *  and `p3` are intentionally NOT included — callers concatenate them
 *  themselves around the returned interior samples so they can decide
 *  whether the curve replaces or augments existing polyline vertices.
 *
 *  The omit-endpoints convention is what the monolith's both-ends-
 *  bonded and one-end-bonded merge paths rely on: each builds a new
 *  polyline as `[startTip, ...sampleCubic(...), endTip]` — duplicating
 *  the endpoints would create zero-length opening segments that the
 *  downstream polygon edge builder would flag as a degenerate seam
 *  (see L13825 and L14147 of the monolith for the call sites).
 *
 *  Ported 1:1 from monolith `_sampleCubic` (nested helper at L13589-
 *  L13601 inside `_weMergeBondEndpoints_standard`).
 */
export function _sampleCubic(
  p0: TilePoint,
  p1: TilePoint,
  p2: TilePoint,
  p3: TilePoint,
  N: number,
): TilePoint[] {
  const out: TilePoint[] = [];
  for (let s = 1; s <= N; s++) {
    const tt = s / (N + 1);
    const mt = 1 - tt;
    const mt3 = mt * mt * mt;
    const mt2t = 3 * mt * mt * tt;
    const mtt2 = 3 * mt * tt * tt;
    const t3 = tt * tt * tt;
    out.push([
      mt3 * p0[0] + mt2t * p1[0] + mtt2 * p2[0] + t3 * p3[0],
      mt3 * p0[1] + mt2t * p1[1] + mtt2 * p2[1] + t3 * p3[1],
    ]);
  }
  return out;
}

/** Centripetal Catmull-Rom segment evaluator — interpolates between
 *  knots `p1` and `p2` using `p0` / `p3` as tangent-informing
 *  neighbors. Returns `n` interior samples PLUS the endpoint `p2`
 *  (so the natural caller concatenates segments end-to-end without
 *  any seam-dedup work). Centripetal parametrization (alpha=0.5)
 *  avoids the loops and self-intersections that uniform Catmull-Rom
 *  (alpha=0) produces near sharp corners.
 *
 *  Knot-distance based parametrization uses `tj+1 = tj + |p−p|^alpha`
 *  with safe degenerate-knot handling at every division (`tN === tM`
 *  collapses the affine blend to the trailing operand) — when two
 *  adjacent knots coincide the segment is well-defined without ever
 *  dividing by zero.
 */
function _crSegment(
  p0: TilePoint,
  p1: TilePoint,
  p2: TilePoint,
  p3: TilePoint,
  n: number,
): TilePoint[] {
  const alpha = 0.5;
  const tj = (ti: number, pa: TilePoint, pb: TilePoint): number => {
    const dx = pa[0] - pb[0];
    const dy = pa[1] - pb[1];
    const d = Math.sqrt(dx * dx + dy * dy);
    return ti + Math.pow(d, alpha);
  };
  const t0 = 0;
  const t1 = tj(t0, p0, p1);
  const t2 = tj(t1, p1, p2);
  const t3 = tj(t2, p2, p3);
  const segOut: TilePoint[] = [];
  for (let s = 1; s <= n; s++) {
    const t = t1 + ((t2 - t1) * s) / n;
    let a1x: number, a1y: number, a2x: number, a2y: number, a3x: number, a3y: number;
    if (t1 !== t0) {
      const u = (t1 - t) / (t1 - t0);
      const v = (t - t0) / (t1 - t0);
      a1x = u * p0[0] + v * p1[0];
      a1y = u * p0[1] + v * p1[1];
    } else {
      a1x = p1[0];
      a1y = p1[1];
    }
    if (t2 !== t1) {
      const u = (t2 - t) / (t2 - t1);
      const v = (t - t1) / (t2 - t1);
      a2x = u * p1[0] + v * p2[0];
      a2y = u * p1[1] + v * p2[1];
    } else {
      a2x = p2[0];
      a2y = p2[1];
    }
    if (t3 !== t2) {
      const u = (t3 - t) / (t3 - t2);
      const v = (t - t2) / (t3 - t2);
      a3x = u * p2[0] + v * p3[0];
      a3y = u * p2[1] + v * p3[1];
    } else {
      a3x = p3[0];
      a3y = p3[1];
    }
    let b1x: number, b1y: number, b2x: number, b2y: number;
    if (t2 !== t0) {
      const u = (t2 - t) / (t2 - t0);
      const v = (t - t0) / (t2 - t0);
      b1x = u * a1x + v * a2x;
      b1y = u * a1y + v * a2y;
    } else {
      b1x = a2x;
      b1y = a2y;
    }
    if (t3 !== t1) {
      const u = (t3 - t) / (t3 - t1);
      const v = (t - t1) / (t3 - t1);
      b2x = u * a2x + v * a3x;
      b2y = u * a2y + v * a3y;
    } else {
      b2x = a3x;
      b2y = a3y;
    }
    let cx: number, cy: number;
    if (t2 !== t1) {
      const u = (t2 - t) / (t2 - t1);
      const v = (t - t1) / (t2 - t1);
      cx = u * b1x + v * b2x;
      cy = u * b1y + v * b2y;
    } else {
      cx = b2x;
      cy = b2y;
    }
    segOut.push([cx, cy]);
  }
  return segOut;
}

/** Sample 25 points along a circular arc from `pStart` to `pEnd` around
 *  center `C` with radius `R`. The arc is forced to take the LONG way
 *  around (`dTheta >= π/2`) so perpendicular cloverleaf inputs sweep
 *  the 270° loop the user expects, not the 90° shortcut.
 *
 *  ANGLE DIRECTION. `dTheta = thetaB - thetaA`, then incremented by 2π
 *  until ≥ π/2. Result: a math-CCW sweep that reads as visual CW for
 *  US right-hand-drive cloverleaf loops (`y` axis grows downward on
 *  canvas; a positive theta increment rotates visually clockwise).
 *  The threshold is π/2 (not π) because dTheta can land anywhere in
 *  [-2π, +2π] depending on the atan2 results; bumping until ≥ π/2
 *  guarantees:
 *    - dTheta initially in (π/2, 2π]              → unchanged.
 *    - dTheta initially in (0, π/2)               → +2π → (2π, 5π/2).
 *    - dTheta initially in [-π/2, 0]              → +2π → [3π/2, 2π].
 *    - dTheta initially in (-2π, -π/2)            → +2π → (0, 3π/2).
 *      For the second-pass case, the loop keeps incrementing until
 *      the bumped value is ≥ π/2 (one more +2π if needed).
 *  Equivalent: "if the chord is short enough that the direct sweep
 *  would be < 90°, walk the long way around the circle instead."
 *
 *  N_arc = 24 internal increments → 25 sampled points INCLUDING both
 *  endpoints. (sampleCubic's interior-only convention doesn't apply
 *  here — the loop ramp's polyline replaces the entire bondedTip-to-
 *  bondedTip span with these arc samples; including both endpoints
 *  means the caller doesn't have to re-append them.)
 *
 *  No validity check on R or C — caller is expected to have verified
 *  `R > 1.0 && R < 200.0` and that C is non-degenerate. Garbage in =
 *  garbage out; the loop falls through to "neither bonded" / user
 *  clicks when those validations fail upstream.
 *
 *  Ported 1:1 from monolith `_sweepArc` (nested helper at L14343-
 *  L14356 inside `_weMergeBondEndpoints_cloverleaf`).
 */
export function _sweepArc(
  pStart: TilePoint,
  pEnd: TilePoint,
  C: TilePoint,
  R: number,
): TilePoint[] {
  const thetaA = Math.atan2(pStart[1] - C[1], pStart[0] - C[0]);
  const thetaB = Math.atan2(pEnd[1] - C[1], pEnd[0] - C[0]);
  let dTheta = thetaB - thetaA;
  while (dTheta < Math.PI * 0.5) dTheta += 2 * Math.PI;
  const N_arc = 24;
  const arc: TilePoint[] = [];
  for (let k = 0; k <= N_arc; k++) {
    const t = k / N_arc;
    const theta = thetaA + dTheta * t;
    arc.push([C[0] + R * Math.cos(theta), C[1] + R * Math.sin(theta)]);
  }
  return arc;
}

/** Smooth curve through every knot, with externally-supplied tangent
 *  direction at the first / last knot (via `phantom_before` /
 *  `phantom_after` "ghost knots" that augment the input array). Returns
 *  the polyline starting at `knots[0]` and ending at `knots[N-1]` with
 *  `samplesPerSeg` interior samples between each consecutive knot pair.
 *
 *  Three behaviors:
 *    1. `knots.length < 2`     → shallow copy or empty.
 *    2. `knots.length === 2`   → straight line, `samplesPerSeg`-step
 *                                lerp between the two knots (phantom
 *                                points unused — Catmull-Rom needs four
 *                                neighbors and two-knot input can't
 *                                provide a meaningful tangent).
 *    3. `knots.length >= 3`    → centripetal Catmull-Rom through
 *                                `[phantom_before, ...knots, phantom_after]`,
 *                                yielding tangent-controlled endpoints.
 *
 *  WHY THE PHANTOM POINTS: the merge endpoint smoother (the eventual
 *  port of `_weMergeBondEndpoints_standard`) sets phantom_before /
 *  phantom_after along each bonded destination's tangent so the curve
 *  enters and exits parallel to the destination road at the gore.
 *  Without externally-supplied phantoms the endpoint tangents would
 *  default to a reflection that bends inward and produces a visible
 *  kink at the connection.
 *
 *  Each interior segment's output INCLUDES its trailing knot, so
 *  walking `i = 1 … augmented.length-3` and concatenating yields a
 *  polyline with no duplicated vertices.
 *
 *  Ported 1:1 from monolith `_catmullRomThroughKnots` (nested helper
 *  at L13618-L13683 inside `_weMergeBondEndpoints_standard`).
 */
export function _catmullRomThroughKnots(
  knots: ReadonlyArray<TilePoint>,
  samplesPerSeg: number,
  phantom_before: TilePoint,
  phantom_after: TilePoint,
): TilePoint[] {
  if (!knots || knots.length < 2) return knots ? knots.map((p) => [p[0], p[1]]) : [];
  if (knots.length === 2) {
    const out: TilePoint[] = [knots[0]];
    for (let s = 1; s < samplesPerSeg; s++) {
      const t = s / samplesPerSeg;
      out.push([
        knots[0][0] * (1 - t) + knots[1][0] * t,
        knots[0][1] * (1 - t) + knots[1][1] * t,
      ]);
    }
    out.push(knots[1]);
    return out;
  }
  const augmented: TilePoint[] = [phantom_before, ...knots, phantom_after];
  const out: TilePoint[] = [[knots[0][0], knots[0][1]]];
  for (let i = 1; i < augmented.length - 2; i++) {
    const seg = _crSegment(
      augmented[i - 1],
      augmented[i],
      augmented[i + 1],
      augmented[i + 2],
      samplesPerSeg,
    );
    for (const p of seg) out.push(p);
  }
  return out;
}
