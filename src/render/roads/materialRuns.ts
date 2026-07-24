/**
 * H1215: shared helpers for the per-section material-override "slow
 * path" in BOTH renderers (game strokeRoad + editor _drawRoadAsphaltPass).
 *
 * The editor writes `materialOverrides[].seg` as RAW polyline segment
 * indices (span writer delete.ts, section picker input.ts, span.ts
 * partitioning — all raw-space). The game render strokes the SMOOTHED
 * polyline (pathSmoothing, ~14 samples per cleaned leg), so it needs a
 * smoothed-segment → raw-segment ownership map to resolve each dense
 * sub-segment's material. Index arithmetic (seg*14) is NOT safe:
 * cleanPolylineXY may drop duplicate/spike vertices and closed loops
 * take a different sampling layout — so the map is built by NORMALIZED
 * ARC LENGTH, which is robust to both.
 */

/** Map each segment of a smoothed polyline to the raw segment that owns
 *  it, by normalized arc length (monotone two-pointer — O(n)). Flat
 *  [x0,y0,x1,y1,...] inputs in the same coordinate space. Returns one
 *  entry per smoothed SEGMENT (length = smoothed point count - 1). */
export function buildSmoothedSegRawMap(
  rawFlat: readonly number[],
  smoothedFlat: readonly number[],
): Int32Array {
  const nRawPts = rawFlat.length >> 1;
  const nSmPts = smoothedFlat.length >> 1;
  const nSmSegs = Math.max(0, nSmPts - 1);
  const map = new Int32Array(nSmSegs);
  const nRawSegs = nRawPts - 1;
  if (nRawSegs <= 0 || nSmSegs === 0) return map;

  const rawCum = new Float64Array(nRawPts);
  for (let i = 1; i < nRawPts; i++) {
    rawCum[i] = rawCum[i - 1] + Math.hypot(
      rawFlat[i * 2] - rawFlat[(i - 1) * 2],
      rawFlat[i * 2 + 1] - rawFlat[(i - 1) * 2 + 1],
    );
  }
  const smCum = new Float64Array(nSmPts);
  for (let i = 1; i < nSmPts; i++) {
    smCum[i] = smCum[i - 1] + Math.hypot(
      smoothedFlat[i * 2] - smoothedFlat[(i - 1) * 2],
      smoothedFlat[i * 2 + 1] - smoothedFlat[(i - 1) * 2 + 1],
    );
  }
  const rawTotal = rawCum[nRawPts - 1];
  const smTotal = smCum[nSmPts - 1];
  if (rawTotal <= 0 || smTotal <= 0) return map;

  let r = 0;
  for (let s = 0; s < nSmSegs; s++) {
    // Owner of the sub-segment = raw leg containing its arc MIDPOINT.
    const mid = ((smCum[s] + smCum[s + 1]) / 2 / smTotal) * rawTotal;
    while (r < nRawSegs - 1 && rawCum[r + 1] <= mid) r++;
    map[s] = r;
  }
  return map;
}

/** One contiguous stretch of segments sharing a resolved material+age.
 *  `from`..`to` are inclusive SEGMENT indices into the polyline the
 *  caller strokes (smoothed for the game, smoothed for the editor). */
export interface MaterialRun {
  from: number;
  to: number;
  material?: string;
  age?: string;
}

/** Group `nSegs` polyline segments into contiguous same-(material, age)
 *  runs. `resolve(seg)` receives the RAW segment index when `segRaw` is
 *  provided (game/editor smoothed stroking), else the segment index
 *  verbatim. Stroking one path per run (lineCap 'butt', lineJoin
 *  'round') replaces the old per-segment round-capped strokes — which
 *  extruded a road-width half-disc past BOTH road termini (the split-
 *  joint "dark semicircle") and cost a stroke call per dense segment. */
export function groupMaterialRuns(
  nSegs: number,
  segRaw: Int32Array | null,
  resolve: (seg: number) => { material?: string; age?: string },
): MaterialRun[] {
  const runs: MaterialRun[] = [];
  if (nSegs <= 0) return runs;
  let cur = resolve(segRaw ? segRaw[0] : 0);
  let from = 0;
  for (let s = 1; s < nSegs; s++) {
    const eff = resolve(segRaw ? segRaw[s] : s);
    if (eff.material !== cur.material || eff.age !== cur.age) {
      runs.push({ from, to: s - 1, material: cur.material, age: cur.age });
      from = s;
      cur = eff;
    }
  }
  runs.push({ from, to: nSegs - 1, material: cur.material, age: cur.age });
  return runs;
}
