/**
 * Procedural parking-lot stall layout (H697).
 *
 * Computes stall rectangles, drive aisles, and ADA cells inside a
 * parking-lot polygon. Pure function — no state, no rendering — so the
 * editor and the in-game ground renderer can share it.
 *
 * ALGORITHM
 * ---------
 *   1. Pick the polygon's LONGEST EDGE as the row direction (θ).
 *   2. Rotate every point into a local frame where θ → 0 (rows run
 *      along the local +X axis).
 *   3. Compute the axis-aligned bbox in that frame.
 *   4. Lay out a grid of cells across the bbox:
 *        - cell width  = STALL_W (~1 tile, real 9ft)
 *        - cell height = STALL_L (~2 tiles, real 18ft)
 *      and group every two stall rows with one aisle row in between:
 *      `[stall][stall][aisle][stall][stall][aisle]...`
 *   5. For each stall cell, check whether its center lies inside the
 *      rotated polygon — keep, else discard.
 *   6. Mark the FRONT ROW (the row nearest the polygon's anchor edge,
 *      which is the edge perpendicular to the row direction nearest
 *      the centroid) as ADA — typically two cells at a time, the
 *      first MAX_ADA_PER_ROW per kept row.
 *   7. Transform each kept cell's corners back into world (un-rotated)
 *      coordinates and return.
 *
 * COORDINATE SPACE
 * ----------------
 *   Input polygon points are TILE coordinates (the same units the
 *   editor uses everywhere). Output corners are also tile coordinates.
 *   The caller (renderer) multiplies by TILE to get world pixels.
 *
 * TUNING
 * ------
 *   STALL_W / STALL_L / AISLE_W are in tiles. With TILE ~= 10 ft, the
 *   defaults yield a recognizable lot at the game's normal zoom.
 *   These constants are exported so the renderer can pre-test whether
 *   a polygon is large enough to host any stalls before bothering.
 */

/** Stall cell footprint in tile coordinates. Corners are in CCW order
 *  starting from the front-left (driver-entry corner). */
export interface StallCell {
  /** Four corners in TILE coords, world (un-rotated) frame. CCW. */
  corners: [number, number][];
  /** Whether this stall is an ADA (accessible) cell. ADA cells render
   *  cyan in both editor and game. */
  ada: boolean;
}

/** Drive aisle band footprint in tile coordinates. Just the four corners
 *  of one rectangular aisle row. Rendered as a thin painted line, not
 *  filled — the underlying tile=18/19 is already drivable. */
export interface AisleBand {
  corners: [number, number][];
}

/** H700: tree-island endcap. One per row-end (front + back of each
 *  stall row). The renderer paints a tan planter rectangle + a green
 *  tree blob centered inside. Same coord conventions as StallCell. */
export interface TreeIsland {
  corners: [number, number][];
}

/** Output of computeStallLayout. */
export interface StallLayout {
  /** Row direction in radians (the longest-edge angle). Useful for the
   *  renderer to know which way the stalls face. */
  angle: number;
  stalls: StallCell[];
  aisles: AisleBand[];
  /** H700: tree-island endcaps. Empty when the lot is too narrow to
   *  fit both a planter and any stalls in a row. */
  treeIslands: TreeIsland[];
}

/** Default stall + aisle dimensions in tile units (1×2 tiles ≈ 9ft × 18ft
 *  for TILE=18px representing ~10ft per tile). Per-lot overrides land in
 *  the row's meta block (H699). */
export const DEFAULT_STALL_W = 1.0;
export const DEFAULT_STALL_L = 2.0;
export const DEFAULT_AISLE_W = 2.0;
/** Default maximum ADA stalls per row near the anchor edge (H697). H703
 *  exposes this as a runtime param via LayoutParams.maxAdaPerRow so the
 *  user can dial accessibility seating up or down. */
export const DEFAULT_MAX_ADA_PER_ROW = 2;

/** Per-call layout parameters. All in tile units. H699 routes per-lot
 *  stall+aisle dimensions; H703 adds maxAdaPerRow as an editor-wide
 *  setting. */
export interface LayoutParams {
  stallW: number;
  stallL: number;
  aisleW: number;
  /** Max ADA cells in the FIRST (anchor-adjacent) stall row. 0 disables
   *  ADA entirely. Defaults to DEFAULT_MAX_ADA_PER_ROW when omitted. */
  maxAdaPerRow?: number;
}

