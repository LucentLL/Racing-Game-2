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

const MAX_SPEED = 200;        // tiles/sec
const ACCEL = 120;            // tiles/sec² when gas held
const BRAKE_DECEL = 240;      // tiles/sec² when brake held
const COAST_FRICTION = 40;    // tiles/sec² when neither held
const MAX_TURN_RATE = 2.5;    // rad/sec, scaled by (speed/MAX_SPEED)

export function arcadeUpdate(player: PlayerState, input: InputState, dt: number): void {
  // Throttle / brake.
  if (input.gas && !input.brake) {
    player.pSpeed = Math.min(MAX_SPEED, player.pSpeed + ACCEL * dt);
  } else if (input.brake) {
    player.pSpeed = Math.max(0, player.pSpeed - BRAKE_DECEL * dt);
  } else {
    // Coast — friction pulls toward zero.
    if (player.pSpeed > 0) {
      player.pSpeed = Math.max(0, player.pSpeed - COAST_FRICTION * dt);
    }
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
