/**
 * GBC-style perspective tilt. The game canvas is internally a flat top-down
 * grid; tilt is applied as a CSS perspective transform so the runtime stays
 * cheap (no per-frame matrix math). The internal canvas dimensions and
 * trapezoid coverage are computed in resize() to match the tilted projection.
 */

/** H686: device-specific tilt angles. Mode 0 is the user-toggleable
 *  "Top-down" override (flat overhead, no perspective); Mode 1 is the
 *  default "natural" pitch — different for PC vs mobile because the
 *  viewports have different aspect ratios and viewing distances.
 *
 *  PC at 20° matches the H146 baseline the user has driven with for
 *  weeks; mobile gets a steeper 35° so the perspective effect reads
 *  on a tighter portrait viewport (the H655 mobile canvas branch
 *  already grows the GH to absorb the extra fold).
 *
 *  effectiveTiltDeg / recomputeTiltFactors check `vw < vh` to pick
 *  the right array — same predicate main.ts uses for body.mob /
 *  body.pc CSS class toggling. */
// H809: mode 2 re-adds 35° as a user-selectable OPT cycle stop (the
// OPT row cycles Top-down → 20° → 35°). H750 removed 35° as the
// mobile DEFAULT — it grew mainCanvas ~25% taller (mobDomH =
// vh×tiltMul), shifted the foreshortened canvas top down (the
// "dark bar at top of screen" report), and added GPU composite cost.
// Those costs still exist; as an explicit option the user opts into
// them knowingly (and the H806/H807 perf work absorbed similar load).
export const TILT_PITCH_DEG_PC:     readonly number[] = [0, 20, 35];
export const TILT_PITCH_DEG_MOBILE: readonly number[] = [0, 20, 35];
/** Back-compat alias for the editor / preview paths that still read
 *  a single array. Returns the PC pitches (those paths run desktop-
 *  only in the editor). */
export const TILT_PITCH_DEG: readonly number[] = TILT_PITCH_DEG_PC;

function pitchArrayFor(vw: number, vh: number): readonly number[] {
  return vw < vh ? TILT_PITCH_DEG_MOBILE : TILT_PITCH_DEG_PC;
}

// H817: 600 → 1000. At 600px a 35° fold inverts the projection on a
// tall desktop viewport (cos35·600 − vh·sin35 < 0 for vh > ~860), so
// effectiveTiltDeg's non-inversion guard clamped the user's 35° down
// to ~27° — the "other logic" the user didn't want. A 1000px
// perspective keeps 35° geometrically valid up to vh ≈ 1428 (covers
// desktop + both mobile orientations), so the configured angle now
// passes through unclamped = the true in-game 35°. The fold reads a
// touch gentler per-degree at the larger distance, but it's a genuine
// 35° rather than a silently-reduced one. All tilt math (ghFactor,
// camYRatioForTilt, the CSS transform) keys off this one constant, so
// they stay consistent.
export const TILT_PERSPECTIVE_PX = 1000;
// H898c: 1.02 → 1.10. At 35° the CSS `rotateX` foreshortens the world
// canvas's top edge: with only 2% margin the narrowed top spanned just
// ~vw×1.02, leaving the viewport's top corners uncovered → a black
// wedge (user-reported top-right; the top-left wedge is hidden behind
// the tachometer HUD widget). 10% margin spans the top edge well past
// the viewport width so both corners stay covered. main.ts applies this
// to domW/domH (display size) and effectiveTiltDeg folds it into the
// max-angle caps, so the bigger canvas can't exceed MAX_DOM.
export const CANVAS_OVERSCAN = 1.10;

// H817: boot default mode 2 = 35° (user request: 35° tilt default for
// PC + mobile landscape). Mode 0 top-down, 1 = 20°, 2 = 35°. Saved
// games keep their cameraTiltMode; fresh games get 35°.
export const tiltState = {
  mode: 2,
  ghFactor: [1.0, 1.0, 1.0] as number[],
};

export function recomputeTiltFactors(vh: number): void {
  const p = TILT_PERSPECTIVE_PX;
  // H686: vw isn't passed here directly — read from window when
  // available. Server-side / pre-DOM contexts fall back to PC pitches
  // (vw=0 < vh=0 is false; pitchArrayFor returns PC).
  const vw = (typeof window !== 'undefined') ? window.innerWidth : 0;
  const arr = pitchArrayFor(vw, vh);
  for (let m = 1; m < arr.length; m++) {
    const r = (arr[m] * Math.PI) / 180;
    const denom = Math.cos(r) * p - vh * Math.sin(r);
    if (denom <= 1) {
      tiltState.ghFactor[m] = 3.5;
      continue;
    }
    const h = (vh * p) / denom;
    tiltState.ghFactor[m] = Math.max(1.0, Math.min(4.0, h / vh));
  }
}

export function effectiveTiltDeg(vh: number, vw: number): number {
  const arr = pitchArrayFor(vw, vh);
  const configured = arr[tiltState.mode] ?? 0;
  if (configured === 0) return 0;
  const P = TILT_PERSPECTIVE_PX;
  const MAX_DOM = 14000;
  const OVERSCAN = CANVAS_OVERSCAN;
  const MARGIN = 1.0;

  const maxByDenom = (Math.atan(P / Math.max(1, vh)) * 180) / Math.PI - MARGIN;

  let maxByCapH = maxByDenom;
  const norm = Math.sqrt(P * P + vh * vh);
  const KH = (vh * P * OVERSCAN) / MAX_DOM;
  if (KH < norm) {
    const alpha = Math.atan2(vh, P);
    const tCap = Math.acos(KH / norm) - alpha;
    maxByCapH = (tCap * 180) / Math.PI - MARGIN;
  }

  let maxByCapW = maxByDenom;
  const ratioW = MAX_DOM / Math.max(1, vw);
  if (ratioW > 1.0) {
    const tanLimit = (P * (ratioW - 1)) / (vh * (OVERSCAN + ratioW - 1));
    if (tanLimit > 0) {
      const tCapW = Math.atan(tanLimit);
      maxByCapW = (tCapW * 180) / Math.PI - MARGIN;
    } else {
      maxByCapW = 0.5;
    }
  }

  const maxDeg = Math.min(maxByDenom, maxByCapH, maxByCapW);
  return Math.min(configured, Math.max(0.5, maxDeg));
}

export function applyCssTilt(canvas: HTMLCanvasElement): void {
  const deg = effectiveTiltDeg(window.innerHeight, window.innerWidth);
  if (deg <= 0.5) {
    canvas.style.transform = '';
    canvas.style.transformOrigin = '';
    return;
  }
  canvas.style.transform = `perspective(${TILT_PERSPECTIVE_PX}px) rotateX(${deg}deg)`;
  canvas.style.transformOrigin = '50% 100%';
}
