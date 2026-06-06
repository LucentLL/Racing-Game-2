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
 *
 * H670: split into two halves so the Phase 0B dispatcher can advance
 * scalar pSpeed (throttle/brake/coast/reverse + fuel) WITHOUT also
 * running arcade steering/position. The integrator owns heading and
 * position when eligible but doesn't integrate longitudinal force —
 * scalar throttle still flows through [[advancePSpeed]].
 */

import type { PlayerState } from '@/state/player';
import type { InputState } from '@/state/input';
import {
  computeEffectiveSteerInput,
  tickBikeLean,
  computeBikePAngVel,
  computeMassDamp,
} from '@/physics/steering';

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

/** Advance scalar pSpeed (throttle/brake/coast/reverse) and burn fuel
 *  proportional to |pSpeed| × dt. Used by both [[arcadeUpdate]] (legacy
 *  default path) and the Phase 0B dispatcher (H670: the integrator
 *  handles lateral + yaw + position but doesn't integrate longitudinal
 *  force into pSpeed, so scalar throttle still flows through here).
 *
 *  MUTATES player.pSpeed, player.pRevIntent, player.fuel.
 *
 *  Does NOT touch player.pAngle, player.px, player.py — caller is
 *  responsible for heading + position (either arcade fallback or
 *  Phase 0B integrator).
 *
 *  `redline=Infinity` (default) disables the H104 rev-limiter accel
 *  cut so callers without a catalog car (pre-life start-flow) skip
 *  the per-car branch entirely. */
export function advancePSpeed(
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
  brakeMult: number = 1,
  fuelMult: number = 1,
  /** H672: per-frame acceleration term (wpx/s²) precomputed by the
   *  caller using the monolith's F=m·a derivation —
   *    accelOverride = g_gu × drivetrainCoef × torqueNorm × gearRatioMult
   *  where drivetrainCoef encodes the per-drivetrain demand + the
   *  hp/kg power-to-weight boost. When supplied, REPLACES the
   *  ACCEL × torqueMult × gearMult chain in the gas branch so
   *  acceleration actually scales with HP / weight / drivetrain
   *  layout / current gear. When `undefined` (legacy path), the
   *  pre-H672 `ACCEL × torqueMult × gearMult` chain runs unchanged. */
  accelOverride?: number,
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
    // H672: when the caller pre-computed the F/m acceleration term
    // (Phase 0B path), use it instead of the ACCEL × torqueMult ×
    // gearMult arcade chain. The override already absorbs torqueNorm
    // and gearRatioMult, so this branch multiplies only the four
    // remaining scalars (revLimiter, fault accelMult, top-speed
    // falloff, dt). Legacy callers (no override) keep the H6 chain.
    const accelTerm = accelOverride !== undefined
      ? accelOverride
      : ACCEL * torqueMult * gearMult;
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
      player.pSpeed + accelTerm * revLimMult * accelMult * powerMult * dt,
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

  // Fuel burn proportional to distance covered at this speed
  // (NOT time — coasting at 50 u/s burns less than foot-down at
  // 200 u/s, matching real-world expectation). Negative pSpeed
  // burns the same (engine runs).
  // H670: moved from the position-integration block to here so the
  // Phase 0B path (which uses advancePSpeed without
  // advanceHeadingAndPosition) still consumes fuel at the right
  // rate. |pSpeed| * dt is the SAME quantity arcade's position
  // integration uses for distance, so behavior is unchanged for
  // the legacy path.
  // H251: fault-system fuel multiplier. Six faults push burn rate
  // up: o2_sensor (1.30 — runs rich, worst single offender),
  // intake_manifold + spark_plugs (1.15), trans_slip (1.20),
  // valve_cover_gasket + carbon_buildup (1.10). Stacked worst case
  // is ~2.1x normal burn — a clean-engine 150-second tank empties
  // in ~70 seconds.
  if (!outOfFuel) {
    const distAbs = Math.abs(player.pSpeed) * dt;
    if (distAbs > 0) {
      player.fuel = Math.max(0, player.fuel - distAbs * FUEL_BURN_PER_UNIT * fuelMult);
    }
  }
}

