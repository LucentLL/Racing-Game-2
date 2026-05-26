/**
 * Catmull-Rom polyline smoothing — produces a denser polyline that
 * passes through every input vertex but has smooth curvature at the
 * joints between segments. Replaces sharp lineTo angles with smooth
 * interpolated curves; original vertices remain on the curve so the
 * smoothed shape stays geometrically anchored to the source data.
 *
 * Used by both the game's strokeRoad render and the editor's
 * renderEditor so road appearance is consistent in-game and at the
 * authoring view. Tile-map physics still uses the source-defined
 * straight-line polyline for isOnRoad classification — the smoothing
 * is visual-only for now. Re-baking the tile map to match would
 * require touching buildBaselineMap (port-later).
 *
 * H661: switched from UNIFORM to CENTRIPETAL Catmull-Rom (alpha=0.5).
 * Uniform CR overshoots at sharp corners and produces visible LOOPS
 * and SELF-INTERSECTIONS in offset stripes (yellow centerline, white
 * edge fog lines, lane dividers) — exactly the "twisted roads"
 * artifact the editor was showing on highway curves. The monolith
 * uses centripetal CR everywhere it splines through knot points
 * (_catmullRomThroughKnots L13618-L13680) and explicitly calls out
 * (L13607) that "Centripetal parametrization (alpha=0.5) avoids the
 * loops and self-intersections that uniform Catmull-Rom produces
 * near sharp corners."
 *
 * Centripetal parameterization: knot times t_i grow by sqrt(d_i)
 * where d_i = |p_{i+1} - p_i|. The Barry-Goldman recursive form
 * computes P(t) on segment p1→p2 for t in [t1, t2]:
 *
 *     A1 = lerp(p0, p1, (t-t0)/(t1-t0))
 *     A2 = lerp(p1, p2, (t-t1)/(t2-t1))
 *     A3 = lerp(p2, p3, (t-t2)/(t3-t2))
 *     B1 = lerp(A1, A2, (t-t0)/(t2-t0))
 *     B2 = lerp(A2, A3, (t-t1)/(t3-t1))
 *     C  = lerp(B1, B2, (t-t1)/(t2-t1))
 *
 * Each lerp falls back to the right endpoint when its denominator is
 * zero (duplicated knot). Endpoint tangents reflect across the first
 * and last source vertex so the curve doesn't overshoot the road's
 * ends.
 */

/** Default samples between each pair of source vertices. Higher =
 *  smoother visible curves at high zoom but more output points (cost
 *  scales linearly in the stroke pass). 8 reads as a smooth curve
 *  at the game's camera zoom + reasonable cost. */
const DEFAULT_SAMPLES_PER_SEG = 8;

const ALPHA = 0.5;

/** Centripetal knot spacing: t_{i+1} = t_i + |p_{i+1} - p_i|^alpha. */
function nextKnot(t: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  const d = Math.sqrt(dx * dx + dy * dy);
  return t + Math.pow(d, ALPHA);
}

/** Barry-Goldman centripetal CR sample at parameter t on segment p1→p2.
 *  Falls back to the right endpoint when any sub-lerp denominator is
 *  zero (duplicated control point). */
function crSample(
  p0x: number, p0y: number, t0: number,
  p1x: number, p1y: number, t1: number,
  p2x: number, p2y: number, t2: number,
  p3x: number, p3y: number, t3: number,
  t: number,
): [number, number] {
  let a1x: number, a1y: number;
  if (t1 !== t0) {
    const u = (t1 - t) / (t1 - t0);
    const v = (t - t0) / (t1 - t0);
    a1x = u * p0x + v * p1x;
    a1y = u * p0y + v * p1y;
  } else { a1x = p1x; a1y = p1y; }
  let a2x: number, a2y: number;
  if (t2 !== t1) {
    const u = (t2 - t) / (t2 - t1);
    const v = (t - t1) / (t2 - t1);
    a2x = u * p1x + v * p2x;
    a2y = u * p1y + v * p2y;
  } else { a2x = p2x; a2y = p2y; }
  let a3x: number, a3y: number;
  if (t3 !== t2) {
    const u = (t3 - t) / (t3 - t2);
    const v = (t - t2) / (t3 - t2);
    a3x = u * p2x + v * p3x;
    a3y = u * p2y + v * p3y;
  } else { a3x = p3x; a3y = p3y; }
  let b1x: number, b1y: number;
  if (t2 !== t0) {
    const u = (t2 - t) / (t2 - t0);
    const v = (t - t0) / (t2 - t0);
    b1x = u * a1x + v * a2x;
    b1y = u * a1y + v * a2y;
  } else { b1x = a2x; b1y = a2y; }
  let b2x: number, b2y: number;
  if (t3 !== t1) {
    const u = (t3 - t) / (t3 - t1);
    const v = (t - t1) / (t3 - t1);
    b2x = u * a2x + v * a3x;
    b2y = u * a2y + v * a3y;
  } else { b2x = a3x; b2y = a3y; }
  if (t2 !== t1) {
    const u = (t2 - t) / (t2 - t1);
    const v = (t - t1) / (t2 - t1);
    return [u * b1x + v * b2x, u * b1y + v * b2y];
  }
  return [b2x, b2y];
}

/** Core: smooth two parallel coordinate arrays via centripetal
 *  Catmull-Rom. Output length = (input - 1) * samplesPerSeg + 1.
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
  for (let i = 0; i < n - 1; i++) {
    // Reflect the first/last source vertex to give zero-curvature
    // endpoint tangents — matches the monolith's phantom-knot pattern
    // when no explicit phantoms are supplied.
    const p0x = i === 0 ? 2 * xs[0] - xs[1] : xs[i - 1];
    const p0y = i === 0 ? 2 * ys[0] - ys[1] : ys[i - 1];
    const p1x = xs[i];
    const p1y = ys[i];
    const p2x = xs[i + 1];
    const p2y = ys[i + 1];
    const p3x = i + 2 < n ? xs[i + 2] : 2 * xs[n - 1] - xs[n - 2];
    const p3y = i + 2 < n ? ys[i + 2] : 2 * ys[n - 1] - ys[n - 2];
    const t0 = 0;
    const t1 = nextKnot(t0, p0x, p0y, p1x, p1y);
    const t2 = nextKnot(t1, p1x, p1y, p2x, p2y);
    const t3 = nextKnot(t2, p2x, p2y, p3x, p3y);
    if (t2 === t1) {
      // Degenerate segment (p1 == p2): emit the endpoint and skip.
      ox.push(p2x);
      oy.push(p2y);
      continue;
    }
    for (let s = 1; s <= samplesPerSeg; s++) {
      const t = t1 + (t2 - t1) * (s / samplesPerSeg);
      const [x, y] = crSample(
        p0x, p0y, t0,
        p1x, p1y, t1,
        p2x, p2y, t2,
        p3x, p3y, t3,
        t,
      );
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