/** Even-odd point-in-polygon test on flat-array polygons. Same algorithm
 *  as editor/stamp.ts but operating in the rotated frame. */
function pointInPolygon(x: number, y: number, pts: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1];
    const xj = pts[j][0], yj = pts[j][1];
    const intersect = (yi > y) !== (yj > y) &&
      x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Compute the longest-edge angle of a polygon, in radians. */
function longestEdgeAngle(pts: [number, number][]): number {
  let bestLen2 = -1;
  let bestAngle = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    if (len2 > bestLen2) {
      bestLen2 = len2;
      bestAngle = Math.atan2(dy, dx);
    }
  }
  return bestAngle;
}

/** Compute procedural stall layout for a parking-lot polygon. Returns
 *  empty lists if the polygon is degenerate or too small for any stalls.
 *  Pure function — call site is responsible for caching if needed.
 *
 *  Inputs are TILE coordinates; outputs are TILE coordinates. H699 added
 *  the params arg so per-lot stall/aisle dimensions baked into the row
 *  meta block flow through; callers that don't supply it get the
 *  DEFAULT_STALL_W / DEFAULT_STALL_L / DEFAULT_AISLE_W constants. */
export function computeStallLayout(
  polygonPts: [number, number][],
  params: LayoutParams = {
    stallW: DEFAULT_STALL_W,
    stallL: DEFAULT_STALL_L,
    aisleW: DEFAULT_AISLE_W,
  },
): StallLayout {
  const empty: StallLayout = { angle: 0, stalls: [], aisles: [], treeIslands: [] };
  if (!polygonPts || polygonPts.length < 3) return empty;
  const { stallW: STALL_W, stallL: STALL_L, aisleW: AISLE_W } = params;
  const maxAdaPerRow = Math.max(0, params.maxAdaPerRow ?? DEFAULT_MAX_ADA_PER_ROW);

  const angle = longestEdgeAngle(polygonPts);
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);

  // Centroid in world frame — used as the rotation origin so the
  // local-frame bbox sits symmetrically around (0,0).
  let cx = 0, cy = 0;
  for (const p of polygonPts) { cx += p[0]; cy += p[1]; }
  cx /= polygonPts.length;
  cy /= polygonPts.length;

  // Rotate the polygon into the local frame.
  const localPoly: [number, number][] = polygonPts.map((p) => {
    const dx = p[0] - cx;
    const dy = p[1] - cy;
    return [dx * cos - dy * sin, dx * sin + dy * cos] as [number, number];
  });

  // Local-frame bbox.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of localPoly) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  if (!(maxX > minX) || !(maxY > minY)) return empty;

  // Lay out band rows along the Y axis: [stall][stall][aisle][stall][stall][aisle]...
  // Start at minY; each band has a known height. Stall bands alternate
  // with aisle bands; pair every 2 stall bands with 1 aisle between
  // pairs. To keep the pattern simple, the loop walks band-by-band.
  const stalls: StallCell[] = [];
  const aisles: AisleBand[] = [];
  const treeIslands: TreeIsland[] = [];

  // Cell back-to-world transform reused for every kept stall/aisle.
  const cosBack = Math.cos(angle);
  const sinBack = Math.sin(angle);
  const localToWorld = (lx: number, ly: number): [number, number] => {
    return [cx + lx * cosBack - ly * sinBack, cy + lx * sinBack + ly * cosBack];
  };

  // Anchor edge = the bottom edge of the local bbox (closest to the
  // polygon's "front"). The first stall row above the anchor gets
  // ADA cells — chosen this way so ADA sits at the lot entry visible
  // to drivers.
  let row = 0; // row index within the alternating-band sequence
  let bandY = minY;
  while (bandY < maxY) {
    // Stall band 1
    const y0 = bandY;
    const y1 = bandY + STALL_L;
    if (y1 > maxY) break;
    layoutStallRow(y0, y1, minX, maxX, STALL_W, maxAdaPerRow, localPoly, localToWorld, row, stalls, treeIslands);
    bandY = y1;
    row++;
    if (bandY >= maxY) break;
    // Stall band 2
    const y2 = bandY + STALL_L;
    if (y2 > maxY) break;
    layoutStallRow(bandY, y2, minX, maxX, STALL_W, maxAdaPerRow, localPoly, localToWorld, row, stalls, treeIslands);
    bandY = y2;
    row++;
    if (bandY >= maxY) break;
    // Aisle band
    const y3 = bandY + AISLE_W;
    if (y3 > maxY) break;
    layoutAisle(bandY, y3, minX, maxX, localPoly, localToWorld, aisles);
    bandY = y3;
  }

  return { angle, stalls, aisles, treeIslands };
}

