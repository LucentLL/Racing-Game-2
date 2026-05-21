/**
 * World Editor — merge-curve sampling primitives.
 *
 * Pure geometry utilities the standard / cloverleaf bond endpoint
 * smoothers compose. Pulled into its own module so the eventual
 * `_weMergeBondEndpoints_standard` port (still scaffolded — TODO at
 * L13346-14215 of the monolith) can import the same primitives that
 * future merge variants (Diamond, SPDI, DDI, etc.) will reuse without
 * each one re-introducing its own copy.
 *
 * No runtime deps: everything here is point-and-number arithmetic.
 */

import type { TilePoint } from '../stamp';

/** Sample a cubic Bezier defined by `p0..p3` and return `N` intermediate
 *  points, uniformly spaced in `t = 1/(N+1) … N/(N+1)`. Endpoints `p0`
 *  and `p3` are intentionally NOT included — callers concatenate them
 *  themselves around the returned interior samples so they can decide
 *  whether the curve replaces or augments existing polyline vertices.
 *
 *  The omit-endpoints convention is what the monolith's both-ends-
 *  bonded and one-end-bonded merge paths rely on: each builds a new
 *  polyline as `[startTip, ...sampleCubic(...), endTip]` — duplicating
 *  the endpoints would create zero-length opening segments that the
 *  downstream polygon edge builder would flag as a degenerate seam
 *  (see L13825 and L14147 of the monolith for the call sites).
 *
 *  Ported 1:1 from monolith `_sampleCubic` (nested helper at L13589-
 *  L13601 inside `_weMergeBondEndpoints_standard`).
 */
export function _sampleCubic(
  p0: TilePoint,
  p1: TilePoint,
  p2: TilePoint,
  p3: TilePoint,
  N: number,
): TilePoint[] {
  const out: TilePoint[] = [];
  for (let s = 1; s <= N; s++) {
    const tt = s / (N + 1);
    const mt = 1 - tt;
    const mt3 = mt * mt * mt;
    const mt2t = 3 * mt * mt * tt;
    const mtt2 = 3 * mt * tt * tt;
    const t3 = tt * tt * tt;
    out.push([
      mt3 * p0[0] + mt2t * p1[0] + mtt2 * p2[0] + t3 * p3[0],
      mt3 * p0[1] + mt2t * p1[1] + mtt2 * p2[1] + t3 * p3[1],
    ]);
  }
  return out;
}
