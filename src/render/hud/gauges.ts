/**
 * Canvas analog gauge cluster (RPM dial + speed digital + odometer +
 * warning symbols + date/FPS pills). Drawn on the HUD canvas as a
 * fallback when the SVG speedo/RPM widgets are disabled.
 *
 * Ported from monolith L29409-29940 (~530 lines of pure 2D drawing).
 * Mostly self-contained — no external deps beyond ctx + opts.
 *
 * Live as of H619 — interior drawing (warning symbols, needles, rolling
 * odo, cluster body) is fully ported (~660 lines). The earlier "SCAFFOLD"
 * header described the Phase C extraction point and is no longer accurate.
 */

// H71: the preset table + helper now live at config/cars/gaugePresets.ts
// as a 1:1 port of monolith GAUGE_PRESETS (L29287). Re-export so existing
// consumers (speedoSvg, drawGaugeCluster, future cluster body port) keep
// the same import surface.
export type { GaugePreset } from '@/config/cars/gaugePresets';
export { GAUGE_PRESETS, getGaugePreset } from '@/config/cars/gaugePresets';
import type { GaugePreset } from '@/config/cars/gaugePresets';

/** Per-frame gauge inputs. From the call site in render() (canvas HUD). */
export interface GaugeOpts {
  /** Engine RPM, idle to ~9000 typical. */
  rpm: number;
  /** Redline RPM (above this the dial reads red). */
  redline: number;
  /** Idle RPM (~800). */
  idleRPM: number;
  /** Vehicle speed (units per speedUnit). */
  speed: number;
  /** Top of speedometer scale (typically 220 mph / 350 kph). */
  speedMax: number;
  /** Display unit label ('MPH' | 'KPH'). */
  speedUnit: string;
  /** Selected gear (1..6, 'R', 'N'). */
  gear: number | string;
  /** Fuel level 0..1. */
  fuel: number;
  /** Coolant temp 0..1 (>0.85 reads red). */
  temp: number;
  /** Battery charge 0..1. */
  battery: number;
  /** Total miles/km on the odo. */
  odo: number;
  /** Odo unit label. */
  odoUnit: string;
  /** Time-of-day icon name ('sun' | 'sunset' | 'moon' | 'sunrise'). */
  todIcon: string;
  /** Time-of-day display name ('MORN', 'AFT', 'EVE', 'NIGHT'). */
  todName: string;
  /** Date string for display. */
  date: string;
  /** Frame rate for the FPS pill. */
  fps: number;
  /** v8.99.123.55: skip the inner RPM circle (background disk + bezel +
   *  ticks + labels + redline arc + ×1000 + gear digit + RPM needle).
   *  Used on mobile where the wheel-RPM SVG takes over. */
  skipRPM?: boolean;
  /** v8.99.123.56: skip the gas/temp rim arc gauges. Used on mobile
   *  where they moved to the wheel-OD SVG. */
  skipRim?: boolean;
  /** v8.99.123.58: skip the speedometer's tick marks, value labels, KM/H
   *  unit text, hub circle, and speed needle on canvas — the SVG overlay
   *  (#speedoSvg) renders these crisply. */
  skipSpeedo?: boolean;
}

// H71: getGaugePreset was the invented two-arg signature; the real
// monolith helper takes only genKey. Now re-exported above from
// config/cars/gaugePresets.

/** Per-render geometry + scale context shared by every gauge sub-widget.
 *  Mirrors the closure scope of the monolith's _drawGaugeCluster
 *  (L29415-29423): k = R/100 drives px() and font(); rimR/rimW position
 *  the outer arcs that hold the gas/temp rim gauges.
 *
 *  H72: extracted as an explicit struct so primitive ports
 *  (drawRimGauge, future drawGaugeCluster body) can share the math
 *  without each computing it separately. */
export interface GaugeCtx {
  cx: number;
  cy: number;
  R: number;
  k: number;
  px: (n: number) => number;
  font: (size: number) => string;
  rimR: number;
  rimW: number;
  preset: GaugePreset;
}

