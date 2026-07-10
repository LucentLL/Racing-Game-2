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

import { isGt2Night, getGt2NightPalette, GT2_COLORS } from '@/ui/gt2Chrome';

let mobileRpmSvgEl: Element | null = null;
let mobileRpmContentEl: Element | null = null;
let mobileRpmNeedleEl: Element | null = null;
let rpmTempNeedleEl: Element | null = null;
/** H740: temp gauge H/C labels + the ×1000 RPM unit text live in
 *  index.html (outside the dynamic content group). Cached here so
 *  we can flip their fill attribute on night toggle. */
let rpmStaticLabelEls: Element[] = [];

let cachedRedline = -1;
let cachedNight = false;
let cachedNightPalette = '';
let lastRpmDeg = NaN;
let lastTempDeg = NaN;

const RPM_GLOW_ID = 'rpmGlow';

/** H739/H740 backlit-cluster palette — tick + label color reads
 *  through GT2_COLORS so the green/amber/orange night variant
 *  follows whatever the player picked. The redline arc stays #c00
 *  red (semantic warning) and the needle keeps its per-car preset. */
function gaugeColors(): { tick: string; label: string } {
  if (isGt2Night()) {
    return { tick: GT2_COLORS.amber, label: GT2_COLORS.amber };
  }
  return { tick: '#bbb', label: '#bbb' };
}

function glowFilterDef(filterId: string): string {
  if (!isGt2Night()) return '';
  return (
    '<defs><filter id="' + filterId + '" x="-60%" y="-60%" width="220%" height="220%">'
    + '<feGaussianBlur stdDeviation="1.8" result="blur"/>'
    + '<feMerge>'
    + '<feMergeNode in="blur"/>'
    + '<feMergeNode in="SourceGraphic"/>'
    + '</feMerge>'
    + '</filter></defs>'
  );
}

function glowAttr(filterId: string): string {
  return isGt2Night() ? ' filter="url(#' + filterId + ')"' : '';
}

