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
/** H89 reverse cap. 1:1 port of monolith L24125's `Math.max(-CAR().topSpeed
 *  * 0.15, ...)` — reverse maxes at 15% of forward top speed. The
 *  monolith reads CAR().topSpeed per-car; arcade tier uses the global
 *  MAX_SPEED for consistency with the forward cap so reverse feels the
 *  same regardless of which catalog car is active. */
const REVERSE_MAX = MAX_SPEED * 0.15;
/** H89 reverse acceleration. Monolith L24076: `pSpeed -= CAR().power *
 *  0.25 * brakeAmount * dt` while standing still + brake held. arcade
 *  tier uses 25% of forward ACCEL (no brakeAmount analog yet — input
 *  is digital). */
const REVERSE_ACCEL = ACCEL * 0.25;
/** H9: off-road top-speed multiplier. Grass / dirt / water all roll
 *  through this path until per-tile-type physics ports. */
const OFF_ROAD_SPEED_MULT = 0.5;
/** Extra friction when off-road so engaging the gas doesn't compensate
 *  fully — the car feels heavier in the dirt. */
const OFF_ROAD_FRICTION_MULT = 2.5;
/** H13: fuel burned per world-unit traveled. At MAX_SPEED=200 a full
 *  tank empties in ~150 seconds of full-throttle driving. Tunable. */
const FUEL_BURN_PER_UNIT = 0.0000333;

/** Per-frame physics step. `onRoad=true` means the player center is on
 *  a TILE_ROAD cell; passing `undefined` (legacy callers) preserves the
 *  pre-H9 on-road behavior so this keeps a single signature. */
export function arcadeUpdate(player: PlayerState, input: InputState, dt: number, onRoad: boolean = true): void {
  const speedCap = onRoad ? MAX_SPEED : MAX_SPEED * OFF_ROAD_SPEED_MULT;
  const frictionMult = onRoad ? 1 : OFF_ROAD_FRICTION_MULT;
  const outOfFuel = player.fuel <= 0;

  // Throttle / brake. Out of fuel = no thrust; coast applies as
  // normal so the player can roll to a stop.
  // H89: brake-while-stopped engages reverse. 1:1 port of monolith
  // L24063-24085's three-way brake branch:
  //   pSpeed > 0.5    → forward brake
  //   0.01..0.5       → snap to 0 (don't jump into reverse from crawl)
  //   < 0.01          → reverse accel, capped at REVERSE_MAX
  // Gas accelerates from any starting pSpeed (including negative),
  // matching monolith L24061-24062 where pressing gas cancels reverse
  // intent and `pSpeed += accel*dt` ramps through zero.
  if (input.gas && !input.brake && !outOfFuel) {
    player.pSpeed = Math.min(speedCap, player.pSpeed + ACCEL * dt);
  } else if (input.brake) {
    if (player.pSpeed > 0.5) {
      player.pSpeed = Math.max(0, player.pSpeed - BRAKE_DECEL * dt);
    } else if (player.pSpeed > 0.01) {
      player.pSpeed = 0;
    } else {
      player.pSpeed = Math.max(-REVERSE_MAX, player.pSpeed - REVERSE_ACCEL * dt);
    }
  } else if (player.pSpeed > 0) {
    player.pSpeed = Math.max(0, player.pSpeed - COAST_FRICTION * frictionMult * dt);
  } else if (player.pSpeed < 0) {
    // H89 coast in reverse — friction pulls toward 0 from the negative side.
    player.pSpeed = Math.min(0, player.pSpeed + COAST_FRICTION * frictionMult * dt);
  }

  // Re-clamp in case we crossed onto grass while traveling above the
  // off-road cap. Brake-style decel toward the new cap keeps the
  // transition smooth instead of a hard snap. Reverse ignores this —
  // REVERSE_MAX is well below any surface's forward cap.
  if (player.pSpeed > speedCap) {
    player.pSpeed = Math.max(speedCap, player.pSpeed - BRAKE_DECEL * frictionMult * dt);
  }

  // Steering — proportional to absolute speed so a stopped car doesn't
  // pivot on its center, AND a reversing car still has steering authority
  // proportional to how fast it's backing up. No reverse-input flip yet
  // (monolith L11879 `pAngVel *= -1` is a grip-path-only inversion that
  // needs the bicycle model to port); right input still rotates heading
  // clockwise regardless of direction, so the rear end swings the way
  // a real steering wheel would push it.
  const speedRatio = Math.abs(player.pSpeed) / MAX_SPEED;
  const turnInput = (input.steerRight ? 1 : 0) - (input.steerLeft ? 1 : 0);
  player.pAngle += turnInput * MAX_TURN_RATE * speedRatio * dt;

  // Integrate position along heading + burn fuel proportional to
  // distance traveled (NOT time — coasting at 50 u/s burns less than
  // foot-down at 200 u/s, matching real-world expectation). Negative
  // pSpeed moves opposite heading; fuel still burns (engine runs).
  const distanceMoved = player.pSpeed * dt;
  player.px += Math.cos(player.pAngle) * distanceMoved;
  player.py += Math.sin(player.pAngle) * distanceMoved;
  const distAbs = Math.abs(distanceMoved);
  if (distAbs > 0 && !outOfFuel) {
    player.fuel = Math.max(0, player.fuel - distAbs * FUEL_BURN_PER_UNIT);
  }
}
