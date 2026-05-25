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

let speedoSvgEl: Element | null = null;
let speedoStaticEl: Element | null = null;
let speedoNeedleEl: Element | null = null;
let speedoNeedlePolyEl: Element | null = null;

let cachedSpeedMax = -1;
let cachedUnit = '';
let cachedNeedleColor = '';
let lastNeedleDeg = NaN;

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
  const parts: string[] = [];
  for (let s = 0; s <= speedMax; s += tickStep) {
    const f = s / speedMax;
    const aRad = ((startDeg + sweepDeg * f) * Math.PI) / 180;
    const x1 = (tickInnerR * Math.cos(aRad)).toFixed(2);
    const y1 = (tickInnerR * Math.sin(aRad)).toFixed(2);
    const x2 = (trackR * Math.cos(aRad)).toFixed(2);
    const y2 = (trackR * Math.sin(aRad)).toFixed(2);
    parts.push('<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="#eaeaea" stroke-width="2"/>');
  }
  for (let s = 0; s <= speedMax; s += labelStep) {
    const f = s / speedMax;
    const aRad = ((startDeg + sweepDeg * f) * Math.PI) / 180;
    const x = (labelR * Math.cos(aRad)).toFixed(2);
    const y = (labelR * Math.sin(aRad)).toFixed(2);
    parts.push('<text x="' + x + '" y="' + y + '" fill="#e0e0e0" font-family="monospace" font-weight="bold" font-size="13" text-anchor="middle" dominant-baseline="middle">' + s + '</text>');
  }
  parts.push('<text x="0" y="-34" fill="#888" font-family="monospace" font-weight="bold" font-size="8" text-anchor="middle" dominant-baseline="alphabetic">' + (speedUnit || 'KM/H') + '</text>');
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
  /** display_failure fault hides the needle (blanks to 0). */
  hideGauges?: boolean;
}

/** Per-frame needle + cached-static update. PC bails immediately — the
 *  canvas gauge cluster owns the dial there. */
export function updateSpeedoSvg(opts: SpeedoSvgOpts): void {
  if (typeof document === 'undefined') return;
  if (!document.body.classList.contains('mob')) return;
  if (!ensureEls() || !speedoNeedleEl) return;

  // Cache invalidation — rebuild static content if speedMax or unit flipped.
  if (opts.speedMax !== cachedSpeedMax || opts.unit !== cachedUnit) {
    cachedSpeedMax = opts.speedMax;
    cachedUnit = opts.unit;
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
}

/** Toggle SVG visibility. Caller flips this based on body.mob — h626
 *  wires it from fitCanvases so the SVG appears + positions on mobile
 *  flip and disappears on a portrait→landscape rotation. */
export function setSpeedoSvgVisible(visible: boolean): void {
  if (!ensureEls() || !speedoSvgEl) return;
  (speedoSvgEl as unknown as HTMLElement).style.display = visible ? '' : 'none';
}
