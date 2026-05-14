/**
 * Canvas analog gauge cluster (RPM dial + speed digital + odometer +
 * warning symbols + date/FPS pills). Drawn on the HUD canvas as a
 * fallback when the SVG speedo/RPM widgets are disabled.
 *
 * Ported from monolith L29409-29940 (~530 lines of pure 2D drawing).
 * Mostly self-contained — no external deps beyond ctx + opts.
 *
 * SCAFFOLD status: type contract + public entry points are present.
 * The interior drawing functions (vector warning symbols, needle
 * geometry, rolling odometer, gauge cluster body) are stubbed with
 * TODO references to the monolith line ranges. They're pure pixel
 * code that ports mechanically — deferred to a follow-up commit so
 * Phase C scaffolding completes faster.
 */

/** Preset bundle for one chassis generation. Holds dial scales, RPM redline
 *  position, color choices, speedometer style, etc. From GAUGE_PRESETS. */
export interface GaugePreset {
  /** Display label for the chassis (e.g. 'CIVIC EG'). */
  label: string;
  /** Needle + accent color. */
  color: string;
  /** RPM redline as fraction of max. */
  redlineFrac: number;
  /** Backplate color hex. */
  bgColor: string;
  /** Numeral color hex. */
  numColor: string;
  /** Extra preset-specific knobs (cluster shape, marker style). */
  [key: string]: unknown;
}

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
}

/** Resolves a generation key to its gauge preset. Falls back to the default
 *  preset when no chassis-specific one is registered. From L29409. */
export function getGaugePreset(
  presets: Readonly<Record<string, GaugePreset>>,
  genKey: string,
): GaugePreset {
  return presets[genKey] || presets.default;
}

/** Draws one of the three warning symbols (fuel pump / thermometer / battery).
 *  Vector path scaled by `size`; expects ctx.fillStyle already set.
 *  TODO(C20-followup): port the vector geometry from L29412-29447. */
export function drawGaugeSymFuelPump(
  _ctx: CanvasRenderingContext2D,
  _cx: number,
  _cy: number,
  _size: number,
): void {
  // TODO: monolith L29412-29423.
}

export function drawGaugeSymThermometer(
  _ctx: CanvasRenderingContext2D,
  _cx: number,
  _cy: number,
  _size: number,
): void {
  // TODO: monolith L29424-29436.
}

export function drawGaugeSymBattery(
  _ctx: CanvasRenderingContext2D,
  _cx: number,
  _cy: number,
  _size: number,
): void {
  // TODO: monolith L29437-29447.
}

/** Rolling 6-digit odometer with the unit label trailing right. Cells are
 *  dark-brown with body-color digits. From L29450-29468.
 *  TODO(C20-followup): port the cell + digit drawing. */
export function drawGaugeOdometer(
  _ctx: CanvasRenderingContext2D,
  _cx: number,
  _cy: number,
  _value: number,
  _color: string,
  _unitLabel: string,
): void {
  // TODO: L29450-29468.
}

/** Scale-aware odometer — same look as drawGaugeOdometer but every dimension
 *  scales by `k` (the dial's R / 100 factor). From L29931-onwards. */
export function drawGaugeOdometerScaled(
  _ctx: CanvasRenderingContext2D,
  _cx: number,
  _cy: number,
  _value: number,
  _color: string,
  _unitLabel: string,
  _k: number,
): void {
  // TODO: L29931+.
}

/** Triangular needle with a circular hub. From L29472-29487.
 *  TODO(C20-followup): port the path. */
export function drawGaugeNeedle(
  _ctx: CanvasRenderingContext2D,
  _cx: number,
  _cy: number,
  _angle: number,
  _length: number,
  _baseW: number,
  _color: string,
  _hubR?: number,
): void {
  // TODO: L29472-29487.
}

/**
 * Main entry — paints the full gauge cluster at (widgetCX, widgetCY) with
 * dial radius R, dispatching to all the helpers above. Reads `preset` for
 * per-chassis color/style. Reads `opts` for live state.
 *
 * From L29497-29929 (~430 lines of dial + RPM arc + speed digital +
 * warning lights + corner pills). The largest internal scaling step uses
 * `k = R / 100`.
 *
 * TODO(C20-followup): port the full body.
 */
export function drawGaugeCluster(
  _ctx: CanvasRenderingContext2D,
  _widgetCX: number,
  _widgetCY: number,
  _R: number,
  _opts: GaugeOpts,
  _preset: GaugePreset,
): void {
  // TODO: monolith L29497-29929.
}
