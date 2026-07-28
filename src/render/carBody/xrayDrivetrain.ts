/**
 * H1279: X-RAY DRIVETRAIN INTERNALS.
 *
 * User: "I would also like to add more details to the X-ray of cars. Engines
 * that correspond to their vehicle (i4, i6, V8, etc), transmission, steering
 * rack, driveshaft, differential... Green can mean healthy, yellow or orange
 * worn, and red damaged."
 *
 * Draws the mechanical layout in car-local space (+X = nose, +Y = right),
 * hung off the SAME GT4-geometry anchors the X-ray tires use (fAxleX/rAxleX,
 * half-tracks), so everything lands on the real wheelbase:
 *
 *   FF  — transverse engine + gearbox across the front axle, halfshafts out
 *   FR  — longitudinal engine, gearbox behind it, prop shaft to a rear diff
 *   MR  — engine amidships behind the cabin, transaxle at the rear axle
 *   RR  — engine hung behind the rear axle, transaxle ahead of it
 *   4WD — FR layout + transfer case, front prop shaft and BOTH diffs
 *
 * The engine block itself is drawn from the car's real GT4 eType: an L4 is
 * four pots in a row, a V8 two staggered banks, a boxer two wide flat banks,
 * a rotary its stack of round housings.
 *
 * CONDITION TINTS use the garage screen's exact ramp (overlay.ts drawCondBar:
 * red < 35, orange < 70, green >= 70) over the three live stats — engine
 * stat on the block, tire stat on the X-ray tires (see drawTopCar), and the
 * HP/powertrain stat on gearbox + shafts + diffs. A DETECTED fault in the
 * matching subsystem forces at least orange, so a diagnosed gearbox reads
 * worn even while the wear stats still look fine. Hidden (undiagnosed)
 * faults deliberately do NOT show — paying for DIAGNOSE is the game.
 */

import type { CarWheelGeom } from './types';

/** Per-subsystem condition feeding the tint pass. Percentages are the live
 *  0-100 stats; the fault flags are DETECTED faults routed by keyword. */
export interface XrayCondition {
  engine: number;
  tires: number;
  /** LIFE.carHP — the powertrain-health stat; tints gearbox/shafts/diffs. */
  power: number;
  transFault: boolean;
  driveFault: boolean;
  steerFault: boolean;
}

/** The garage condition ramp, verbatim (overlay.ts drawCondBar). */
export function xrayCondColor(pct: number): string {
  const v = Math.max(0, Math.min(100, pct || 0));
  return v < 35 ? '#f44' : v < 70 ? '#fa0' : '#0f8';
}

const WORN = '#fa0';

/** Route detected fault names onto the three drawn subsystems. Accepts the
 *  live fault rows however they're shaped (objects with a name, or strings). */
export function buildXrayCondition(
  engine: number,
  tires: number,
  power: number,
  faults: readonly unknown[] | undefined,
): XrayCondition {
  let transFault = false;
  let driveFault = false;
  let steerFault = false;
  for (const f of faults ?? []) {
    const n = String((f as { name?: unknown })?.name ?? f ?? '').toLowerCase();
    if (!n) continue;
    if (/driveshaft|driveline|axle|differen|halfshaft|cv_|cv /.test(n)) driveFault = true;
    else if (/trans|gear|clutch|torque|shift/.test(n)) transFault = true;
    if (/steer|tie_rod|tie rod|rack|ps_leak|ps leak/.test(n)) steerFault = true;
  }
  return { engine, tires, power, transFault, driveFault, steerFault };
}

/** Fault-aware tint: the stat ramp, forced to at least WORN by a fault. */
function tint(pct: number, fault: boolean): string {
  const base = xrayCondColor(pct);
  return fault && base === '#0f8' ? WORN : base;
}

const FILL_ALPHA: Record<string, string> = {
  '#f44': 'rgba(255,68,68,0.30)',
  '#fa0': 'rgba(255,170,0,0.28)',
  '#0f8': 'rgba(0,255,136,0.22)',
};

