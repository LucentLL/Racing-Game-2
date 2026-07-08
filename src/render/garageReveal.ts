/**
 * H1009: garage drive-under + reveal.
 *
 * A top-down view shows a house's intact roof, not its garage door (H1006's
 * painted door was wrong). Instead:
 *   1. DRIVE-UNDER — while the player is engaging their garage, the house
 *      roof is redrawn OVER the car (after the car draw) so the car visibly
 *      slides UNDER the roof as it enters.
 *   2. REVEAL — a translucent cutaway of the garage notch fades in as the
 *      player approaches, showing where to park (dashed stalls) and the
 *      player's OTHER owned cars parked inside (coloured top-down glyphs).
 *
 * Called once per frame from drawPlaying, on whichever context the player car
 * was drawn to (pcCtx on the desktop overlay, mainCtx on the single-canvas /
 * mobile path), inside that context's world-space camera transform. The
 * projection is plain world-space (tile * TILE) — the camera transform is
 * already applied by the caller, exactly like drawPlacedBuildings.
 */
import { garageEngagement } from '@/world/placedBuildings';
import { CAR_CATALOG } from '@/config/cars/catalog';

export interface GarageOverdrawDeps {
  playerPx: number;
  playerPy: number;
  TILE: number;
  /** life.ownedCars — catalog ids; [0] is the active (driven) car. */
  ownedCars: ReadonlyArray<string>;
}

const FLOOR_FILL = '#2b2c30';
const FLOOR_EDGE = '#101012';
const STALL_LINE = '#d8d152';

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** A parked car (or bike), top-down, coloured by its catalog body colour,
 *  nose pointed OUT the garage door. Drawn in the caller's world transform. */
function drawParkedGlyph(
  ctx: CanvasRenderingContext2D,
  wx: number, wy: number, ang: number, color: string, isBike: boolean, TILE: number,
): void {
  const L = (isBike ? 1.5 : 2.0) * TILE;
  const W = (isBike ? 0.5 : 0.92) * TILE;
  ctx.save();
  ctx.translate(wx, wy);
  ctx.rotate(ang); // local +x = INTO the building; nose (local -x) faces the door
  roundRectPath(ctx, -L / 2, -W / 2, L, W, Math.min(W * 0.32, 5));
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = Math.max(0.6, W * 0.06);
  ctx.stroke();
  // Cabin glass toward the nose end.
  ctx.fillStyle = 'rgba(18,22,28,0.72)';
  roundRectPath(ctx, -L * 0.20, -W * 0.34, L * 0.34, W * 0.68, 2);
  ctx.fill();
  ctx.restore();
}

/** H1058 (Phase 2c): draw the ENGAGED residence's garage as an OPEN, ROOFLESS
 *  bay — an opaque concrete floor + recessed side/back walls + dashed stalls +
 *  the player's OTHER parked cars, painted OVER the roof so the bay reads as a
 *  cut-out you can see straight into.
 *
 *  MUST be called in the WORLD pass BEFORE the player car (on mainCtx) so the
 *  car draws ON TOP of the bay floor — you watch it roll into the open garage.
 *  This replaces the old H1009 drive-under-roof + translucent reveal, where the
 *  car was buried under a murky translucent roof and the interior was unreadable
 *  (user report). No-op unless the player is engaging a garage; the floor fades
 *  open over the first ~0.8 tile of engagement so the roof doesn't hard-pop. */
export function drawGarageBay(
  ctx: CanvasRenderingContext2D,
  deps: GarageOverdrawDeps,
): void {
  const eng = garageEngagement(deps.playerPx, deps.playerPy, deps.TILE);
  if (!eng) return;
  const TILE = deps.TILE;
  const { garage: g, lanes, into } = eng;
  const project = (tx: number, ty: number): [number, number] => [tx * TILE, ty * TILE];
  const face = (a: number, dp: number): [number, number] =>
    project(g.fcx + g.lax * a + g.dax * dp, g.fcy + g.lay * a + g.day * dp);
  const depth = g.depth;
  const hw = g.halfW;
  // Floor is OPAQUE (so the bay reads roofless, not a murky translucent patch);
  // it fades in over the first ~0.8 tile of the 2-tile engagement so the roof
  // opens smoothly rather than popping. Detail (stalls/cars) fades a bit later.
  const floorA = Math.max(0, Math.min(1, (into + 2.0) / 0.8));
  if (floorA < 0.02) return;
  const detailA = Math.max(0, Math.min(1, (into + 2.0) / 2.5));

  // q: [mouth-L, mouth-R, back-R, back-L]
  const q = [face(-hw, 0), face(hw, 0), face(hw, depth), face(-hw, depth)];
  ctx.save();

  // 1. OPEN BAY FLOOR — opaque concrete, overpaints the roof in the bay.
  ctx.globalAlpha = floorA;
  ctx.beginPath();
  ctx.moveTo(q[0][0], q[0][1]);
  for (let i = 1; i < q.length; i++) ctx.lineTo(q[i][0], q[i][1]);
  ctx.closePath();
  ctx.fillStyle = FLOOR_FILL;
  ctx.fill();

  // 2. RECESSED WALLS — a darker band along the LEFT, BACK and RIGHT edges
  //    (NOT the mouth), so the bay reads as sunk into the house body.
  ctx.strokeStyle = FLOOR_EDGE;
  ctx.lineWidth = Math.max(1.5, TILE * 0.22);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(q[0][0], q[0][1]); // mouth-L
  ctx.lineTo(q[3][0], q[3][1]); // back-L
  ctx.lineTo(q[2][0], q[2][1]); // back-R
  ctx.lineTo(q[1][0], q[1][1]); // mouth-R
  ctx.stroke();

  // 3. Per-lane dashed stalls + the player's other parked cars.
  const nLanes = Math.max(1, lanes);
  const other = deps.ownedCars.slice(1); // [0] is the car being driven in
  const stallHalf = hw / nLanes;
  const glyphAng = Math.atan2(g.day, g.dax);
  for (let i = 0; i < nLanes; i++) {
    const aCenter = -hw + (i + 0.5) * (2 * hw / nLanes);
    const s = [
      face(aCenter - stallHalf * 0.82, 0.25),
      face(aCenter + stallHalf * 0.82, 0.25),
      face(aCenter + stallHalf * 0.82, depth - 0.25),
      face(aCenter - stallHalf * 0.82, depth - 0.25),
    ];
    ctx.globalAlpha = 0.7 * detailA;
    ctx.setLineDash([TILE * 0.35, TILE * 0.28]);
    ctx.lineWidth = Math.max(0.8, TILE * 0.08);
    ctx.strokeStyle = STALL_LINE;
    ctx.beginPath();
    ctx.moveTo(s[0][0], s[0][1]);
    for (let k = 1; k < s.length; k++) ctx.lineTo(s[k][0], s[k][1]);
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    // Parked car for this stall, if the player owns another.
    const id = other[i];
    if (id) {
      const spec = CAR_CATALOG[id];
      const color = spec?.color || '#b23';
      const [cx, cy] = face(aCenter, depth * 0.56);
      ctx.globalAlpha = 0.95 * detailA;
      drawParkedGlyph(ctx, cx, cy, glyphAng, color, !!spec?.isBike, TILE);
    }
  }

  ctx.restore();
}
