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
import {
  xrayEngineFocus, xrayComponentBoxes,
  type XrayCondition, type XrayComponentBox,
} from '@/render/carBody/xrayDrivetrain';
import type { BodyDamage } from '@/render/carBody/damage';
import { drawTopCar } from '@/render/carBody/drawTopCar';
import { previewDepsForCar } from '@/render/carBody/previewDeps';
import { xrayCarGeom } from '@/render/carBody/xrayGeom';
import { GT4_SPECS } from '@/config/cars/gt4Database';

/** H1298 (INSPECT): the exact transform drawCarSpritePreview applies —
 *  exported so hit-testing can map car-local X-ray coordinates into
 *  screen space without re-deriving the math (no drift possible). */
export function carPreviewTransform(
  x: number, y: number, w: number, h: number, car: CatalogCar,
): { cx: number; cy: number; scale: number; L: number; W: number } {
  const sp: readonly [number, number] = car.size ?? [20, 8];
  const scale = Math.min(w / sp[0], h / sp[1]) * 0.92;
  return { cx: x + w / 2, cy: y + h / 2, scale, L: sp[0], W: sp[1] };
}

/** Draw `car` centered + scaled to fit the (x,y,w,h) box. Saves/restores ctx.
 *  H1284: pass `xrayCond` (+ optional bodyDamage) to render the box as an
 *  X-RAY inspection instead of the sprite — same internals the in-world
 *  X-ray shows, tinted by the supplied per-subsystem condition. */
export function drawCarSpritePreview(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  car: CatalogCar,
  xrayCond?: XrayCondition,
  bodyDamage?: BodyDamage,
): void {
  const t = carPreviewTransform(x, y, w, h, car);
  ctx.save();
  ctx.translate(t.cx, t.cy);
  ctx.scale(t.scale, t.scale);
  drawTopCar(
    ctx,
    { cx: 0, cy: 0, angle: 0, color: car.color, isPlayer: true, steerAngle: 0 },
    previewDepsForCar(car, xrayCond, bodyDamage),
  );
  ctx.restore();
}

/** H1298 (INSPECT): the engine's car-local focus box for `car` — geometry
 *  resolved exactly the way the X-ray draw resolves it (GT4 spec by name,
 *  'sedan' bodyType fallback), so hit rect and ink agree. Null-geom cars
 *  fall back to a rough front-third box. */
export function engineFocusFor(car: CatalogCar): { x: number; y: number; hw: number; hh: number } {
  const sp: readonly [number, number] = car.size ?? [20, 8];
  const L = sp[0];
  const W = sp[1];
  const geom = xrayCarGeom(car.name, 'sedan', L, W, (n) => GT4_SPECS[n], car.id);
  if (!geom) return { x: L * 0.25, y: 0, hw: L * 0.14, hh: W * 0.2 };
  return xrayEngineFocus(geom, L, W, car.drv, car.eType);
}

/** H1299 (INSPECT H-B): every component's car-local hit boxes for `car`,
 *  geometry resolved the same way the X-ray draw resolves it. Null-geom
 *  cars fall back to just the rough engine box. */
export function componentBoxesFor(car: CatalogCar): XrayComponentBox[] {
  const sp: readonly [number, number] = car.size ?? [20, 8];
  const L = sp[0];
  const W = sp[1];
  const geom = xrayCarGeom(car.name, 'sedan', L, W, (n) => GT4_SPECS[n], car.id);
  if (!geom) return [{ comp: 'engine', x: L * 0.25, y: 0, hw: L * 0.14, hh: W * 0.2 }];
  return xrayComponentBoxes(geom, L, W, car.drv, car.eType);
}

/** H1298 (INSPECT): focus-zoom variant — the same preview draw, zoomed onto
 *  a car-local point and clipped to the box. Dash/line widths are car-unit
 *  values so they thicken with zoom (accepted for now; polish slice thins
 *  them). */
export function drawCarSpriteFocus(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  car: CatalogCar,
  xrayCond: XrayCondition | undefined,
  bodyDamage: BodyDamage | undefined,
  focus: { x: number; y: number },
  zoom: number,
): void {
  const t = carPreviewTransform(x, y, w, h, car);
  const s = t.scale * zoom;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.translate(t.cx - focus.x * s, t.cy - focus.y * s);
  ctx.scale(s, s);
  drawTopCar(
    ctx,
    { cx: 0, cy: 0, angle: 0, color: car.color, isPlayer: true, steerAngle: 0 },
    previewDepsForCar(car, xrayCond, bodyDamage),
  );
  ctx.restore();
}
