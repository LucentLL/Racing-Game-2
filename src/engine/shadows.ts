/**
 * Shadow + headlight cone geometry helpers. Pure functions — no module-level
 * state. Used by the renderer to draw soft headlight cones and to project
 * tire/body shadow polygons from light sources.
 */

export type Point2 = readonly [x: number, y: number];

/** H1077: append the soft-cone outline to the CURRENT path — no
 *  beginPath/fill — so callers can union several cones into one path
 *  (the player-shadow clip is built from BOTH lamp cones this way). */
export function traceSoftCone(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  dirAngle: number,
  halfSpread: number,
  length: number,
  bulgeK?: number,
): void {
  const k = bulgeK ?? 1.5;
  const spK = halfSpread * k;
  const hL = length * 0.5;
  const tipLx = ox + Math.cos(dirAngle - halfSpread) * length;
  const tipLy = oy + Math.sin(dirAngle - halfSpread) * length;
  const tipRx = ox + Math.cos(dirAngle + halfSpread) * length;
  const tipRy = oy + Math.sin(dirAngle + halfSpread) * length;
  const ctrlLx = ox + Math.cos(dirAngle - spK) * hL;
  const ctrlLy = oy + Math.sin(dirAngle - spK) * hL;
  const ctrlRx = ox + Math.cos(dirAngle + spK) * hL;
  const ctrlRy = oy + Math.sin(dirAngle + spK) * hL;
  ctx.moveTo(ox, oy);
  ctx.quadraticCurveTo(ctrlLx, ctrlLy, tipLx, tipLy);
  ctx.lineTo(tipRx, tipRy);
  ctx.quadraticCurveTo(ctrlRx, ctrlRy, ox, oy);
  ctx.closePath();
}

export function drawSoftCone(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  dirAngle: number,
  halfSpread: number,
  length: number,
  bulgeK?: number,
): void {
  ctx.beginPath();
  traceSoftCone(ctx, ox, oy, dirAngle, halfSpread, length, bulgeK);
  ctx.fill();
}

export function rectCornersWS(
  cx: number,
  cy: number,
  ang: number,
  hl: number,
  hw: number,
): Point2[] {
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  return [
    [cx + -hl * ca - -hw * sa, cy + -hl * sa + -hw * ca],
    [cx + hl * ca - -hw * sa, cy + hl * sa + -hw * ca],
    [cx + hl * ca - hw * sa, cy + hl * sa + hw * ca],
    [cx + -hl * ca - hw * sa, cy + -hl * sa + hw * ca],
  ];
}

export function castShadowPoly(
  mctx: CanvasRenderingContext2D,
  lx: number,
  ly: number,
  corners: readonly Point2[],
  farR: number,
): void {
  if (!corners || corners.length < 2) return;
  let ccx = 0;
  let ccy = 0;
  for (const c of corners) {
    ccx += c[0];
    ccy += c[1];
  }
  ccx /= corners.length;
  ccy /= corners.length;
  const refA = Math.atan2(ccy - ly, ccx - lx);
  let aMin = Infinity;
  let aMax = -Infinity;
  let cMin: Point2 | null = null;
  let cMax: Point2 | null = null;
  for (const c of corners) {
    let a = Math.atan2(c[1] - ly, c[0] - lx) - refA;
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    if (a < aMin) {
      aMin = a;
      cMin = c;
    }
    if (a > aMax) {
      aMax = a;
      cMax = c;
    }
  }
  if (!cMin || !cMax || cMin === cMax) return;
  const d1 = Math.hypot(cMin[0] - lx, cMin[1] - ly);
  const d2 = Math.hypot(cMax[0] - lx, cMax[1] - ly);
  if (d1 < 0.001 || d2 < 0.001) return;
  const e1x = lx + ((cMin[0] - lx) / d1) * farR;
  const e1y = ly + ((cMin[1] - ly) / d1) * farR;
  const e2x = lx + ((cMax[0] - lx) / d2) * farR;
  const e2y = ly + ((cMax[1] - ly) / d2) * farR;
  mctx.beginPath();
  mctx.moveTo(cMin[0], cMin[1]);
  mctx.lineTo(e1x, e1y);
  mctx.lineTo(e2x, e2y);
  mctx.lineTo(cMax[0], cMax[1]);
  mctx.closePath();
  mctx.fill();
}

