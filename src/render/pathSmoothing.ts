/**
 * Polyline smoothing — produces a denser polyline whose stroke reads
 * as a continuous curve, used by the game's strokeRoad render, the
 * editor's renderEditor, and buildBaselineMap's tile stamper so all
 * three pipelines see the same shape.
 *
 * H680: switched from centripetal Catmull-Rom (H661) to MIDPOINT-
 * ANCHORED QUADRATIC BEZIER. CR forces the curve through every source
 * vertex; after H678's RDP simplification the vertices land 10-30
 * tiles apart with up to ~20° turns between them, so even centripetal
 * CR produced visible kinks at each vertex (user screenshot showed
 * yellow centerline + white fog lines all bending at the same point
 * instead of curving smoothly). Midpoint-Bezier instead uses each
 * interior source vertex as a Bezier CONTROL point — the curve passes
 * through endpoints + each per-segment midpoint but only approximates
 * interior vertices, taking a wider arc around sharp angles. This is
 * the "auto-curve" pattern the editor preview used pre-H631 and the
 * monolith used at L10697-L10723 for road draft drawing.
 *
 * Three-region pattern for a polyline P[0..N-1]:
 *   • Leg 0:        linear from P[0] to M(0,1) where M(i,j) =
 *                   (P[i] + P[j]) / 2.
 *   • Legs 1..N-3:  quadratic Bezier from M(i-1,i) through P[i] (the
 *                   control point) to M(i,i+1). Consecutive legs share
 *                   midpoints so C1 continuity falls out for free.
 *   • Last leg:     quadratic Bezier from M(N-3,N-2) through P[N-2]
 *                   to P[N-1]. Endpoint stays at exactly P[N-1] so
 *                   road graph connections (shared endpoints between
 *                   adjacent baseline rows) still align.
 *
 * No-overshoot guarantee: a quadratic Bezier always lies inside the
 * triangle (start, control, end); each control triangle here is a
 * subset of the source polyline's neighborhood, so the smoothed curve
 * can never loop or self-intersect even at very sharp source angles
 * — the geometric property the H661 centripetal switch was reaching
 * for, but achieved by construction here.
 *
 * Physics still uses the raw (unsmoothed) polyline for isOnRoad
 * classification via roadGraph.ts:isOnMajorRoad — visual smoothing
 * doesn't affect drivable-tile detection.
 */

/** Default samples between each pair of source vertices. Higher =
 *  smoother visible curves at high zoom but more output points (cost
 *  scales linearly in the stroke pass). 8 reads as a smooth curve
 *  at the game's camera zoom + reasonable cost. */
const DEFAULT_SAMPLES_PER_SEG = 8;

/** Quadratic Bezier sample at parameter t in [0, 1]. */
function quadSample(
  sx: number, sy: number,
  cx: number, cy: number,
  ex: number, ey: number,
  t: number,
): [number, number] {
  const u = 1 - t;
  return [u * u * sx + 2 * u * t * cx + t * t * ex,
          u * u * sy + 2 * u * t * cy + t * t * ey];
}

/** Core: smooth two parallel coordinate arrays via midpoint-anchored
 *  quadratic Bezier (see file header for the three-region pattern).
 *  Polylines with fewer than 3 source vertices return their input
 *  verbatim (1 or 2 points cannot have interior curvature). */
export function smoothPolylineXY(
  xs: readonly number[],
  ys: readonly number[],
  samplesPerSeg: number = DEFAULT_SAMPLES_PER_SEG,
): { xs: number[]; ys: number[] } {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return { xs: [...xs], ys: [...ys] };
  const ox: number[] = [xs[0]];
  const oy: number[] = [ys[0]];

  // Leg 0 — linear P[0] → M(0, 1). Sampled at samplesPerSeg points so
  // the output spacing matches the interior legs (downstream offset-
  // path passes assume uniform sample density).
  {
    const m01x = (xs[0] + xs[1]) / 2;
    const m01y = (ys[0] + ys[1]) / 2;
    for (let s = 1; s <= samplesPerSeg; s++) {
      const t = s / samplesPerSeg;
      ox.push(xs[0] * (1 - t) + m01x * t);
      oy.push(ys[0] * (1 - t) + m01y * t);
    }
  }

  // Interior legs — i from 1 to n-3: quadratic Bezier
  //   start  = M(i-1, i)
  //   control = P[i]
  //   end    = M(i, i+1)
  for (let i = 1; i <= n - 3; i++) {
    const sx = (xs[i - 1] + xs[i]) / 2;
    const sy = (ys[i - 1] + ys[i]) / 2;
    const cx = xs[i];
    const cy = ys[i];
    const ex = (xs[i] + xs[i + 1]) / 2;
    const ey = (ys[i] + ys[i + 1]) / 2;
    for (let s = 1; s <= samplesPerSeg; s++) {
      const [x, y] = quadSample(sx, sy, cx, cy, ex, ey, s / samplesPerSeg);
      ox.push(x);
      oy.push(y);
    }
  }

  // Last leg — quadratic Bezier
  //   start  = M(n-3, n-2)
  //   control = P[n-2]
  //   end    = P[n-1] (real endpoint, not a midpoint, so shared road
  //                    endpoints between adjacent baseline rows still
  //                    coincide exactly)
  {
    const last = n - 1;
    const sx = (xs[last - 2] + xs[last - 1]) / 2;
    const sy = (ys[last - 2] + ys[last - 1]) / 2;
    const cx = xs[last - 1];
    const cy = ys[last - 1];
    const ex = xs[last];
    const ey = ys[last];
    for (let s = 1; s <= samplesPerSeg; s++) {
      const [x, y] = quadSample(sx, sy, cx, cy, ex, ey, s / samplesPerSeg);
      ox.push(x);
      oy.push(y);
    }
  }
  return { xs: ox, ys: oy };
}

/** Tuple-format wrapper for the editor's [x, y] road format. */
export function smoothPolyline(
  pts: readonly (readonly [number, number])[],
  samplesPerSeg: number = DEFAULT_SAMPLES_PER_SEG,
): [number, number][] {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const { xs: sx, ys: sy } = smoothPolylineXY(xs, ys, samplesPerSeg);
  const out: [number, number][] = [];
  for (let i = 0; i < sx.length; i++) out.push([sx[i], sy[i]]);
  return out;
}

/** Flat-array wrapper for the game's BaselineRoadRow road format
 *  (where coords land as a flat [x1, y1, x2, y2, ...] in tile coords). */
export function smoothFlatPolyline(
  flat: readonly number[],
  samplesPerSeg: number = DEFAULT_SAMPLES_PER_SEG,
): number[] {
  if (flat.length < 6) return [...flat];
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    xs.push(flat[i]);
    ys.push(flat[i + 1]);
  }
  const { xs: sx, ys: sy } = smoothPolylineXY(xs, ys, samplesPerSeg);
  const out: number[] = [];
  for (let i = 0; i < sx.length; i++) {
    out.push(sx[i], sy[i]);
  }
  return out;
}
