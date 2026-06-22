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

/** Reflex-arc sampler for the cloverleaf LOOP (bisector-inscribed-circle
 *  redesign). Same 25-point output as _sweepArc, but it sweeps the REFLEX
 *  (>180°) side from pStart to pEnd around C — the long ~270° loop, not
 *  the short hop. The direction comes from the geometry: take the CCW
 *  delta A→B in (0, 2π], then choose the reflex complement (the side whose
 *  |sweep| > π), which is the arc that goes the long way AROUND the
 *  crossing rather than cutting straight across it. Distinct from
 *  _sweepArc (which blindly bumps to ≥90°) so the standard / stop / U-turn
 *  / one-end paths through _sweepArc stay byte-identical. */
export function _sweepLoop(
  pStart: TilePoint,
  pEnd: TilePoint,
  C: TilePoint,
  R: number,
): TilePoint[] {
  const thetaA = Math.atan2(pStart[1] - C[1], pStart[0] - C[0]);
  const thetaB = Math.atan2(pEnd[1] - C[1], pEnd[0] - C[0]);
  let dRaw = thetaB - thetaA;
  if (dRaw <= 0) dRaw += 2 * Math.PI; // CCW A→B in (0, 2π]
  const sweep = dRaw > Math.PI ? dRaw : dRaw - 2 * Math.PI; // reflex side
  const N_arc = 24;
  const arc: TilePoint[] = [];
  for (let k = 0; k <= N_arc; k++) {
    const theta = thetaA + sweep * (k / N_arc);
    arc.push([C[0] + R * Math.cos(theta), C[1] + R * Math.sin(theta)]);
  }
  return arc;
}

/** Clamped Hermite ("cardinal") spline through `knots` with EXPLICIT
 *  end-tangent DIRECTIONS. Unlike _catmullRomThroughKnots (which controls
 *  the end tangents indirectly through phantom ghost-knots), this clamps
 *  the velocity at knots[0] / knots[K-1] to `tanStart` / `tanEnd` exactly,
 *  so the resulting polyline LEAVES the first knot heading along tanStart
 *  and ARRIVES at the last knot heading along tanEnd — i.e. it is tangent
 *  to whatever those directions represent (here: each bonded destination
 *  road), which is what the user means by "start and end tangential to
 *  the roads."
 *
 *  - `tanStart` / `tanEnd` are UNIT direction vectors (the caller picks
 *    the sign so they point INTO / OUT-OF the curve along travel).
 *  - Interior knot tangents use a non-overshooting Catmull-Rom variant:
 *    the bisector of the two adjacent chord directions, scaled by the
 *    SHORTER adjacent chord. The min-chord magnitude is the standard
 *    guard against the loops/overshoot uniform Catmull-Rom produces on
 *    unevenly-spaced knots — it keeps each segment monotone between its
 *    endpoints.
 *  - End-tangent magnitude is the adjacent chord length, matching the
 *    interior scale so the clamp doesn't introduce a speed discontinuity
 *    (which would read as a kink at knots[1] / knots[K-2]).
 *  - Each segment [k_i, k_{i+1}] is emitted as a cubic Bezier whose
 *    control points encode the Hermite tangents (B1 = k_i + T_i/3,
 *    B2 = k_{i+1} - T_{i+1}/3) and sampled with `_sampleCubic`
 *    (`samplesPerSeg` interior points). Output starts at knots[0], ends
 *    at knots[K-1], with no duplicated vertices.
 *
 *  K === 2 collapses to a single tangent-clamped Bezier — a smooth blend
 *  from one road's tangent to the other with no intermediate clicks.
 *
 *  H899: replaces the both-ends-bonded standard merge's prior
 *  natural-phantom Catmull-Rom (H891), which left the curve free to meet
 *  the destination at any angle (measured up to 80°+ off-tangent). */
