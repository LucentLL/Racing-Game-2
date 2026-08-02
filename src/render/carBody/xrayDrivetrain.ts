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
  /** H1302: render EVERY component neutral gray — pure layout information
   *  with no condition claim (the starter-car spec sheet). */
  neutral?: boolean;
  /** H1302: per-lane gray override for the INSPECT flow — true = the
   *  player hasn't looked at that component yet, draw it neutral.
   *  Detected faults may HINT in prose but never color an uninspected
   *  part (user rule). Ignored when `neutral` is set. */
  gray?: {
    engine?: boolean; trans?: boolean; drive?: boolean;
    steer?: boolean; cool?: boolean; susp?: boolean; tires?: boolean;
  };
}

/** H1302: the informational gray for neutral / not-yet-inspected parts. */
export const XRAY_NEUTRAL_COLOR = '#8b95a1';

// ---------------------------------------------------------------------------
// H1307: firing sweep. One cylinder at a time goes solid as its piston comes
// up to TDC (user: "show piston when it reaches top of cylinder by cylinder
// becoming solid color instead of hollow").
//
// The rate is DELIBERATELY not the literal crank speed. A real four-stroke at
// idle completes ~6.7 cycles/second, so at 60 fps each cylinder's TDC window
// is under one frame — a literal crank aliases into random flicker and reads
// as a rendering bug, not an engine. Instead the sweep runs 1..5 cycles/sec
// across the rev range: still obviously faster when you rev it, but legible.
// This is a diagram, not a stroboscope.
// ---------------------------------------------------------------------------

let _crankDeg = 0;
let _crankRunning = false;
let _crankLastT = 0;

/** Advance the firing sweep. Call ONCE per frame (not from inside a draw —
 *  drawTopCar is re-entered for the tow-bed copy and the cel bake). */
export function advanceXrayCrank(rpm: number, redline: number, running: boolean): void {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const dt = _crankLastT ? Math.min(0.1, (now - _crankLastT) / 1000) : 0;
  _crankLastT = now;
  _crankRunning = running;
  if (!running) return;
  const rev = Math.max(0, Math.min(1.15, rpm / Math.max(1, redline)));
  _crankDeg = (_crankDeg + (1 + 4 * rev) * 720 * dt) % 720;
}

/** Which of `total` cylinders is at TDC right now, or -1 when the engine is
 *  not turning. Exactly one is lit at a time, so it sweeps the fire order. */
function firingCylinder(total: number): number {
  if (!_crankRunning || total < 1) return -1;
  return Math.floor((_crankDeg / 720) * total) % total;
}

/** H1302: tire tint honoring the neutral / gray-until-inspected rules —
 *  the tire color is applied by drawTopCar (outside drawXrayDrivetrain),
 *  so it needs the same override logic in one shared place. */
