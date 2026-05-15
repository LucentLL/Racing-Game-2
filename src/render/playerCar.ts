/**
 * H6 placeholder player-car render.
 *
 * Draws a rotated triangle at the player's world position. Real V2
 * car renderer (src/render/carBody/drawCarBodyV2 + drawTopCar) replaces
 * this when the carBody scaffold's TODOs port. The triangle survives
 * as long as that work is in progress; once V2 lands this file is
 * removed.
 *
 * The shape is forward-pointed (apex along +x in local space) so it
 * visually matches the pAngle convention used by arcadeUpdate
 * (pAngle=0 → heading east; +cos*speed for x, +sin*speed for y).
 */

import type { PlayerState } from '@/state/player';

/** Body dimensions (world units, ≈ canvas px). Picked to read clearly
 *  at the current camera zoom — not tied to any specific car's real
 *  proportions yet. V2 renderer ports per-car-shape later. */
const CAR_LEN = 22;
const CAR_W = 14;
const WHEEL_LEN = 5;
const WHEEL_W = 3;
const WHEEL_INSET = 3;
const WINDSHIELD_LEN = 6;
const WINDSHIELD_W = 9;

/** Default body color when no active-car color is supplied. */
const DEFAULT_BODY = '#cc0000';

/** Headlight beam length, in world units. */
const BEAM_LEN = 220;
/** Half-angle of the headlight cone, in radians. ~24°. */
const BEAM_HALF_ANGLE = 0.42;
/** Color at the apex of the cone (bright at the car, fades to 0 at
 *  the far edge via radial gradient). */
const BEAM_COLOR = '255, 240, 180';

/** Darken a #RRGGBB hex string by a percent (0..1). Cheap inline lerp
 *  toward black so wheels / shadow read against the body color. */
function darken(hex: string, amount: number): string {
  if (!hex.startsWith('#') || hex.length !== 7) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const f = 1 - amount;
  const to2 = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return '#' + to2(r * f) + to2(g * f) + to2(b * f);
}

/** Draws the player car in WORLD space — caller has already applied
 *  the camera transform via translate(). Top-down silhouette: body
 *  rectangle + 4 wheels + windshield strip + 2 headlight studs +
 *  heading dot. Border flashes amber while collisionFlash > 0
 *  (H18 visual feedback). Body color sourced from CAR_CATALOG entry
 *  the caller resolved (falls back to red if undefined). */
export function drawPlayerCar(ctx: CanvasRenderingContext2D, player: PlayerState, bodyColor: string = DEFAULT_BODY): void {
  ctx.save();
  ctx.translate(player.px, player.py);
  ctx.rotate(player.pAngle);

  const halfL = CAR_LEN / 2;
  const halfW = CAR_W / 2;
  const wheelColor = '#111';

  // Wheels — drawn first so the body covers their inner edge.
  for (const [wx, wy] of [
    [ halfL - WHEEL_INSET,  halfW],   // front-right
    [ halfL - WHEEL_INSET, -halfW],   // front-left
    [-halfL + WHEEL_INSET,  halfW],   // rear-right
    [-halfL + WHEEL_INSET, -halfW],   // rear-left
  ] as const) {
    ctx.fillStyle = wheelColor;
    ctx.fillRect(wx - WHEEL_LEN / 2, wy - WHEEL_W / 2, WHEEL_LEN, WHEEL_W);
  }

  // Body.
  ctx.fillStyle = bodyColor;
  ctx.fillRect(-halfL, -halfW, CAR_LEN, CAR_W);

  // Subtle darker stripe down the centerline — reads as the roof seam
  // / hood line at this scale.
  ctx.fillStyle = darken(bodyColor, 0.3);
  ctx.fillRect(-halfL, -0.5, CAR_LEN, 1);

  // Windshield — light-blue strip on the front half of the cabin.
  ctx.fillStyle = 'rgba(170, 220, 255, 0.6)';
  ctx.fillRect(halfL - WINDSHIELD_LEN - 3, -WINDSHIELD_W / 2, WINDSHIELD_LEN, WINDSHIELD_W);

  // Headlight studs — tiny bright rects at the front corners.
  ctx.fillStyle = '#ffe98a';
  ctx.fillRect(halfL - 2, -halfW + 1, 2, 2);
  ctx.fillRect(halfL - 2, halfW - 3, 2, 2);

  // Outline — flashes amber on collision; otherwise a dark border for
  // contrast against light-colored bodies.
  if (player.collisionFlash > 0) {
    ctx.strokeStyle = `rgba(255, 200, 60, ${0.55 + 0.45 * player.collisionFlash})`;
    ctx.lineWidth = 2.5;
  } else {
    ctx.strokeStyle = 'rgba(0,0,0,0.65)';
    ctx.lineWidth = 1.2;
  }
  ctx.strokeRect(-halfL, -halfW, CAR_LEN, CAR_W);

  // Heading indicator — tiny white dot at the very front. Belt-and-
  // suspenders next to the headlight studs; reads at any zoom.
  ctx.beginPath();
  ctx.arc(halfL + 1, 0, 1.4, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();

  ctx.restore();
}

/** Draws warm headlight cones in front of the player. Call BEFORE the
 *  car body so the cone sits under the car visually. Skip silently when
 *  `intensity` is 0 (full day) — no allocation or path work. */
export function drawHeadlights(
  ctx: CanvasRenderingContext2D,
  player: PlayerState,
  intensity: number,
): void {
  if (intensity <= 0.02) return;
  ctx.save();
  ctx.translate(player.px, player.py);
  ctx.rotate(player.pAngle);

  // Cone apex at car nose, fanning out along +x.
  const x0 = CAR_LEN;
  const xFar = x0 + BEAM_LEN;
  const cosA = Math.cos(BEAM_HALF_ANGLE);
  const sinA = Math.sin(BEAM_HALF_ANGLE);
  const leftX = x0 + BEAM_LEN * cosA;
  const leftY = -BEAM_LEN * sinA;
  const rightX = leftX;
  const rightY = -leftY;

  // Radial gradient anchored at the apex; warm yellow at the car,
  // fades to transparent at the far edge.
  const grad = ctx.createRadialGradient(x0, 0, 0, x0, 0, BEAM_LEN);
  grad.addColorStop(0, `rgba(${BEAM_COLOR}, ${0.42 * intensity})`);
  grad.addColorStop(0.55, `rgba(${BEAM_COLOR}, ${0.18 * intensity})`);
  grad.addColorStop(1, `rgba(${BEAM_COLOR}, 0)`);

  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(x0, 0);
  ctx.lineTo(leftX, leftY);
  // Slight bulge at the far end gives the cone a rounded tip rather
  // than a hard triangular point — reads more like a real headlight.
  ctx.quadraticCurveTo(xFar, 0, rightX, rightY);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}