export function _hermiteSplineThroughKnots(
  knots: ReadonlyArray<TilePoint>,
  samplesPerSeg: number,
  tanStart: readonly [number, number],
  tanEnd: readonly [number, number],
): TilePoint[] {
  const K = knots.length;
  if (K < 2) return knots ? knots.map((p) => [p[0], p[1]]) : [];
  const chord = (i: number, j: number): number =>
    Math.hypot(knots[j][0] - knots[i][0], knots[j][1] - knots[i][1]);
  const T: TilePoint[] = new Array(K);
  for (let i = 0; i < K; i++) {
    if (i === 0) {
      const L = chord(0, 1) || 1;
      T[i] = [tanStart[0] * L, tanStart[1] * L];
    } else if (i === K - 1) {
      const L = chord(K - 2, K - 1) || 1;
      T[i] = [tanEnd[0] * L, tanEnd[1] * L];
    } else {
      const inX = knots[i][0] - knots[i - 1][0];
      const inY = knots[i][1] - knots[i - 1][1];
      const outX = knots[i + 1][0] - knots[i][0];
      const outY = knots[i + 1][1] - knots[i][1];
      const Lin = Math.hypot(inX, inY) || 1;
      const Lout = Math.hypot(outX, outY) || 1;
      let dx = inX / Lin + outX / Lout;
      let dy = inY / Lin + outY / Lout;
      const Ld = Math.hypot(dx, dy) || 1;
      dx /= Ld;
      dy /= Ld;
      const mag = Math.min(Lin, Lout);
      T[i] = [dx * mag, dy * mag];
    }
  }
  const out: TilePoint[] = [[knots[0][0], knots[0][1]]];
  for (let i = 0; i < K - 1; i++) {
    const b0 = knots[i];
    const b3 = knots[i + 1];
    const b1: TilePoint = [b0[0] + T[i][0] / 3, b0[1] + T[i][1] / 3];
    const b2: TilePoint = [b3[0] - T[i + 1][0] / 3, b3[1] - T[i + 1][1] / 3];
    const seg = _sampleCubic(b0, b1, b2, b3, samplesPerSeg);
    for (const p of seg) out.push(p);
    out.push([b3[0], b3[1]]);
  }
  return out;
}

/** H919 — G2 EASEMENT through a corner, replacing the constant-radius
 *  quadratic-Bézier fillet (which met the straight parallel runs at a
 *  CURVATURE STEP: curvature jumped 0 → 1/R instantly at the tangent point,
 *  the "harsh turn-in" the user feels, and concentrated all the bend at the
 *  apex near C so the peak curvature was high / radius small).
 *
 *  Given the two straight-run tangent points `qA` (curve start) and `qB`
 *  (curve end), the corner `C` where the run LINES meet, and the unit travel
 *  directions `tanA` (qA→C) and `tanB` (C→qB), build a symmetric QUINTIC
 *  Bézier whose curvature is ZERO at both ends and ramps gradually to a low
 *  maximum in the middle — a clothoid-like easement:
 *
 *    A quintic Bézier B(t) with control points P0..P5 has SECOND derivative
 *    at t=0 proportional to (P0 − 2·P1 + P2) and at t=1 proportional to
 *    (P3 − 2·P4 + P5). Forcing P0,P1,P2 COLLINEAR (along tanA) makes
 *    B''(0)=0 → zero curvature at qA; likewise P3,P4,P5 collinear (along
 *    tanB) → zero curvature at qB. So the curve LEAVES the straight run with
 *    the run's own curvature (0) and builds up gradually — no step.
 *
 *  Control points (g = `tipFrac` ∈ (0, 0.5], leg = |C−qA| = |C−qB| = d):
 *    P0 = qA
 *    P1 = qA + tanA·(g·d)
 *    P2 = qA + tanA·(2g·d)      (collinear with P0,P1 → B''(0)=0)
 *    P3 = qB − tanB·(2g·d)      (collinear with P4,P5 → B''(1)=0)
 *    P4 = qB − tanB·(g·d)
 *    P5 = qB
 *  Smaller g pulls P2/P3 back toward the runs, spreading the bend over more
 *  arc length (gentler, lower peak curvature); g→0.5 puts P2,P3 at C (tighter,
 *  approaching the old quadratic). A render-harness sweep over corner geometries
 *  found peak curvature MINIMIZED around g≈0.28–0.33 (below that the curvature
 *  re-concentrates near the ends), so the default g=0.30 gives the largest
 *  effective radius — several times gentler than the old constant-radius
 *  quadratic — with the bend evenly distributed and no overshoot past C.
 *
 *  Returns `N+1` points INCLUDING both endpoints (qA … qB) so the caller can
 *  drop-in replace the old quadratic arc array. */