/** Lay out one row of stall cells across a band, keeping only cells
 *  whose centers lie inside the rotated polygon. Marks first
 *  MAX_ADA_PER_ROW cells of the FIRST (row=0) band as ADA. H699 added
 *  STALL_W as a parameter so per-lot widths flow from the row. */
function layoutStallRow(
  y0: number,
  y1: number,
  minX: number,
  maxX: number,
  STALL_W: number,
  maxAdaPerRow: number,
  localPoly: [number, number][],
  localToWorld: (lx: number, ly: number) => [number, number],
  row: number,
  out: StallCell[],
  treeIslandsOut: TreeIsland[],
): void {
  if (STALL_W <= 0) return;
  const midY = (y0 + y1) * 0.5;
  // H700: capture which cells fall inside the polygon for this row.
  // Then the FIRST and LAST inside-cell become tree-island endcaps;
  // the rest are stalls. If only one cell fits, it stays a stall (no
  // island) — endcap-with-no-stalls would just look like a planter
  // with no purpose.
  const candidates: number[] = [];
  for (let x = minX; x + STALL_W <= maxX; x += STALL_W) {
    const midX = x + STALL_W * 0.5;
    if (pointInPolygon(midX, midY, localPoly)) candidates.push(x);
  }
  if (candidates.length === 0) return;
  // Helper — push a cell (corners CCW from front-left).
  const cellCorners = (x: number): [number, number][] => ([
    localToWorld(x, y0),
    localToWorld(x + STALL_W, y0),
    localToWorld(x + STALL_W, y1),
    localToWorld(x, y1),
  ]);
  const islandIndices = new Set<number>();
  if (candidates.length >= 3) {
    // Two endcaps + at least one stall in between.
    islandIndices.add(0);
    islandIndices.add(candidates.length - 1);
  }
  let adaCount = 0;
  for (let idx = 0; idx < candidates.length; idx++) {
    const x = candidates[idx];
    if (islandIndices.has(idx)) {
      treeIslandsOut.push({ corners: cellCorners(x) });
      continue;
    }
    const ada = row === 0 && adaCount < maxAdaPerRow;
    if (ada) adaCount++;
    out.push({ corners: cellCorners(x), ada });
  }
}

/** Lay out one aisle band — a single rectangle clipped to the polygon's
 *  x-extent intersected with the band. Stored as one rectangle (the
 *  renderer may further intersect with the polygon outline when
 *  drawing). */
function layoutAisle(
  y0: number,
  y1: number,
  minX: number,
  maxX: number,
  localPoly: [number, number][],
  localToWorld: (lx: number, ly: number) => [number, number],
  out: AisleBand[],
): void {
  // Find the polygon's x-range AT THIS BAND by sampling — use the
  // midpoint y. Walk the polygon edges and collect intersections of the
  // horizontal line y=midY with each edge; the aisle x-extent is
  // [min(intersections), max(intersections)] clipped to [minX, maxX].
  const midY = (y0 + y1) * 0.5;
  let xMin = Infinity, xMax = -Infinity;
  for (let i = 0; i < localPoly.length; i++) {
    const a = localPoly[i];
    const b = localPoly[(i + 1) % localPoly.length];
    const ay = a[1], by = b[1];
    if ((ay <= midY && by > midY) || (by <= midY && ay > midY)) {
      const t = (midY - ay) / (by - ay);
      const xi = a[0] + t * (b[0] - a[0]);
      if (xi < xMin) xMin = xi;
      if (xi > xMax) xMax = xi;
    }
  }
  if (!(xMax > xMin)) return;
  xMin = Math.max(xMin, minX);
  xMax = Math.min(xMax, maxX);
  if (!(xMax > xMin)) return;
  out.push({
    corners: [
      localToWorld(xMin, y0),
      localToWorld(xMax, y0),
      localToWorld(xMax, y1),
      localToWorld(xMin, y1),
    ],
  });
}
