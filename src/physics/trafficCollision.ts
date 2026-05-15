/**
 * Circle-vs-circle player ↔ traffic collision.
 *
 * Each car is treated as a disc of radius CAR_RADIUS centered on its
 * position. A "hit" is squared-distance < (2*CAR_RADIUS)². On hit:
 *   - player.pSpeed *= COLLISION_SLOW (60% velocity reduction)
 *   - player.fuel -= FUEL_PENALTY * impactFactor, where
 *     impactFactor = pre-collision pSpeed / MAX_SPEED
 *   - traffic car's `t` jumps forward FLEE_T_BUMP so it scoots ahead
 *     instead of staying on top of the player (cheap "bounce" — real
 *     physics impulse + traffic-aware avoidance ports with the real
 *     AI).
 *   - player.collisionFlash = FLASH_DURATION, ticked down by the
 *     caller. Doubles as cooldown — collision checks short-circuit
 *     while flash is mid-fade so one bump doesn't fire on each of
 *     the next 60 frames.
 *
 * INTENTIONALLY simpler than the monolith's collision pipeline
 * (L25193-26377 — rect-vs-rect with damage zones, body damage, fault
 * generation, sound). Real bodies port with src/physics/collision.
 */

import type { PlayerState } from '@/state/player';
import type { TrafficCar } from '@/state/traffic';
import { BASELINE_ROADS } from '@/config/world/baselineRoads';

const CAR_RADIUS = 9;                  // matches player + traffic visual sizes
const COLLISION_DIST_SQ = (2 * CAR_RADIUS) ** 2;
const COLLISION_SLOW = 0.4;            // pSpeed *= COLLISION_SLOW
const FUEL_PENALTY_MAX = 0.03;         // max fuel cost per heavy bump
const FLEE_T_BUMP = 0.04;              // shove the traffic car forward along its road
const FLASH_DURATION = 0.5;            // seconds the flash stays > 0
const MAX_SPEED = 200;                 // mirrors arcadeUpdate's MAX_SPEED

/** Returned on the frame a collision resolves. Caller uses
 *  `impact` to drive the crash-sound volume. */
export interface CollisionEvent {
  /** Impact factor 0..1 = pre-collision pSpeed / MAX_SPEED. */
  impact: number;
}

/** Returns a CollisionEvent if a hit fired this frame, null otherwise. */
export function tickTrafficCollisions(player: PlayerState, traffic: TrafficCar[]): CollisionEvent | null {
  // Fade the flash regardless of whether we collide this frame —
  // caller doesn't have to thread dt because we update flash
  // separately at a constant per-call decay (60Hz tick assumed
  // close enough; precise timing isn't gameplay-critical here).
  if (player.collisionFlash > 0) {
    player.collisionFlash = Math.max(0, player.collisionFlash - 1 / 60);
  }
  // Cooldown: skip collision detection while still flashing. Prevents
  // 60-frames-of-bumps when player parks against a stationary car.
  if (player.collisionFlash > FLASH_DURATION * 0.5) return null;

  let hit: CollisionEvent | null = null;
  for (const car of traffic) {
    const dx = car.px - player.px;
    const dy = car.py - player.py;
    if (dx * dx + dy * dy < COLLISION_DIST_SQ) {
      // Impact factor: scales fuel penalty + crash-sound volume by
      // how fast we were going PRE-collision.
      const impact = Math.min(1, player.pSpeed / MAX_SPEED);
      player.pSpeed *= COLLISION_SLOW;
      player.fuel = Math.max(0, player.fuel - FUEL_PENALTY_MAX * impact);
      // Shove the traffic car along its road. If it's already near
      // the end of its segment, the next tickTraffic will walk it to
      // the next segment naturally.
      car.t = Math.min(0.99, car.t + FLEE_T_BUMP);
      player.collisionFlash = FLASH_DURATION;
      hit = { impact };
      // Only resolve one collision per frame — chain reactions feel
      // worse than a single firm bump.
      break;
    }
  }
  // Silence unused import — keep BASELINE_ROADS reachable for future
  // segment-aware collision (e.g., projecting player onto road for
  // proper deflection).
  void BASELINE_ROADS;
  return hit;
}
