/**
 * H984 — CONSTRUCTIVE LANE CONNECTOR (docs/ROADSPEC.md, Stage 1).
 *
 * Pure geometry: given two directed lane anchors (position + unit travel
 * direction, already resolved to lane centers), build the DRIVE PATH of a
 * connector lane as: departure run along the source direction → equal-
 * tangent-length BIARC honoring both tangents → arrival run into the
 * destination anchor. One code path for every tangent pair — 0°, 90°,
 * 180°, 270° loops all fall out of the same closed form. No merge-type
 * modes; the geometry is fully determined by the two anchors.
 *
 * This module is deliberately free of editor/game imports (unit-testable
 * headlessly in node — tools/mergelab/builder_matrix.mjs). Stage 2 wires
 * it behind _weMergeBondEndpoints when both lane-click targets are
 * present, resolving anchors from BondTargets.
 *
 * Biarc construction (equal tangent lengths; cf. OpenDRIVE junction
 * connectors and the classic biarc interpolation form):
 *   v = p1 − p0,  t = t0 + t1,  denom = 2·(1 − t0·t1)
 *   d = (−v·t + sqrt((v·t)² + denom·(v·v))) / denom     (denom > ε)
 *   joint J = (p0 + p1 + d·(t0 − t1)) / 2
 * Degenerate ladder:
 *   F-collinear: tangents parallel AND joint on the line → straight.
 *   F-parallel:  t0·t1 = 1 with lateral offset → two half-circle S
 *                (the lane-change case; d from |v|²/(4·v·t1) when v·t1>0,
 *                else the S constructed via the same joint formula with
 *                d = |v|/2).
 *   F-radius:    if either arc radius < rMin, LENGTHEN both runs (never
 *                sharpen a kink) and retry, up to MAX_REPLAN times.
 */

export type Vec2 = readonly [number, number];

export interface LaneAnchor {
  /** Point on the lane center (tile units). */
  pt: Vec2;
  /** Unit travel direction of that lane. */
  dir: Vec2;
}

export interface ConnectorOpts {
  /** Departure run length along src.dir before the curve (tiles). */
  runSrc?: number;
  /** Arrival run length along dst.dir before dst.pt (tiles). */
  runDst?: number;
  /** Minimum acceptable arc radius (tiles) — AASHTO-scaled floor. */
  rMin?: number;
  /** Sample spacing along arcs (tiles). */
  step?: number;
}

export interface ConnectorResult {
  /** Drive-path polyline from src.pt to dst.pt inclusive. */
  pts: Array<[number, number]>;
  /** Smaller of the two biarc radii (Infinity for straight). */
  minRadius: number;
  /** Total arc length of the curved section. */
  curveLen: number;
  /** How many radius-floor replans were needed (0 = first try). */
  replans: number;
  /** Which construction produced the curve. */
  kind: 'straight' | 'biarc' | 'parallel-s';
  /** True when the path is clean but the tightest arc misses the AASHTO
   *  radius floor (tight-quarters best effort) — Stage 3 surfaces this
   *  as a warning ring instead of silently rejecting. */
  belowFloor: boolean;
}

const EPS = 1e-9;

function add(a: Vec2, b: Vec2): [number, number] { return [a[0] + b[0], a[1] + b[1]]; }
function sub(a: Vec2, b: Vec2): [number, number] { return [a[0] - b[0], a[1] - b[1]]; }
function mul(a: Vec2, s: number): [number, number] { return [a[0] * s, a[1] * s]; }
function dot(a: Vec2, b: Vec2): number { return a[0] * b[0] + a[1] * b[1]; }
function cross(a: Vec2, b: Vec2): number { return a[0] * b[1] - a[1] * b[0]; }
function len(a: Vec2): number { return Math.hypot(a[0], a[1]); }

/** Sample a circular arc from p0 to p1 whose tangent at p0 is t0.
 *  Handles sweeps beyond 180° (loop halves) via signed center angles.
 *  Returns points EXCLUDING p0, INCLUDING p1; also the radius. */