export function _g2EasementThroughCorner(
  qA: TilePoint,
  qB: TilePoint,
  C: TilePoint,
  tanA: readonly [number, number],
  tanB: readonly [number, number],
  N: number,
  tipFrac = 0.30,
): TilePoint[] {
  const dA = Math.hypot(C[0] - qA[0], C[1] - qA[1]) || 1;
  const dB = Math.hypot(C[0] - qB[0], C[1] - qB[1]) || 1;
  const g = Math.max(0.05, Math.min(0.5, tipFrac));
  const P0 = qA;
  const P1: TilePoint = [qA[0] + tanA[0] * (g * dA), qA[1] + tanA[1] * (g * dA)];
  const P2: TilePoint = [qA[0] + tanA[0] * (2 * g * dA), qA[1] + tanA[1] * (2 * g * dA)];
  const P3: TilePoint = [qB[0] - tanB[0] * (2 * g * dB), qB[1] - tanB[1] * (2 * g * dB)];
  const P4: TilePoint = [qB[0] - tanB[0] * (g * dB), qB[1] - tanB[1] * (g * dB)];
  const P5 = qB;
  const out: TilePoint[] = [];
  for (let k = 0; k <= N; k++) {
    const t = k / N;
    const u = 1 - t;
    // quintic Bernstein basis
    const b0 = u * u * u * u * u;
    const b1 = 5 * u * u * u * u * t;
    const b2 = 10 * u * u * u * t * t;
    const b3 = 10 * u * u * t * t * t;
    const b4 = 5 * u * t * t * t * t;
    const b5 = t * t * t * t * t;
    out.push([
      b0 * P0[0] + b1 * P1[0] + b2 * P2[0] + b3 * P3[0] + b4 * P4[0] + b5 * P5[0],
      b0 * P0[1] + b1 * P1[1] + b2 * P2[1] + b3 * P3[1] + b4 * P4[1] + b5 * P5[1],
    ]);
  }
  return out;
}

/** Centripetal Catmull-Rom interpolation through knot points — RESTORED to
 *  match the monolith (`_catmullRomThroughKnots`, L13618-13683) after H899
 *  wrongly removed it in favour of an invented Hermite. This is the curve the
 *  standard merge has used since v126.30 and it is what the user means by "it
 *  was all functional in the HTML monolith."
 *
 *  Generates a smooth curve passing EXACTLY through each knot (unlike a cubic
 *  Bezier where control points are pulled handles, not on-curve). Centripetal
 *  parametrization (alpha=0.5) avoids the loops / self-intersections that
 *  uniform Catmull-Rom produces near sharp corners.
 *
 *  Tangent at knots[0] is set by `phantom_before`; tangent at knots[N-1] by
 *  `phantom_after`. For merge ramps the caller places the phantoms along each
 *  destination tangent so the curve enters/exits parallel to the road at each
 *  gore. Returns points from knots[0] through knots[N-1], with `samplesPerSeg`
 *  interpolated points between each consecutive pair of knots.
 *
 *  Ported 1:1 from the monolith. */
