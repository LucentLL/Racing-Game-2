/**
 * H1244: polyline-following race AI.
 *
 * Before this, opponents could steer exactly two ways: pinned to +y down the
 * drag strip, and around a parametric ellipse on the oval (trackRace.advanceOpp).
 * Neither gets a car around Monza. This follows an ARBITRARY closed centerline
 * — which is what every real circuit is — with a corner-speed model, so the AI
 * lifts for the Variante and stretches its legs down the straight.
 *
 * The car rides the path on rails (an arc-length cursor, like the oval did)
 * rather than being driven through the physics steering. That's deliberate: it
 * cannot understeer into the grass, cannot spin, and is cheap for a 7-car
 * field. Longitudinal motion still goes through the SAME advanceOppPhysics the
 * drag/oval opponents use, so gearing and power differences between cars still
 * read on track.
 *
 * Corner speed is v = sqrt(a_lat * R) with the radius measured from the baked
 * centerline, evaluated over a look-ahead window so the car brakes BEFORE the
 * corner instead of on the apex.
 */
import { WPX_PER_M } from '@/config/world/tiles';

/** Lateral grip the AI plans corners around, in m/s^2. ~0.95 g — a quick road
 *  car on warm tyres. Scaled per-car by the driver's skill. */
const BASE_LAT_ACCEL = 9.3;
/** How far ahead (metres) to look for the tightest upcoming corner. Roughly a
 *  braking zone from ~200 km/h. */
const LOOKAHEAD_M = 95;
/** Radius (m) at or above which a corner imposes no speed limit at all. */
const STRAIGHT_R = 900;

export interface TrackPath {
  /** Flat [x0,y0,x1,y1,...] in WORLD PIXELS. */
  pts: number[];
  /** cum[i] = arc length (world px) from pts[0] to vertex i. */
  cum: number[];
  /** Total closed length (world px). */
  total: number;
  /** Corner radius (world px) at each vertex; Infinity on a straight. */
  radius: number[];
  closed: boolean;
}

/** Circumradius of three points — the local corner radius. Infinity when the
 *  points are collinear (a straight). */
function circumRadius(
  ax: number, ay: number, bx: number, by: number, cx: number, cy: number,
): number {
  const a = Math.hypot(bx - cx, by - cy);
  const b = Math.hypot(ax - cx, ay - cy);
  const c = Math.hypot(ax - bx, ay - by);
  // Twice the triangle area via the cross product.
  const area2 = Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay));
  if (area2 < 1e-6) return Infinity;
  return (a * b * c) / (2 * area2);
}

/**
 * Build a followable path from a smoothed centerline.
 *
 * `smoothed` is in TILE coords (RENDER_ENTRIES.smoothed); `tile` converts to
 * world px. Points are RESAMPLED to a roughly even spacing first — the baked
 * geometry has wildly uneven vertex density, and an unresampled curvature
 * estimate reads clustered vertices as hairpins and puts phantom corners on
 * the straights.
 */
