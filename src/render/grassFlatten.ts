/**
 * H1117 — grass flattened by cars (and future effectors).
 *
 * Canvas-2D translation of the Dynamic 2D Grass plugin's effector
 * system: there, hidden sprites write "displacement/destruction" into a
 * terrain data texture and the grass shader bends/kills blades under
 * them, regrowing when the effector fades. Here, the same idea rides
 * the skidMarks pattern the game already trusts: a fixed ring buffer of
 * world-space stamps, emitted when something crosses grass, drawn as
 * two pressed-down wheel-track dabs that fade out (= regrow) over
 * FLATTEN_LIFE_S.
 *
 * Emission is player-driven today (tickGrassFlattenEmit from the
 * update path), but addGrassFlattenStamp is the generic effector API —
 * a knocked-over fence, a dragged trash can, or traffic can call it
 * with their own pose/width when those become hittable.
 *
 * Perf: axis-aligned fillRects like skidMarks (no per-stamp rotation
 * state), fixed 800-slot ring (skidMarks parity), distance²-culled.
 * No getImageData anywhere.
 */

import { isOnGrass, getTile, type TileMap } from '@/world/tileMap';
import { TILE } from '@/config/world/tiles';

interface FlattenStamp {
  /** Left / right wheel-track dab centers (world px). */
  x1: number; y1: number;
  x2: number; y2: number;
  /** Date.now() at emit — drives the fade/regrow. */
  born: number;
  /** H1159: single-track effector (motorcycle) — only the x1/y1 dab is
   *  painted. Skipping the second rect (not just co-locating it) matters:
   *  two stacked dabs at alpha 0.55 would composite to ~0.80 and read
   *  darker than one car wheel track. */
  single?: boolean;
}

const CAP = 800;
/** Seconds until a flattened patch fully "regrows" (fades out). */
const FLATTEN_LIFE_S = 26;
/** Emit spacing along the travel path (world px). H1121: must be LESS
 *  than the dab size (6) so diagonal travel leaves a continuous band —
 *  at 7 the square dabs read as a checkerboard (user screenshot). */
const EMIT_SPACING = 5;
/** |pSpeed| below this doesn't press grass (idling car). */
const EMIT_MIN_SPEED = 8;
/** Wheel dab half-size (world px) — a 6×6 press per track. */
const DAB = 3;
/** Peak dab opacity at age 0. */
const MAX_A = 0.55;

const stamps: FlattenStamp[] = [];
let head = 0;
let lastEx = 0;
let lastEy = 0;

/** H1117 generic effector entry: press the grass at (x, y) with the
 *  effector heading `angle` (radians) and track `width` (world px
 *  between the two wheel dabs). Anything hittable can call this. */
export function addGrassFlattenStamp(x: number, y: number, angle: number, width: number, single = false): void {
  const px = single ? 0 : -Math.sin(angle) * width * 0.5;
  const py = single ? 0 : Math.cos(angle) * width * 0.5;
  const s: FlattenStamp = {
    x1: x + px, y1: y + py,
    x2: x - px, y2: y - py,
    born: Date.now(),
    single,
  };
  if (stamps.length < CAP) stamps.push(s);
  else { stamps[head] = s; head = (head + 1) % CAP; }
}

/** Per-frame player emitter. Presses two wheel tracks whenever the car
 *  is MOVING on a grass tile, spaced EMIT_SPACING along the path so a
 *  drive-through leaves a continuous pair of ruts, not a dashed line
 *  at high speed / a blob at low speed. Runs in the update path, so
 *  pause menus stop emission with everything else. */
export function tickGrassFlattenEmit(
  px: number,
  py: number,
  angle: number,
  speed: number,
  map: TileMap,
  carWidth: number,
  /** H1159: motorcycles press ONE centered rut (single rear wheel line),
   *  same as the H687/H820 single-track passes for skids/dust/trail. */
  isBike = false,
): void {
  if (Math.abs(speed) < EMIT_MIN_SPEED) return;
  const dx = px - lastEx;
  const dy = py - lastEy;
  if (dx * dx + dy * dy < EMIT_SPACING * EMIT_SPACING) return;
  lastEx = px;
  lastEy = py;
  // H1121: isOnGrass's monolith-parity variant list includes tile 9
  // (water!), which left grass ruts ON the river (user screenshot).
  // Exclude water explicitly.
  if (!isOnGrass(map, px, py)) return;
  if (getTile(map, Math.floor(px / TILE), Math.floor(py / TILE)) === 9) return;
  addGrassFlattenStamp(px, py, angle, carWidth, isBike);
}

/** Draw all live stamps. Called right after the grass pass (flattened
 *  tracks sit on the grass, under lots/roads/roofs — they are only
 *  emitted on grass tiles anyway). Fade = regrowth. */
export function drawGrassFlatten(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  cullR: number,
  nowMs: number,
): void {
  if (stamps.length === 0) return;
  const r2 = cullR * cullR;
  const prevAlpha = ctx.globalAlpha;
  // Pressed grass reads LIGHTER than standing grass (crushed blades show
  // their pale undersides / dry straw). H1119: '#565830' was tuned for
  // the pre-H1118 dark grass and disappeared on the lush rebake (user
  // report) — pale straw stays readable on the bright meadow.
  ctx.fillStyle = '#9a9456';
  for (const s of stamps) {
    const age = (nowMs - s.born) * 0.001;
    if (age >= FLATTEN_LIFE_S || age < 0) continue;
    const ddx = s.x1 - centerX;
    const ddy = s.y1 - centerY;
    if (ddx * ddx + ddy * ddy > r2) continue;
    // H1119: hold full strength for the first 35% of life, THEN regrow —
    // a fresh track stays crisp behind the car instead of fading the
    // moment it's laid.
    const lifeFrac = age / FLATTEN_LIFE_S;
    ctx.globalAlpha = MAX_A * (lifeFrac < 0.35 ? 1 : 1 - (lifeFrac - 0.35) / 0.65);
    ctx.fillRect(s.x1 - DAB, s.y1 - DAB, DAB * 2, DAB * 2);
    if (!s.single) ctx.fillRect(s.x2 - DAB, s.y2 - DAB, DAB * 2, DAB * 2);
  }
  ctx.globalAlpha = prevAlpha;
}

/** Test-only: live stamp count (headless verification). */
export function __grassFlattenCount(): number {
  const now = Date.now();
  let n = 0;
  for (const s of stamps) if ((now - s.born) * 0.001 < FLATTEN_LIFE_S) n++;
  return n;
}
