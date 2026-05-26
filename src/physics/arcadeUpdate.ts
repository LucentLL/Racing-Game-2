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
  accelMult: number = 1,
  gripMult: number = 1,
  brakeMult: number = 1,
  fuelMult: number = 1,
  steerPull: number = 0,
  steerSlow: boolean = false,
  /** H582: live steering-sensitivity slider from OPT
   *  (gameplaySettings.padSteerSens, range 0.5..2.0). Multiplies
   *  the heading-integration rate so the player's tuning takes
   *  effect on the legacy arcade path too. Default 1.0 = no scaling
   *  (matches pre-H582 behavior). */
  sensSlider: number = 1,
): void {
  // H667: per-car speed cap. Pre-H667 the cap was a hard MAX_SPEED=200
  // wpx/s = 148 km/h regardless of catalog topSpeed, so sports cars
  // (NSX ~204 km/h, Ferrari ~280 km/h) bottomed out at 148 km/h while
  // their gauge dial promised much higher — user reported "5th gear at
  // 160 km/h feels like 20 mph" partly because the cap was clipping
  // peak speed below the dial's read-out. The monolith uses the
  // catalog's per-car topSpeed: L24124-L24125 reads
  //   maxSpd = onRoad ? CAR().topSpeed
  //                   : (onGrass ? topSpeed*0.5 : topSpeed*0.35)
  // Falling back to MAX_SPEED when the caller didn't pass a per-car
  // topSpeed (pre-life start-flow, editor preview, traffic AI fallback).
  const carCap = isFinite(topSpeed) ? topSpeed : MAX_SPEED;
  const speedCap = onRoad ? carCap : carCap * OFF_ROAD_SPEED_MULT;
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
    // H248: fault-system acceleration multiplier. Aggregated from
    // life.faults via computeFaultEffects upstream; threaded here as
    // a flat scalar so this function stays decoupled from the fault
    // shape. 1 = no fault. ~0.55-0.95 in practice (trans_slip is the
    // worst single fault at 0.55). Slots into the torque chain so a
    // 0.85 spark_plugs misfire scales accel the same way reaching
    // 50% top-speed already scaled it (powerMult=0.75) — both are
    // engine-output reductions, mathematically identical.
    player.pSpeed = Math.min(
      speedCap,
      player.pSpeed + ACCEL * revLimMult * accelMult * torqueMult * gearMult * powerMult * dt,
    );
    player.pRevIntent = false;
  } else if (input.brake) {
    if (player.pSpeed > 0.5) {
      // H109: per-car brake force replaces the H6 flat BRAKE_DECEL.
      // 1:1 port of monolith L24066 (the forward-braking branch):
      //   pSpeed -= CAR().brakePower * brakeAmount * fxFault.brakeMult * dt
      // brakeAmount is the analog input (0..1) — arcade is digital so
      // we use 1. Real-world brake decel ranges ~7-10 m/s² (0.7-1g);
      // the formula maps power-to-weight pwr=hp/kg directly into this
      // band, so an economy car decels around 41 wpx/s² (~1.7s from
      // 70 wpx/s to 0) and a sports car around 48 — much less than
      // the old 240 wpx/s² fantasy brake.
      // H250: brakeMult plumbed in. rotor_warp (0.65) and
      // sport_brake_wear (0.70) are the only contributors; stacked
      // = 0.455 of normal stopping power (~2.2x stopping distance).
      player.pSpeed = Math.max(0, player.pSpeed - brakePower * brakeMult * dt);
      player.pRevIntent = false;
    } else if (player.pSpeed > 0.01) {
      player.pSpeed = 0;
      player.pRevIntent = false;
    } else {
      // H667: reverse cap is also per-car (monolith L24125
      // `Math.max(-CAR().topSpeed*0.15, ...)`). Fallback to the static
      // REVERSE_MAX (= MAX_SPEED*0.15) when topSpeed wasn't supplied.
      const revCap = isFinite(topSpeed) ? topSpeed * 0.15 : REVERSE_MAX;
      player.pSpeed = Math.max(-revCap, player.pSpeed - REVERSE_ACCEL * dt);
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
  // H252: fault-system steering pull. alignment (±0.25),
  // control_arm_rust (±0.12), control_arm_bush (±0.15), and
  // ball_joint (±0.10) bias yaw additively — each pre-multiplied
  // by a stable ±1 direction cached on the fault entry (so a
  // single alignment fault doesn't flicker pull direction every
  // frame, while two independent faults can pull opposite
  // directions and partly cancel). Aggregator delivers the signed
  // sum here.
  //
  // Bias is added to steerAxis BEFORE the turn-rate multiplication
  // so it shares the same speedRatio scaling — a parked car
  // doesn't pull (mirroring real-world steering geometry, and
  // matching monolith L25996 which gates the pull on pSpeed > 0).
  // Player can counter-steer by holding the opposite input;
  // worst stacked pull (0.62) needs ~62% input to drive straight,
  // not quite all-the-way-locked.
  let turnInput = input.steerAxis + steerPull;
  // H254: ps_leak fault — heavy steering at low speed (lost power
  // assist). 1:1 port of monolith L24769-24773's speed-scaled curve:
  // at standstill, steering effort is heaviest (0.40× rate); ramps
  // back to normal by ~60 wpx/s (~25 mph). Above that, rolling
  // tires + caster self-align mean PS doesn't matter — fault has
  // no effect. Multiplicative scalar on turnInput keeps the same
  // shape as the gripMult / speedRatio chain below.
  if (steerSlow) {
    const lo = Math.max(0, 1 - Math.abs(player.pSpeed) / 60);
    turnInput *= 1 - 0.60 * lo;
  }
  // H249: fault-system grip multiplier. tire_wear (0.78),
  // air_susp_leak (0.75), strut_bushings (0.82), control_arm_bush
  // (0.88) and friends scale turn authority down. 1 = no fault.
  // Slots into the turn-rate formula as a flat scalar — same
  // shape monolith L26181's `pAngVel *= fxFault.gripMult` uses for
  // the bicycle-model port. Arcade tier reads it on the heading
  // integration directly since there's no separate angular-velocity
  // state. Stacks multiplicatively with the gripMult-bearing entries
  // (computeFaultEffects already aggregated the product upstream).
  player.pAngle += turnInput * sensSlider * MAX_TURN_RATE * speedRatio * gripMult * dt;

  // Integrate position along heading + burn fuel proportional to
  // distance traveled (NOT time — coasting at 50 u/s burns less than
  // foot-down at 200 u/s, matching real-world expectation). Negative
  // pSpeed moves opposite heading; fuel still burns (engine runs).
  const distanceMoved = player.pSpeed * dt;
  player.px += Math.cos(player.pAngle) * distanceMoved;
  player.py += Math.sin(player.pAngle) * distanceMoved;
  const distAbs = Math.abs(distanceMoved);
  if (distAbs > 0 && !outOfFuel) {
    // H251: fault-system fuel multiplier. Six faults push burn rate
    // up: o2_sensor (1.30 — runs rich, worst single offender),
    // intake_manifold + spark_plugs (1.15), trans_slip (1.20),
    // valve_cover_gasket + carbon_buildup (1.10). Stacked worst case
    // is ~2.1x normal burn — a clean-engine 150-second tank empties
    // in ~70 seconds. Slots multiplicatively in the same shape as
    // accel/grip/brake.
    player.fuel = Math.max(0, player.fuel - distAbs * FUEL_BURN_PER_UNIT * fuelMult);
  }
}
