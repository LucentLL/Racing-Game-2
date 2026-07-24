/**
 * H1217: deck-end connection CLASSIFICATION, shared by the game deck
 * bake (worldMap._deckEndClass) and the editor bridge mirror.
 *
 * H964 treated every connected deck end the same: trim the parapet band
 * 3 tiles and extend the asphalt 1 tile — right for a skewed T-join
 * into a crossing road, wrong for a COLLINEAR CONTINUATION (a bridge
 * section split out of a longer road, or a bridge welded end-to-end
 * into its approach). There the trim ate 6 tiles of rail (all of it on
 * short sections) and the extension stamped deck material 1 tile onto
 * the neighbour. A continuation end keeps its full-length rail (a real
 * parapet runs to the abutment face) and needs no extension (the shared
 * vertex guarantees the surfaces abut).
 */

export type DeckEndConn = 'free' | 'continuation' | 'abutment';

/** Dot-product bar for "the neighbour carries straight on". cos(~25°). */
const CONT_DOT = 0.9;

/** Classify one deck end against ONE other polyline (raw pts as [x,y]
 *  pairs). `ux,uy` is the deck end's OUTWARD unit tangent (interior →
 *  end). Returns null when the end doesn't touch this polyline. */
export function classifyDeckEndAgainst(
  ex: number,
  ey: number,
  ux: number,
  uy: number,
  poly: ReadonlyArray<readonly number[]>,
  thresh: number,
): DeckEndConn | null {
  const n = poly.length;
  if (n < 2) return null;
  const t2 = thresh * thresh;
  let touching = false;
  for (let i = 0; i < n - 1; i++) {
    const ax = poly[i][0];
    const ay = poly[i][1];
    const dx = poly[i + 1][0] - ax;
    const dy = poly[i + 1][1] - ay;
    const L2 = dx * dx + dy * dy;
    if (L2 < 1e-9) continue;
    let t = ((ex - ax) * dx + (ey - ay) * dy) / L2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const qx = ax + dx * t - ex;
    const qy = ay + dy * t - ey;
    if (qx * qx + qy * qy <= t2) { touching = true; break; }
  }
  if (!touching) return null;
  // Endpoint-to-endpoint join whose first leg carries on along the deck
  // end's outward tangent = continuation; anything else (mid-segment
  // T-hit, skewed end join) = abutment.
  const termini: Array<[readonly number[], readonly number[]]> = [
    [poly[0], poly[1]],
    [poly[n - 1], poly[n - 2]],
  ];
  for (const [v, adj] of termini) {
    const ddx = v[0] - ex;
    const ddy = v[1] - ey;
    if (ddx * ddx + ddy * ddy > t2) continue;
    const wl = Math.hypot(adj[0] - v[0], adj[1] - v[1]) || 1;
    const wx = (adj[0] - v[0]) / wl;
    const wy = (adj[1] - v[1]) / wl;
    if (ux * wx + uy * wy > CONT_DOT) return 'continuation';
  }
  return 'abutment';
}

/** Fold per-polyline classes: any abutment wins (the band must yield to
 *  a crossing road even if a sibling also continues the line), else any
 *  continuation, else free. */
export function foldDeckEndClasses(classes: ReadonlyArray<DeckEndConn | null>): DeckEndConn {
  let out: DeckEndConn = 'free';
  for (const c of classes) {
    if (c === 'abutment') return 'abutment';
    if (c === 'continuation') out = 'continuation';
  }
  return out;
}
