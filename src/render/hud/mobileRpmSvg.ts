/**
 * Mobile SVG RPM tachometer — top-left counterpart to the H624-H628
 * SVG speedometer at top-right. Mobile-only; PC continues to render the
 * RPM through the canvas gauge cluster. Hosts the cyan temp needle on
 * its right OD (the symmetric pair to the speedo's orange fuel needle
 * on its left OD).
 *
 * Mirrors monolith _buildMobileRpmGauge (L22538-L22566) +
 * _updateMobileRpm (L22566-L22628) + _syncMobileRpmPosition (L22630)
 * mobile branch. The PC branch of _syncMobileRpmPosition (positions
 * below the speedo with the canvas RPM circle's footprint) isn't
 * ported here — modular's PC mode keeps the canvas RPM, so the SVG
 * stays hidden on PC.
 *
 * Three pieces:
 *   - buildMobileRpmGauge(redline) — populates #mobileRpmContent with
 *     tick marks every 1000 RPM, integer labels every 1000, and a red
 *     redline arc from 80% sweep to 100%. Called at startup + on car
 *     change.
 *   - updateMobileRpm(opts) — per-frame. Bails on PC. Rebuilds static
 *     content on redline change; updates needle rotation + color; also
 *     updates the temp needle (placeholder 0.5 until LIFE.engineTemp
 *     wires).
 *   - syncMobileRpmPosition() — anchors the SVG at top-left of the
 *     viewport, sized so the visible r=78 disc matches the canvas
 *     RPM cluster's footprint.
 */

import { isGt2Night } from '@/ui/gt2Chrome';

let mobileRpmSvgEl: Element | null = null;
let mobileRpmContentEl: Element | null = null;
let mobileRpmNeedleEl: Element | null = null;
let mobileRpmGearTextEl: Element | null = null;
let rpmTempNeedleEl: Element | null = null;

let cachedRedline = -1;
let cachedNight = false;
let lastRpmDeg = NaN;
let lastTempDeg = NaN;
let lastGearText = '';

/** H739 backlit-cluster palette — tick + label color flips to
 *  sage-yellow at night to match the H738 GT2 menu palette. The
 *  redline arc stays #c00 red (semantic warning) and the needle
 *  uses its per-car preset color unchanged. */
function gaugeColors(): { tick: string; label: string } {
  if (isGt2Night()) {
    return { tick: '#b8c64a', label: '#b8c64a' };
  }
  return { tick: '#bbb', label: '#bbb' };
}

function ensureEls(): boolean {
  if (mobileRpmSvgEl) return true;
  if (typeof document === 'undefined') return false;
  mobileRpmSvgEl = document.getElementById('mobileRpmSvg');
  mobileRpmContentEl = document.getElementById('mobileRpmContent');
  mobileRpmNeedleEl = document.getElementById('mobileRpmNeedle');
  mobileRpmGearTextEl = document.getElementById('mobileRpmGearText');
  rpmTempNeedleEl = document.getElementById('rpmTempNeedle');
  return !!(mobileRpmSvgEl && mobileRpmContentEl && mobileRpmNeedleEl);
}

/** Build (or rebuild) the tick / label / redline content inside the
 *  #mobileRpmContent group. Called when the redline changes (per car). */