function ensureEls(): boolean {
  if (mobileRpmSvgEl) return true;
  if (typeof document === 'undefined') return false;
  mobileRpmSvgEl = document.getElementById('mobileRpmSvg');
  mobileRpmContentEl = document.getElementById('mobileRpmContent');
  mobileRpmNeedleEl = document.getElementById('mobileRpmNeedle');
  rpmTempNeedleEl = document.getElementById('rpmTempNeedle');
  if (mobileRpmSvgEl) {
    // H740: collect the "×1000 RPM" text and the temp-gauge H/C
    // labels (everything that's NOT inside #mobileRpmContent). All
    // <text> elements outside the rebuilt content group qualify —
    // that's the unit label and the H/C marks. (H1084: the gear text
    // that was excluded here is gone.)
    rpmStaticLabelEls = [];
    for (const el of Array.from(mobileRpmSvgEl.querySelectorAll('text'))) {
      // Skip text inside the rebuilt #mobileRpmContent — those get
      // retinted on each buildMobileRpmGauge.
      let p: Node | null = el.parentNode;
      let inside = false;
      while (p) {
        if (p === mobileRpmContentEl) { inside = true; break; }
        p = p.parentNode;
      }
      if (!inside) rpmStaticLabelEls.push(el);
    }
  }
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
  const glow = glowAttr(RPM_GLOW_ID);
  const parts: string[] = [glowFilterDef(RPM_GLOW_ID)];
  for (let r = 0; r <= totalRPM; r += tickStep) {
    const f = r / totalRPM;
    const aRad = ((startDeg + sweepDeg * f) * Math.PI) / 180;
    const x1 = (tickInnerR * Math.cos(aRad)).toFixed(2);
    const y1 = (tickInnerR * Math.sin(aRad)).toFixed(2);
    const x2 = (tickOuterR * Math.cos(aRad)).toFixed(2);
    const y2 = (tickOuterR * Math.sin(aRad)).toFixed(2);
    parts.push('<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="' + col.tick + '" stroke-width="1.6"' + glow + '/>');
  }
  for (let r = 0; r <= totalRPM; r += tickStep) {
    const f = r / totalRPM;
    const aRad = ((startDeg + sweepDeg * f) * Math.PI) / 180;
    const x = (labelR * Math.cos(aRad)).toFixed(2);
    const y = (labelR * Math.sin(aRad) + 4.5).toFixed(2);
    parts.push('<text x="' + x + '" y="' + y + '" fill="' + col.label + '" font-family="monospace" font-weight="bold" font-size="13" text-anchor="middle"' + glow + '>' + (r / 1000) + '</text>');
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

/** Per-frame needle + cached-static update. Bails when the mobile-style
 *  SVG cluster isn't owning the dial — i.e. PC default with no PC Touch
 *  Controls toggle. With the toggle on, runs the same update path
 *  mobile uses so the temp arc + RPM needle stay live on PC. */
export function updateMobileRpm(opts: MobileRpmOpts): void {
  if (typeof document === 'undefined') return;
  const _cl = document.body.classList;
  if (!_cl.contains('mob') && !_cl.contains('pc-touch-ui')) return;
  if (!ensureEls() || !mobileRpmNeedleEl) return;

  // H739/H740: rebuild static content on redline change, night/day
  // flip, OR night-palette name change (green/amber/orange).
  const nightNow = isGt2Night();
  const paletteNow = getGt2NightPalette();
  if (
    opts.redline !== cachedRedline
    || nightNow !== cachedNight
    || paletteNow !== cachedNightPalette
  ) {
    cachedRedline = opts.redline;
    cachedNight = nightNow;
    cachedNightPalette = paletteNow;
    buildMobileRpmGauge(opts.redline);
    // H740: retint the static index.html labels (×1000 RPM, H, C)
    // to match the active cluster glow. Day = soft grey #888 / #bbb
    // (matches the index.html defaults); night = the night unit
    // color so they read dimmer than the integer labels.
    // Also apply the same glow filter the dynamic ticks/labels use
    // (#rpmGlow, defined inside #mobileRpmContent by buildMobileRpmGauge
    // when night is active). User reported "×1000 RPM should have the
    // same glow effect as rest of cluster." SVG id resolution is
    // document-scoped so the sibling reference works. Cleared in day
    // mode so the labels render crisp.
    const labelFill = nightNow ? GT2_COLORS.amberDark : '#888';
    for (const el of rpmStaticLabelEls) {
      el.setAttribute('fill', labelFill);
      if (nightNow) {
        el.setAttribute('filter', 'url(#' + RPM_GLOW_ID + ')');
      } else {
        el.removeAttribute('filter');
      }
    }
  }

  const rpm = opts.hideGauges ? 0 : opts.rpm;
  const frac = Math.max(0, Math.min(1, rpm / opts.redline));
  const angleDeg = 135 + 270 * frac;
  const qDeg = Math.round(angleDeg * 10) / 10;
  if (qDeg !== lastRpmDeg) {
    lastRpmDeg = qDeg;
    mobileRpmNeedleEl.setAttribute('transform', 'rotate(' + qDeg + ')');
  }

  // H1084: the H630 gear digit that used to render here is removed —
  // the tach's bottom face now hosts the temp gauge (Corolla layout);
  // the gear reads from the shift-knob recess (#skGearText). opts.gear
  // is still accepted for call-site compatibility but no longer drawn.

  // H1098/H1102: temp needle — a mini-dial pivoting at (0,38) (translate in
  // the markup) whose needle is a scaled copy of the main tach needle through
  // its own hub. Arc sits ON the bottom rim edge at ±45°: C=cold at
  // +45° (down-left), H=hot at -45° (down-right) → tempDeg = 45 - 90·level.
  // Placeholder 0.5 (needle straight down = normal temp) since LIFE.engineTemp
  // isn't wired in modular yet.
  if (rpmTempNeedleEl) {
    const tempLevel = opts.hideGauges ? 0 : Math.max(0, Math.min(1, opts.temp ?? 0.5));
    const tempDeg = 45 - 90 * tempLevel;
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

/** Position the SVG at the top-left. Sized off the steering-wheel
 *  formula `min(280, vw/2 - 24, vh*0.28)` (matches base.css
 *  .steer-wheel width) so the visible r=78 disc inside the SVG (78/110
 *  of the element box) lands at exactly the same diameter as the
 *  mobile speedometer and the inside-the-wheel minimap.
 *
 *  The visible disc is INSET from the SVG element's edge by
 *  (boxPx - boxPx*78/110)/2 = boxPx × 32/220 on each side (the extra
 *  viewBox padding that gives the temp gauge room past r=78). Without
 *  compensating, the visible disc sat ~36 px below the speedo's disc
 *  top edge — user reported "RPM gauge should be in left corner same
 *  distance from edge as speedometer." Shift the element NEGATIVE by
 *  that inset so the disc's top-left corner lands at the margin. The
 *  overflow:visible attribute on the SVG keeps the temp gauge to the
 *  right of the disc rendering normally even with the negative offset.
 *
 *  The `clusterR` parameter is kept for the PC main.ts call signature
 *  but ignored on mobile. */
export function syncMobileRpmPosition(_clusterR: number): void {
  if (!ensureEls() || !mobileRpmSvgEl) return;
  if (typeof window === 'undefined') return;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // H1048: size the RPM disc off the steering wheel's ACTUAL rendered width
  // (#steerBar) so it tracks the --wheel-dia CSS var with no duplicated
  // formula — the visible r=78 disc = boxPx × 78/110 = the wheel's inner
  // diameter, matching the speedo + minimap. Fallback to the var's formula
  // when the wheel isn't laid out yet (boot / not-driving → rect width 0).
  const wheelEl = typeof document !== 'undefined' ? document.getElementById('steerBar') : null;
  const wheelRect = wheelEl ? wheelEl.getBoundingClientRect() : null;
  const boxPx = wheelRect && wheelRect.width >= 1
    ? wheelRect.width
    : Math.min(400, vw * 0.5 - 24, vh * 0.42);
  const visibleInset = boxPx * 32 / 220;
  const margin = 4;
  const left = margin - visibleInset;
  const top = margin - visibleInset;
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