export function buildTrackPath(smoothed: readonly number[], tile: number): TrackPath | null {
  if (!smoothed || smoothed.length < 6) return null;
  const raw: number[] = [];
  for (let i = 0; i + 1 < smoothed.length; i += 2) {
    raw.push(smoothed[i] * tile, smoothed[i + 1] * tile);
  }
  const n = raw.length / 2;
  const closed = Math.hypot(raw[0] - raw[(n - 1) * 2], raw[1] - raw[(n - 1) * 2 + 1]) < tile;

  // Resample at ~1.5 tiles so curvature is measured over a consistent baseline.
  const STEP = tile * 1.5;
  const pts: number[] = [raw[0], raw[1]];
  let carry = 0;
  for (let i = 0; i + 3 < raw.length; i += 2) {
    const x0 = raw[i], y0 = raw[i + 1], x1 = raw[i + 2], y1 = raw[i + 3];
    const segLen = Math.hypot(x1 - x0, y1 - y0);
    if (segLen < 1e-6) continue;
    let d = STEP - carry;
    while (d <= segLen) {
      const t = d / segLen;
      pts.push(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
      d += STEP;
    }
    carry = (carry + segLen) % STEP;
  }
  if (pts.length < 6) return null;

  const m = pts.length / 2;
  const cum: number[] = new Array(m);
  cum[0] = 0;
  for (let i = 1; i < m; i++) {
    cum[i] = cum[i - 1] + Math.hypot(pts[i * 2] - pts[(i - 1) * 2], pts[i * 2 + 1] - pts[(i - 1) * 2 + 1]);
  }
  let total = cum[m - 1];
  if (closed) {
    total += Math.hypot(pts[0] - pts[(m - 1) * 2], pts[1] - pts[(m - 1) * 2 + 1]);
  }

  // Curvature over a WIDER stencil than adjacent vertices: at 1.5-tile spacing
  // neighbouring points are nearly collinear even in a real corner, so a tight
  // stencil reports Infinity almost everywhere.
  const K = 5;
  const radius: number[] = new Array(m);
  for (let i = 0; i < m; i++) {
    const ia = closed ? (i - K + m) % m : Math.max(0, i - K);
    const ib = closed ? (i + K) % m : Math.min(m - 1, i + K);
    radius[i] = circumRadius(
      pts[ia * 2], pts[ia * 2 + 1], pts[i * 2], pts[i * 2 + 1], pts[ib * 2], pts[ib * 2 + 1],
    );
  }

  // Smooth CURVATURE (1/R), not radius. The centerlines come from OSM traces
  // and carry vertex noise; because the look-ahead takes the tightest radius in
  // the window, a single noisy vertex read as a hairpin makes the AI crawl
  // through a fast corner. Averaging radius directly is useless — the Infinity
  // of a straight swamps it — but curvature averages cleanly (a straight is
  // simply 0). Measured effect: Spa's slowest corner went from 39 to a sane
  // speed and lap times dropped toward real-world pace.
  const curv = radius.map((r) => (isFinite(r) && r > 1e-6 ? 1 / r : 0));
  for (let pass = 0; pass < 2; pass++) {
    const src = curv.slice();
    for (let i = 0; i < m; i++) {
      const a = closed ? (i - 1 + m) % m : Math.max(0, i - 1);
      const b = closed ? (i + 1) % m : Math.min(m - 1, i + 1);
      curv[i] = (src[a] + src[i] * 2 + src[b]) / 4;
    }
  }
  for (let i = 0; i < m; i++) radius[i] = curv[i] > 1e-9 ? 1 / curv[i] : Infinity;

  return { pts, cum, total, radius, closed };
}

/** Per-car cursor along a TrackPath. */
export interface TrackAiState {
  /** Arc-length position (world px). Grows without bound; lap = s / total. */
  s: number;
  /** Lateral offset from the centerline (world px). Spreads the field out. */
  lane: number;
  /** 0.90 .. 1.03 — scales both corner grip and straight-line pace so the
   *  field isn't a train of identical cars. */
  skill: number;
  lap: number;
}

/** Vertex index at or before arc length `s` (wrapped for a closed path). */
function idxAt(path: TrackPath, s: number): number {
  const m = path.cum.length;
  let d = s;
  if (path.closed) {
    d = ((s % path.total) + path.total) % path.total;
  } else {
    d = Math.max(0, Math.min(path.cum[m - 1], s));
  }
  // Binary search the cumulative table.
  let lo = 0, hi = m - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (path.cum[mid] <= d) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** Pose (world px + heading) at arc length `s`, offset `lane` to the side. */
export function poseAt(path: TrackPath, s: number, lane: number): { x: number; y: number; angle: number } {
  const m = path.cum.length;
  const i = idxAt(path, s);
  const j = path.closed ? (i + 1) % m : Math.min(m - 1, i + 1);
  const segLen = Math.max(1e-6,
    Math.hypot(path.pts[j * 2] - path.pts[i * 2], path.pts[j * 2 + 1] - path.pts[i * 2 + 1]));
  const d = path.closed ? ((s % path.total) + path.total) % path.total : Math.max(0, Math.min(path.cum[m - 1], s));
  const t = Math.max(0, Math.min(1, (d - path.cum[i]) / segLen));
  const x = path.pts[i * 2] + (path.pts[j * 2] - path.pts[i * 2]) * t;
  const y = path.pts[i * 2 + 1] + (path.pts[j * 2 + 1] - path.pts[i * 2 + 1]) * t;
  const dx = path.pts[j * 2] - path.pts[i * 2];
  const dy = path.pts[j * 2 + 1] - path.pts[i * 2 + 1];
  const angle = Math.atan2(dy, dx);
  // Left-hand normal for the lane offset.
  const nl = Math.hypot(dx, dy) || 1;
  return { x: x + (-dy / nl) * lane, y: y + (dx / nl) * lane, angle };
}

/**
 * Speed cap (world px/s) for the tightest corner within the look-ahead window
 * from `s`. This is what makes the AI lift before a corner rather than on it.
 */
export function cornerSpeedCap(path: TrackPath, s: number, skill: number): number {
  const m = path.cum.length;
  const start = idxAt(path, s);
  const aheadPx = LOOKAHEAD_M * WPX_PER_M;
  const straightPx = STRAIGHT_R * WPX_PER_M;
  let minR = Infinity;
  let walked = 0;
  for (let k = 0; k < m && walked < aheadPx; k++) {
    const i = path.closed ? (start + k) % m : Math.min(m - 1, start + k);
    const r = path.radius[i];
    if (r < minR) minR = r;
    const j = path.closed ? (i + 1) % m : Math.min(m - 1, i + 1);
    walked += Math.hypot(path.pts[j * 2] - path.pts[i * 2], path.pts[j * 2 + 1] - path.pts[i * 2 + 1]);
    if (!path.closed && i === m - 1) break;
  }
  if (!isFinite(minR) || minR >= straightPx) return Infinity;
  // v = sqrt(a_lat * R). Work in metres, return world px/s.
  const rM = minR / WPX_PER_M;
  const vMs = Math.sqrt(BASE_LAT_ACCEL * skill * rM);
  return vMs * WPX_PER_M;
}

/** Advance a cursor one frame. `speed` is world px/s (already advanced by
 *  advanceOppPhysics and capped by the caller). Returns the new pose. */
export function advanceTrackAI(
  ai: TrackAiState,
  path: TrackPath,
  speed: number,
  dt: number,
): { x: number; y: number; angle: number } {
  ai.s += speed * dt;
  if (path.closed && path.total > 0) {
    const lap = Math.floor(ai.s / path.total);
    if (lap > ai.lap) ai.lap = lap;
  }
  return poseAt(path, ai.s, ai.lane);
}

/** Arc length of the point on `path` nearest (x, y). Used to place the PLAYER
 *  on the same progress scale as the AI so race position is comparable. */
export function nearestS(path: TrackPath, x: number, y: number): number {
  const m = path.cum.length;
  let best = 0, bestD = Infinity;
  for (let i = 0; i < m; i++) {
    const d = (path.pts[i * 2] - x) ** 2 + (path.pts[i * 2 + 1] - y) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return path.cum[best];
}