/** Build the geometry/scale context for a single cluster render.
 *  1:1 port of the closure setup at monolith L29415-29423. */
export function makeGaugeCtx(
  widgetCX: number,
  widgetCY: number,
  R: number,
  preset: GaugePreset,
): GaugeCtx {
  const k = R / 100;
  const px = (n: number): number => n * k;
  const font = (size: number): string =>
    'bold ' + Math.max(5, Math.round(size * k)) + 'px monospace';
  const rimGap = px(5);
  const rimW = px(11);
  const rimR = R + rimGap + rimW / 2;
  return { cx: widgetCX, cy: widgetCY, R, k, px, font, rimR, rimW, preset };
}

/** Signature shared by drawGaugeSymFuelPump / drawGaugeSymThermometer /
 *  drawGaugeSymBattery — so rimGauge can take any of them as drawSym. */
export type GaugeSymDraw = (
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
) => void;

/** Draws one of the three warning symbols (fuel pump / thermometer / battery).
 *  Vector path scaled by `size`; expects ctx.fillStyle already set.
 *  H70: 1:1 port of monolith _gaugeSymFuelPump at L29330. */
export function drawGaugeSymFuelPump(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(size / 16, size / 16);
  ctx.beginPath();
  ctx.moveTo(-5, -7); ctx.lineTo(2, -7); ctx.lineTo(2, 7); ctx.lineTo(-5, 7);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(2, -5); ctx.lineTo(5.5, -5); ctx.lineTo(5.5, -2); ctx.lineTo(7, -2);
  ctx.lineTo(7, -7); ctx.lineTo(5.5, -7); ctx.lineTo(5.5, -8.5); ctx.lineTo(2, -8.5);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.85)';
  ctx.fillRect(-3.5, -5, 4, 3);
  ctx.restore();
}

