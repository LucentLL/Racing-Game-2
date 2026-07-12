/**
 * H1130: road-network pathfinding for NPC service vehicles.
 *
 * The AI incoming-tow truck (breakdown recovery) used to drive a
 * STRAIGHT LINE from its spawn to the player — through grass, water,
 * buildings, whatever (1:1 with the monolith, which never pathed it).
 * User call 2026-07-11: the truck should drive on roads.
 *
 * findRoadPath() runs A* over the tile grid restricted to road tiles
 * (ids 1..3 — same predicate as the H200 job walks), 4-neighbor so the
 * path can't cut corners diagonally through non-road tiles. Both
 * endpoints snap to their nearest road tile first (callers hand in
 * arbitrary world points — a breakdown can be off-road). Collinear
 * runs collapse to single waypoints so a follower turns at corners
 * instead of micro-stepping every tile.
 *
 * Returns world-px waypoints (tile centers), or null when either
 * endpoint can't snap or the search exhausts its expansion cap
 * (disconnected road islands). Callers MUST keep their old
 * straight-line behavior as the fallback — a null path should degrade,
 * never strand.
 */

import { TILE } from '@/config/world/tiles';
import { snapToNearestRoad, type TargetTileMap } from '@/sim/jobTargets';

/** A* expansion cap. The road network is sparse (~5-10% of tiles);
 *  measured 2026-07-11: a 1200-tile-apart pair routes in ~8ms, so even
 *  this cap is a one-shot cost in the tens of ms. Genuinely
 *  disconnected road islands (other-map baselines, editor fragments)
 *  exhaust their whole component fast and return null — that's the
 *  designed degrade-to-straight-line signal, not a budget problem. */
const MAX_EXPANSIONS = 120000;

function isRoadTile(tileMap: TargetTileMap, tx: number, ty: number): boolean {
  const t = tileMap.getTile(tx, ty);
  return t >= 1 && t <= 3;
}

/**
 * A* from (fromWX, fromWY) to (toWX, toWY) along road tiles.
 * World-px in, world-px waypoints out (tile centers). Null = no path.
 */
export function findRoadPath(
  tileMap: TargetTileMap,
  fromWX: number,
  fromWY: number,
  toWX: number,
  toWY: number,
): Array<{ x: number; y: number }> | null {
  const start = snapToNearestRoad(tileMap, Math.floor(fromWX / TILE), Math.floor(fromWY / TILE));
  const goal = snapToNearestRoad(tileMap, Math.floor(toWX / TILE), Math.floor(toWY / TILE));
  if (!start || !goal) return null;

  const key = (tx: number, ty: number): number => ty * 65536 + tx;
  const startKey = key(start.tx, start.ty);
  const goalKey = key(goal.tx, goal.ty);
  if (startKey === goalKey) {
    return [{ x: start.tx * TILE + TILE / 2, y: start.ty * TILE + TILE / 2 }];
  }

  // Open list as a plain binary heap on f-score.
  const heapKeys: number[] = [startKey];
  const heapF: number[] = [0];
  const gScore = new Map<number, number>([[startKey, 0]]);
  const cameFrom = new Map<number, number>();
  const closed = new Set<number>();

  const heapPush = (k: number, f: number): void => {
    heapKeys.push(k);
    heapF.push(f);
    let i = heapKeys.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapF[p] <= heapF[i]) break;
      [heapF[p], heapF[i]] = [heapF[i], heapF[p]];
      [heapKeys[p], heapKeys[i]] = [heapKeys[i], heapKeys[p]];
      i = p;
    }
  };
  const heapPop = (): number => {
    const top = heapKeys[0];
    const lastK = heapKeys.pop()!;
    const lastF = heapF.pop()!;
    if (heapKeys.length > 0) {
      heapKeys[0] = lastK;
      heapF[0] = lastF;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heapF.length && heapF[l] < heapF[m]) m = l;
        if (r < heapF.length && heapF[r] < heapF[m]) m = r;
        if (m === i) break;
        [heapF[m], heapF[i]] = [heapF[i], heapF[m]];
        [heapKeys[m], heapKeys[i]] = [heapKeys[i], heapKeys[m]];
        i = m;
      }
    }
    return top;
  };

  let expansions = 0;
  let found = false;
  while (heapKeys.length > 0) {
    const cur = heapPop();
    if (cur === goalKey) { found = true; break; }
    if (closed.has(cur)) continue;
    closed.add(cur);
    if (++expansions > MAX_EXPANSIONS) return null;
    const cx = cur % 65536;
    const cy = Math.floor(cur / 65536);
    const g = gScore.get(cur)!;
    // 4-neighbor — diagonals could thread between two non-road tiles.
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!isRoadTile(tileMap, nx, ny)) continue;
      const nk = key(nx, ny);
      if (closed.has(nk)) continue;
      const ng = g + 1;
      const known = gScore.get(nk);
      if (known !== undefined && known <= ng) continue;
      gScore.set(nk, ng);
      cameFrom.set(nk, cur);
      const h = Math.abs(nx - goal.tx) + Math.abs(ny - goal.ty);
      heapPush(nk, ng + h);
    }
  }
  if (!found) return null;

  // Walk back, then reverse + collapse collinear runs.
  const tiles: Array<[number, number]> = [];
  let cur: number | undefined = goalKey;
  while (cur !== undefined) {
    tiles.push([cur % 65536, Math.floor(cur / 65536)]);
    cur = cameFrom.get(cur);
  }
  tiles.reverse();

  const path: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < tiles.length; i++) {
    if (i > 0 && i < tiles.length - 1) {
      const [px, py] = tiles[i - 1];
      const [cx2, cy2] = tiles[i];
      const [nx, ny] = tiles[i + 1];
      // Skip interior points of straight runs.
      if (nx - cx2 === cx2 - px && ny - cy2 === cy2 - py) continue;
    }
    path.push({ x: tiles[i][0] * TILE + TILE / 2, y: tiles[i][1] * TILE + TILE / 2 });
  }
  return path;
}