/** Advance heading (steering input → pAngle) and integrate position
 *  along the new heading. Used by [[arcadeUpdate]] for the legacy path
 *  AND by the Phase 0B dispatcher's defer-fallback (low speed) so a
 *  parked car can still steer and creep when the integrator bails.
 *
 *  MUTATES player.pAngle, player.px, player.py.
 *
 *  Reads player.pSpeed (must already be advanced by
 *  [[advancePSpeed]] this frame). Does NOT touch fuel — that's owned
 *  by advancePSpeed.
 *
 *  H582 sensSlider, H249 gripMult, H252 steerPull, H254 steerSlow
 *  thread through here verbatim from the legacy signature. */
export function advanceHeadingAndPosition(
  player: PlayerState,
  input: InputState,
  dt: number,
  gripMult: number = 1,
  steerPull: number = 0,
  steerSlow: boolean = false,
  /** H582: live steering-sensitivity slider from OPT
   *  (gameplaySettings.padSteerSens, range 0.5..2.0). Multiplies
   *  the heading-integration rate so the player's tuning takes
   *  effect on the legacy arcade path too. Default 1.0 = no scaling
   *  (matches pre-H582 behavior). */
  sensSlider: number = 1,
): void {
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

  // Integrate position along heading. Negative pSpeed moves opposite
  // heading. Fuel burn already happened in advancePSpeed.
  const distanceMoved = player.pSpeed * dt;
  player.px += Math.cos(player.pAngle) * distanceMoved;
  player.py += Math.sin(player.pAngle) * distanceMoved;
}

/** H727: bike-specific heading + position advance. Mirrors the monolith's
 *  MotoGP-style bike branch at L24686-L24789 verbatim: stick input drives
 *  a smoothed bikeLeanPos (speed-damped 4.0× target via [[tickBikeLean]]),
 *  current lean magnitude is normalized + raised to the 1.3 turn-exponent
 *  and scaled by per-bike turnRate × spdFactor × bikeHSF to produce the
 *  per-frame yaw rate ([[computeBikePAngVel]]). The arcade tier's car-only
 *  [[advanceHeadingAndPosition]] does `pAngle += steerInput × MAX_TURN_RATE
 *  × speedRatio × dt` instead — direct yaw with no lean smoothing — which
 *  is the "dreadful" feel the user flagged: bikes turn like cars instead
 *  of leaning into corners.
 *
 *  MUTATES player.pAngle, player.px, player.py, player.bikeLeanPos.
 *
 *  Reads player.pSpeed (must already be advanced by [[advancePSpeed]]
 *  this frame). Does NOT touch fuel — that's owned by advancePSpeed.
 *
 *  WHY SEPARATE FUNCTION (not a branch inside advanceHeadingAndPosition):
 *  the bike chain has its own per-frame state (bikeLeanPos) and bypasses
 *  the gripMult-multiplied direct-yaw formula entirely. Splitting reads
 *  cleaner than threading isBike + lean state through the car path.
 *
 *  Ported 1:1 from monolith L24681-L24712 + L24769-L24789 (steerInputEff
 *  with BIKE_STEER_SENS_BASE, the drift-branch lean decay at L24688, the
 *  grip-branch lean chain at L24702-L24712, the steerSlow fault scaling
 *  at L24769-L24773, and the reverse-yaw flip at L24789). */