/** H70: 1:1 port of monolith _gaugeSymThermometer at L29342. */
export function drawGaugeSymThermometer(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(size / 16, size / 16);
  ctx.beginPath();
  ctx.arc(0, 4, 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.rect(-1.3, -7, 2.6, 11);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0, -7, 1.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 1.0;
  // Monolith reassigns strokeStyle = ctx.fillStyle so the wavy "heat" line
  // matches the symbol body color the caller set. Cast through string |
  // CanvasGradient | CanvasPattern — the canvas API allows the assignment
  // even though TypeScript is strict about the union type.
  ctx.strokeStyle = ctx.fillStyle as string;
  ctx.beginPath();
  ctx.moveTo(-6, 8.5);
  ctx.bezierCurveTo(-4, 7.5, -2, 9.5, 0, 8.5);
  ctx.bezierCurveTo(2, 7.5, 4, 9.5, 6, 8.5);
  ctx.stroke();
  ctx.restore();
}

/** H70: 1:1 port of monolith _gaugeSymBattery at L29355. */
export function drawGaugeSymBattery(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(size / 16, size / 16);
  ctx.beginPath();
  ctx.rect(-7, -4, 14, 9);
  ctx.fill();
  ctx.beginPath();
  ctx.rect(-5, -6, 2.5, 2);
  ctx.fill();
  ctx.beginPath();
  ctx.rect(2.5, -6, 2.5, 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.85)';
  ctx.fillRect(-5.0, -0.5, 3.0, 1.0);
  ctx.fillRect(-3.85, -1.8, 0.7, 3.6);
  ctx.fillRect(2.0, -0.5, 3.0, 1.0);
  ctx.restore();
}

/** Rolling 6-digit odometer with the unit label trailing right. Cells are
 *  dark-brown with body-color digits.
 *  H70: 1:1 port of monolith _gaugeOdometer at L29368. */
export function drawGaugeOdometer(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  value: number,
  color: string,
  unitLabel: string,
): void {
  const digits = 6;
  const cellW = 7.5;
  const cellH = 11;
  const totalW = cellW * digits + (digits - 1) * 0.6;
  const x0 = cx - totalW / 2;
  const y0 = cy - cellH / 2;
  let s = String(Math.max(0, Math.floor(value)));
  while (s.length < digits) s = '0' + s;
  ctx.save();
  for (let i = 0; i < digits; i++) {
    const cellX = x0 + i * (cellW + 0.6);
    ctx.fillStyle = '#15110c';
    ctx.fillRect(cellX, y0, cellW, cellH);
    ctx.strokeStyle = '#3a2f20';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(cellX, y0, cellW, cellH);
    ctx.fillStyle = color;
    ctx.font = 'bold 9px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(s[i], cellX + cellW / 2, y0 + cellH / 2 + 0.5);
  }
  ctx.fillStyle = color;
  ctx.font = 'bold 7px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(unitLabel, x0 + totalW + 3, y0 + cellH / 2 + 0.5);
  ctx.restore();
}

/** Scale-aware odometer — same look as drawGaugeOdometer but every dimension
 *  scales by `k` (the dial's R / 100 factor). Cell dimensions and font
 *  sizes both floor to readable minimums so the digits stay legible at
 *  small cluster radii (mobile path).
 *  H73: 1:1 port of monolith _gaugeOdometer_scaled at L29849. */
export function drawGaugeOdometerScaled(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  value: number,
  color: string,
  unitLabel: string,
  k: number,
): void {
  const digits = 6;
  const cellW = Math.max(4, 7.5 * k);
  const cellH = Math.max(6, 11 * k);
  const cellGap = 0.6 * k;
  const totalW = cellW * digits + (digits - 1) * cellGap;
  const x0 = cx - totalW / 2;
  const y0 = cy - cellH / 2;
  let s = String(Math.max(0, Math.floor(value)));
  while (s.length < digits) s = '0' + s;
  ctx.save();
  for (let i = 0; i < digits; i++) {
    const cellX = x0 + i * (cellW + cellGap);
    ctx.fillStyle = '#15110c';
    ctx.fillRect(cellX, y0, cellW, cellH);
    ctx.strokeStyle = '#3a2f20';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(cellX, y0, cellW, cellH);
    ctx.fillStyle = color;
    ctx.font = 'bold ' + Math.max(5, Math.round(9 * k)) + 'px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(s[i], cellX + cellW / 2, y0 + cellH / 2 + 0.5);
  }
  ctx.fillStyle = color;
  ctx.font = 'bold ' + Math.max(5, Math.round(7 * k)) + 'px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(unitLabel, x0 + totalW + 3 * k, y0 + cellH / 2 + 0.5);
  ctx.restore();
}

/** Triangular needle with a small back-tail and optional circular hub.
 *  H70: 1:1 port of monolith _gaugeNeedle at L29390. */
export function drawGaugeNeedle(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  angle: number,
  length: number,
  baseW: number,
  color: string,
  hubR?: number,
): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(0, -baseW / 2);
  ctx.lineTo(length, 0);
  ctx.lineTo(0, +baseW / 2);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(0, -baseW / 2);
  ctx.lineTo(-length * 0.18, 0);
  ctx.lineTo(0, +baseW / 2);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  if (hubR) {
    ctx.beginPath();
    ctx.arc(cx, cy, hubR, 0, Math.PI * 2);
    ctx.fillStyle = '#222';
    ctx.fill();
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 1.0;
    ctx.stroke();
  }
}

/** Rim-mounted half-circle gauge (gas, temp, etc.) hugging the cluster's
 *  outer bezel. 85° sweep, low/high ends derived from the +sin direction
 *  so the same code lays out gas (centered at 0°) and temp (centered at
 *  180°) correctly — the v8.99.123.57 fix at L29734-29737.
 *
 *  H72: 1:1 port of inner rimGauge function at monolith L29727-29774.
 *  Parent-scope closures (cx, cy, rimR, rimW, preset, px, font) come in
 *  via gctx from makeGaugeCtx. drawSym=null skips the warning-symbol
 *  paint (mobile-OD path doesn't draw the symbol). */
