/**
 * Mobile SVG speedometer overlay — crisp vector ticks + labels + needle
 * layered above the HUD canvas. Replaces the canvas-rasterized
 * tick/label/unit/needle layer of drawGaugeCluster on mobile; the
 * canvas cluster continues to paint the dial fill, bezel, RPM, fuel
 * gauge, etc. PC bails — canvas is sharper at the cluster's PC
 * footprint and avoids per-frame DOM writes.
 *
 * Three pieces:
 *
 *   - buildSpeedoSvg(speedMax, speedUnit) — populates #speedoStaticContent
 *     with tick marks (every 20/40/50 kph or mph depending on max), integer
 *     speed labels (every 40/80/100), and the unit text. Called at startup
 *     and on car change (any time speedMax or unit flips between cars).
 *
 *   - updateSpeedoSvg(opts) — per-frame. Bails on PC. Rebuilds static
 *     content if the speedMax/unit changed since last frame. Updates needle
 *     transform (rotate(135° + 270° × speedFrac)) and needle fill color.
 *
 *   - syncSpeedoSvgPosition(canvasW, canvasH, isMobile, ...) — anchors the
 *     SVG element to the canvas cluster's screen footprint. Called from
 *     fitCanvases (H626 follow-up).
 *
 * Geometry constants mirror the monolith (L22826-L22862): the SVG viewBox
 * is -100..100 so tick math uses the same magic numbers as the canvas
 * cluster's `px(N)` macro at R=100. startDeg=135 sweep=270 means the dial
 * runs counterclockwise from "8 o'clock low" through "12 high" to "4
 * o'clock low" — same as the canvas needle.
 *
 * 1:1 with monolith _buildSpeedoSvg (L22826) + _updateSpeedoSvg (L22864).
 */

import { isGt2Night } from '@/ui/gt2Chrome';

let speedoSvgEl: Element | null = null;
let speedoStaticEl: Element | null = null;
let speedoNeedleEl: Element | null = null;
let speedoNeedlePolyEl: Element | null = null;
let speedoFuelNeedleEl: Element | null = null;

let cachedSpeedMax = -1;
let cachedUnit = '';
let cachedNight = false;
let cachedNeedleColor = '';
let lastNeedleDeg = NaN;
let lastFuelDeg = NaN;
let lastFuelColor = '';

/** H739 backlit-cluster color palette for the gauge ticks / labels /
 *  unit text. Day = original near-white #eaeaea / #e0e0e0 / #888.
 *  Night = sage-yellow #b8c64a / darker sage #7a8a30, matching the
 *  H738 GT2 menu palette so the gauges glow with the same instrument
 *  backlight as the menus. Needle color stays per-car-preset on the
 *  caller's path. */
function gaugeColors(): { tick: string; label: string; unit: string } {
  if (isGt2Night()) {
    return { tick: '#b8c64a', label: '#b8c64a', unit: '#7a8a30' };
  }
  return { tick: '#eaeaea', label: '#e0e0e0', unit: '#888' };
}

/** Lazy DOM lookup — defer until first call so the module imports cleanly
 *  in headless / pre-DOM contexts. Returns false if any required element
 *  is missing (e.g. index.html hasn't loaded yet). */
function ensureEls(): boolean {
  if (speedoSvgEl) return true;
  if (typeof document === 'undefined') return false;
  speedoSvgEl = document.getElementById('speedoSvg');
  speedoStaticEl = document.getElementById('speedoStaticContent');
  speedoNeedleEl = document.getElementById('speedoNeedle');
  speedoNeedlePolyEl = document.getElementById('speedoNeedlePoly');
  speedoFuelNeedleEl = document.getElementById('speedoFuelNeedle');
  return !!(speedoSvgEl && speedoStaticEl && speedoNeedleEl && speedoNeedlePolyEl);
}

/** Build (or rebuild) the static tick + label + unit content inside the
 *  #speedoStaticContent group. Called on speedMax / unit change. */
