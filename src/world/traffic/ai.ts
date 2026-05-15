/**
 * Traffic AI — per-frame steering + speed for every traffic car.
 * GTA-style lane keeping with T-junction yield, traffic-light obedience,
 * collision avoidance, and cop-pursuit attraction toward the player.
 *
 * Ported from monolith L26663+ (the traffic-AI block inside update(dt)).
 * The largest single AI block in the game.
 *
 * SCAFFOLD status: typed entry; body stubbed.
 */

import type { TrafficCar } from './types';

export interface TrafficAiDeps {
  /** Player position — feeds despawn cull and cop attraction. */
  px: number;
  py: number;
  /** Player speed — for highway-cop radar detection. */
  pSpeed: number;
  /** Active speed limit (mph) at the player's current road segment. */
  speedLimit: number;
}

/** Per-frame AI tick — advances every traffic car's position + speed,
 *  decides lane changes, applies yields at intersections, manages cop
 *  pursuit state machine.
 *
 *  TODO(C25-followup): port monolith L26663+ (the AI block inside update). */
export function updateTrafficAi(
  _traffic: TrafficCar[],
  _deps: TrafficAiDeps,
  _dt: number,
): void {
  // TODO: L26663+.
}