function sampleArc(
  p0: Vec2, t0: Vec2, p1: Vec2, step: number,
): { pts: Array<[number, number]>; radius: number; arcLen: number } {
  const chord = sub(p1, p0);
  const cl = len(chord);
  if (cl < EPS) return { pts: [], radius: Infinity, arcLen: 0 };
  const x = cross(t0, chord);
  if (Math.abs(x) < 1e-7 * cl) {
    // collinear with the start tangent → straight segment
    const n = Math.max(1, Math.ceil(cl / step));
    const pts: Array<[number, number]> = [];
    for (let i = 1; i <= n; i++) pts.push(add(p0, mul(chord, i / n)));
    return { pts, radius: Infinity, arcLen: cl };
  }
  // circle through p0 with tangent t0: center = p0 + R·n̂, where n̂ ⟂ t0
  // toward the chord side; R from |p1−C| = R.
  // Solve: C = p0 + s·n, n = perp(t0) (unit). |p1 − p0 − s·n|² = s²
  //   ⇒ cl² − 2·s·(chord·n) = 0 ⇒ s = cl² / (2·(chord·n))
  const n: Vec2 = [-t0[1], t0[0]];
  const cn = dot(chord, n);
  const s = (cl * cl) / (2 * cn); // signed radius along n
  const C = add(p0, mul(n, s));
  const R = Math.abs(s);
  const a0 = Math.atan2(p0[1] - C[1], p0[0] - C[0]);
  const a1 = Math.atan2(p1[1] - C[1], p1[0] - C[0]);
  // travel direction around the circle: sign of cross(radial, tangent)
  const ccw = cross(sub(p0, C), t0) > 0;
  let sweep = a1 - a0;
  if (ccw) { while (sweep <= EPS) sweep += 2 * Math.PI; }
  else { while (sweep >= -EPS) sweep -= 2 * Math.PI; }
  const arcLen = Math.abs(sweep) * R;
  const nSeg = Math.max(2, Math.ceil(arcLen / step));
  const pts: Array<[number, number]> = [];
  for (let i = 1; i <= nSeg; i++) {
    const a = a0 + sweep * (i / nSeg);
    pts.push([C[0] + R * Math.cos(a), C[1] + R * Math.sin(a)]);
  }
  return { pts, radius: R, arcLen };
}

/** Equal-tangent-length biarc between two poses. Returns the sampled
 *  curve (excluding p0, including p1) or null when the configuration is
 *  unsolvable (anti-parallel head-on with zero offset). */
function biarc(
  p0: Vec2, t0: Vec2, p1: Vec2, t1: Vec2, step: number,
): { pts: Array<[number, number]>; minRadius: number; arcLen: number; kind: 'straight' | 'biarc' | 'parallel-s' } | null {
  const v = sub(p1, p0);
  const vl = len(v);
  if (vl < EPS) return { pts: [[p1[0], p1[1]]], minRadius: Infinity, arcLen: 0, kind: 'straight' };
  const t = add(t0, t1);
  const tdot = dot(t0, t1);
  // fully collinear same-direction along the chord → straight
  if (tdot > 1 - 1e-9 && Math.abs(cross(t0, v)) < 1e-7 * vl && dot(t0, v) > 0) {
    const a = sampleArc(p0, t0, p1, step);
    return { pts: a.pts, minRadius: Infinity, arcLen: a.arcLen, kind: 'straight' };
  }
  let d: number;
  const denom = 2 * (1 - tdot);
  if (denom > 1e-9) {
    const vt = dot(v, t);
    const disc = vt * vt + denom * (vl * vl);
    d = (-vt + Math.sqrt(disc)) / denom;
  } else {
    // parallel same-direction with lateral offset (lane-change S)
    const vt1 = dot(v, t1);
    if (Math.abs(vt1) < EPS) return null; // pure sideways translation, no forward motion
    d = (vl * vl) / (4 * vt1);
    if (d <= 0) return null; // target behind — Stage 2 handles via waypoint recursion
  }
  if (!isFinite(d) || d <= 0) return null;
  const J: Vec2 = [
    (p0[0] + p1[0] + d * (t0[0] - t1[0])) / 2,
    (p0[1] + p1[1] + d * (t0[1] - t1[1])) / 2,
  ];
  const arc1 = sampleArc(p0, t0, J, step);
  // tangent at J = direction the first arc arrives with
  const lastBeforeJ = arc1.pts.length >= 2 ? arc1.pts[arc1.pts.length - 2] : p0;
  const tj0 = sub(J, lastBeforeJ);
  const tjl = len(tj0);
  const tJ: Vec2 = tjl > EPS ? [tj0[0] / tjl, tj0[1] / tjl] : t0;
  const arc2 = sampleArc(J, tJ, p1, step);
  return {
    pts: [...arc1.pts, ...arc2.pts],
    minRadius: Math.min(arc1.radius, arc2.radius),
    arcLen: arc1.arcLen + arc2.arcLen,
    kind: denom > 1e-9 ? 'biarc' : 'parallel-s',
  };
}

/** Build the connector drive path: src anchor → departure run → biarc →
 *  arrival run → dst anchor. Radius floor triggers run-lengthening
 *  replans (never a kink). */