export function buildSpeedoSvg(speedMax: number, speedUnit: string): void {
  if (!ensureEls() || !speedoStaticEl) return;
  let tickStep: number;
  let labelStep: number;
  if (speedMax <= 280) { tickStep = 20; labelStep = 40; }
  else if (speedMax <= 360) { tickStep = 40; labelStep = 80; }
  else { tickStep = 50; labelStep = 100; }
  const startDeg = 135;
  const sweepDeg = 270;
  const trackR = 91;
  const tickInnerR = 81;
  const labelR = 68;
  const col = gaugeColors();
  const parts: string[] = [];
  for (let s = 0; s <= speedMax; s += tickStep) {
    const f = s / speedMax;
    const aRad = ((startDeg + sweepDeg * f) * Math.PI) / 180;
    const x1 = (tickInnerR * Math.cos(aRad)).toFixed(2);
    const y1 = (tickInnerR * Math.sin(aRad)).toFixed(2);
    const x2 = (trackR * Math.cos(aRad)).toFixed(2);
    const y2 = (trackR * Math.sin(aRad)).toFixed(2);
    parts.push('<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="' + col.tick + '" stroke-width="2"/>');
  }
  for (let s = 0; s <= speedMax; s += labelStep) {
    const f = s / speedMax;
    const aRad = ((startDeg + sweepDeg * f) * Math.PI) / 180;
    const x = (labelR * Math.cos(aRad)).toFixed(2);
    const y = (labelR * Math.sin(aRad)).toFixed(2);
    parts.push('<text x="' + x + '" y="' + y + '" fill="' + col.label + '" font-family="monospace" font-weight="bold" font-size="13" text-anchor="middle" dominant-baseline="middle">' + s + '</text>');
  }
  parts.push('<text x="0" y="-34" fill="' + col.unit + '" font-family="monospace" font-weight="bold" font-size="8" text-anchor="middle" dominant-baseline="alphabetic">' + (speedUnit || 'KM/H') + '</text>');
  speedoStaticEl.innerHTML = parts.join('');
}

/** Per-frame inputs for updateSpeedoSvg. Caller pulls these from the same
 *  sources the canvas cluster reads (so PC and mobile see identical numbers). */
export interface SpeedoSvgOpts {
  /** Current speed in the unit shown (mph or kph). */
  speed: number;
  /** Top-of-scale (matches GaugeOpts.speedMax). */
  speedMax: number;
  /** 'MPH' | 'KM/H'. */
  unit: string;
  /** Per-car needle color from gauge preset. Falls back to '#e44'. */
  needleColor?: string;
  /** Fuel level 0..1 — drives the H628 fuel needle on the speedo's
   *  left OD. Hidden under hideGauges. */
  fuel?: number;
  /** display_failure fault hides the needle (blanks to 0). */
  hideGauges?: boolean;
}

/** Per-frame needle + cached-static update. PC bails immediately — the
 *  canvas gauge cluster owns the dial there. */
export function updateSpeedoSvg(opts: SpeedoSvgOpts): void {
  if (typeof document === 'undefined') return;
  if (!document.body.classList.contains('mob')) return;
  if (!ensureEls() || !speedoNeedleEl) return;

  // Cache invalidation — rebuild static content if speedMax, unit, or
  // the H739 night-cluster-glow palette flipped since last frame.
  const nightNow = isGt2Night();
  if (
    opts.speedMax !== cachedSpeedMax
    || opts.unit !== cachedUnit
    || nightNow !== cachedNight
  ) {
    cachedSpeedMax = opts.speedMax;
    cachedUnit = opts.unit;
    cachedNight = nightNow;
    buildSpeedoSvg(opts.speedMax, opts.unit);
  }

  // Needle color from preset (varies per car generation). Cached so we
  // don't pay the setAttribute write every frame when the color is stable.
  const needleColor = opts.needleColor || '#e44';
  if (needleColor !== cachedNeedleColor) {
    cachedNeedleColor = needleColor;
    if (speedoNeedlePolyEl) speedoNeedlePolyEl.setAttribute('fill', needleColor);
  }

  // Needle rotation. Quantize to 0.1° so micro-jitter in the speed value
  // doesn't trigger a DOM write each frame.
  const speedVal = opts.hideGauges ? 0 : opts.speed;
  const speedFrac = Math.max(0, Math.min(1, speedVal / opts.speedMax));
  const angleDeg = 135 + 270 * speedFrac;
  const qDeg = Math.round(angleDeg * 10) / 10;
  if (qDeg !== lastNeedleDeg) {
    lastNeedleDeg = qDeg;
    speedoNeedleEl.setAttribute('transform', 'rotate(' + qDeg + ')');
  }

  // H628 fuel needle — analog indicator on the left OD of the speedo.
  // 85° arc, E at +137.5° (lower-left) at v=0, F at +222.5° (upper-left)
  // at v=1. Critical-low: orange #f80 default, red #f00 when ≤15%.
  // Dirty-checked separately from the speed needle so a hold-throttle
  // run doesn't fire spurious fuel writes.
  if (speedoFuelNeedleEl) {
    const fuelLevel = opts.hideGauges
      ? 0
      : Math.max(0, Math.min(1, opts.fuel ?? 1));
    const fuelDeg = 137.5 + 85 * fuelLevel;
    const qFuelDeg = Math.round(fuelDeg * 10) / 10;
    if (qFuelDeg !== lastFuelDeg) {
      lastFuelDeg = qFuelDeg;
      speedoFuelNeedleEl.setAttribute('transform', 'rotate(' + qFuelDeg + ')');
    }
    const fuelColor = fuelLevel <= 0.15 ? '#f00' : '#f80';
    if (fuelColor !== lastFuelColor) {
      lastFuelColor = fuelColor;
      const line = speedoFuelNeedleEl.querySelector('line');
      const dot = speedoFuelNeedleEl.querySelector('circle');
      if (line) line.setAttribute('stroke', fuelColor);
      if (dot) dot.setAttribute('fill', fuelColor);
    }
  }
}

