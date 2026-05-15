/**
 * SVG speedometer widget. Drives the dial in #speedoSvg by:
 *   - building static tick + label content when speedMax/unit changes
 *     (rare — only on car change),
 *   - rotating the needle every frame,
 *   - resyncing CSS position/size when the layout flips (mob ↔ pc, resize).
 *
 * Mobile-only on the per-frame update path: PC reverts to the canvas
 * speedometer (perf — the SVG version cost ~12 ms/frame at 1080p in v123).
 *
 * Ported from monolith L22896-23040. The DOM elements (#speedoSvg,
 * #speedoStaticContent, #speedoNeedle, #speedoNeedlePoly) are part of
 * the static index.html shell and don't move; this module only mutates
 * their attributes / innerHTML.
 *
 * SCAFFOLD status: type contract + public entry points. Internal element
 * caching + SVG-string assembly stubbed with TODO line refs.
 */

import type { GaugePreset } from '../../render/hud/gauges';

/** Per-frame inputs for the SVG needle update. */
export interface SpeedoSvgOpts {
  /** Current wheel speed in game units (pWheelSpeedGU). */
  wheelSpeedGU: number;
  /** SCALE_MS conversion factor (game-units → m/s). */
  scaleMs: number;
  /** True when the active car reports unit==='mph'. */
  isMph: boolean;
  /** Top speed in game units (drives the dial range). */
  topSpeed: number;
  /** Active car's gauge preset (needleColor, etc.). */
  preset: GaugePreset | null;
  /** True when display_failure fault hides the gauges. */
  hideGauges: boolean;
}

/** CSS positioning inputs. The host (resize / orientation flip) drives this. */
export interface SpeedoSvgGeometry {
  /** True for body.mob, false for body.pc. */
  isMobile: boolean;
  /** HUD canvas internal width (HUD_W). */
  hudW: number;
}

/** Builds the static tick marks + speed labels + unit text. Called once
 *  per (speedMax, unit) change — typically only on car switch.
 *  TODO(D27-followup): port from L22907-22944. */
export function buildSpeedoSvg(_speedMax: number, _speedUnit: string): void {
  // TODO: L22907-22944.
}

/** Per-frame needle update. Mobile-only — bails on body.pc.
 *  TODO(D27-followup): port from L22945-23000. */
export function updateSpeedoSvg(_opts: SpeedoSvgOpts): void {
  // TODO: L22945-23000. Rebuilds static content via buildSpeedoSvg() if
  // speedMax / unit changed; updates needle rotation + fill.
}

/** Recomputes left/top/width/height when layout flips. Tracks a position
 *  signature internally so it only writes to the DOM on actual change.
 *  TODO(D27-followup): port from L23001-23040. */
export function syncSpeedoSvgPosition(_geom: SpeedoSvgGeometry): void {
  // TODO: L23001-23040.
}