function paint(ctx: CanvasRenderingContext2D, color: string): void {
  ctx.fillStyle = FILL_ALPHA[color] ?? 'rgba(160,255,255,0.2)';
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.35;
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// Engine block — shape from the GT4 eType string.
// ---------------------------------------------------------------------------

interface EngineShape {
  kind: 'inline' | 'vee' | 'flat' | 'rotary';
  /** Cylinders per bank (rotors for a rotary). */
  perBank: number;
  banks: 1 | 2;
}

/** Local eType parser — a render-layer sibling of engineFamily.carLayout,
 *  kept here so carBody stays free of the catalog import chain (same
 *  precedent as xrayGeom's local GT4SpecLike). */
export function engineShapeOf(eType: string | undefined): EngineShape {
  const s = (eType || '').toUpperCase();
  let m = /^L(\d+)/.exec(s);
  if (m) return { kind: 'inline', perBank: Math.max(1, +m[1]), banks: 1 };
  m = /^V(\d+)/.exec(s);
  if (m) return { kind: 'vee', perBank: Math.max(1, Math.round(+m[1] / 2)), banks: 2 };
  m = /^BOXER(\d+)/.exec(s);
  if (m) return { kind: 'flat', perBank: Math.max(1, Math.round(+m[1] / 2)), banks: 2 };
  m = /^ROT[AO]R(\d+)/.exec(s);   // GT4 data has one 'Rotar2' typo
  if (m) return { kind: 'rotary', perBank: Math.max(1, +m[1]), banks: 1 };
  return { kind: 'inline', perBank: 4, banks: 1 };
}

/** Block footprint (length along the crank, width across it) in car units. */
function engineDims(shape: EngineShape, L: number, W: number): { len: number; wid: number } {
  switch (shape.kind) {
    case 'vee':    return { len: L * (0.085 + 0.022 * shape.perBank), wid: W * 0.34 };
    case 'flat':   return { len: L * (0.075 + 0.024 * shape.perBank), wid: W * 0.52 };
    case 'rotary': return { len: L * (0.055 + 0.032 * shape.perBank), wid: W * 0.24 };
    default:       return { len: L * (0.075 + 0.019 * shape.perBank), wid: W * 0.21 };
  }
}

/** Draw the block centered at (cx, cy), crank along +X (rotate outside for
 *  a transverse mount). Cylinders are the see-through detail that says
 *  "four pots" vs "a V8" at a glance — exactly the user's reference art. */
function drawEngine(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  shape: EngineShape,
  L: number,
  W: number,
  color: string,
): { len: number; wid: number } {
  const { len, wid } = engineDims(shape, L, W);
  ctx.beginPath();
  ctx.rect(cx - len / 2, cy - wid / 2, len, wid);
  paint(ctx, color);
  ctx.strokeStyle = color;
  const n = shape.perBank;
  const step = len / n;
  const r = Math.min(step * 0.34, wid * (shape.banks === 2 ? 0.17 : 0.26));
  const bankOff = shape.banks === 2 ? wid * (shape.kind === 'flat' ? 0.30 : 0.22) : 0;
  for (let b = 0; b < shape.banks; b++) {
    const by = cy + (shape.banks === 2 ? (b === 0 ? -bankOff : bankOff) : 0);
    // A vee's banks are staggered along the crank; a boxer's oppose directly.
    const stag = shape.kind === 'vee' ? (b === 0 ? -step * 0.14 : step * 0.14) : 0;
    for (let i = 0; i < n; i++) {
      const px = cx - len / 2 + step * (i + 0.5) + stag;
      ctx.beginPath();
      if (shape.kind === 'rotary') {
        // Rotor housing: fatter, slightly squared circle.
        ctx.arc(px, by, r * 1.25, 0, Math.PI * 2);
      } else {
        ctx.arc(px, by, r, 0, Math.PI * 2);
      }
      ctx.lineWidth = 0.3;
      ctx.stroke();
    }
  }
  return { len, wid };
}

// ---------------------------------------------------------------------------
// Small parts.
// ---------------------------------------------------------------------------

/** Gearbox: a tapering trapezoid, wide end at x0 pointing toward x1. */
function drawGearbox(
  ctx: CanvasRenderingContext2D,
  x0: number,
  x1: number,
  cy: number,
  W: number,
  color: string,
): void {
  const w0 = W * 0.145;
  const w1 = W * 0.085;
  ctx.beginPath();
  ctx.moveTo(x0, cy - w0 / 2);
  ctx.lineTo(x1, cy - w1 / 2);
  ctx.lineTo(x1, cy + w1 / 2);
  ctx.lineTo(x0, cy + w0 / 2);
  ctx.closePath();
  paint(ctx, color);
}

/** Differential: the diagrams' crossed box at an axle center. */
function drawDiff(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, color: string): void {
  ctx.beginPath();
  ctx.rect(x - s / 2, y - s / 2, s, s);
  paint(ctx, color);
  ctx.beginPath();
  ctx.moveTo(x - s / 2, y - s / 2); ctx.lineTo(x + s / 2, y + s / 2);
  ctx.moveTo(x + s / 2, y - s / 2); ctx.lineTo(x - s / 2, y + s / 2);
  ctx.lineWidth = 0.25;
  ctx.stroke();
}

/** A shaft as a stroked line with a hair of body. */
function drawShaft(
  ctx: CanvasRenderingContext2D,
  x0: number, y0: number, x1: number, y1: number,
  width: number,
  color: string,
): void {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

/** Driven axle pair: diff at (axleX, 0) + halfshafts out to the wheels. */
function drawDrivenAxle(
  ctx: CanvasRenderingContext2D,
  axleX: number,
  halfTrack: number,
  L: number,
  color: string,
): void {
  drawShaft(ctx, axleX, -halfTrack * 0.92, axleX, halfTrack * 0.92, 0.5, color);
  drawDiff(ctx, axleX, 0, Math.max(1.6, L * 0.055), color);
}

/** Steering rack: a bar behind the front axle + tie rods to the wheels. */
function drawSteeringRack(
  ctx: CanvasRenderingContext2D,
  geom: CarWheelGeom,
  L: number,
  color: string,
): void {
  const x = geom.fAxleX - L * 0.075;
  const half = geom.fHalfTrack * 0.55;
  ctx.beginPath();
  ctx.rect(x - L * 0.012, -half, L * 0.024, half * 2);
  paint(ctx, color);
  drawShaft(ctx, x, -half, geom.fAxleX, -geom.fHalfTrack * 0.85, 0.3, color);
  drawShaft(ctx, x, half, geom.fAxleX, geom.fHalfTrack * 0.85, 0.3, color);
}

// ---------------------------------------------------------------------------
// The layouts.
// ---------------------------------------------------------------------------

/**
 * Draw the full drivetrain for this car. Call inside the car-local transform
 * (after translate/rotate), BEFORE the dashed body outline so the chassis
 * ink reads on top. No-ops when geometry or drivetrain identity is missing —
 * traffic and listing pins keep today's look.
 */
export function drawXrayDrivetrain(
  ctx: CanvasRenderingContext2D,
  geom: CarWheelGeom,
  L: number,
  W: number,
  drv: string | undefined,
  eType: string | undefined,
  cond: XrayCondition,
): void {
  if (!drv) return;
  const shape = engineShapeOf(eType);
  const engineC = tint(cond.engine, false);
  const transC = tint(cond.power, cond.transFault);
  const driveC = tint(cond.power, cond.driveFault);
  const steerC = tint(100, cond.steerFault);
  const F = geom.fAxleX;
  const R = geom.rAxleX;
  const wb = F - R;
  const diffS = Math.max(1.6, L * 0.055);

  ctx.save();
  drawSteeringRack(ctx, geom, L, steerC);

  if (drv === 'FF') {
    // Transverse assembly on the front axle line — engine block on the left
    // of the bay, gearbox continuing the same line to the right, halfshafts
    // out of the diff (the user's FWD reference diagram).
    const dims = engineDims(shape, L, W);
    const span = geom.fHalfTrack * 1.5;
    const ex = F + L * 0.03;
    const engCy = -span / 2 + dims.len / 2;
    ctx.save();
    ctx.translate(ex, engCy);
    ctx.rotate(Math.PI / 2);
    drawEngine(ctx, 0, 0, shape, L, W, engineC);
    ctx.restore();
    const gb0 = engCy + dims.len / 2 + L * 0.01;
    const gb1 = Math.min(span / 2, gb0 + L * 0.10);
    ctx.save();
    ctx.translate(ex, 0);
    ctx.rotate(Math.PI / 2);
    drawGearbox(ctx, gb0, gb1, 0, W, transC);
    ctx.restore();
    drawDrivenAxle(ctx, F, geom.fHalfTrack, L, driveC);
  } else if (drv === 'FR' || drv === '4WD') {
    const dims = engineDims(shape, L, W);
    const ex = F - dims.len * 0.42 + wb * 0.04;
    drawEngine(ctx, ex, 0, shape, L, W, engineC);
    const gb0 = ex - dims.len / 2;
    const gb1 = gb0 - L * 0.115;
    drawGearbox(ctx, gb0, gb1, 0, W, transC);
    if (drv === '4WD') {
      // Transfer case behind the box, front prop offset to its side.
      const tcS = L * 0.05;
      ctx.beginPath();
      ctx.rect(gb1 - tcS, -W * 0.02, tcS, W * 0.17);
      paint(ctx, transC);
      const py = W * 0.10;
      drawShaft(ctx, gb1 - tcS / 2, py, F - diffS * 0.4, py * 0.35, 0.45, driveC);
      drawShaft(ctx, gb1 - tcS, W * 0.06, R + diffS / 2, 0.001, 0.5, driveC);
      drawDrivenAxle(ctx, F, geom.fHalfTrack, L, driveC);
    } else {
      drawShaft(ctx, gb1, 0, R + diffS / 2, 0, 0.5, driveC);
    }
    drawDrivenAxle(ctx, R, geom.rHalfTrack, L, driveC);
  } else if (drv === 'MR') {
    const dims = engineDims(shape, L, W);
    const ex = R + wb * 0.30 + dims.len * 0.1;
    drawEngine(ctx, ex, 0, shape, L, W, engineC);
    drawGearbox(ctx, ex - dims.len / 2, R - L * 0.02, 0, W, transC);
    drawDrivenAxle(ctx, R, geom.rHalfTrack, L, driveC);
  } else if (drv === 'RR') {
    // Engine hung behind the rear axle (the 911 silhouette), gearbox
    // reaching FORWARD past the axle, diff between them at the axle line.
    const dims = engineDims(shape, L, W);
    const ex = R - dims.len * 0.32 - L * 0.035;
    drawGearbox(ctx, ex + dims.len * 0.35, R + L * 0.12, 0, W, transC);
    drawDrivenAxle(ctx, R, geom.rHalfTrack, L, driveC);
    drawEngine(ctx, ex, 0, shape, L, W, engineC);
  } else {
    // Unknown code — draw just the engine amidfront so SOMETHING shows.
    drawEngine(ctx, F - L * 0.05, 0, shape, L, W, engineC);
  }
  ctx.restore();
}