export function drawRimGauge(
  ctx: CanvasRenderingContext2D,
  gctx: GaugeCtx,
  centerAngleDeg: number,
  drawSym: GaugeSymDraw | null,
  value: number,
  criticalLow: boolean,
  lowLabel: string | null,
  highLabel: string | null,
): void {
  const { cx, cy, rimR, rimW, preset, px, font } = gctx;
  const cA = (centerAngleDeg * Math.PI) / 180;
  const halfSweep = (42.5 * Math.PI) / 180;  // 85° total (90° - 5° gap split)
  const a0 = cA - halfSweep;
  const a1 = cA + halfSweep;
  ctx.beginPath();
  ctx.arc(cx, cy, rimR, a0, a1);
  ctx.lineWidth = rimW;
  ctx.strokeStyle = '#1a1a1a';
  ctx.stroke();
  const v = Math.max(0, Math.min(1, value));
  // v8.99.123.57: resolve low/high end from angle geometry, not by
  // assuming a fixed mapping (which broke temp in v56).
  const lowAngle = Math.sin(a0) >= Math.sin(a1) ? a0 : a1;
  const highAngle = lowAngle === a0 ? a1 : a0;
  const valueAngle = lowAngle + (highAngle - lowAngle) * v;
  const tipR = rimR + rimW / 2;
  const baseR = rimR - rimW / 2 - px(2);
  let needleColor = preset.rimNeedleColor;
  if (criticalLow && v <= 0.15) needleColor = '#f00';
  else if (criticalLow && v <= 0.30) needleColor = '#f80';
  ctx.beginPath();
  ctx.lineWidth = Math.max(1, px(2.0));
  ctx.strokeStyle = needleColor;
  ctx.moveTo(cx + baseR * Math.cos(valueAngle), cy + baseR * Math.sin(valueAngle));
  ctx.lineTo(cx + tipR  * Math.cos(valueAngle), cy + tipR  * Math.sin(valueAngle));
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(
    cx + baseR * Math.cos(valueAngle),
    cy + baseR * Math.sin(valueAngle),
    Math.max(0.8, px(1.6)),
    0,
    Math.PI * 2,
  );
  ctx.fillStyle = needleColor;
  ctx.fill();
  // v44: symbol drawing skipped if drawSym is null.
  if (drawSym) {
    const symR = rimR + rimW / 2 + px(14);
    ctx.fillStyle = '#ddd';
    drawSym(ctx, cx + symR * Math.cos(cA), cy + symR * Math.sin(cA), Math.max(8, px(14)));
  }
  // Endpoint labels (E/F, C/H) placed OUTSIDE the rim arc per v45.
  // v8.99.123.57: lowLabel at lowAngle (geometric bottom-side end),
  // highLabel at highAngle (top-side end).
  if (lowLabel || highLabel) {
    const lblR = rimR + rimW / 2 + px(7);
    ctx.fillStyle = '#bbb';
    ctx.font = font(9);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (lowLabel)  ctx.fillText(lowLabel,  cx + lblR * Math.cos(lowAngle),  cy + lblR * Math.sin(lowAngle));
    if (highLabel) ctx.fillText(highLabel, cx + lblR * Math.cos(highAngle), cy + lblR * Math.sin(highAngle));
  }
}