export function advanceBikeHeadingAndPosition(
  player: PlayerState,
  input: InputState,
  dt: number,
  turnRate: number,
  topSpeed: number,
  sensSlider: number = 1,
  /** H728: per-bike mass (kg). Threaded through so the e-brake
   *  impulse and sustained kick can scale by [[computeMassDamp]]
   *  exactly like the monolith bike branch at L24400 / L24441.
   *  Default 250 (roughly a mid-weight motorcycle) keeps legacy
   *  callers that don't yet pass mass behaviorally close to a real
   *  bike. */
  mass: number = 250,
  /** H728: true when the rear-axle contact is on a grass tile. Boosts
   *  the e-brake press-edge impulse by 1.3× per monolith L24395 — wet
   *  grass μ is lower so the same handbrake pull rotates the bike more
   *  aggressively. */
  onGrass: boolean = false,
  /** H728: true when the rear-axle contact is on a dirt / canyon tile
   *  (tile 12 / 14 / 16). Boosts the e-brake impulse by 1.15× per
   *  monolith L24396 — looser than asphalt, less loose than grass. */
  onDirt: boolean = false,
): void {
  const absSpd = Math.abs(player.pSpeed);
  // speedRatio = absSpd / topSpeed, clamped to [0, 1]. Falls back to
  // MAX_SPEED when topSpeed is missing or zero (pre-life start-flow).
  const denom = topSpeed > 0 ? topSpeed : MAX_SPEED;
  const speedRatio = Math.min(1, absSpd / denom);
  // spdFactor = 0..1 speed ramp. Matches monolith L24640's
  // `spdFactor=Math.min(1,absSpd/10)` — bike steering authority
  // ramps in from zero at standstill to full at ~10 wpx/s.
  const spdFactor = Math.min(1, absSpd / 10);

  // steerInputEff = steerAxis × BIKE_STEER_SENS_BASE × sensSlider.
  // computeEffectiveSteerInput owns the bike-vs-car base-sens choice.
  // Note: the monolith bike branch deliberately skips the steerPull /
  // steerSlow / engine-stall fault scalings that the car branch applies
  // at L24769-L24786 — bikes go straight from leanChain to reverse-flip
  // (L24787 close brace; L24789 flip). We mirror that omission to keep
  // the bike feel identical to the monolith.
  const steerInputEff = computeEffectiveSteerInput(
    input.steerAxis, true, sensSlider,
  );

  // === H728: BIKE E-BRAKE BLOCK ===
  // 1:1 port of monolith L24334 + L24379-L24455 (bike branch only).
  //
  // Three pieces, mirroring the legacy-drift handbrake model the
  // monolith uses for bikes (cars-with-Phase-0B-off route through
  // the same block, but here we only handle the bike side):
  //
  //   (a) Always-on cooldown / timer decay. bikeEbrakeCooldown ticks
  //       at 1.0/s so the press-edge re-arm window closes; bikeEbrake
  //       Timer also drains so the drift state expires after release.
  //
  //   (b) Press-edge yaw impulse. On the ebrk rising edge with absSpd
  //       > 8 wpx/s, cooldown expired, and |steerAxis| > 0.15, snap
  //       pAngle by the monolith bike formula
  //         impulseRad = 0.25 × massDamp × |steer|
  //                    × (0.3 + 0.7 × speedRatio) × surfaceKickBoost
  //       — full stick at top speed ≈ 17°, half stick at half speed
  //       ≈ 6°, no steer → no rotation. This is THE missing piece
  //       the user reported ("e-brake doesn't trigger a slide"):
  //       without an impulse on the press edge, the grip-branch
  //       lean chain just keeps doing its normal thing, and the
  //       audio-heuristic drifting flag at gameLoop L4230 doesn't
  //       actually feed any physics — only the audio. The arcade
  //       bike path integrates position from pAngle (no separate
  //       pVelAngle), so the impulse goes on pAngle directly; the
  //       drift-branch lean-decay + elevated driftSteer at L420-426
  //       handle sustained rotation once drifting=true.
  //
  //   (c) Sustained refresh + bleed. While held + absSpd > 8: refresh
  //       bikeEbrakeTimer to 0.6s and bleed pSpeed *= 0.998 per frame
  //       (monolith L24381). If gas + |steer| > 0.15 also held, apply
  //       the monolith continuous kick
  //         sustRate = 0.5 × massDamp × |steer|
  //                  × (0.4 + 0.6 × speedRatio)
  //       to pAngle each frame so throttle commits the slide.
  //
  // Runs BEFORE the lean / drift branches below so the snap takes
  // effect this frame. bikeEbrakePrev is updated at the tail.
  if (player.bikeEbrakeCooldown > 0) {
    player.bikeEbrakeCooldown = Math.max(0, player.bikeEbrakeCooldown - dt);
  }
  if (player.bikeEbrakeTimer > 0) {
    player.bikeEbrakeTimer = Math.max(0, player.bikeEbrakeTimer - dt);
  }
  // H729: lazy-init the velocity-direction tracker on first eligible
  // frame (or after a car-switch reset). Without this seed, the very
  // first physics frame would compute alignment against bikeVelAngle=0
  // and snap the bike to face east. switchCar.ts clears the flag
  // whenever the player swaps vehicles so re-entering the bike path
  // re-syncs from the current pAngle.
  if (!player.bikeVelAngleInit) {
    player.bikeVelAngle = player.pAngle;
    player.bikeVelAngleInit = true;
  }

  if (input.ebrk && absSpd > 8) {
    const _ebrakeEdge = !player.bikeEbrakePrev;
    if (_ebrakeEdge
        && player.bikeEbrakeCooldown <= 0
        && Math.abs(input.steerAxis) > 0.15) {
      const _kickDir = Math.sign(input.steerAxis);
      const _massDamp = computeMassDamp(mass, null);
      let _surfaceKickBoost = 1.0;
      if (onGrass) _surfaceKickBoost = 1.3;
      else if (onDirt) _surfaceKickBoost = 1.15;
      const _impulseRad = 0.25 * _massDamp
        * Math.abs(input.steerAxis)
        * (0.3 + speedRatio * 0.7)
        * _surfaceKickBoost;
      // H729: the impulse goes on bikeVelAngle (velocity direction),
      // NOT pAngle. 1:1 with monolith L24401 `pVelAngle -= kickDir ×
      // impulseRad`. Rotating the motion vector opposite to the steer
      // direction grows the slip angle (pAngle - bikeVelAngle) so the
      // chassis ends up pointing harder into the turn than the bike
      // is moving — the visible powerslide. Position integration
      // below uses bikeVelAngle so this immediately translates the
      // bike sideways relative to its heading.
      player.bikeVelAngle -= _kickDir * _impulseRad;
      player.drifting = true;
      player.bikeEbrakeCooldown = 0.15;
    }
    // Sustained refresh + speed bleed (monolith L24429 + L24381).
    player.bikeEbrakeTimer = 0.6;
    player.pSpeed *= 0.998;
    // Throttle + steer commitment kick on bikeVelAngle (monolith
    // L24439-L24442). Same impulse axis as the press-edge branch —
    // continued gas + steer drives the slip wider.
    if (input.gas && Math.abs(input.steerAxis) > 0.15) {
      const _kickDir2 = Math.sign(input.steerAxis);
      const _massDamp2 = computeMassDamp(mass, null);
      const _sustRate = 0.5 * _massDamp2
        * Math.abs(input.steerAxis)
        * (0.4 + speedRatio * 0.6);
      player.bikeVelAngle -= _kickDir2 * _sustRate * dt;
    }
  }
  player.bikeEbrakePrev = input.ebrk;

  let pAngVel: number;
  if (player.drifting) {
    // Drift branch — monolith L24687-L24694. Bikes get an extra
    // `bikeLeanPos *= 0.9` per-frame decay (L24688) because real
    // bikes sit upright during a slide. The drift formula itself
    // is identical to the car path; arcade tier doesn't track mass
    // so massDamp = 1.
    player.bikeLeanPos *= 0.9;
    const driftSpeedPenalty = 1 / (1 + speedRatio * 1.5);
    const driftSteer = steerInputEff * 2.2 * spdFactor * driftSpeedPenalty;
    const slipForce = Math.sin(player.slipAngle) * (1.2 + speedRatio * 1.2);
    pAngVel = driftSteer + slipForce;
  } else {
    // Grip branch — MotoGP lean chain at monolith L24702-L24712.
    // tickBikeLean handles the speed-damped target + 3.5/s smoothing;
    // computeBikePAngVel handles the lean-norm^1.3 × turnRate × spdFactor
    // × bikeHSF tail.
    player.bikeLeanPos = tickBikeLean(
      player.bikeLeanPos, steerInputEff, speedRatio, dt,
    );
    pAngVel = computeBikePAngVel(
      player.bikeLeanPos, turnRate, spdFactor, speedRatio,
    );
  }

  // Reverse-yaw flip at the tail — monolith L24789. A bike rolling
  // backward with steering input rotates the chassis the opposite
  // way around.
  if (player.pSpeed < 0) pAngVel = -pAngVel;

  // Integrate heading from yaw rate.
  player.pAngle += pAngVel * dt;

  // === H729: VELOCITY-DIRECTION ALIGNMENT (monolith L25068-L25103) ===
  // Pull bikeVelAngle toward the just-updated pAngle. Two rates:
  //
  //   GRIP / NORMAL: 14/s — bikes track heading tightly (monolith
  //     L25072: "Bikes: very high grip, tires track heading tightly").
  //     At dt=1/60s this is 14/60 ≈ 0.23 per frame, so a typical
  //     small slip from the lean chain re-aligns in ~4-5 frames.
  //
  //   E-BRAKE ACTIVE (bikeEbrakeTimer > 0): 14 × 0.30 = 4.2/s —
  //     collapses grip to 30 % (monolith L25085: "e-brake timer
  //     collapses grip even when not yet in drift state"). At 4.2/s
  //     the post-impulse divergence between heading and velocity
  //     persists for ~0.5 s — that's the slide window.
  //
  // Shortest-arc wrap handles the ±π discontinuity so a 180° spin
  // doesn't unwind the long way around. Skipped at near-zero speed
  // because the velocity direction is undefined.
  if (absSpd > 1) {
    let diff = player.pAngle - player.bikeVelAngle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    let gripAlign = 14;
    if (player.bikeEbrakeTimer > 0) gripAlign *= 0.30;
    player.bikeVelAngle += diff * gripAlign * dt;
  } else {
    // Below 1 wpx/s the velocity has no meaningful direction —
    // snap to heading so the next acceleration starts coherent.
    player.bikeVelAngle = player.pAngle;
  }

  // === Position integration FROM bikeVelAngle, not pAngle ===
  // 1:1 with monolith L26301-L26303: `const moveAngle=pVelAngle;
  // nx=px+cos(moveAngle)*pSpeed*dt`. This is what makes the slide
  // visible — during the e-brake impulse window, heading and motion
  // direction diverge, so the bike translates sideways relative to
  // its chassis. Without this divergence (the pre-H729 `px += cos
  // (pAngle) × pSpeed × dt` path), every heading rotation
  // instantly redirected motion and no slide was possible.
  const distanceMoved = player.pSpeed * dt;
  player.px += Math.cos(player.bikeVelAngle) * distanceMoved;
  player.py += Math.sin(player.bikeVelAngle) * distanceMoved;
}

