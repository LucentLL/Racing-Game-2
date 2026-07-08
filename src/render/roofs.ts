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

interface ShinglePal { base: string; ridge: string; eave: string; course: string; tab: string }
const SHINGLE_PALS: readonly ShinglePal[] = [
  { base: '#6b5744', ridge: '#8a7358', eave: '#42362a', course: '#5c4a39', tab: '#77624c' }, // brown
  { base: '#565049', ridge: '#726b60', eave: '#38332d', course: '#48433c', tab: '#625b52' }, // gray
  { base: '#4c5649', ridge: '#657563', eave: '#323a31', course: '#3f483d', tab: '#586353' }, // weathered green
  { base: '#5c4a3d', ridge: '#7d6551', eave: '#3a2f26', course: '#4e3f33', tab: '#6a5546' }, // tan-brown
  { base: '#4a4e57', ridge: '#666b76', eave: '#30333a', course: '#3e424b', tab: '#555a64' }, // slate blue-gray
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
  /** H1085: cel-shade — a hard lit/shadow band + a bold ink outline
   *  around the footprint (Auto-Modellista treatment). */
  cel = false,
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
    // Pixel-art SHINGLE COURSES — rows of tabs running parallel to the ridge
    // (long axis), stepping from ridge to eave, brick-offset per course, with
    // per-course shading + tab separators. Rectangular footprints (presets)
    // only; freeform buildings keep the flat base.
    if (corners.length === 4) {
      const c0 = corners[0], c1 = corners[1], c3 = corners[3];
      const eA: [number, number] = [c1[0] - c0[0], c1[1] - c0[1]]; // edge c0→c1
      const eB: [number, number] = [c3[0] - c0[0], c3[1] - c0[1]]; // edge c0→c3
      const lenA = Math.hypot(eA[0], eA[1]);
      const lenB = Math.hypot(eB[0], eB[1]);
      // u = LONG axis (courses run along it), v = SHORT axis (step across it).
      const [u, v, vTiles] = lenA >= lenB ? [eA, eB, lenB] : [eB, eA, lenA];
      // Point at local fractions s∈[0,1] along u, t∈[0,1] along v.
      const at = (s: number, t: number): [number, number] =>
        project(c0[0] + u[0] * s + v[0] * t, c0[1] + u[1] * s + v[1] * t);
      const courses = Math.max(3, Math.min(22, Math.round(vTiles / 0.5)));
      const tabFrac = Math.max(0.05, 0.85 / Math.max(1, Math.hypot(u[0], u[1])));
      ctx.lineCap = 'butt';
      for (let ci = 0; ci < courses; ci++) {
        const t = ci / courses;
        const tNext = (ci + 1) / courses;
        // Shadow line at the course butt (the tab overlap) + a lit exposure.
        const s0 = at(0, t), s1 = at(1, t);
        ctx.strokeStyle = pal.course;
        ctx.lineWidth = Math.max(0.6, shortDim * 0.05);
        ctx.beginPath(); ctx.moveTo(s0[0], s0[1]); ctx.lineTo(s1[0], s1[1]); ctx.stroke();
        const e0 = at(0, t + (tNext - t) * 0.28), e1 = at(1, t + (tNext - t) * 0.28);
        ctx.strokeStyle = pal.tab;
        ctx.lineWidth = Math.max(0.5, shortDim * 0.03);
        ctx.beginPath(); ctx.moveTo(e0[0], e0[1]); ctx.lineTo(e1[0], e1[1]); ctx.stroke();
        // Tab separators — short ticks across the exposure, brick-offset.
        const off = (ci & 1) ? tabFrac * 0.5 : 0;
        ctx.strokeStyle = pal.eave;
        ctx.lineWidth = Math.max(0.4, shortDim * 0.02);
        for (let s = off; s < 1; s += tabFrac) {
          const p0 = at(s, t), p1 = at(s, tNext * 0.82 + t * 0.18);
          ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.stroke();
        }
      }
      // Ridge cap down the long axis.
      const rA = at(0, 0.5), rB = at(1, 0.5);
      ctx.strokeStyle = pal.ridge;
      ctx.lineWidth = Math.max(1, shortDim * 0.10);
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(rA[0], rA[1]); ctx.lineTo(rB[0], rB[1]); ctx.stroke();
    }
    // Eave shadow border.
    traceProjected(ctx, proj);
    ctx.strokeStyle = pal.eave;
    ctx.lineWidth = Math.max(1, shortDim * 0.09);
    ctx.lineJoin = 'round';
    ctx.stroke();
    // H1009: no garage door is drawn here — from directly overhead you see
    // the intact roof, not the door. The garage is revealed only when the
    // player drives in (drawGarageOverdraw redraws this roof OVER the car so
    // it slides under, then paints a translucent cutaway of the notch).
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

  // H1085: cel-shade — a hard lit/shadow band (light from screen top-
  // left) clipped to the footprint, then a bold ink outline. Editor-
  // placed buildings are few on screen, so per-building strokes are cheap.
  if (cel) {
    const cc = project(cx, cy);
    ctx.save();
    traceProjected(ctx, proj);
    ctx.clip();
    const inv = Math.SQRT1_2, BIG = bb.w + bb.h + 40, D = shortDim * 0.12;
    const ox = cc[0] - inv * D, oy = cc[1] - inv * D;
    const nX = inv, nY = inv, tX = -inv, tY = inv;
    ctx.fillStyle = 'rgba(10,12,20,0.22)';
    ctx.beginPath();
    ctx.moveTo(ox + tX * BIG, oy + tY * BIG);
    ctx.lineTo(ox - tX * BIG, oy - tY * BIG);
    ctx.lineTo(ox - tX * BIG + nX * BIG, oy - tY * BIG + nY * BIG);
    ctx.lineTo(ox + tX * BIG + nX * BIG, oy + tY * BIG + nY * BIG);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    traceProjected(ctx, proj);
    ctx.strokeStyle = '#0a0c14';
    ctx.lineWidth = Math.max(1.4, shortDim * 0.13);
    ctx.lineJoin = 'round';
    ctx.stroke();
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
