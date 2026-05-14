/**
 * Player ↔ world collision: isSolid (tile-based) + collide (point-radius
 * sweep) + isOnMajorRoad (used by speed-limit + grip lookups).
 *
 * Ported from monolith L23804-23830. Small subsystem — collision against
 * traffic + race opponent is in world/traffic and physics/movement.
 *
 * SCAFFOLD status: type contract; bodies stubbed.
 */

export interface CollisionDeps {
  /** Tile constants + map size. */
  TILE: number;
  MAP_W: number;
  MAP_H: number;
  /** Tile lookup. */
  getTile(wtx: number, wty: number): number;
  /** Building registry — buildings are tile=4 / tile=17 plus stored bbox. */
  getBldg(wtx: number, wty: number): { collidable: boolean } | null;
}

/** True if the tile at world coords (wx, wy) blocks vehicle motion.
 *  Considers building, canyon walls, water (only when player isn't on a
 *  bridge). TODO(C23-followup): port from L23823. */
export function isSolid(
  _wx: number,
  _wy: number,
  _deps: CollisionDeps,
): boolean {
  return false;
}

/** Resolves a sphere-radius collision against world tiles. Pushes the
 *  position out of solids, scales velocity by impact direction.
 *  TODO(C23-followup): port from L23830. */
export function collide(
  _x: number,
  _y: number,
  _r: number,
  _deps: CollisionDeps,
): { x: number; y: number; hit: boolean } {
  return { x: 0, y: 0, hit: false };
}

/** True if the player position projects onto a major road (w >= 8 tile
 *  width). Used by speed-limit + grip. TODO(C23-followup): port from
 *  L23804. */
export function isOnMajorRoad(
  _wx: number,
  _wy: number,
): boolean {
  return false;
}