export function buildMobileRpmGauge(redline: number): void {
  if (!ensureEls() || !mobileRpmContentEl) return;
  const startDeg = 135;
  const sweepDeg = 270;
  const tickOuterR = 77.5;
  const tickInnerR = 68;
  const labelR = 58;
  const arcR = 77.5;
  const totalRPM = redline || 7000;
  const tickStep = 1000;
  const redlineFrac = 0.80;
  const col = gaugeColors();
  const parts: string[] = [];
  for (let r = 0; r <= totalRPM; r += tickStep) {
    const f = r / totalRPM;
    const aRad = ((startDeg + sweepDeg * f) * Math.PI) / 180;
    const x1 = (tickInnerR * Math.cos(aRad)).toFixed(2);
    const y1 = (tickInnerR * Math.sin(aRad)).toFixed(2);
    const x2 = (tickOuterR * Math.cos(aRad)).toFixed(2);
    const y2 = (tickOuterR * Math.sin(aRad)).toFixed(2);
    parts.push('<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="' + col.tick + '" stroke-width="1.6"/>');
  }
  for (let r = tickStep; r <= totalRPM; r += tickStep) {
    const f = r / totalRPM;
    const aRad = ((startDeg + sweepDeg * f) * Math.PI) / 180;
    const x = (labelR * Math.cos(aRad)).toFixed(2);
    const y = (labelR * Math.sin(aRad) + 4.5).toFixed(2);
    parts.push('<text x="' + x + '" y="' + y + '" fill="' + col.label + '" font-family="monospace" font-weight="bold" font-size="13" text-anchor="middle">' + (r / 1000) + '</text>');
  }
  const redStartDeg = startDeg + sweepDeg * redlineFrac;
  const redEndDeg = startDeg + sweepDeg;
  const rs = (redStartDeg * Math.PI) / 180;
  const re = (redEndDeg * Math.PI) / 180;
  const rx1 = (arcR * Math.cos(rs)).toFixed(2);
  const ry1 = (arcR * Math.sin(rs)).toFixed(2);
  const rx2 = (arcR * Math.cos(re)).toFixed(2);
  const ry2 = (arcR * Math.sin(re)).toFixed(2);
  parts.push('<path d="M ' + rx1 + ' ' + ry1 + ' A ' + arcR + ' ' + arcR + ' 0 0 1 ' + rx2 + ' ' + ry2 + '" stroke="#c00" stroke-width="3.5" fill="none" stroke-linecap="butt"/>');
  mobileRpmContentEl.innerHTML = parts.join('');
}

/** Per-frame inputs. Caller pulls these from the same sources the canvas
 *  cluster reads (gameLoop's gaugeOpts). */
export interface MobileRpmOpts {
  rpm: number;
  redline: number;
  /** display_failure fault zeros the needle. */
  hideGauges?: boolean;
  /** Engine temp 0..1. Modular hardcodes 0.4 (matches canvas) until
   *  LIFE.engineTemp wires in. */
  temp?: number;
  /** Selected gear — number for 1..6, 'R' for reverse, 'N' for neutral.
   *  Drives the H630 gear digit below the RPM needle. */
  gear?: number | string;
}

/** Per-frame needle + cached-static update. Bails on PC. */
export function updateMobileRpm(opts: MobileRpmOpts): void {
  if (typeof document === 'undefined') return;
  if (!document.body.classList.contains('mob')) return;
  if (!ensureEls() || !mobileRpmNeedleEl) return;

  // H739: rebuild static content on redline change OR night/day flip
  // so the cluster glow tracks the world's lights-on transition.
  const nightNow = isGt2Night();
  if (opts.redline !== cachedRedline || nightNow !== cachedNight) {
    cachedRedline = opts.redline;
    cachedNight = nightNow;
    buildMobileRpmGauge(opts.redline);
  }

  const rpm = opts.hideGauges ? 0 : opts.rpm;
  const frac = Math.max(0, Math.min(1, rpm / opts.redline));
  const angleDeg = 135 + 270 * frac;
  const qDeg = Math.round(angleDeg * 10) / 10;
  if (qDeg !== lastRpmDeg) {
    lastRpmDeg = qDeg;
    mobileRpmNeedleEl.setAttribute('transform', 'rotate(' + qDeg + ')');
  }

  // H630 gear digit below the RPM needle. Caller hands us the canonical
  // gear string ('1'..'6', 'R', 'N') so we don't need to know the
  // pGear/manualGear/pRevIntent encoding. Dirty-checked.
  if (mobileRpmGearTextEl) {
    const gearText = opts.hideGauges ? '-' : String(opts.gear ?? '-');
    if (gearText !== lastGearText) {
      lastGearText = gearText;
      mobileRpmGearTextEl.textContent = gearText;
    }
  }

  // Temp needle — right OD, 85° arc, H upper at -42.5° (v=1), C lower
  // at +42.5° (v=0). Cyan needle. Placeholder 0.5 (matches canvas) since
  // LIFE.engineTemp isn't wired in modular.
  if (rpmTempNeedleEl) {
    const tempLevel = opts.hideGauges ? 0 : Math.max(0, Math.min(1, opts.temp ?? 0.5));
    const tempDeg = 42.5 - 85 * tempLevel;
    const qTempDeg = Math.round(tempDeg * 10) / 10;
    if (qTempDeg !== lastTempDeg) {
      lastTempDeg = qTempDeg;
      rpmTempNeedleEl.setAttribute('transform', 'rotate(' + qTempDeg + ')');
    }
  }
}

