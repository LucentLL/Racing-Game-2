/**
 * Traffic spawning — places traffic on visible roads at target density,
 * respawns despawned slots near the player, picks body types per road
 * class, assigns colors / bike sprite keys.
 *
 * Ported from monolith L18642-20102 (~1460 lines). Includes road
 * preprocessing helpers (T-junction detection, auto-taper detection) +
 * spawn placement logic + overlap checks + color/body-type tables.
 *
 * SCAFFOLD status: types + key entry signatures; bodies stubbed.
 */

import type { TrafficCar } from './types';

export interface SpawnDeps {
  /** Target traffic count per road class. From TRAFFIC_TARGET_DENSITY. */
  targetDensity: number;
  /** Color tables. */
  colorsNormal: ReadonlyArray<string>;
  colorsRacer: ReadonlyArray<string>;
  /** Cop spawn rate (per second). */
  copSpawnRate: number;
}

/** Picks a body type for a traffic car spawning on the given road class. */
export function pickTrafficBodyType(
  _roadW: number,
  _isMajor: boolean,
): string {
  // TODO(C25-followup): port the per-class body-type distribution
  // (civic99 / accord99 / sedan / hatch / suv / pickup / semi).
  return 'sedan';
}

/** Picks a color from the appropriate palette (normal vs racer). */
export function pickTrafficColor(
  _isRacer: boolean,
  _deps: SpawnDeps,
): string {
  // TODO(C25-followup): port from monolith.
  return '#888';
}

/** True if a candidate spawn position overlaps any existing traffic car
 *  within a safe spawn radius. */
export function trafficOverlaps(
  _x: number,
  _y: number,
  _r: number,
  _traffic: ReadonlyArray<TrafficCar>,
): boolean {
  // TODO(C25-followup): port from monolith.
  return false;
}

/** Spawns a new traffic car on the given road (random lane / direction).
 *  Pushes into the traffic array. */
export function spawnTrafficOnRoad(
  _road: unknown,
  _traffic: TrafficCar[],
  _deps: SpawnDeps,
): TrafficCar | null {
  // TODO(C25-followup): port from monolith.
  return null;
}
