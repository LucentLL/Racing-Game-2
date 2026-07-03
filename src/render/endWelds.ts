/**
 * H993: endpoint-to-endpoint WELD seam planes.
 *
 * When two same-z roads butt-join end-to-end (H962 weld doctrine snaps
 * their endpoints together), each road's render previously painted its
 * full-width asphalt band, gray edge-band tint, and markings straight
 * across the joint — the later-painted road's "butt" region layered over
 * the earlier road's finished surface (worst with mismatched materials:
 * a concrete road's tan slab + band visibly overlapping a dark highway).
 *
 * The fix: give BOTH roads a clip half-plane through the shared endpoint,
 * oriented along the bisector of their end tangents. Each road renders
 * only its own side, so the two surfaces meet at ONE straight transverse
 * joint — like a real construction joint. No overlap; the SEAM_EPS
 * keep-side overshoot (sub-pixel) prevents anti-aliasing from opening a
 * hairline gap between the clipped edges.
 *
 * Scope: END-to-END welds between exactly two roads only. T-junctions
 * (endpoint onto a mid-segment) keep the existing tee machinery; corner
 * joints and 3-way endpoint clusters are skipped (clipping those would
 * cut visible pavement). Merge/connector rows are excluded — their
 * geometry is bonder output with its own tapers.
 *
 * Pure module (tile-coord in, tile-coord out) shared by the game render
 * (worldMap.ts strokeRoad) and the editor game-parity render so both
 * pipelines show the same joint.
 */

/** One clip half-plane: point on the seam + unit normal pointing OUTWARD
 *  (the side to clip away). Same coordinate space as the input pts. */
export interface WeldPlane {
  x: number;
  y: number;
  nx: number;
  ny: number;
}

/** Minimal road shape the scan needs. `skip` excludes merge rows,
 *  deleted-baseline placeholders keep pts=[] and fall out naturally. */
export interface WeldRoadLike {
  pts: ReadonlyArray<ReadonlyArray<number>>;
  z: number;
  skip?: boolean;
}

/** Endpoints closer than this (tiles) are one weld. Matches the spirit of
 *  ENDCAP_CONNECT_SLACK; welded coords are toFixed(2)-exact in practice. */
const WELD_TOL = 0.6;
/** Outward end tangents must roughly OPPOSE (dot below this) — a
 *  continuation joint, not an L-corner (dot≈0) or side-by-side parallel
 *  termini (dot≈+1), where a bisector clip would cut visible pavement. */
const OPPOSE_DOT_MAX = -0.3;
/** Keep-side overshoot (tiles, ~sub-pixel) so both clipped edges overlap
 *  by a hair instead of AA opening a seam. */
const SEAM_EPS = 0.02;

/** Compute per-road weld clip planes. Returns one entry per input road:
 *  null (no welds) or the list of planes for that road's welded ends. */
export function computeEndWelds(
  roads: readonly WeldRoadLike[],
): Array<WeldPlane[] | null> {
  interface Ep { r: number; x: number; y: number; tx: number; ty: number }
  const eps: Ep[] = [];
  for (let r = 0; r < roads.length; r++) {
    const road = roads[r];
    if (road.skip) continue;
    const pts = road.pts;
    if (!pts || pts.length < 2) continue;
    const push = (e: ReadonlyArray<number>, n: ReadonlyArray<number>): void => {
      const dx = e[0] - n[0];
      const dy = e[1] - n[1];
      const L = Math.hypot(dx, dy);
      if (L < 1e-6) return;
      eps.push({ r, x: e[0], y: e[1], tx: dx / L, ty: dy / L });
    };
    push(pts[0], pts[1]);                                 // start, outward
    push(pts[pts.length - 1], pts[pts.length - 2]);       // end, outward
  }

  const out: Array<WeldPlane[] | null> = roads.map(() => null);
  const tol2 = WELD_TOL * WELD_TOL;
  for (let i = 0; i < eps.length; i++) {
    const A = eps[i];
    // Exactly ONE counterpart endpoint → a clean two-road butt weld.
    let match: Ep | null = null;
    let matches = 0;
    for (let j = 0; j < eps.length; j++) {
      if (j === i) continue;
      const B = eps[j];
      if (B.r === A.r) continue;
      if (roads[A.r].z !== roads[B.r].z) continue;
      const dx = B.x - A.x;
      const dy = B.y - A.y;
      if (dx * dx + dy * dy > tol2) continue;
      matches++;
      if (matches > 1) break;
      match = B;
    }
    if (matches !== 1 || !match) continue;
    if (A.tx * match.tx + A.ty * match.ty > OPPOSE_DOT_MAX) continue;
    // Seam normal = bisector of (my outward, their inward) — for a
    // collinear continuation this is exactly my tangent, i.e. a
    // perpendicular transverse joint.
    let nx = A.tx - match.tx;
    let ny = A.ty - match.ty;
    const L = Math.hypot(nx, ny) || 1;
    nx /= L;
    ny /= L;
    const mx = (A.x + match.x) / 2;
    const my = (A.y + match.y) / 2;
    (out[A.r] ??= []).push({ x: mx + nx * SEAM_EPS, y: my + ny * SEAM_EPS, nx, ny });
  }
  return out;
}

/** Apply weld clip planes to a 2D context (caller must ctx.save() first
 *  and ctx.restore() after painting). Coordinates of `planes` must be in
 *  the ctx's drawing space; `extent` is a "big enough" half-size for the
 *  clip quads (world-px: pass ~1e6; screen-px: canvas diagonal works). */
export function applyWeldClips(
  ctx: CanvasRenderingContext2D,
  planes: readonly WeldPlane[],
  extent: number,
): void {
  for (const wl of planes) {
    const txv = -wl.ny;
    const tyv = wl.nx;
    const ax = wl.x + txv * extent;
    const ay = wl.y + tyv * extent;
    const bx = wl.x - txv * extent;
    const by = wl.y - tyv * extent;
    const p = new Path2D();
    p.moveTo(ax, ay);
    p.lineTo(bx, by);
    p.lineTo(bx - wl.nx * extent, by - wl.ny * extent);
    p.lineTo(ax - wl.nx * extent, ay - wl.ny * extent);
    p.closePath();
    ctx.clip(p);
  }
}
