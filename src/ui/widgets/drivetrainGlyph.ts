/**
 * H880: GT2-style drivetrain layout glyph.
 *
 * A small top-down car silhouette (front at top) with the DRIVEN wheels
 * highlighted amber and the layout code (FF/FR/MR/RR/4WD) labelled — the
 * "FR box" treatment from GT2's car screens. Front-drive lights the front
 * wheels, rear/mid/rear-engine light the rears, AWD lights all four.
 *
 * Pure canvas; reusable on SPECS / UPGRADE / the dealership + garage car
 * browsers (the user's "still missing the visual for FWD/RWD/AWD" ask).
 */

import { GT2_COLORS } from '@/ui/gt2Chrome';

export type DrivetrainCode = 'FF' | 'FR' | 'MR' | 'RR' | '4WD' | string;

/** Draw the glyph filling the (x,y,w,h) box. Label sits centered in the body. */
export function drawDrivetrainGlyph(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  drv: DrivetrainCode,
): void {
  const drivenFront = drv === 'FF' || drv === '4WD';
  const drivenRear = drv === 'FR' || drv === 'MR' || drv === 'RR' || drv === '4WD';

  // Body outline (rounded rect, narrower than the wheel track).
  const bx = x + w * 0.24;
  const bw = w * 0.52;
  const r = 4;
  ctx.strokeStyle = '#7a7a7a';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(bx + r, y);
  ctx.arcTo(bx + bw, y, bx + bw, y + h, r);
  ctx.arcTo(bx + bw, y + h, bx, y + h, r);
  ctx.arcTo(bx, y + h, bx, y, r);
  ctx.arcTo(bx, y, bx + bw, y, r);
  ctx.closePath();
  ctx.stroke();

  // Wheels at the four corners; driven ones glow amber.
  const ww = w * 0.2;
  const wh = h * 0.2;
  const wheel = (wx: number, wy: number, on: boolean): void => {
    ctx.fillStyle = on ? GT2_COLORS.amber : '#4a4a4a';
    ctx.fillRect(wx, wy, ww, wh);
  };
  wheel(x, y + h * 0.1, drivenFront);
  wheel(x + w - ww, y + h * 0.1, drivenFront);
  wheel(x, y + h * 0.7, drivenRear);
  wheel(x + w - ww, y + h * 0.7, drivenRear);

  // Layout code centered in the body.
  ctx.fillStyle = GT2_COLORS.text;
  ctx.font = 'bold 9px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(String(drv), x + w / 2, y + h * 0.56);
  ctx.textAlign = 'left';
}
