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
 *  pre-H9 on-road behavior so this keeps a single signature.
 *  `redline=Infinity` (default) disables the H104 rev-limiter accel
 *  cut so callers without a catalog car (pre-life start-flow) skip
 *  the per-car branch entirely. */
export function arcadeUpdate(
  player: PlayerState,
  input: InputState,
  dt: number,
  onRoad: boolean = true,
  redline: number = Infinity,
  torqueMult: number = 1,
  gearMult: number = 1,
  topSpeed: number = Infinity,
  engineBrake: number = 0,
  rollingFriction: number = 0,
  aeroFactor: number = 0,
  brakePower: number = BRAKE_DECEL,
): void {
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
  // H92: reverse-intent flag set/clear at the same 5 points the monolith
  // mutates pRevIntent (L24062/24069/24073/24084/24104). The flag goes
  // true ONLY in the brake-while-stopped reverse-accel branch — every
  // other transition (gas, forward brake, final-stop snap, coast-to-
  // zero) clears it. Consumers (H90 lamps, H91 HUD) read it directly
  // instead of inferring from pSpeed<-0.5.
  if (input.gas && !input.brake && !outOfFuel) {
    // H104: rev-limiter acceleration cut. 1:1 port of monolith L24011:
    //   const revLimMult = pRPM >= cc.redline * 0.98 ? 0.05 : 1
    // H105: torque-curve multiplier. 1:1 port of monolith L23996-24008:
    //   torqueMult = getTorqueAtRPM(cc, pRPM)    // normalized 0..1
    // H106: gear-spread torque multiplier. 1:1 port of monolith
    // L24014-24020 — lower gears get mechanical-advantage bonus from
    // the deeper ratio spread.
    // H107: quadratic top-speed falloff. 1:1 port of monolith L23990-
    // 23991:
    //   speedRatio = |pSpeed| / topSpeed
    //   powerMult  = max(0, 1 - speedRatio²)
    // Models the engine + aero-drag force balance — accel asymptotes
    // to zero as the car approaches its catalog top speed. At 50%
    // top, powerMult = 0.75; at 80% it's 0.36; at 100% it's 0. Slow
    // cars (topSpeed < MAX_SPEED) now asymptote to their real top
    // speed before the speedCap hard-clamp triggers; fast cars (top
    // speed > MAX_SPEED) still hit speedCap but with realistic
    // accel decay near the cap. topSpeed=Infinity (no-car default)
    // makes the multiplier always 1, preserving H6 baseline.
    const revLimMult = player.pRpm >= redline * 0.98 ? 0.05 : 1;
    const speedRatio = Math.abs(player.pSpeed) / topSpeed;
    const powerMult = Math.max(0, 1 - speedRatio * speedRatio);
    player.pSpeed = Math.min(
      speedCap,
      player.pSpeed + ACCEL * revLimMult * torqueMult * gearMult * powerMult * dt,
    );
    player.pRevIntent = false;
  } else if (input.brake) {
    if (player.pSpeed > 0.5) {
      // H109: per-car brake force replaces the H6 flat BRAKE_DECEL.
      // 1:1 port of monolith L24066 (the forward-braking branch):
      //   pSpeed -= CAR().brakePower * brakeAmount * fxFault.brakeMult * dt
      // brakeAmount is the analog input (0..1) — arcade is digital so
      // we use 1. fxFault.brakeMult is the fault-system multiplier;
      // not ported, defaults to 1 (no fault). Real-world brake decel
      // ranges ~7-10 m/s² (0.7-1g); the formula maps power-to-weight
      // pwr=hp/kg directly into this band, so an economy car decels
      // around 41 wpx/s² (~1.7s from 70 wpx/s to 0) and a sports car
      // around 48 — much less than the old 240 wpx/s² fantasy brake.
      player.pSpeed = Math.max(0, player.pSpeed - brakePower * dt);
      player.pRevIntent = false;
    } else if (player.pSpeed > 0.01) {
      player.pSpeed = 0;
      player.pRevIntent = false;
    } else {
      player.pSpeed = Math.max(-REVERSE_MAX, player.pSpeed - REVERSE_ACCEL * dt);
      player.pRevIntent = true;
    }
  } else if (Math.abs(player.pSpeed) > 0.3) {
    // H108: per-car coast drag. 1:1 port of monolith L24090-24096:
    //   drag = engineBrake + rollingFriction + aeroFactor * pSpeed²
    //   sign = pSpeed > 0 ? 1 : -1
    //   pSpeed -= sign * drag * dt
    //   // don't overshoot zero
    // Three forces compose: constant engine compression braking +
    // constant rolling tire friction + speed-squared aero drag.
    // Slow cars barely feel aero; supercars at 250 km/h are dominated
    // by it (~3 m/s² aero alone). Falls back to the H6 COAST_FRICTION
    // constant when no car drag is plumbed (pre-life start-flow path).
    const useCarDrag = engineBrake > 0 || rollingFriction > 0 || aeroFactor > 0;
    const aSpd = Math.abs(player.pSpeed);
    const drag = useCarDrag
      ? engineBrake + rollingFriction + aeroFactor * aSpd * aSpd
      : COAST_FRICTION;
    const sign = player.pSpeed > 0 ? 1 : -1;
    const next = player.pSpeed - sign * drag * frictionMult * dt;
    // Overshoot prevention — clamp to zero from either direction.
    player.pSpeed = (sign > 0 && next < 0) || (sign < 0 && next > 0) ? 0 : next;
  } else if (player.pSpeed !== 0) {
    // Within ±0.3 wpx/s — snap to zero. Matches monolith L24097-24099
    // "Stopped — NO backward rolling" branch in the coasting path.
    player.pSpeed = 0;
  }
  // Monolith L24097-24104 clears pRevIntent once the car comes to a full
  // stop while coasting — letting off the brake after backing up and
  // rolling to zero exits "actively reversing" state. We check after
  // the input/coast block so a same-frame coast→zero clamp catches it.
  if (!input.gas && !input.brake && player.pSpeed === 0) {
    player.pRevIntent = false;
  }

  // Re-clamp in case we crossed onto grass while traveling above the
  // off-road cap. Brake-style decel toward the new cap keeps the
  // transition smooth instead of a hard snap. Reverse ignores this —
  // REVERSE_MAX is well below any surface's forward cap.
  // H109: uses the same per-car brakePower as the brake-input branch
  // so the surface-transition feel matches the actual brake feel for
  // the active car. frictionMult magnifies the decel off-road (×2.5)
  // since grass adds slip-and-grab on top of brake force.
  if (player.pSpeed > speedCap) {
    player.pSpeed = Math.max(speedCap, player.pSpeed - brakePower * frictionMult * dt);
  }

  // Steering — proportional to absolute speed so a stopped car doesn't
  // pivot on its center, AND a reversing car still has steering authority
  // proportional to how fast it's backing up. No reverse-input flip yet
  // (monolith L11879 `pAngVel *= -1` is a grip-path-only inversion that
  // needs the bicycle model to port); right input still rotates heading
  // clockwise regardless of direction, so the rear end swings the way
  // a real steering wheel would push it.
  const speedRatio = Math.abs(player.pSpeed) / MAX_SPEED;
  // H140: read the signed analog steerAxis set by mergeInputs. The
  // value is -1..1; gamepad left-stick is smoothed via the monolith's
  // L23808 curve+blend, keyboard snaps to -1/0/+1. Boolean
  // steerLeft/steerRight shadows on input still exist for legacy
  // readers but physics now goes through the continuous field.
  const turnInput = input.steerAxis;
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