export function _catmullRomThroughKnots(
  knots: ReadonlyArray<TilePoint>,
  samplesPerSeg: number,
  phantom_before: TilePoint,
  phantom_after: TilePoint,
): TilePoint[] {
  if (!knots || knots.length < 2) return knots ? knots.map((p) => [p[0], p[1]]) : [];
  if (knots.length === 2) {
    const out: TilePoint[] = [[knots[0][0], knots[0][1]]];
    for (let s = 1; s < samplesPerSeg; s++) {
      const t = s / samplesPerSeg;
      out.push([knots[0][0] * (1 - t) + knots[1][0] * t, knots[0][1] * (1 - t) + knots[1][1] * t]);
    }
    out.push([knots[1][0], knots[1][1]]);
    return out;
  }
  const augmented: TilePoint[] = [phantom_before, ...knots, phantom_after];
  const out: TilePoint[] = [[knots[0][0], knots[0][1]]];
  const _crSegment = (
    p0: TilePoint, p1: TilePoint, p2: TilePoint, p3: TilePoint, n: number,
  ): TilePoint[] => {
    const alpha = 0.5;
    const tj = (ti: number, pa: TilePoint, pb: TilePoint): number => {
      const dx = pa[0] - pb[0], dy = pa[1] - pb[1];
      const d = Math.sqrt(dx * dx + dy * dy);
      return ti + Math.pow(d, alpha);
    };
    const t0 = 0;
    const t1 = tj(t0, p0, p1);
    const t2 = tj(t1, p1, p2);
    const t3 = tj(t2, p2, p3);
    const segOut: TilePoint[] = [];
    for (let s = 1; s <= n; s++) {
      const t = t1 + (t2 - t1) * s / n;
      let a1x: number, a1y: number, a2x: number, a2y: number, a3x: number, a3y: number;
      if (t1 !== t0) {
        const u = (t1 - t) / (t1 - t0), v = (t - t0) / (t1 - t0);
        a1x = u * p0[0] + v * p1[0]; a1y = u * p0[1] + v * p1[1];
      } else { a1x = p1[0]; a1y = p1[1]; }
      if (t2 !== t1) {
        const u = (t2 - t) / (t2 - t1), v = (t - t1) / (t2 - t1);
        a2x = u * p1[0] + v * p2[0]; a2y = u * p1[1] + v * p2[1];
      } else { a2x = p2[0]; a2y = p2[1]; }
      if (t3 !== t2) {
        const u = (t3 - t) / (t3 - t2), v = (t - t2) / (t3 - t2);
        a3x = u * p2[0] + v * p3[0]; a3y = u * p2[1] + v * p3[1];
      } else { a3x = p3[0]; a3y = p3[1]; }
      let b1x: number, b1y: number, b2x: number, b2y: number;
      if (t2 !== t0) {
        const u = (t2 - t) / (t2 - t0), v = (t - t0) / (t2 - t0);
        b1x = u * a1x + v * a2x; b1y = u * a1y + v * a2y;
      } else { b1x = a2x; b1y = a2y; }
      if (t3 !== t1) {
        const u = (t3 - t) / (t3 - t1), v = (t - t1) / (t3 - t1);
        b2x = u * a2x + v * a3x; b2y = u * a2y + v * a3y;
      } else { b2x = a3x; b2y = a3y; }
      let cx: number, cy: number;
      if (t2 !== t1) {
        const u = (t2 - t) / (t2 - t1), v = (t - t1) / (t2 - t1);
        cx = u * b1x + v * b2x; cy = u * b1y + v * b2y;
      } else { cx = b2x; cy = b2y; }
      segOut.push([cx, cy]);
    }
    return segOut;
  };
  for (let i = 1; i < augmented.length - 2; i++) {
    const seg = _crSegment(augmented[i - 1], augmented[i], augmented[i + 1], augmented[i + 2], samplesPerSeg);
    for (const p of seg) out.push(p);
  }
  return out;
}