/** Per-frame physics step. `onRoad=true` means the player center is on
 *  a TILE_ROAD cell; passing `undefined` (legacy callers) preserves the
 *  pre-H9 on-road behavior so this keeps a single signature.
 *  `redline=Infinity` (default) disables the H104 rev-limiter accel
 *  cut so callers without a catalog car (pre-life start-flow) skip
 *  the per-car branch entirely.
 *
 *  H670: now a thin wrapper over [[advancePSpeed]] +
 *  [[advanceHeadingAndPosition]]. Phase 0B dispatcher calls the two
 *  halves directly; legacy callers (non-Phase-0B path, traffic AI,
 *  editor preview) keep the single-call ergonomics. */
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
  sensSlider: number = 1,
  /** H705: GT4-derived per-car acceleration term (wpx/s²). When
   *  supplied, REPLACES the constant ACCEL=120 chain in the gas
   *  branch so the arcade-tier path also benefits from real
   *  hp/kg/drivetrain scaling. Without this, when Phase 0B
   *  isn't active (slider off, eligibility fails, drift, low
   *  speed) every car accelerated identically — a 64 HP Honda
   *  Beat hit its catalog 137 km/h cap as fast as a 500+ HP
   *  Ferrari hit 300 km/h. Same accelOverride parameter
   *  [[advancePSpeed]] already accepts; this just threads it
   *  through the legacy entry point. */
  accelOverride?: number,
): void {
  advancePSpeed(
    player, input, dt, onRoad, redline, torqueMult, gearMult, topSpeed,
    engineBrake, rollingFriction, aeroFactor, brakePower,
    accelMult, brakeMult, fuelMult, accelOverride,
  );
  advanceHeadingAndPosition(
    player, input, dt, gripMult, steerPull, steerSlow, sensSlider,
  );
}
