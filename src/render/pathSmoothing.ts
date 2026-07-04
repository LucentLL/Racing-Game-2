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
 *  smoother visible curves at high zoom but more output points.
 *
 *  H836: raised 8 → 14. At the game's close, perspective-tilted camera
 *  8 samples left visible FACETS on long/sparse curve segments — a
 *  gentle highway curve drawn with few vertices read as short straight
 *  chords (user: "all curves should be smooth, not straight lines
 *  connecting vertices through turns"). 14 keeps the midpoint-Bezier
 *  reading as a true arc up close. The cost is per-road tessellation in
 *  the cached Path2D (built once at rebuild, not per-frame) — the
 *  rasterized fill covers the same pixels regardless of point count, so
 *  the per-frame stroke cost barely moves (the perf cost model is
 *  stroke-CALL-count bound, not points-per-call). All callers — render,
 *  editor draft/preview, and the baseline tile-stamper — read this one
 *  default, so the three stay geometrically identical. */
const DEFAULT_SAMPLES_PER_SEG = 14;

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

/** H837: max turn (degrees) a source vertex may make before it's treated
 *  as a data-error SPIKE and dropped. A real road never reverses at a
 *  single point — a turn approaching 180° means the polyline backtracks
 *  on itself (e.g. baseline road m43 had `…(2499,154),(2499,151),
 *  (2499,186)` — a 3-unit backtrack then a 35-unit jump = a ~180° spike,
 *  which the midpoint-Bezier faithfully rendered as a hard kink in the
 *  centerline). 150° keeps every legitimate corner (even a 90° turn is
 *  only a 90° turn-angle) and drops only near-reversals. */
const SPIKE_TURN_DEG = 150;

/** H837: vertices closer than this (TILE units) to the previously kept
 *  vertex are duplicates and dropped — they create zero-length segments
 *  whose direction is floating-point noise (spurious kinks). */
const DUP_EPS_TILES = 0.05;

/** H837: clean a polyline before smoothing — drop near-duplicate and
 *  near-reversal (spike) INTERIOR vertices. Endpoints are always kept so
 *  roads that share an endpoint still connect exactly. Runs for every
 *  smoothing caller (render / editor / tile-stamper), so bad baseline
 *  data AND any future editor mis-click get cleaned the same way. */
function cleanPolylineXY(
  xs: readonly number[],
  ys: readonly number[],
): { xs: number[]; ys: number[] } {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return { xs: [...xs], ys: [...ys] };
  const ox: number[] = [xs[0]];
  const oy: number[] = [ys[0]];
  for (let i = 1; i < n - 1; i++) {
    const px = ox[ox.length - 1], py = oy[oy.length - 1];
    const cx = xs[i], cy = ys[i];
    // Drop near-duplicate of the last kept vertex.
    if (Math.hypot(cx - px, cy - py) < DUP_EPS_TILES) continue;
    // Drop a backtrack spike: turn between (prev→cur) and (cur→next) near 180°.
    const nx = xs[i + 1], ny = ys[i + 1];
    const v1x = cx - px, v1y = cy - py;
    const v2x = nx - cx, v2y = ny - cy;
    const m1 = Math.hypot(v1x, v1y), m2 = Math.hypot(v2x, v2y);
    if (m1 > 1e-6 && m2 > 1e-6) {
      let dot = (v1x * v2x + v1y * v2y) / (m1 * m2);
      dot = Math.max(-1, Math.min(1, dot));
      if (Math.acos(dot) * 180 / Math.PI > SPIKE_TURN_DEG) continue;
    }
    ox.push(cx); oy.push(cy);
  }
  ox.push(xs[n - 1]); oy.push(ys[n - 1]);
  // H843: low-pass the SOURCE vertices before the Bezier. Many baseline
  // roads were digitized with large per-vertex turns (e.g. m14 averaged
  // 30°/vertex, peaks 54°) — a jagged zigzag the corner-rounding Bezier
  // can't hide, so the user still saw "hard angles in road lines" after
  // the H836/H837 work. A couple of Laplacian passes (each interior
  // vertex eased toward the midpoint of its neighbours) turn the zigzag
  // into a flowing curve while leaving genuinely straight runs and the
  // overall path untouched. Endpoints stay fixed so connected roads still
  // share them exactly. All consumers (render, collision, tile-stamp)
  // read this same smoothed output, so nothing desyncs.
  laplacianSmoothInPlace(ox, oy, LAPLACIAN_ITERS, LAPLACIAN_LAMBDA);
  return { xs: ox, ys: oy };
}

/** H843: Laplacian smoothing tuning. 2 passes at λ=0.5 roughly quarters
 *  per-vertex zigzag; endpoints pinned. */
const LAPLACIAN_ITERS = 2;
const LAPLACIAN_LAMBDA = 0.5;

/** H843: in-place Laplacian smoothing of an open polyline. Each interior
 *  vertex moves a fraction λ toward the average of its two neighbours,
 *  per iteration. Endpoints (index 0 and last) are never moved. */
function laplacianSmoothInPlace(xs: number[], ys: number[], iters: number, lambda: number): void {
  const n = xs.length;
  if (n < 3) return;
  for (let it = 0; it < iters; it++) {
    let px = xs[0], py = ys[0];
    for (let i = 1; i < n - 1; i++) {
      const cx = xs[i], cy = ys[i];
      const tx = (px + xs[i + 1]) / 2;
      const ty = (py + ys[i + 1]) / 2;
      xs[i] = cx + (tx - cx) * lambda;
      ys[i] = cy + (ty - cy) * lambda;
      px = cx; py = cy; // use the PRE-smoothed neighbour for the next vertex
    }
  }
}

/** Core: smooth two parallel coordinate arrays via midpoint-anchored
 *  quadratic Bezier (see file header for the three-region pattern).
 *  Polylines with fewer than 3 source vertices return their input
 *  verbatim (1 or 2 points cannot have interior curvature). */
export function smoothPolylineXY(
  rawXs: readonly number[],
  rawYs: readonly number[],
  samplesPerSeg: number = DEFAULT_SAMPLES_PER_SEG,
): { xs: number[]; ys: number[] } {
  // H837: strip data-error spikes / duplicate vertices first so the
  // smoother never renders a hard backtrack kink.
  const { xs, ys } = cleanPolylineXY(rawXs, rawYs);
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

/** Smooth a CLOSED polygon (lakes, surfaces, buildings, parking lots).
 *  H698: addresses user-reported "lakes don't auto-round" feedback —
 *  closed shapes draw with sharp clicked corners by default, looking
 *  unfinished. Each consecutive corner is rounded with the same
 *  midpoint-Bezier scheme smoothPolyline uses for roads.
 *
 *  The trick: extend the source by ONE copy of the polygon on each
 *  side ([pts, pts, pts]), smooth that open polyline, then keep only
 *  the MIDDLE THIRD of the output. Both ends of the middle third sit
 *  inside the polyline context so no kink remains at the polygon's
 *  start/end vertex — every corner gets the same treatment.
 *
 *  Polygons with fewer than 3 vertices return their input verbatim. */
export function smoothClosedPolygon(
  pts: readonly (readonly [number, number])[],
  samplesPerSeg: number = DEFAULT_SAMPLES_PER_SEG,
): [number, number][] {
  if (pts.length < 3) return pts.map((p) => [p[0], p[1]] as [number, number]);
  const n = pts.length;
  // Triple the polygon so the smoother has full context around every
  // vertex (including the wrap-around). Each leg adds samplesPerSeg
  // samples — smoothPolyline output length is 1 + (3n - 1) * samplesPerSeg.
  const tripled: [number, number][] = [];
  for (let r = 0; r < 3; r++) {
    for (let i = 0; i < n; i++) tripled.push([pts[i][0], pts[i][1]]);
  }
  const smoothed = smoothPolyline(tripled, samplesPerSeg);
  // Middle third = legs [n, 2n). Sample indices = n*samplesPerSeg+1
  // through 2n*samplesPerSeg inclusive (one boundary point + samplesPerSeg
  // per leg × n legs). The slice's last point should equal its first to
  // close the loop, so trim the trailing repeat.
  const start = n * samplesPerSeg;
  const end = 2 * n * samplesPerSeg + 1; // exclusive
  const middle = smoothed.slice(start, end);
  // Drop the trailing duplicate close-on-wrap point.
  if (middle.length > 1 &&
      middle[middle.length - 1][0] === middle[0][0] &&
      middle[middle.length - 1][1] === middle[0][1]) {
    middle.pop();
  }
  return middle;
}

/** Flat-array wrapper for the game's BaselineRoadRow road format
 *  (where coords land as a flat [x1, y1, x2, y2, ...] in tile coords). */
export function smoothFlatPolyline(
  flat: readonly number[],
  samplesPerSeg: number = DEFAULT_SAMPLES_PER_SEG,
): number[] {
  if (flat.length < 6) return [...flat];
  // H1015: CLOSED loop (first vertex == last vertex, e.g. the oval test
  // track) — the open smoother leaves a kink/gap at the wrap-around seam.
  // Route to the closed-polygon smoother (triple-extend context) so the
  // ring is seamless, then re-close for consumers that expect first==last.
  const n = flat.length;
  const closed = n >= 8 && flat[0] === flat[n - 2] && flat[1] === flat[n - 1];
  if (closed) {
    const ring: [number, number][] = [];
    for (let i = 0; i < n - 2; i += 2) ring.push([flat[i], flat[i + 1]]); // drop dup close
    const sm = smoothClosedPolygon(ring, samplesPerSeg);
    const out: number[] = [];
    for (const p of sm) out.push(p[0], p[1]);
    if (sm.length) out.push(sm[0][0], sm[0][1]); // re-close the ring
    return out;
  }
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