/** Max turn between consecutive samples a drivable path may contain. */
const KINK_DEG = 32;

function pathIsClean(pts: ReadonlyArray<readonly [number, number]>): boolean {
  // kink check
  for (let i = 1; i + 1 < pts.length; i++) {
    const a = Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]);
    const b = Math.atan2(pts[i + 1][1] - pts[i][1], pts[i + 1][0] - pts[i][0]);
    let d = Math.abs(b - a) * 180 / Math.PI;
    if (d > 180) d = 360 - d;
    if (d > KINK_DEG) return false;
  }
  // self-intersection (non-adjacent segments)
  for (let i = 0; i + 1 < pts.length; i++) {
    for (let j = i + 2; j + 1 < pts.length; j++) {
      if (i === 0 && j + 2 === pts.length) continue;
      const a = pts[i], b = pts[i + 1], c = pts[j], d2 = pts[j + 1];
      const den = (b[0] - a[0]) * (d2[1] - c[1]) - (b[1] - a[1]) * (d2[0] - c[0]);
      if (Math.abs(den) < 1e-12) continue;
      const t = ((c[0] - a[0]) * (d2[1] - c[1]) - (c[1] - a[1]) * (d2[0] - c[0])) / den;
      const u = ((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / den;
      if (t > 0.001 && t < 0.999 && u > 0.001 && u < 0.999) return false;
    }
  }
  return true;
}

export function buildConnectorPath(
  src: LaneAnchor, dst: LaneAnchor, opts?: ConnectorOpts,
): ConnectorResult | null {
  const runSrc0 = opts?.runSrc ?? 7.0;   // AASHTO-scaled decel run
  const runDst0 = opts?.runDst ?? 10.6;  // MERGE_ACCEL_TILES
  const rMin = opts?.rMin ?? 2.7;
  const step = opts?.step ?? 0.75;
  const sep = len(sub(dst.pt, src.pt));
  if (sep < 3) return null;

  // Replan ladder: runs CLAMP to the pose separation (a 14-tile hop can't
  // afford 17.6 tiles of straight runs), then try shorter scales for tight
  // quarters and longer for open ground. First attempt meeting the radius
  // floor with a clean (kink-free, non-self-intersecting) path wins.
  const SCALES = [1, 0.65, 0.4, 0.22, 1.5, 2.0];
  let bestEffort: ConnectorResult | null = null;
  for (let attempt = 0; attempt < SCALES.length; attempt++) {
    const s = SCALES[attempt];
    const runSrc = Math.max(1.2, Math.min(runSrc0 * s, sep * 0.30));
    const runDst = Math.max(1.6, Math.min(runDst0 * s, sep * 0.40));
    const exit: Vec2 = add(src.pt, mul(src.dir, runSrc));
    const entry: Vec2 = sub(dst.pt, mul(dst.dir, runDst));
    const mid = biarc(exit, src.dir, entry, dst.dir, step);
    if (!mid) continue;
    const pts: Array<[number, number]> = [[src.pt[0], src.pt[1]]];
    const nA = Math.max(1, Math.ceil(runSrc / step));
    for (let i = 1; i <= nA; i++) pts.push(add(src.pt, mul(src.dir, (runSrc * i) / nA)));
    pts.push(...mid.pts);
    const nB = Math.max(1, Math.ceil(runDst / step));
    for (let i = 1; i <= nB; i++) pts.push(add(entry, mul(dst.dir, (runDst * i) / nB)));
    pts[pts.length - 1] = [dst.pt[0], dst.pt[1]];
    const out: Array<[number, number]> = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const q = out[out.length - 1];
      if (Math.hypot(pts[i][0] - q[0], pts[i][1] - q[1]) > 0.05) out.push(pts[i]);
    }
    if (out.length < 3) continue;
    out[out.length - 1] = [dst.pt[0], dst.pt[1]];
    const res: ConnectorResult = {
      pts: out, minRadius: mid.minRadius, curveLen: mid.arcLen, replans: attempt, kind: mid.kind,
      belowFloor: mid.minRadius < rMin,
    };
    const clean = pathIsClean(out);
    if (clean && mid.minRadius >= rMin) return res;
    if (clean && (!bestEffort || res.minRadius > bestEffort.minRadius)) bestEffort = res;
  }
  // A clean path that misses the radius floor beats nothing — flagged
  // belowFloor so Stage 3 shows a warning ring. A kinked/self-crossing
  // path is NEVER returned (unsolvable without a waypoint — spec F3).
  return bestEffort && bestEffort.minRadius >= rMin * 0.6 ? bestEffort : null;
}
