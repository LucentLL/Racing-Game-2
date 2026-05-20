/**
 * Angle-reference picker — detect the tangent direction of the nearest
 * road segment to a click point.
 *
 * USED BY: the editor's "📐 Ref" mode. When `state.angleRefMode` is on,
 * the next canvas tap consumes the click, locates the closest road
 * segment within 16 tiles, and stores its (sign-corrected) tangent
 * direction in `state.angleRefDirection`. The wePropAngle input then
 * rotates the selected road's chord around its centroid by the user's
 * angle PLUS the reference angle — letting the user say "make this road
 * 45° relative to that highway over there".
 *
 * SIGN CONVENTION: the raw segment tangent points from pts[s] → pts[s+1],
 * which is arbitrary (depends on how the polyline was authored). To make
 * the reference direction feel consistent regardless of authoring order,
 * we flip the tangent when the click landed on the LEFT side of the raw
 * tangent (signed perpendicular distance < 0). After the flip, the
 * reference direction always points along the segment, toward the side
 * the user clicked on.
 *
 * Ported 1:1 from monolith driver_city_charlotte_v8_99_126_89.html
 * L14551-L14583. In the modular world the live road list arrives via a
 * caller-supplied `getRoads()` callback — gameLoop.ts adapts
 * RENDER_ENTRIES into the `{pts}` shape that mirrors the monolith's
 * runtime `majorRoads`.
 */

/** Click-to-segment max distance, in tile units. Monolith's SEARCH_R. */
export const ANGLE_REF_SEARCH_RADIUS_TILES = 16;

/** Minimal road shape the picker needs — just the raw polyline. */
export interface AngleRefRoad {
  pts: ReadonlyArray<readonly [number, number]>;
}

/** Host-supplied accessor for the runtime road list. */
export interface AngleRefDeps {
  getRoads(): ReadonlyArray<AngleRefRoad>;
}

/** Successful pick — includes the projection point on the segment and
 *  the index of the road that produced the best hit, for downstream
 *  diagnostics. Callers that only care about the direction can read
 *  `result.direction`. */
export interface AngleRefResult {
  dist: number;
  projX: number;
  projY: number;
  direction: [number, number];
  roadIdx: number;
}

export function _weDetectAngleRefDirection(
  tx: number,
  ty: number,
  deps: AngleRefDeps,
): AngleRefResult | null {
  let best: AngleRefResult | null = null;
  const roads = deps.getRoads();
  for (let r = 0; r < roads.length; r++) {
    const road = roads[r];
    if (!road || !road.pts || road.pts.length < 2) continue;
    for (let s = 0; s < road.pts.length - 1; s++) {
      const ax = road.pts[s][0];
      const ay = road.pts[s][1];
      const bx = road.pts[s + 1][0];
      const by = road.pts[s + 1][1];
      const dx = bx - ax;
      const dy = by - ay;
      const segLen = Math.hypot(dx, dy);
      if (segLen < 0.01) continue;
      const t = ((tx - ax) * dx + (ty - ay) * dy) / (segLen * segLen);
      const tc = Math.max(0, Math.min(1, t));
      const projX = ax + tc * dx;
      const projY = ay + tc * dy;
      const dist = Math.hypot(tx - projX, ty - projY);
      if (dist > ANGLE_REF_SEARCH_RADIUS_TILES) continue;
      if (!best || dist < best.dist) {
        const tdx = dx / segLen;
        const tdy = dy / segLen;
        // perpSigned > 0 ⇒ click is on the right of the raw tangent.
        const perpSigned = (tx - projX) * -tdy + (ty - projY) * tdx;
        const dirSign = perpSigned >= 0 ? 1 : -1;
        best = {
          dist,
          projX,
          projY,
          direction: [dirSign * tdx, dirSign * tdy],
          roadIdx: r,
        };
      }
    }
  }
  return best;
}
