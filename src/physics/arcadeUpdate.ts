/**
 * Arcade-tier physics update — INTENTIONALLY simpler than the monolith's
 * NFS-Blackbox-derived port at L23838-27650.
 *
 * H6: this is the "first playable" stop-gap. Gas accelerates, brake
 * decelerates, no-input coasts with friction; steering rate scales
 * with speed so a parked car doesn't spin on its centerpoint. Heading
 * vector drives position integration.
 *
 * Real port (physics/vehicle.ts + tire.ts + steering.ts bodies) replaces
 * this in a later H commit. The arcade model exists ONLY so the playing
 * state runs visibly while the real physics is still scaffolded.
 *
 * Units: tiles for position, radians for angle, tiles-per-second for
 * speed. Tunables below are calibrated for "feels right" at a
 * 1-tile-per-canvas-px draw scale; subsequent ports replace them with
 * the real per-car spec from GT4_DB.
 */

import type { PlayerState } from '@/state/player';
import type { InputState } from '@/state/input';

const MAX_SPEED = 200;        // world-px/sec on-road
const ACCEL = 120;            // world-px/sec² when gas held
const BRAKE_DECEL = 240;      // world-px/sec² when brake held
const COAST_FRICTION = 40;    // world-px/sec² when neither held
const MAX_TURN_RATE = 2.5;    // rad/sec, scaled by (speed/MAX_SPEED)
/** H9: off-road top-speed multiplier. Grass / dirt / water all roll
 *  through this path until per-tile-type physics ports. */
const OFF_ROAD_SPEED_MULT = 0.5;
/** Extra friction when off-road so engaging the gas doesn't compensate
 *  fully — the car feels heavier in the dirt. */
const OFF_ROAD_FRICTION_MULT = 2.5;

/** Per-frame physics step. `onRoad=true` means the player center is on
 *  a TILE_ROAD cell; passing `undefined` (legacy callers) preserves the
 *  pre-H9 on-road behavior so this keeps a single signature. */
export function arcadeUpdate(player: PlayerState, input: InputState, dt: number, onRoad: boolean = true): void {
  const speedCap = onRoad ? MAX_SPEED : MAX_SPEED * OFF_ROAD_SPEED_MULT;
  const frictionMult = onRoad ? 1 : OFF_ROAD_FRICTION_MULT;

  // Throttle / brake.
  if (input.gas && !input.brake) {
    player.pSpeed = Math.min(speedCap, player.pSpeed + ACCEL * dt);
  } else if (input.brake) {
    player.pSpeed = Math.max(0, player.pSpeed - BRAKE_DECEL * dt);
  } else if (player.pSpeed > 0) {
    player.pSpeed = Math.max(0, player.pSpeed - COAST_FRICTION * frictionMult * dt);
  }

  // Re-clamp in case we crossed onto grass while traveling above the
  // off-road cap. Brake-style decel toward the new cap keeps the
  // transition smooth instead of a hard snap.
  if (player.pSpeed > speedCap) {
    player.pSpeed = Math.max(speedCap, player.pSpeed - BRAKE_DECEL * frictionMult * dt);
  }

  // Steering — proportional to speed so a stopped car doesn't pivot
  // on its center (parking-lot behavior the real physics models too).
  const speedRatio = player.pSpeed / MAX_SPEED;
  const turnInput = (input.steerRight ? 1 : 0) - (input.steerLeft ? 1 : 0);
  player.pAngle += turnInput * MAX_TURN_RATE * speedRatio * dt;

  // Integrate position along heading.
  player.px += Math.cos(player.pAngle) * player.pSpeed * dt;
  player.py += Math.sin(player.pAngle) * player.pSpeed * dt;
}
