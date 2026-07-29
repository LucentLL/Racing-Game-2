/**
 * H1279: X-RAY DRIVETRAIN INTERNALS.
 *
 * User: "I would also like to add more details to the X-ray of cars. Engines
 * that correspond to their vehicle (i4, i6, V8, etc), transmission, steering
 * rack, driveshaft, differential... Green can mean healthy, yellow or orange
 * worn, and red damaged."
 *
 * H1283 component pass (user follow-up): the steering RACK bar is gone
 * (clutter, rarely the damaged part) but the tie rods to the front wheels
 * stay; the cooling package (radiator, at the nose) and front/rear anti-roll
 * bars are in. Brake components and struts stay intentionally undrawn —
 * "I don't think there's a good way to include" them (user).
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
  /** H1283: cooling faults tint the radiator (engine stat is its base). */
  coolFault: boolean;
  /** H1283: suspension faults tint the sway bars (no stat — green unless
   *  a detected suspension fault forces worn). */
  suspFault: boolean;
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
  let coolFault = false;
  let suspFault = false;
  for (const f of faults ?? []) {
    const n = String((f as { name?: unknown })?.name ?? f ?? '').toLowerCase();
    if (!n) continue;
    if (/driveshaft|driveline|axle|differen|halfshaft|cv_|cv /.test(n)) driveFault = true;
    else if (/trans|gear|clutch|torque|shift/.test(n)) transFault = true;
    if (/steer|tie_rod|tie rod|rack|ps_leak|ps leak|alignment/.test(n)) steerFault = true;
    // H1283: cooling package (radiator) + suspension (sway bars). Names are
    // the human-readable fault rows ('Cooling System Failure', 'Strut
    // Bushings Worn', 'Timing Belt/Water Pump', ...).
    if (/radiat|coolant|cooling|water pump|thermostat|overheat|head gasket/.test(n)) coolFault = true;
    if (/suspension|sway|anti.?roll|stabiliz|strut|spring|damper|shock|control arm|ball joint|bushing/.test(n)) suspFault = true;
  }
  return { engine, tires, power, transFault, driveFault, steerFault, coolFault, suspFault };
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

/** H1283: tie rods only — the rack bar itself was clutter and rarely the
 *  damaged part (user: "the steering rack can be omitted... but keep the
 *  tie rods to the tire"). Two links from the rack line out to the front
 *  wheels; still the steering-fault tint surface. */
function drawTieRods(
  ctx: CanvasRenderingContext2D,
  geom: CarWheelGeom,
  L: number,
  color: string,
): void {
  const x = geom.fAxleX - L * 0.075;
  const half = geom.fHalfTrack * 0.55;
  drawShaft(ctx, x, -half, geom.fAxleX, -geom.fHalfTrack * 0.85, 0.3, color);
  drawShaft(ctx, x, half, geom.fAxleX, geom.fHalfTrack * 0.85, 0.3, color);
}

/** H1283: cooling package — the radiator core just inside the nose, with a
 *  hair of grille gap. All catalog cars radiate at the front (the MR/RR
 *  exotics in this era run front-mounted cores too). */
function drawRadiator(
  ctx: CanvasRenderingContext2D,
  L: number,
  W: number,
  color: string,
): void {
  const depth = Math.max(0.9, L * 0.024);
  const x = L * 0.47 - depth;
  const half = W * 0.21;
  ctx.beginPath();
  ctx.rect(x, -half, depth, half * 2);
  paint(ctx, color);
  // Core line so it reads as a heat exchanger, not a bumper bar.
  ctx.beginPath();
  ctx.moveTo(x + depth / 2, -half * 0.85);
  ctx.lineTo(x + depth / 2, half * 0.85);
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.25;
  ctx.stroke();
}

/** H1283: anti-roll (sway) bar — a thin bar across the car near the axle
 *  with short end links back to the axle line. `off` is signed: negative
 *  puts the bar behind the axle (front suspension), positive ahead of it
 *  (rear), keeping both clear of the diffs and halfshafts AT the axles. */
