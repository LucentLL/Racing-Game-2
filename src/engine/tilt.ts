/**
 * GBC-style perspective tilt. The game canvas is internally a flat top-down
 * grid; tilt is applied as a CSS perspective transform so the runtime stays
 * cheap (no per-frame matrix math). The internal canvas dimensions and
 * trapezoid coverage are computed in resize() to match the tilted projection.
 */

export const TILT_PITCH_DEG: readonly number[] = [0, 20];
export const TILT_PERSPECTIVE_PX = 600;
export const CANVAS_OVERSCAN = 1.02;

export const tiltState = {
  mode: 1,
  ghFactor: [1.0, 1.0] as number[],
};

export function recomputeTiltFactors(vh: number): void {
  const p = TILT_PERSPECTIVE_PX;
  for (let m = 1; m < TILT_PITCH_DEG.length; m++) {
    const r = (TILT_PITCH_DEG[m] * Math.PI) / 180;
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
  const configured = TILT_PITCH_DEG[tiltState.mode];
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
