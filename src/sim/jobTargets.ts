/**
 * H1127: job-target resolver — the DeliveryTask scaffolding.
 *
 * Every delivery-shaped job resolves its pickup/drop-off through ONE
 * `resolveTarget(kind, tileMap)` call instead of the two copy-pasted
 * random road-tile walks jobsRoller carried since H200. A target kind
 * names WHERE the point anchors:
 *
 *   'road'        random drivable road tile (the H200 behavior — all
 *                 4 mainline jobs + TRUCK DRIVER still use this).
 *   'gasStation'  one of the named GAS_STATIONS, snapped to the
 *                 nearest road tile (H1128 FUEL TANKER destination).
 *   'building'    any editor-placed building (PLACED_BUILDINGS).
 *   'partsStore'  PLACED_BUILDINGS type 'autoparts'.
 *   'restaurant'  PLACED_BUILDINGS type 'restaurant' — NO SUCH PRESET
 *                 EXISTS YET; resolves as 'road' until the editor
 *                 grows one. Reserved for FOOD DELIVERY restaurant→
 *                 house loops.
 *   'house'       PLACED_BUILDINGS residence types.
 *
 * Buildings are SOLID since H998 — a marker at the centroid would be
 * unreachable inside the footprint, so building-backed kinds snap to
 * the nearest road tile (ring search) and keep the building's display
 * name. When a kind's pool is empty (e.g. a map with no autoparts
 * placed), the resolver falls back to a random road point AND reports
 * kind:'road' — the returned kind always describes the point actually
 * produced, so markers/arrival never claim an anchor that isn't there.
 *
 * Adding a new delivery venue = add the kind here + list its pool.
 * The run machine (sim/jobArrival.ts arrival-spec table) and markers
 * never need to change.
 */

import { MAP_W, MAP_H, TILE } from '@/config/world/tiles';
import { GAS_STATIONS } from '@/config/world/gasStations';
import { PLACED_BUILDINGS, placedBuildingLabel, type PlacedBuilding } from '@/world/placedBuildings';

/** Where a job target point anchors. See module doc for each kind. */
export type TargetKind =
  | 'road'
  | 'gasStation'
  | 'building'
  | 'partsStore'
  | 'restaurant'
  | 'house';

/** A resolved job target — world-px point + display name (undefined
 *  for anonymous road points). */
export interface JobTarget {
  kind: TargetKind;
  /** World-px center of the target tile. */
  x: number;
  y: number;
  /** Display name (station/building label). */
  name?: string;
}

/** Tile-map contract — same shape jobsRoller has always used, kept
 *  as a parameter so this module stays test-friendly. */
export interface TargetTileMap {
  getTile(tx: number, ty: number): number;
}

/** Road-tile test — ids 1..3 are drivable road (same predicate as the
 *  H200 roller walks). */
function isRoadTile(tileMap: TargetTileMap, tx: number, ty: number): boolean {
  const t = tileMap.getTile(tx, ty);
  return t >= 1 && t <= 3;
}

/** Random road tile → world-px center. 1:1 with the H200 roller walk
 *  (500 attempts, falls through to whatever the last roll was — same
 *  degenerate-map behavior as before). */
function randomRoadPoint(tileMap: TargetTileMap): { x: number; y: number } {
  let tx = 0;
  let ty = 0;
  for (let attempts = 0; attempts < 500; attempts++) {
    tx = Math.floor(Math.random() * MAP_W);
    ty = Math.floor(Math.random() * MAP_H);
    if (isRoadTile(tileMap, tx, ty)) break;
  }
  return { x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 };
}

/** Max snap search radius (tiles). Building footprints run ~2-8 tiles
 *  of half-extent, but the H13-era GAS_STATIONS coords predate the
 *  user's world export and now sit up to ~69 tiles from the nearest
 *  road (measured headless 2026-07-11: Uptown 29, Pineville 69,
 *  Westside 5, University 14). 80 keeps every live anchor resolvable;
 *  the marker lands on the closest drivable tile to the venue. */
const SNAP_MAX_R = 80;

/** Nearest road tile to (tx,ty) by expanding ring search (Chebyshev
 *  rings — closest-first). Returns null when nothing drivable sits
 *  within SNAP_MAX_R. Needed because H998 made buildings solid: the
 *  player parks at the footprint edge and can never reach a marker
 *  at the centroid. */
export function snapToNearestRoad(
  tileMap: TargetTileMap,
  tx: number,
  ty: number,
): { tx: number; ty: number } | null {
  if (isRoadTile(tileMap, tx, ty)) return { tx, ty };
  for (let r = 1; r <= SNAP_MAX_R; r++) {
    for (let i = -r; i <= r; i++) {
      // Top + bottom rows of the ring.
      if (isRoadTile(tileMap, tx + i, ty - r)) return { tx: tx + i, ty: ty - r };
      if (isRoadTile(tileMap, tx + i, ty + r)) return { tx: tx + i, ty: ty + r };
      // Left + right columns (corners already covered above).
      if (i > -r && i < r) {
        if (isRoadTile(tileMap, tx - r, ty + i)) return { tx: tx - r, ty: ty + i };
        if (isRoadTile(tileMap, tx + r, ty + i)) return { tx: tx + r, ty: ty + i };
      }
    }
  }
  return null;
}

/** Residence preset types — mirrors placedBuildings' residence set
 *  (that set isn't exported; the `residence` flag on each entry is,
 *  so filter on the flag). */
function buildingPool(kind: TargetKind): PlacedBuilding[] {
  switch (kind) {
    case 'building': return [...PLACED_BUILDINGS];
    case 'partsStore': return PLACED_BUILDINGS.filter((b) => b.type === 'autoparts');
    case 'restaurant': return PLACED_BUILDINGS.filter((b) => b.type === 'restaurant');
    case 'house': return PLACED_BUILDINGS.filter((b) => b.residence);
    default: return [];
  }
}

/**
 * Resolve a target point for `kind`. Never throws — empty pools and
 * failed snaps degrade to a random road point with kind:'road' (the
 * returned kind always matches the produced point).
 */
export function resolveTarget(kind: TargetKind, tileMap: TargetTileMap): JobTarget {
  if (kind === 'road') {
    return { kind: 'road', ...randomRoadPoint(tileMap) };
  }

  if (kind === 'gasStation') {
    const st = GAS_STATIONS[Math.floor(Math.random() * GAS_STATIONS.length)];
    const snapped = snapToNearestRoad(tileMap, st.tx, st.ty);
    if (snapped) {
      return {
        kind: 'gasStation',
        x: snapped.tx * TILE + TILE / 2,
        y: snapped.ty * TILE + TILE / 2,
        name: st.name,
      };
    }
    return { kind: 'road', ...randomRoadPoint(tileMap) };
  }

  // Building-backed kinds.
  const pool = buildingPool(kind);
  if (pool.length > 0) {
    const b = pool[Math.floor(Math.random() * pool.length)];
    const snapped = snapToNearestRoad(tileMap, Math.round(b.cx), Math.round(b.cy));
    if (snapped) {
      return {
        kind,
        x: snapped.tx * TILE + TILE / 2,
        y: snapped.ty * TILE + TILE / 2,
        name: placedBuildingLabel(b),
      };
    }
  }
  return { kind: 'road', ...randomRoadPoint(tileMap) };
}
