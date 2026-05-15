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

/** Draws the player triangle in WORLD space — caller has already
 *  applied the camera transform via translate(). */
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
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // Heading indicator — small white dot at the front so spin direction
  // is unambiguous.
  ctx.beginPath();
  ctx.arc(CAR_LEN - 3, 0, 1.5, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.restore();
}