function drawSwayBar(
  ctx: CanvasRenderingContext2D,
  axleX: number,
  halfTrack: number,
  off: number,
  color: string,
): void {
  const x = axleX + off;
  const half = halfTrack * 0.78;
  drawShaft(ctx, x, -half, x, half, 0.35, color);
  drawShaft(ctx, x, -half, axleX, -half, 0.3, color);
  drawShaft(ctx, x, half, axleX, half, 0.3, color);
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
  // H1283: vehicles with no drivetrain code used to draw NOTHING (user
  // screenshot: a truck with an empty X-ray). The cars missing the field
  // are trucks/vans — longitudinal engine driving the rear axle — so FR is
  // the correct default layout; engineShapeOf already defaults a missing
  // eType to an L4.
  const layout = drv || 'FR';
  const shape = engineShapeOf(eType);
  const engineC = tint(cond.engine, false);
  const transC = tint(cond.power, cond.transFault);
  const driveC = tint(cond.power, cond.driveFault);
  const steerC = tint(100, cond.steerFault);
  const coolC = tint(cond.engine, cond.coolFault);
  const suspC = tint(100, cond.suspFault);
  const F = geom.fAxleX;
  const R = geom.rAxleX;
  const wb = F - R;
  const diffS = Math.max(1.6, L * 0.055);
  const barOff = Math.max(1.4, L * 0.045);

  ctx.save();
  // H1283: chassis furniture first so the powertrain ink reads on top —
  // radiator at the nose, anti-roll bars behind the front / ahead of the
  // rear axle, tie rods to the front wheels (rack bar removed).
  drawRadiator(ctx, L, W, coolC);
  drawSwayBar(ctx, F, geom.fHalfTrack, -barOff, suspC);
  drawSwayBar(ctx, R, geom.rHalfTrack, +barOff, suspC);
  drawTieRods(ctx, geom, L, steerC);

  if (layout === 'FF') {
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
  } else if (layout === 'FR' || layout === '4WD') {
    const dims = engineDims(shape, L, W);
    // H1283: sit the block's FRONT FACE just over the front axle line —
    // the classic front-engine layout (accessories ahead, crank back over
    // the axle). The old center formula (F - len*0.42 + wb*0.04) slid long
    // blocks progressively rearward, which is what made trucks read
    // "engine too far back" (user screenshots).
    const ex = F + L * 0.02 - dims.len / 2;
    drawEngine(ctx, ex, 0, shape, L, W, engineC);
    const gb0 = ex - dims.len / 2;
    const gb1 = gb0 - L * 0.115;
    drawGearbox(ctx, gb0, gb1, 0, W, transC);
    if (layout === '4WD') {
      // Transfer case behind the box; the FRONT prop runs offset to its
      // side (that is mechanically true), landing on the front diff.
      const tcS = L * 0.05;
      ctx.beginPath();
      ctx.rect(gb1 - tcS, -W * 0.02, tcS, W * 0.17);
      paint(ctx, transC);
      const py = W * 0.10;
      drawShaft(ctx, gb1 - tcS / 2, py, F - diffS * 0.4, 0, 0.45, driveC);
      // H1283: the REAR prop runs the CENTERLINE. It used to start at
      // y = W*0.06 and land at ~0 — a visibly diagonal shaft (user:
      // "quite a few have driveshaft offcenter (Skyline, Audi Quattro)").
      drawShaft(ctx, gb1 - tcS, 0, R + diffS / 2, 0, 0.5, driveC);
      drawDrivenAxle(ctx, F, geom.fHalfTrack, L, driveC);
    } else {
      drawShaft(ctx, gb1, 0, R + diffS / 2, 0, 0.5, driveC);
    }
    drawDrivenAxle(ctx, R, geom.rHalfTrack, L, driveC);
  } else if (layout === 'MR') {
    const dims = engineDims(shape, L, W);
    const ex = R + wb * 0.30 + dims.len * 0.1;
    drawEngine(ctx, ex, 0, shape, L, W, engineC);
    drawGearbox(ctx, ex - dims.len / 2, R - L * 0.02, 0, W, transC);
    drawDrivenAxle(ctx, R, geom.rHalfTrack, L, driveC);
  } else if (layout === 'RR') {
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
