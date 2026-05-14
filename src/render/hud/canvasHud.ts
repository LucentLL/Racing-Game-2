/**
 * Canvas-fallback HUD — speedometer + tachometer + gear indicator drawn
 * directly on the HUD canvas when the SVG widgets are disabled (mobile
 * portrait without enough screen room, or display_failure fault).
 *
 * Ported from monolith L34447-34795 (~350 lines). The HUD context swap
 * (ctx → hctx, GH → GH_BASE, WORLD_GW → GW) is performed by the
 * orchestrator before this module is called.
 *
 * SCAFFOLD status: type contract + public entry points. Interior pixel
 * code stubbed with TODOs.
 */

/** Per-frame HUD state. */
export interface CanvasHudOpts {
  /** Vehicle speed for the digital readout. */
  speed: number;
  /** Display unit ('MPH' | 'KPH'). */
  speedUnit: string;
  /** Engine RPM for the bar tach. */
  rpm: number;
  redline: number;
  /** Selected gear. */
  gear: number | string;
  /** True = manual transmission visible label. */
  isManual: boolean;
  /** Brake-pedal-down flash. */
  isBraking: boolean;
  /** E-brake engaged. */
  ebrk: boolean;
  /** Fuel 0..1 — gauge fills proportionally. */
  fuel: number;
  /** True hides the speedo/tach (display_failure fault). */
  hideGauges: boolean;
}

export interface CanvasHudGeometry {
  /** Canvas internal width / height. */
  GW: number;
  GH: number;
  /** Mobile vs PC layout (mobile shifts gauges to corners). */
  isMobile: boolean;
}

/** Draws the speed digital + speedometer ring at the configured anchor.
 *  TODO(C20-followup): port from L34447-34568. */
export function drawCanvasSpeedo(
  _ctx: CanvasRenderingContext2D,
  _opts: CanvasHudOpts,
  _geom: CanvasHudGeometry,
): void {
  // TODO: L34447-34568.
}

/** Draws the bar / arc tach with redline pulse. TODO(C20-followup):
 *  port from L34568-34700. */
export function drawCanvasTach(
  _ctx: CanvasRenderingContext2D,
  _opts: CanvasHudOpts,
  _geom: CanvasHudGeometry,
): void {
  // TODO: L34568-34700.
}

/** Draws the gear indicator (R / N / 1..6) at the configured anchor.
 *  TODO(C20-followup): port from L34700-34795. */
export function drawCanvasGear(
  _ctx: CanvasRenderingContext2D,
  _opts: CanvasHudOpts,
  _geom: CanvasHudGeometry,
): void {
  // TODO: L34700-34795.
}

/** Entry point — draws the three sub-widgets in the right order. */
export function drawCanvasHud(
  ctx: CanvasRenderingContext2D,
  opts: CanvasHudOpts,
  geom: CanvasHudGeometry,
): void {
  if (opts.hideGauges) return;
  drawCanvasTach(ctx, opts, geom);
  drawCanvasSpeedo(ctx, opts, geom);
  drawCanvasGear(ctx, opts, geom);
}
