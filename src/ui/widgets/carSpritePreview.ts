/**
 * H881: static top-down car-sprite preview for menu screens.
 *
 * Reuses the same drawTopCar + previewDepsForCar path the pause-menu STATUS
 * tab uses (pauseMenu.ts ~512), packaged as a one-call widget so the SPECS /
 * UPGRADE screens (and the car browsers later) can drop a car sprite into a
 * box. Renders the actual PNG sprite when loaded, else the V2 vector body
 * (previewDeps handles the fallback). The car points front-right (angle 0).
 */

import type { CatalogCar } from '@/config/cars/catalog';
import { drawTopCar } from '@/render/carBody/drawTopCar';
import { previewDepsForCar } from '@/render/carBody/previewDeps';

/** Draw `car` centered + scaled to fit the (x,y,w,h) box. Saves/restores ctx. */
export function drawCarSpritePreview(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  car: CatalogCar,
): void {
  const sp: readonly [number, number] = car.size ?? [20, 8];
  const scale = Math.min(w / sp[0], h / sp[1]) * 0.92;
  ctx.save();
  ctx.translate(x + w / 2, y + h / 2);
  ctx.scale(scale, scale);
  drawTopCar(
    ctx,
    { cx: 0, cy: 0, angle: 0, color: car.color, isPlayer: true, steerAngle: 0 },
    previewDepsForCar(car),
  );
  ctx.restore();
}