/**
 * Main entry — paints the full PC canvas gauge cluster (speedometer disk,
 * inner RPM circle, gas/temp rim arcs, center stack with KM/H + odometer,
 * RPM-interior labels, needles, and the bottom-right MENU button).
 *
 * H74: 1:1 port of monolith _drawGaugeCluster at L29415-29846. Calls
 * already-ported helpers — drawGaugeNeedle (H70), drawRimGauge (H72),
 * drawGaugeOdometerScaled (H73) — for the leaf bits. The closure scope
 * (cx, cy, k, px, font, rimR, rimW, preset) lives on GaugeCtx via
 * makeGaugeCtx (H72).
 *
 * Removed from the monolith (per v8.99.123.42-67 archaeology):
 *   - Battery gauge (third rim arc — v42)
 *   - TL (ToD) + TR (Date) pills — v43
 *   - Symbol icons on rim gauges — v44
 *   - BL Gear pill — v67 (gear is now shown INSIDE the RPM circle)
 *
 * Inner `pill()` helper at L29784-29808 is intentionally NOT ported —
 * it's dead code in the monolith (BL gear pill was removed in v67, and
 * the MENU button draws inline below). Skipping the dead inner function
 * avoids a TS "unused function" warning; behavior is identical.
 */
export function drawGaugeCluster(
  ctx: CanvasRenderingContext2D,
  widgetCX: number,
  widgetCY: number,
  R: number,
  opts: GaugeOpts,
  preset: GaugePreset,
): void {
  const gctx = makeGaugeCtx(widgetCX, widgetCY, R, preset);
  const { cx, cy, k, px, font, rimR, rimW } = gctx;
  // v8.99.123.42: pill anchor radius — corner pills sit nearly tangent
  // to the bezel. Only the BR MENU button consumes this now (BL gear
  // pill removed in v67).
  const footR = rimR + rimW / 2 + px(2);
  const skipRPM = !!opts.skipRPM;
  const skipRim = !!opts.skipRim;
  const skipSpeedo = !!opts.skipSpeedo;

  // ===== BACKGROUND DISK + BEZEL (v8.99.123.48 render order) =====
  //   1. Fill speedometer disk
  //   2. Stroke speedometer bezel (full circle outline at radius R)
  //   3. Fill RPM disk (covers speedo bezel arc in the overlap region)
  //   4. Stroke RPM bezel (full small-circle outline)
  // Result: speedo bezel hidden inside the RPM circle, RPM bezel visible
  // throughout.
  const _v47_speedTickInner = R - px(19);
  const _v47_rpmCircleR = _v47_speedTickInner;                                          // ≈ 0.81*R
  const _v47_rpmCircleCy = cy + _v47_speedTickInner * Math.SQRT2 + px(15);              // v54: +px(15) to clear lowest speed labels
  // v8.99.123.74: PC canvas fills the dial backdrop (mobile skips since
  // the wheel-interior SVG has its own backing circle).
  const _isMobMobileDial = typeof document !== 'undefined' && document.body.classList.contains('mob');
  if (!_isMobMobileDial) {
    ctx.fillStyle = preset.faceColor;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = Math.max(1, px(2));
    ctx.strokeStyle = preset.bezelColor;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = preset.faceColor;
  if (!skipRPM) {
    ctx.beginPath();
    ctx.arc(cx, _v47_rpmCircleCy, _v47_rpmCircleR, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = Math.max(1, px(2));
    ctx.strokeStyle = preset.bezelColor;
    ctx.beginPath();
    ctx.arc(cx, _v47_rpmCircleCy, _v47_rpmCircleR, 0, Math.PI * 2);
    ctx.stroke();
  }

  // ===== SPEEDOMETER (outer ring) =====
  let speedTickStep: number;
  let speedLabelStep: number;
  if (opts.speedMax <= 280) { speedTickStep = 20; speedLabelStep = 40; }
  else if (opts.speedMax <= 360) { speedTickStep = 40; speedLabelStep = 80; }
  else { speedTickStep = 50; speedLabelStep = 100; }
  const speedStartAngle = (135 * Math.PI) / 180;
  const speedSweep = (270 * Math.PI) / 180;
  const speedTrackR = R - px(9);
  const speedTickInner = R - px(19);
  const speedLabelR = R - px(32);
  ctx.lineCap = 'butt';
  // v8.99.123.58: tick marks + speed-value labels suppressed when SVG
  // overlay handles them.
  if (!skipSpeedo) {
    // v40b: minor ticks removed.
    for (let s = 0; s <= opts.speedMax; s += speedTickStep) {
      const f = s / opts.speedMax;
      const a = speedStartAngle + speedSweep * f;
      ctx.beginPath();
      ctx.lineWidth = px(2.0);
      ctx.strokeStyle = '#eaeaea';
      const r1 = speedTickInner;
      const r2 = speedTrackR;
      ctx.moveTo(cx + r1 * Math.cos(a), cy + r1 * Math.sin(a));
      ctx.lineTo(cx + r2 * Math.cos(a), cy + r2 * Math.sin(a));
      ctx.stroke();
    }
    ctx.fillStyle = preset.speedTextColor;
    ctx.font = font(13);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let s = 0; s <= opts.speedMax; s += speedLabelStep) {
      const f = s / opts.speedMax;
      const a = speedStartAngle + speedSweep * f;
      ctx.fillText(String(s), cx + speedLabelR * Math.cos(a), cy + speedLabelR * Math.sin(a));
    }
  }

  // ===== INNER RPM RING (v8.99.123.47 — sweep matches speedometer) =====
  if (!skipRPM) {
    const rpmCircleR = _v47_rpmCircleR;
    const rpmCircleCx = cx;
    const rpmCircleCy = _v47_rpmCircleCy;
    const rpmTickInner = rpmCircleR - px(8);
    const rpmTickOuter = rpmCircleR;
    const rpmLabelR = rpmCircleR - px(14);
    const rpmStartAngle = speedStartAngle;
    const rpmSweep = speedSweep;
    const totalRPM = opts.redline;
    const rpmTickStep = 1000;
    // Full 360° background ring (faint).
    ctx.beginPath();
    ctx.arc(rpmCircleCx, rpmCircleCy, rpmCircleR, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(0.5, px(1.0));
    ctx.strokeStyle = '#2a2a2a';
    ctx.stroke();
    // Redline arc.
    const redStart = rpmStartAngle + rpmSweep * preset.redlineFrac;
    const redEnd = rpmStartAngle + rpmSweep;
    ctx.beginPath();
    ctx.arc(rpmCircleCx, rpmCircleCy, rpmCircleR, redStart, redEnd);
    ctx.lineWidth = Math.max(1, px(3.0));
    ctx.strokeStyle = '#c00';
    ctx.stroke();
    // Major tick marks.
    for (let r = 0; r <= totalRPM; r += rpmTickStep) {
      const f = r / totalRPM;
      const a = rpmStartAngle + rpmSweep * f;
      ctx.beginPath();
      ctx.lineWidth = px(1.6);
      ctx.strokeStyle = '#bbb';
      const r1 = rpmTickInner;
      const r2 = rpmTickOuter;
      ctx.moveTo(rpmCircleCx + r1 * Math.cos(a), rpmCircleCy + r1 * Math.sin(a));
      ctx.lineTo(rpmCircleCx + r2 * Math.cos(a), rpmCircleCy + r2 * Math.sin(a));
      ctx.stroke();
    }
    // RPM number labels (1, 2, 3, ...).
    ctx.fillStyle = preset.rpmTextColor;
    ctx.font = font(10);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let r = rpmTickStep; r <= totalRPM; r += rpmTickStep) {
      const f = r / totalRPM;
      const a = rpmStartAngle + rpmSweep * f;
      ctx.fillText(String(r / 1000), rpmCircleCx + rpmLabelR * Math.cos(a), rpmCircleCy + rpmLabelR * Math.sin(a));
    }
  }

  // ===== CENTER STACK (v8.99.123.48/54/58) =====
  if (!skipSpeedo) {
    ctx.fillStyle = '#888';
    ctx.font = font(8);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(opts.speedUnit || 'KM/H', cx, cy - px(34));
  }
  ctx.textBaseline = 'alphabetic';
  if (R >= 50) {
    drawGaugeOdometerScaled(ctx, cx, cy + px(36), opts.odo || 0, preset.odoColor, opts.odoUnit || 'KM', k);
  }

  // ===== RPM GAUGE INTERIOR LABELS (v8.99.123.54) =====
  if (!skipRPM) {
    const rpmCircleCx = cx;
    const rpmCircleCy = _v47_rpmCircleCy;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#888';
    ctx.font = font(7);
    ctx.fillText('×1000 RPM', rpmCircleCx, rpmCircleCy - px(10));
    // Gear # under pivot. v54: bright green (#7fff5a) matching the
    // legacy GEAR pill color for continuity.
    ctx.fillStyle = '#7fff5a';
    ctx.font = font(14);
    ctx.fillText(String(opts.gear ?? '-'), rpmCircleCx, rpmCircleCy + px(20));
  }

  // ===== NEEDLES (v8.99.123.44/49/55/58) =====
  if (!skipRPM) {
    const rpmCircleR = _v47_rpmCircleR;
    const rpmCircleCx = cx;
    const rpmCircleCy = _v47_rpmCircleCy;
    const rpmStartAngle = speedStartAngle;
    const rpmSweep = speedSweep;
    // v8.99.123.49: needle frac is rpm/redline (NOT (rpm-idle)/(redline-idle))
    // so the needle aligns with the absolute-scale tick labels.
    const rpmFrac = Math.max(0, Math.min(1, opts.rpm / opts.redline));
    const rpmAngle = rpmStartAngle + rpmSweep * rpmFrac;
    drawGaugeNeedle(ctx, rpmCircleCx, rpmCircleCy, rpmAngle, rpmCircleR + px(4), Math.max(1.5, px(3.4)), preset.rpmNeedleColor, 0);
  }
  const speedFrac = Math.max(0, Math.min(1, opts.speed / opts.speedMax));
  const speedAngle = speedStartAngle + speedSweep * speedFrac;
  if (!skipSpeedo) {
    drawGaugeNeedle(ctx, cx, cy, speedAngle, speedTrackR - px(1), Math.max(1.5, px(3.0)), preset.speedNeedleColor, Math.max(2, px(5.5)));
  }

  // ===== RIM GAUGES (v8.99.123.42/43/44/45/56/57) =====
  // Gas centered at 0° (right), temp at 180° (left). Symbol icons skipped
  // per v44 (drawSym=null). E/F + C/H labels placed at the geometrically
  // determined low/high arc endpoints per v57.
  if (!skipRim) {
    drawRimGauge(ctx, gctx,   0, null, opts.fuel, true,  'E', 'F');
    drawRimGauge(ctx, gctx, 180, null, opts.temp, false, 'C', 'H');
  }

  // ===== CORNER PILLS =====
  // v8.99.123.43: TL (ToD) + TR (Date) pills REMOVED.
  // v8.99.123.67: BL Gear pill REMOVED (gear is shown inside the RPM
  //   circle's interior labels block above).
  // Only the BR MENU button remains. Reference angle math kept for any
  // future pill that wants to anchor off footR — currently unused.
  const _blA = (135 * Math.PI) / 180;
  void _blA;
  // BR: MENU button — v42 bumped 40% (was 48×22 with 12px font; now 64×30
  // with 17px). v44: pin right edge to gas-gauge outer arc edge (=
  // cx + rimR + rimW/2) so the cluster's bbox doesn't exceed HUD_W.
  const brA = (45 * Math.PI) / 180;
  const brAY = cy + footR * Math.sin(brA);
  const menuW = px(64);
  const menuH = px(30);
  const menuRightX = cx + rimR + rimW / 2;
  const menuX = menuRightX - menuW;
  const menuY = brAY;
  ctx.fillStyle = 'rgba(60,60,90,0.65)';
  ctx.fillRect(menuX, menuY, menuW, menuH);
  ctx.strokeStyle = '#557';
  ctx.lineWidth = 1.0;
  ctx.strokeRect(menuX, menuY, menuW, menuH);
  ctx.fillStyle = '#bbf';
  ctx.font = font(17);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('MENU', menuX + menuW / 2, menuY + menuH / 2);
}
