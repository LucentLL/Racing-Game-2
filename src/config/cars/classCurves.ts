import type { BrandClass } from './brandTiers';

export type CurveAnchor = readonly [hp: number, basePriceUsd: number];
export type ClassCurve = readonly CurveAnchor[];

export const CLASS_CURVES: Record<BrandClass, ClassCurve> = {
  econ:    [[50, 8500], [100, 11000], [150, 15000], [200, 20000]],
  mid:     [[60, 10000], [100, 13000], [150, 18000], [200, 24000], [260, 32000], [320, 44000], [400, 62000]],
  premium: [[120, 22000], [200, 32000], [280, 55000], [350, 85000], [450, 120000]],
  exotic:  [[280, 80000], [400, 180000], [500, 320000], [600, 500000]],
  bike:    [[40, 6000], [80, 10000], [120, 15000], [160, 22000]],
  race:    [[200, 120000], [400, 280000], [600, 500000], [800, 900000]],
};

export function curveLookup(curve: ClassCurve, hp: number): number {
  if (hp <= curve[0][0]) return curve[0][1];
  if (hp >= curve[curve.length - 1][0]) return curve[curve.length - 1][1];
  for (let i = 0; i < curve.length - 1; i++) {
    const [x0, y0] = curve[i];
    const [x1, y1] = curve[i + 1];
    if (hp >= x0 && hp <= x1) {
      const t = (hp - x0) / (x1 - x0);
      return y0 + (y1 - y0) * t;
    }
  }
  return curve[curve.length - 1][1];
}
