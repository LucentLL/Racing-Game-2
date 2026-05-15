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

const CAR_LEN = 18;
const CAR_W = 12;
/** Headlight beam length, in world units. */
const BEAM_LEN = 220;
/** Half-angle of the headlight cone, in radians. ~24°. */
const BEAM_HALF_ANGLE = 0.42;
/** Color at the apex of the cone (bright at the car, fades to 0 at
 *  the far edge via radial gradient). */
const BEAM_COLOR = '255, 240, 180';

/** Draws the player triangle in WORLD space — caller has already
 *  applied the camera transform via translate(). Border flashes red
 *  while collisionFlash > 0 (H18 visual feedback). */
export function drawPlayerCar(ctx: CanvasRenderingContext2D, player: PlayerState): void {
  ctx.save();
  ctx.translate(player.px, player.py);
  ctx.rotate(player.pAngle);
  ctx.beginPath();
  ctx.moveTo(CAR_LEN, 0);
  ctx.lineTo(-CAR_LEN * 0.6, -CAR_W);
  ctx.lineTo(-CAR_LEN * 0.6, CAR_W);
  ctx.closePath();
  ctx.fillStyle = '#cc0000';
  ctx.fill();
  if (player.collisionFlash > 0) {
    ctx.strokeStyle = `rgba(255, 200, 60, ${0.55 + 0.45 * player.collisionFlash})`;
    ctx.lineWidth = 2.5;
  } else {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
  }
  ctx.stroke();
  // Heading indicator — small white dot at the front so spin direction
  // is unambiguous.
  ctx.beginPath();
  ctx.arc(CAR_LEN - 3, 0, 1.5, 0, Math.PI * 2);
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