let _lastMobileRpmVisible: boolean | null = null;

/** Toggle SVG visibility. H658: dirty-checked — see speedoSvg for
 *  rationale. drawHud calls per frame. */
export function setMobileRpmSvgVisible(visible: boolean): void {
  if (visible === _lastMobileRpmVisible) return;
  if (!ensureEls() || !mobileRpmSvgEl) return;
  _lastMobileRpmVisible = visible;
  (mobileRpmSvgEl as unknown as HTMLElement).style.display = visible ? '' : 'none';
}

let lastPosSig = '';

/** Position the SVG at top-left. Sized so the visible r=78 disc matches
 *  the canvas RPM cluster's r=34 footprint. Mirrors monolith
 *  _syncMobileRpmPosition L22640-L22656 mobile branch (legacy top-left
 *  anchor, used pre-H644 or as a fallback when #steerBar isn't built). */
export function syncMobileRpmPosition(clusterR: number): void {
  if (!ensureEls() || !mobileRpmSvgEl) return;
  if (typeof window === 'undefined') return;
  const speedTickInner = clusterR * 0.81;
  // Visible disc inside the SVG is r=78 of a 220 viewBox (71% of box).
  // We want the visible disc to be 2 * speedTickInner CSS pixels (matches
  // the canvas RPM circle's diameter). Scale up by 110/78 to get the
  // SVG element's CSS size.
  const visibleDiam = 2 * speedTickInner;
  const boxPx = visibleDiam * (110 / 78);
  const margin = 4;
  const left = margin;
  const top = margin;
  const sig = boxPx.toFixed(1) + '|' + left.toFixed(1) + '|' + top.toFixed(1);
  if (sig === lastPosSig) return;
  lastPosSig = sig;
  const el = mobileRpmSvgEl as unknown as HTMLElement;
  el.style.left = left + 'px';
  el.style.top = top + 'px';
  el.style.width = boxPx + 'px';
  el.style.height = boxPx + 'px';
}

/** H644: position the mobile RPM SVG INSIDE the steering wheel's bounds
 *  so the wheel rim frames the gauge. Mirrors monolith
 *  _syncMobileRpmPosition L22640-L22653 — the wheel's interior is
 *  78/110 of its visual width (the rim's inner edge), and the RPM SVG's
 *  visible r=78 disc fills that interior at 110/78 box scale.
 *
 *  Returns true if the wheel was found and the RPM was anchored to it;
 *  false if #steerBar is absent (caller should fall through to
 *  syncMobileRpmPosition for the legacy top-left anchor). */
export function syncMobileRpmPositionInWheel(): boolean {
  if (!ensureEls() || !mobileRpmSvgEl) return false;
  if (typeof document === 'undefined') return false;
  const wheel = document.getElementById('steerBar');
  if (!wheel) return false;
  const rect = wheel.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return false;
  // Wheel interior (inside the rim) is 78/110 of its visual width.
  const wheelCssPx = rect.width;
  const interiorPx = wheelCssPx * (78 / 110);
  const boxPx = interiorPx * (110 / 78);
  const left = rect.left + (rect.width - boxPx) / 2;
  const top = rect.top + (rect.height - boxPx) / 2;
  const sig = boxPx.toFixed(1) + '|' + left.toFixed(1) + '|' + top.toFixed(1);
  if (sig === lastPosSig) return true;
  lastPosSig = sig;
  const el = mobileRpmSvgEl as unknown as HTMLElement;
  el.style.left = left + 'px';
  el.style.top = top + 'px';
  el.style.width = boxPx + 'px';
  el.style.height = boxPx + 'px';
  return true;
}
