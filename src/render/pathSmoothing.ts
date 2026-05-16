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
 * Closed-form Catmull-Rom (uniform parameterization, tension 0.5):
 *
 *   For each interior segment p1→p2 with neighbors p0, p3:
 *     P(t) = 0.5 * ( 2*p1
 *                  + (-p0 + p2) * t
 *                  + (2*p0 - 5*p1 + 4*p2 - p3) * t²
 *                  + (-p0 + 3*p1 - 3*p2 + p3) * t³ )
 *
 *   Endpoint duplication (p0 = p1 for the first segment, p3 = p2 for
 *   the last) gives zero-curvature endpoints so the curve doesn't
 *   overshoot the road's ends.
 */

/** Default samples between each pair of source vertices. Higher =
 *  smoother visible curves at high zoom but more output points (cost
 *  scales linearly in the stroke pass). 8 reads as a smooth curve
 *  at the game's camera zoom + reasonable cost. */
const DEFAULT_SAMPLES_PER_SEG = 8;

/** Core: smooth two parallel coordinate arrays. Output length =
 *  (input - 1) * samplesPerSeg + 1. Polylines with fewer than 3
 *  source vertices return their input verbatim (1 or 2 points cannot
 *  have interior curvature). */
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
    const p0x = i === 0 ? xs[0] : xs[i - 1];
    const p0y = i === 0 ? ys[0] : ys[i - 1];
    const p1x = xs[i];
    const p1y = ys[i];
    const p2x = xs[i + 1];
    const p2y = ys[i + 1];
    const p3x = i + 2 < n ? xs[i + 2] : xs[i + 1];
    const p3y = i + 2 < n ? ys[i + 2] : ys[i + 1];
    for (let s = 1; s <= samplesPerSeg; s++) {
      const t = s / samplesPerSeg;
      const t2 = t * t;
      const t3 = t2 * t;
      const x = 0.5 * (
        (2 * p1x)
        + (-p0x + p2x) * t
        + (2 * p0x - 5 * p1x + 4 * p2x - p3x) * t2
        + (-p0x + 3 * p1x - 3 * p2x + p3x) * t3
      );
      const y = 0.5 * (
        (2 * p1y)
        + (-p0y + p2y) * t
        + (2 * p0y - 5 * p1y + 4 * p2y - p3y) * t2
        + (-p0y + 3 * p1y - 3 * p2y + p3y) * t3
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