export function xrayTireColor(cond: XrayCondition): string {
  if (cond.neutral || cond.gray?.tires) return XRAY_NEUTRAL_COLOR;
  return xrayCondColor(cond.tires);
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

/** Stroke weights the engine draw uses. BLOCK_LW must match paint(). The
 *  cylinder layout budgets for the INK, not just the centreline. */
const BLOCK_LW = 0.35;
const CYL_LW = 0.30;
/** Cylinder radius as a fraction of the cylinder pitch. */
const CYL_R_FRAC = 0.34;
/** Bank stagger along the crank, +/- per bank. Real V-engine banks ARE
 *  offset by one con-rod big-end width (~24 mm on ~110 mm bore spacing,
 *  i.e. ~0.22 of pitch bank-to-bank), so the stagger is correct — H1307's
 *  bug was that engineDims never budgeted for it, which is what pushed the
 *  outer pots through the block wall (user: "Why are cylinders staggered
 *  and colliding with edges of engine?"). */
const VEE_STAG_FRAC = 0.10;

/** Draw the block centered at (cx, cy), crank along +X (rotate outside for
 *  a transverse mount). Cylinders are the see-through detail that says
 *  "four pots" vs "a V8" at a glance — exactly the user's reference art.
 *
 *  H1307: the row used to be laid out on step = len/n, which leaves only
 *  0.5*step of end margin — the radius ate 0.34*step and the vee stagger
 *  another 0.14*step, leaving 0.02*step against a combined stroke half-width
 *  of 0.325 car units. The two outlines were literally the same ink on 376
 *  of 377 catalog cars. The pitch is now SOLVED from the block's real
 *  budget, so the stagger and the rotary 1.25x draw multiplier sit inside
 *  the budget instead of being spent after it. */
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
  // Rotor housings DRAW at 1.25x the solved radius — fold that into the
  // budget so the multiplier can never push a housing through the wall.
  const drawMul = shape.kind === 'rotary' ? 1.25 : 1;
  const stagFrac = shape.kind === 'vee' ? VEE_STAG_FRAC : 0;
  // Clear space reserved at the wall: half the cylinder stroke + half the
  // block stroke (so the outlines never merge) + 5% of the block, so the
  // gap scales with the drawing.
  const ink = (CYL_LW + BLOCK_LW) / 2;
  const mx = ink + len * 0.05;
  const my = ink + wid * 0.05;
  // 0.26 (was 0.22) spends the dead vertical margin the old radius cap left
  // behind — the bank separation is what actually makes a V read as a V.
  const bankOff = shape.banks === 2 ? wid * (shape.kind === 'flat' ? 0.30 : 0.26) : 0;
  const rMaxV = Math.max(0, wid / 2 - my - bankOff) / drawMul;
  const pitch = Math.max(0, len / 2 - mx)
    / ((n - 1) / 2 + stagFrac + CYL_R_FRAC * drawMul);
  const r = Math.min(CYL_R_FRAC * pitch, rMaxV);
  if (r <= 0.01) return { len, wid };

  // H1307: the firing sweep — one pot solid at a time (user idea).
  const total = n * shape.banks;
  const firing = firingCylinder(total);
  for (let b = 0; b < shape.banks; b++) {
    const by = cy + (shape.banks === 2 ? (b === 0 ? -bankOff : bankOff) : 0);
    const stag = (b === 0 ? -stagFrac : stagFrac) * pitch;
    ctx.lineWidth = CYL_LW;
    for (let i = 0; i < n; i++) {
      const px = cx + (i - (n - 1) / 2) * pitch + stag;
      // Alternate banks so a V fires across the vee, not along one side.
      const fireIdx = shape.banks === 2 ? i * 2 + b : i;
      ctx.beginPath();
      ctx.arc(px, by, r * drawMul, 0, Math.PI * 2);
      if (fireIdx === firing) {
        ctx.fillStyle = color;
        ctx.fill();
      }
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

/** Driven axle pair: diff at (axleX, 0) + halfshafts out to the wheels.
 *
 *  H1307: `gapHalf` suppresses the middle of the halfshaft span. On a 4WD the
 *  front axle sits under the engine block, so the full-width line used to be
 *  drawn straight across it (86 catalog cars) — hidden-line convention keeps
 *  the shafts readable without painting them over the block. */
function drawDrivenAxle(
  ctx: CanvasRenderingContext2D,
  axleX: number,
  halfTrack: number,
  L: number,
  color: string,
  gapHalf = 0,
): void {
  const outer = halfTrack * 0.92;
  if (gapHalf > 0 && gapHalf < outer) {
    drawShaft(ctx, axleX, -outer, axleX, -gapHalf, 0.5, color);
    drawShaft(ctx, axleX, gapHalf, axleX, outer, 0.5, color);
  } else {
    drawShaft(ctx, axleX, -outer, axleX, outer, 0.5, color);
  }
  drawDiff(ctx, axleX, 0, Math.max(1.6, L * 0.055), color);
}

/** H1283: tie rods to the front wheels. The full steering rack was dropped
 *  as clutter (user: "the steering rack can be omitted... but keep the tie
 *  rods to the tire").
 *
 *  H1307: that left both rods hanging off nothing — user: "Tie rods? are
 *  sticking out but connecting to nothing." A linkage has to join something,
 *  so the inner ends now meet a short rack bar spanning just between them.
 *  It is a third of the old full-width rack, so it reads as the part the
 *  rods pivot on rather than the clutter that was removed. */
function drawTieRods(
  ctx: CanvasRenderingContext2D,
  geom: CarWheelGeom,
  L: number,
  color: string,
): void {
  const x = geom.fAxleX - L * 0.075;
  const half = geom.fHalfTrack * 0.55;
  drawShaft(ctx, x, -half, x, half, 0.34, color);          // the rack the rods hang off
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
  // H1302: neutral / gray-until-inspected overrides. `neutral` grays the
  // whole drivetrain (pure layout information — the starter-car sheet);
  // `gray` grays per lane (INSPECT: a component keeps its secrets until
  // the player — or a shop — has actually looked at it).
  const N = XRAY_NEUTRAL_COLOR;
  const g = cond.neutral
    ? { engine: true, trans: true, drive: true, steer: true, cool: true, susp: true }
    : (cond.gray ?? {});
  const engineC = g.engine ? N : tint(cond.engine, false);
  const transC = g.trans ? N : tint(cond.power, cond.transFault);
  const driveC = g.drive ? N : tint(cond.power, cond.driveFault);
  const steerC = g.steer ? N : tint(100, cond.steerFault);
  const coolC = g.cool ? N : tint(cond.engine, cond.coolFault);
  const suspC = g.susp ? N : tint(100, cond.suspFault);
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
  // H1307 (user: "the transmission, driveshafts are crooked" — the vertical
  // line crossing the engine was actually this bar): behind the front axle
  // the bar runs straight THROUGH the engine block on every FR and 4WD car
  // in the catalog (230/230 — the condition len > 0.02*L + barOff is
  // independent of wheelbase, so it is always true). Ahead of the axle it
  // clears the block on every layout and still misses the radiator and the
  // 4WD front diff. H1283's "keep it clear of the diffs" reasoning was
  // about the axle hardware, which +barOff satisfies equally.
  drawSwayBar(ctx, F, geom.fHalfTrack, +barOff, suspC);
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
      // Transfer case behind the box, then the FRONT prop forward to the
      // front diff.
      //
      // H1307 (user: "The transmission, driveshafts are crooked"): the case
      // rect used to span y = -0.02W..+0.15W — off-centre by 0.065W, which
      // read as a transmission bolted on crooked. Centre it.
      const tcS = L * 0.05;
      const tcH = W * 0.17;
      ctx.beginPath();
      ctx.rect(gb1 - tcS, -tcH / 2, tcS, tcH);
      paint(ctx, transC);
      // The front prop is genuinely offset to one side of the sump on a real
      // 4WD, but it runs PARALLEL to the centreline — the old single diagonal
      // from y=0.10W down to y=0 was the same bug H1283 fixed on the rear
      // prop. Keep the offset small enough that the shaft terminates inside
      // the front diff box, so it lands on something.
      const py = Math.min(W * 0.10, diffS * 0.32);
      drawShaft(ctx, gb1 - tcS / 2, py, F, py, 0.45, driveC);
      // H1283: the REAR prop runs the CENTERLINE. It used to start at
      // y = W*0.06 and land at ~0 — a visibly diagonal shaft (user:
      // "quite a few have driveshaft offcenter (Skyline, Audi Quattro)").
      drawShaft(ctx, gb1 - tcS, 0, R + diffS / 2, 0, 0.5, driveC);
      // Hidden-line the halfshaft where it runs under the block.
      drawDrivenAxle(ctx, F, geom.fHalfTrack, L, driveC, dims.wid / 2);
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

/** H1298 (INSPECT): the engine block's center + half-extents in car-local
 *  units — CO-LOCATED with the layout math in drawXrayDrivetrain above so
 *  the INSPECT hit-rect and focus-zoom can never drift from the drawn ink
 *  (the sellerButtonStartY principle). Mirrors each layout branch's `ex`
 *  formula exactly; FF is transverse so len/wid swap axes. */
export function xrayEngineFocus(
  geom: CarWheelGeom,
  L: number,
  W: number,
  drv: string | undefined,
  eType: string | undefined,
): { x: number; y: number; hw: number; hh: number } {
  const layout = drv || 'FR';
  const shape = engineShapeOf(eType);
  const dims = engineDims(shape, L, W);
  const F = geom.fAxleX;
  const R = geom.rAxleX;
  const wb = F - R;
  const pad = L * 0.02;
  if (layout === 'FF') {
    const span = geom.fHalfTrack * 1.5;
    return {
      x: F + L * 0.03,
      y: -span / 2 + dims.len / 2,
      hw: dims.wid / 2 + pad,
      hh: dims.len / 2 + pad,
    };
  }
  if (layout === 'MR') {
    return { x: R + wb * 0.30 + dims.len * 0.1, y: 0, hw: dims.len / 2 + pad, hh: dims.wid / 2 + pad };
  }
  if (layout === 'RR') {
    return { x: R - dims.len * 0.32 - L * 0.035, y: 0, hw: dims.len / 2 + pad, hh: dims.wid / 2 + pad };
  }
  const ex = (layout === 'FR' || layout === '4WD')
    ? F + L * 0.02 - dims.len / 2
    : F - L * 0.05;
  return { x: ex, y: 0, hw: dims.len / 2 + pad, hh: dims.wid / 2 + pad };
}

/** H1299 (INSPECT H-B): the tappable component set. 'body' is the
 *  everything-else fallback and gets no box. */
export type XrayComponentId =
  | 'engine' | 'transmission' | 'driveline' | 'cooling'
  | 'steering' | 'suspension' | 'wheels' | 'body';

export interface XrayComponentBox {
  comp: XrayComponentId;
  x: number; y: number; hw: number; hh: number;
}

/** H1299 (INSPECT H-B): car-local hit boxes for every drawn component —
 *  CO-LOCATED with the layout math above (each box mirrors its draw
 *  branch's coordinates) so hit rects track the ink. Components can own
 *  several boxes (sway bars, wheels, twin diffs); a component's FIRST box
 *  is its focus anchor for the zoom view. Callers should hit-test
 *  smallest-area-first — thin parts (bars, rods) overlap the big blocks. */
export function xrayComponentBoxes(
  geom: CarWheelGeom,
  L: number,
  W: number,
  drv: string | undefined,
  eType: string | undefined,
): XrayComponentBox[] {
  const layout = drv || 'FR';
  const shape = engineShapeOf(eType);
  const dims = engineDims(shape, L, W);
  const F = geom.fAxleX;
  const R = geom.rAxleX;
  const wb = F - R;
  const diffS = Math.max(1.6, L * 0.055);
  const barOff = Math.max(1.4, L * 0.045);
  const pad = L * 0.02;
  const out: XrayComponentBox[] = [];

  out.push({ comp: 'engine', ...xrayEngineFocus(geom, L, W, drv, eType) });

  // TRANSMISSION — mirrors each layout's gearbox span (+4WD transfer case).
  if (layout === 'FF') {
    const span = geom.fHalfTrack * 1.5;
    const engCy = -span / 2 + dims.len / 2;
    const gb0 = engCy + dims.len / 2 + L * 0.01;
    const gb1 = Math.min(span / 2, gb0 + L * 0.10);
    out.push({ comp: 'transmission', x: F + L * 0.03, y: (gb0 + gb1) / 2, hw: W * 0.09, hh: (gb1 - gb0) / 2 + pad });
  } else if (layout === 'FR' || layout === '4WD') {
    const ex = F + L * 0.02 - dims.len / 2;
    const gb0 = ex - dims.len / 2;
    const gb1 = gb0 - L * 0.115 - (layout === '4WD' ? L * 0.05 : 0);
    out.push({ comp: 'transmission', x: (gb0 + gb1) / 2, y: 0, hw: Math.abs(gb0 - gb1) / 2 + pad, hh: W * 0.10 });
  } else if (layout === 'MR') {
    const ex = R + wb * 0.30 + dims.len * 0.1;
    const gb0 = ex - dims.len / 2;
    const gb1 = R - L * 0.02;
    out.push({ comp: 'transmission', x: (gb0 + gb1) / 2, y: 0, hw: Math.abs(gb0 - gb1) / 2 + pad, hh: W * 0.10 });
  } else if (layout === 'RR') {
    const ex = R - dims.len * 0.32 - L * 0.035;
    const gb0 = ex + dims.len * 0.35;
    const gb1 = R + L * 0.12;
    out.push({ comp: 'transmission', x: (gb0 + gb1) / 2, y: 0, hw: Math.abs(gb1 - gb0) / 2 + pad, hh: W * 0.10 });
  }

  // DRIVELINE — the driven diff(s).
  if (layout === 'FF') {
    out.push({ comp: 'driveline', x: F, y: 0, hw: diffS / 2 + pad, hh: diffS / 2 + pad });
  } else {
    out.push({ comp: 'driveline', x: R, y: 0, hw: diffS / 2 + pad, hh: diffS / 2 + pad });
    if (layout === '4WD') out.push({ comp: 'driveline', x: F, y: 0, hw: diffS / 2 + pad, hh: diffS / 2 + pad });
  }

  // COOLING — the radiator core at the nose (drawRadiator's rect).
  {
    const depth = Math.max(0.9, L * 0.024);
    const x = L * 0.47 - depth;
    out.push({ comp: 'cooling', x: x + depth / 2, y: 0, hw: depth / 2 + pad, hh: W * 0.21 + pad * 0.5 });
  }

  // STEERING — the outer tie-rod ends (thin boxes; the mid-span crosses
  // the engine bay, which must stay the engine's tap).
  out.push({ comp: 'steering', x: F - L * 0.03, y: -geom.fHalfTrack * 0.72, hw: L * 0.055, hh: geom.fHalfTrack * 0.24 });
  out.push({ comp: 'steering', x: F - L * 0.03, y: geom.fHalfTrack * 0.72, hw: L * 0.055, hh: geom.fHalfTrack * 0.24 });

  // SUSPENSION — both sway bars (thin spans at ±barOff off the axles).
  // H1307: the front box moves with the bar (+barOff). Co-located with the
  // draw on purpose — and it also fixes a tap bug: the old box sat INSIDE
  // the engine block and, because callers hit-test smallest-area-first,
  // tapping the front ~47% of the visible engine selected SUSPENSION.
  out.push({ comp: 'suspension', x: F + barOff, y: 0, hw: barOff * 0.5 + 0.6, hh: geom.fHalfTrack * 0.78 });
  out.push({ comp: 'suspension', x: R + barOff, y: 0, hw: barOff * 0.5 + 0.6, hh: geom.rHalfTrack * 0.78 });

  // WHEELS & BRAKES — the four tire positions.
  const axles: ReadonlyArray<readonly [number, number]> = [[F, geom.fHalfTrack], [R, geom.rHalfTrack]];
  for (const [ax, ht] of axles) {
    out.push({ comp: 'wheels', x: ax, y: -ht, hw: L * 0.055, hh: W * 0.08 });
    out.push({ comp: 'wheels', x: ax, y: ht, hw: L * 0.055, hh: W * 0.08 });
  }
  return out;
}