let _lastSpeedoVisible: boolean | null = null;

/** Toggle SVG visibility. H658: dirty-checked — drawHud calls every
 *  frame and pre-H658 this set style.display per frame even when the
 *  bit didn't change. The browser noop'd the write but the setter +
 *  property dispatch still ran. */
export function setSpeedoSvgVisible(visible: boolean): void {
  if (visible === _lastSpeedoVisible) return;
  if (!ensureEls() || !speedoSvgEl) return;
  _lastSpeedoVisible = visible;
  (speedoSvgEl as unknown as HTMLElement).style.display = visible ? '' : 'none';
}

let lastPosSig = '';

/** Anchor the SVG to the canvas cluster's screen footprint. The canvas
 *  cluster center sits at (HUD_W - rimOuter, R) in HUD internal coords;
 *  scale that to viewport pixels via the vw/HUD_W ratio. The SVG element's
 *  CSS box (left/top/width/height) becomes the cluster's on-screen bbox.
 *
 *  Called from fitCanvases on resize / orientation change. Dirty-checked
 *  via lastPosSig so repeated calls with the same viewport are O(1).
 *
 *  Geometry mirrors monolith _syncSpeedoSvgPosition L22920-L22959. The
 *  mobile branch that anchors to #steerBar (wheel-relative positioning)
 *  is deferred to the steering-wheel SVG hop — until that lands every
 *  mobile mode treats the speedo like the PC layout (top-right corner).
 *
 *  Pass HUD_W = canvas internal width (= GW × upscale at PC ratio = 240
 *  scaled, in modular's GW=240 baseline). clusterR matches gameLoop's
 *  CLUSTER_R (= 42). */
export function syncSpeedoSvgPosition(
  hudW: number,
  clusterR: number,
): void {
  if (!ensureEls() || !speedoSvgEl) return;
  if (typeof window === 'undefined' || !hudW) return;
  const vw = window.innerWidth;
  const ratio = vw / hudW;
  const rimOuter = clusterR * 1.16;
  const dialDiameter = 2 * clusterR * ratio;
  const centerX = (hudW - rimOuter) * ratio;
  const centerY = clusterR * ratio;
  const dq = dialDiameter;
  const left = centerX - clusterR * ratio;
  const top = centerY - clusterR * ratio;
  const sig = dq.toFixed(1) + '|' + left.toFixed(1) + '|' + top.toFixed(1);
  if (sig === lastPosSig) return;
  lastPosSig = sig;
  const el = speedoSvgEl as unknown as HTMLElement;
  el.style.left = left + 'px';
  el.style.top = top + 'px';
  el.style.width = dq + 'px';
  el.style.height = dq + 'px';
}