export function castParallelShadow(
  mctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  corners: readonly Point2[],
  dx: number,
  dy: number,
  lx: number,
  ly: number,
  minStartDFromLight: number,
  farDist: number,
): void {
  if (!corners || corners.length < 2) return;
  const n = corners.length;
  let bestEdge = -1;
  let bestDot = -Infinity;
  for (let i = 0; i < n; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % n];
    const mx = (a[0] + b[0]) * 0.5 - cx;
    const my = (a[1] + b[1]) * 0.5 - cy;
    const ml = Math.hypot(mx, my);
    if (ml < 1e-6) continue;
    const dot = (mx / ml) * dx + (my / ml) * dy;
    if (dot > bestDot) {
      bestDot = dot;
      bestEdge = i;
    }
  }
  if (bestEdge < 0) return;
  const cMin = corners[bestEdge];
  const cMax = corners[(bestEdge + 1) % n];
  const c1DFromLight = (cMin[0] - lx) * dx + (cMin[1] - ly) * dy;
  const c2DFromLight = (cMax[0] - lx) * dx + (cMax[1] - ly) * dy;
  const s1 = Math.max(0, minStartDFromLight - c1DFromLight);
  const s2 = Math.max(0, minStartDFromLight - c2DFromLight);
  const st1x = cMin[0] + dx * s1;
  const st1y = cMin[1] + dy * s1;
  const st2x = cMax[0] + dx * s2;
  const st2y = cMax[1] + dy * s2;
  const e1x = st1x + dx * farDist;
  const e1y = st1y + dy * farDist;
  const e2x = st2x + dx * farDist;
  const e2y = st2y + dy * farDist;
  mctx.beginPath();
  mctx.moveTo(st1x, st1y);
  mctx.lineTo(e1x, e1y);
  mctx.lineTo(e2x, e2y);
  mctx.lineTo(st2x, st2y);
  mctx.closePath();
  mctx.fill();
}

export interface TireRect {
  x: number;
  y: number;
  hl: number;
  hw: number;
  ang: number;
}

export function tireRectsWS(
  cx: number,
  cy: number,
  ang: number,
  hl: number,
  hw: number,
  isBike: boolean,
  isTrailer: boolean,
): TireRect[] {
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  const tl = Math.max(1.2, hl * 0.15);
  const tw = 1.0;

  if (isTrailer) {
    const ax1c = -hl + 8 + 2.25;
    const ax2c = -hl + 14 + 2.25;
    const tyC = Math.max(2.15, hw - 2.45);
    const tHalfW = 2.15;
    const local: Array<[number, number]> = [
      [ax1c, -tyC], [ax1c, tyC],
      [ax2c, -tyC], [ax2c, tyC],
    ];
    const out: TireRect[] = [];
    for (const p of local) {
      out.push({
        x: cx + p[0] * ca - p[1] * sa,
        y: cy + p[0] * sa + p[1] * ca,
        hl: 2.25,
        hw: tHalfW,
        ang,
      });
    }
    return out;
  }

  const ty = Math.max(tw, hw - tw);
  const local: Array<[number, number]> = isBike
    ? [[hl * 0.75, 0], [-hl * 0.75, 0]]
    : [[hl * 0.7, -ty], [hl * 0.7, ty], [-hl * 0.7, -ty], [-hl * 0.7, ty]];
  const out: TireRect[] = [];
  for (const p of local) {
    out.push({
      x: cx + p[0] * ca - p[1] * sa,
      y: cy + p[0] * sa + p[1] * ca,
      hl: tl,
      hw: tw,
      ang,
    });
  }
  return out;
}
