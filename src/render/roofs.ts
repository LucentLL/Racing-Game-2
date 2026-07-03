/**
 * H1004: shared roof + driveway polygon rendering.
 *
 * Editor-placed buildings and their driveways previously rendered per-TILE
 * (a staircased blob) with a translucent editor box on top. This paints
 * them as clean FOOTPRINT POLYGONS with an aerial-view read:
 *   - residential (house / trailer / apartment) → a SHINGLE roof: a solid
 *     base with a ridge line down the long axis + an eave-shadow border,
 *     colour varied per-building so a street of houses isn't monochrome.
 *   - commercial (dealership / mechanic / junkyard / autoparts) → a FLAT
 *     concrete roof: light gravel fill + a darker parapet edge + a couple
 *     of rooftop HVAC units.
 *   - driveways → a solid concrete strip.
 *
 * Coordinate-agnostic: the caller passes a `project(tileX, tileY) →
 * [px, py]`. The GAME pass uses world-space (tile * TILE); the EDITOR pass
 * uses _weTileToScreen. Detail sizes derive from the PROJECTED footprint so
 * they read correctly at any zoom.
 */

export type Project = (tx: number, ty: number) => [number, number];

/** Residential types get a pitched shingle roof; everything else flat. */
const SHINGLE_TYPES = new Set(['trailer', 'house', 'house2', 'house3', 'house4', 'apartment']);

export function roofIsShingle(type: string): boolean {
  return SHINGLE_TYPES.has(type);
}

interface ShinglePal { base: string; ridge: string; eave: string }
const SHINGLE_PALS: readonly ShinglePal[] = [
  { base: '#6b5744', ridge: '#8a7358', eave: '#42362a' }, // brown
  { base: '#565049', ridge: '#726b60', eave: '#38332d' }, // gray
  { base: '#4c5649', ridge: '#657563', eave: '#323a31' }, // weathered green
  { base: '#5c4a3d', ridge: '#7d6551', eave: '#3a2f26' }, // tan-brown
  { base: '#4a4e57', ridge: '#666b76', eave: '#30333a' }, // slate blue-gray
];
const FLAT_BASE = '#8a877e';
const FLAT_PARAPET = '#5c594f';
const FLAT_UNIT = '#615d54';
const FLAT_UNIT_HI = '#736f66';

const DRIVEWAY_FILL = '#b6b0a1';
const DRIVEWAY_EDGE = '#8f8c84';

function traceProjected(ctx: CanvasRenderingContext2D, proj: Array<[number, number]>): void {
  ctx.beginPath();
  ctx.moveTo(proj[0][0], proj[0][1]);
  for (let i = 1; i < proj.length; i++) ctx.lineTo(proj[i][0], proj[i][1]);
  ctx.closePath();
}

function projBbox(proj: Array<[number, number]>) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of proj) {
    if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

/** Deterministic shingle palette pick from the footprint centroid so the
 *  same building always gets the same colour, but neighbours vary. */
function shinglePal(cxTile: number, cyTile: number): ShinglePal {
  const h = (Math.round(cxTile) * 73856093) ^ (Math.round(cyTile) * 19349663);
  return SHINGLE_PALS[Math.abs(h) % SHINGLE_PALS.length];
}

/** Draw a building roof for `corners` (tile coords), styled by `type`. */
export function drawRoof(
  ctx: CanvasRenderingContext2D,
  corners: ReadonlyArray<readonly [number, number]>,
  type: string,
  project: Project,
): void {
  if (corners.length < 3) return;
  const proj = corners.map((c) => project(c[0], c[1]) as [number, number]);
  const bb = projBbox(proj);
  const shortDim = Math.max(1, Math.min(bb.w, bb.h));
  let cx = 0, cy = 0;
  for (const c of corners) { cx += c[0]; cy += c[1]; }
  cx /= corners.length; cy /= corners.length;

  if (roofIsShingle(type)) {
    const pal = shinglePal(cx, cy);
    traceProjected(ctx, proj);
    ctx.fillStyle = pal.base;
    ctx.fill();
    // Ridge down the LONG axis (rectangular footprints only — the presets).
    if (corners.length === 4) {
      const d01 = Math.hypot(corners[0][0] - corners[1][0], corners[0][1] - corners[1][1]);
      const d12 = Math.hypot(corners[1][0] - corners[2][0], corners[1][1] - corners[2][1]);
      const mid = (a: readonly [number, number], b: readonly [number, number]) =>
        project((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      const [a, b] = d01 >= d12
        ? [mid(corners[3], corners[0]), mid(corners[1], corners[2])]
        : [mid(corners[0], corners[1]), mid(corners[2], corners[3])];
      ctx.strokeStyle = pal.ridge;
      ctx.lineWidth = Math.max(1, shortDim * 0.12);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }
    // Eave shadow border.
    traceProjected(ctx, proj);
    ctx.strokeStyle = pal.eave;
    ctx.lineWidth = Math.max(1, shortDim * 0.09);
    ctx.lineJoin = 'round';
    ctx.stroke();
  } else {
    // Flat commercial roof.
    traceProjected(ctx, proj);
    ctx.fillStyle = FLAT_BASE;
    ctx.fill();
    // Parapet edge.
    traceProjected(ctx, proj);
    ctx.strokeStyle = FLAT_PARAPET;
    ctx.lineWidth = Math.max(1.5, shortDim * 0.14);
    ctx.lineJoin = 'round';
    ctx.stroke();
    // Rooftop HVAC units near the centre, scaled to the footprint.
    const c = project(cx, cy);
    const u = Math.max(3, shortDim * 0.22);
    ctx.fillStyle = FLAT_UNIT;
    ctx.fillRect(c[0] - u * 1.1, c[1] - u * 0.6, u, u * 0.8);
    ctx.fillRect(c[0] + u * 0.2, c[1] - u * 0.1, u * 0.8, u * 0.7);
    ctx.fillStyle = FLAT_UNIT_HI;
    ctx.fillRect(c[0] - u * 1.1, c[1] - u * 0.6, u, Math.max(1, u * 0.18));
  }
}

/** Draw a driveway as a solid concrete strip (tile-coord polygon). */
export function drawDrivewayStrip(
  ctx: CanvasRenderingContext2D,
  corners: ReadonlyArray<readonly [number, number]>,
  project: Project,
  edgePx = 1,
): void {
  if (corners.length < 3) return;
  const proj = corners.map((c) => project(c[0], c[1]) as [number, number]);
  traceProjected(ctx, proj);
  ctx.fillStyle = DRIVEWAY_FILL;
  ctx.fill();
  ctx.strokeStyle = DRIVEWAY_EDGE;
  ctx.lineWidth = edgePx;
  ctx.lineJoin = 'round';
  ctx.stroke();
}
