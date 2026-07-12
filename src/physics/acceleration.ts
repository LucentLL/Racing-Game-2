/**
 * Realistic-tier acceleration computation. Fires inside update() when
 * the player holds gas with no brake. Composes ELEVEN per-tick
 * multipliers into a single accel value:
 *
 *     accel = cc.power
 *           * powerMult       (quadratic falloff with speed)
 *           * torqueMult      (RPM-indexed torque curve)
 *           * shiftMult       (0 mid-shift, 1 otherwise)
 *           * revLimMult      (0.05 at redline·0.98+, 1 otherwise)
 *           * gearMult        (ratio-spread amplification)
 *           * turboMult       (1 - turboLag · (1 - spool))
 *           * inertiaEffect   (per-car drivetrain mass factor)
 *           * traction        (LSD bonus, 0.6× on grass)
 *           * dfGrip          (downforce grip, quadratic in speed)
 *           * grassPenalty    (off-road power reduction)
 *           * gasAmount       (analog gas pedal 0..1)
 *           * trailerMassFactor (hitched-trailer drag)
 *           * fxFault.accelMult (engine fault effects)
 *
 *     pSpeed += accel * dt
 *
 * Pulled out as a standalone module so the per-multiplier formulas
 * can be unit-tested in isolation, and so the eventual update() port
 * has a clean call site instead of inlining 75 lines of arithmetic.
 *
 * Monolith source: inside update() at L23988-L24062 (the
 * `if(gas && !brake)` branch — the dominant per-tick code path
 * during normal driving).
 */

import { getTorqueAtRPM } from './torqueCurve';

/** Subset of CAR() the acceleration block reads. The acceleration
 *  pipeline pulls more fields than any other update() sub-block —
 *  every drivetrain / aero / chassis property matters for "how
 *  hard does the car accelerate this tick". */
export interface AccelerationCar {
  /** RPM samples for the GT4 torque curve. Indexed by `norms` of
   *  the same length. Consumed by getTorqueAtRPM when
   *  `useGT4TC === true`. */
  rpms: readonly number[];
  /** Normalized torque (0..1) at the matching `rpms[i]`. Linear
   *  interpolation between adjacent points. */
  norms: readonly number[];
  /** Base power (game units per second²). The bulk of the per-car
   *  difference in acceleration sits in this multiplier. */
  power: number;
  /** Top speed (game units) — used by powerMult, downforce grip,
   *  and the grass-penalty roll-off. */
  topSpeed: number;
  /** When true, use the GT4 RPM-indexed torque-curve lookup via
   *  getTorqueAtRPM. False → fall through to the legacy
   *  fraction-based interpolation against `torqueCurve` /
   *  `idleRPM` / `redline`. Bikes + specials predate the GT4
   *  table and stay on the legacy path. */
  useGT4TC: boolean;
  /** Legacy torque curve as a per-fraction array. Indexed by
   *  `(rpm - idleRPM) / (redline - idleRPM)` clamped to [0, 1].
   *  Linear interpolation between adjacent entries.
   *
   *  Unused when `useGT4TC === true`. */
  torqueCurve: number[];
  idleRPM: number;
  redline: number;
  /** Per-car gear count. The gear-mult formula reads gearSpeeds
   *  to recover the real ratio spread when available. */
  gears: number;
  /** Per-gear top speeds (game units). When populated, the
   *  ratio-spread formula at L24015-L24017 drives gearMult; when
   *  empty / missing, the fallback at L24019 fires. */
  gearSpeeds: number[];
  /** Turbo lag (seconds). 0 → naturally-aspirated / supercharged
   *  (no spool delay); larger values mean longer to reach full
   *  boost. */
  turboLag: number;
  /** GT4 drivetrain mass effect (per-car constant). Slows initial
   *  acceleration on heavy-drivetrain cars; gives the "muscle
   *  car off the line" vs "lightweight rocket" feel. */
  inertiaMult: number;
  /** LSD (limited-slip differential) effectiveness. 1.0 = perfect
   *  power transfer; below = wheelspin losses. Cut to 60% on
   *  grass regardless of LSD. */
  tractionMult: number;
  /** Total downforce coefficient — combined front + rear aero
   *  trim. Quadratic-in-speed grip bonus; tuned so cars with
   *  active aero feel planted at speed. */
  dfTotal: number;
  /** Curb weight (kg). Used by the trailer-mass-factor formula
   *  when LIFE.trailer is set. Defaults to 8000kg (semi tractor)
   *  when absent — bikes / cars carry their real curb weight in
   *  the GT4 catalog. */
  mass?: number;
}

/** Fault effects relevant to acceleration. Other update() blocks
 *  read different fxFault fields (brakeMult, steerMult, etc.). */
export interface AccelerationFaultEffects {
  /** Engine fault multiplier — full power = 1.0, full disability
   *  (seized engine) approaches 0. Read once per frame upstream
   *  by computeFaultEffects(). */
  accelMult: number;
}

/** LIFE state shape the trailer-mass-factor branch reads. Caller
 *  passes the live trailer record when hitched, null/undefined
 *  when bobtail. */
export interface TrailerState {
  /** Load weight fraction 0..1 — 0 = empty trailer, 1 = full
 *  (governor-load). The 0.6 default reflects "typical highway
 *  load" matching the GT4 trailer-tuning telemetry. */
  loadWeight?: number;
}

/** Drive state — caller's live tick context. The `turboBoost`
 *  field is mutated by the spool branch and returned in the
 *  result so callers don't have to track it separately. */
export interface AccelerationTickState {
  pSpeed: number;
  pRPM: number;
  pGear: number;
  turboBoost: number;
  /** Mid-shift timer (seconds). When > 0, shiftMult = 0 (no
   *  power applied — drivetrain disengaged). */
  gearShiftTimer: number;
  onGrass: boolean;
  /** Analog gas pedal 0..1. Keyboard players see binary 1.0
   *  when held; gamepad triggers / mobile pedal give continuous
   *  values. */
  gasAmount: number;
}

/** Result of one acceleration tick. */
export interface AccelerationTickResult {
  pSpeed: number;
  turboBoost: number;
  /** Decomposed multipliers — exposed so callers (debug HUD, unit
   *  tests) can inspect which factor dominated. */
  diagnostics: {
    powerMult: number;
    torqueMult: number;
    shiftMult: number;
    revLimMult: number;
    gearMult: number;
    turboMult: number;
    traction: number;
    dfGrip: number;
    grassPenalty: number;
    trailerMassFactor: number;
    accel: number;
  };
}

/** Empty trailer load weight default — matches monolith L24053. */
const TRAILER_DEFAULT_LOAD = 0.6;
/** Empty trailer frame mass (kg). */
const TRAILER_FRAME_KG = 4500;
/** Trailer additional cargo mass at full load (kg). At 1.0 load
 *  → 4500 + 16000 = 20500 kg total. */
const TRAILER_FULL_CARGO_KG = 16000;
/** Tractor default mass when CAR().mass is missing (kg). */
const TRACTOR_DEFAULT_MASS_KG = 8000;
/** Trailer mass-penalty scale. 0.25 means a fully-loaded trailer
 *  drops accel to ~25% of its no-trailer value at maximum massRatio;
 *  matches monolith L24057 "0.84 full → 0.92 empty". */
const TRAILER_MASS_PENALTY_SCALE = 0.25;

/** H1131: hitched-trailer acceleration factor — the trailer's share
 *  of the combined rig mass eats into thrust. 1:1 with monolith
 *  L24053-L24057 (and identical to the inline block in
 *  [[computeAcceleration]] below, which now calls this). Exported so
 *  the LIVE arcade path (gameLoop → advancePSpeed) can finally apply
 *  it — this formula previously ran only inside computeAcceleration,
 *  which nothing on the live path calls.
 *
 *  Full load (1.0) at the default 8 t tractor → ×0.82; the H897 box
 *  trailer's lightest roll (0.3) → ×0.87. */
export function computeTrailerMassFactor(
  trailerLoadWeight: number | undefined,
  tractorKg?: number,
): number {
  const lw = trailerLoadWeight ?? TRAILER_DEFAULT_LOAD;
  const trailerKg = TRAILER_FRAME_KG + lw * TRAILER_FULL_CARGO_KG;
  const tKg = tractorKg ?? TRACTOR_DEFAULT_MASS_KG;
  const massRatio = trailerKg / (tKg + trailerKg);
  return 1 - massRatio * TRAILER_MASS_PENALTY_SCALE;
}

/** Rev-limiter threshold — at and above this fraction of redline,
 *  power drops to 5%. Matches monolith L24011's `pRPM >= cc.redline
 *  * 0.98`. */
const REV_LIMIT_FRACTION = 0.98;
/** Power left at the rev limiter. Matches monolith L24011's `0.05`
 *  (5% of nominal output). The non-zero residual prevents the car
 *  from "falling off a cliff" the instant it hits the limit. */
const REV_LIMIT_OUTPUT = 0.05;

/** Gear-mult scale factor — how much the ratio-spread amplifies
 *  per-gear torque. 0.1 keeps passenger cars roughly unchanged
 *  while letting deep-gearing trucks/semis benefit. Matches
 *  monolith L24017. */
const GEAR_MULT_SCALE = 0.1;

/** Turbo spool-up rate (game units per second, scaled by RPM
 *  fraction). Matches monolith L24025's `3.0 * (1 + pRPM/redline)`. */
const TURBO_SPOOL_RATE = 3.0;

/** Grass-traction penalty multiplier. Grass cuts LSD effectiveness
 *  to 60%. Matches monolith L24039. */
const GRASS_TRACTION_FACTOR = 0.6;

/** Compute one realistic-acceleration tick. Returns the new pSpeed
 *  and turboBoost values plus a diagnostics object exposing all
 *  intermediate multipliers (zero overhead — JS engines elide unused
 *  fields).
 *
 *  Ported 1:1 from monolith L23988-L24062 (the
 *  `if(gas && !brake)` branch inside the gas/brake dispatch). */
export function tickRealisticAcceleration(
  car: AccelerationCar,
  state: AccelerationTickState,
  fxFault: AccelerationFaultEffects,
  trailer: TrailerState | null,
  dt: number,
): AccelerationTickResult {
  // Power curve — quadratic falloff with speed ratio. At top speed
  // (ratio = 1), powerMult = 0; at standstill, powerMult = 1.
  const speedRatio = Math.abs(state.pSpeed) / car.topSpeed;
  const powerMult = Math.max(0, 1 - speedRatio * speedRatio);

  // Torque curve.
  let torqueMult: number;
  if (car.useGT4TC) {
    torqueMult = getTorqueAtRPM(car.rpms, car.norms, state.pRPM);
  } else {
    const tc = car.torqueCurve;
    const rpmFrac = Math.max(
      0,
      Math.min(1, (state.pRPM - car.idleRPM) / (car.redline - car.idleRPM)),
    );
    const tcIdx = rpmFrac * (tc.length - 1);
    const tcLow = Math.floor(tcIdx);
    const tcHigh = Math.min(tc.length - 1, tcLow + 1);
    const tcLerp = tcIdx - tcLow;
    torqueMult = tc[tcLow] * (1 - tcLerp) + tc[tcHigh] * tcLerp;
  }

  const shiftMult = state.gearShiftTimer > 0 ? 0 : 1;
  const revLimMult = state.pRPM >= car.redline * REV_LIMIT_FRACTION ? REV_LIMIT_OUTPUT : 1;

  // Gear multiplier — ratio-spread amplification.
  let gearMult = 1.0;
  if (
    car.gears > 0 &&
    car.gearSpeeds &&
    car.gearSpeeds[car.gears] > 0 &&
    car.gearSpeeds[state.pGear] > 0
  ) {
    const ratioSpread = car.gearSpeeds[car.gears] / car.gearSpeeds[state.pGear];
    gearMult = 1.0 + (ratioSpread - 1) * GEAR_MULT_SCALE;
  } else if (car.gears > 0) {
    gearMult = 1.0 + 0.6 * (1 - state.pGear / car.gears);
  }

  // Turbo spool. NA / SC cars (turboLag === 0) snap to full boost.
  let nextTurbo = state.turboBoost;
  if (car.turboLag > 0) {
    const spoolRate = TURBO_SPOOL_RATE * (1 + state.pRPM / (car.redline || 7000));
    nextTurbo = Math.min(1, state.turboBoost + spoolRate * dt);
  } else {
    nextTurbo = 1;
  }
  const turboMult = 1.0 - car.turboLag * (1 - nextTurbo);

  // Drive inertia + LSD traction + downforce + grass penalty.
  const inertiaEffect = car.inertiaMult;
  const traction = car.tractionMult * (state.onGrass ? GRASS_TRACTION_FACTOR : 1.0);
  const absSpd = Math.abs(state.pSpeed);
  const speedFrac = absSpd / Math.max(1, car.topSpeed);
  const dfGrip = 1.0 + car.dfTotal * speedFrac * speedFrac;
  // Grass penalty: starts at ~55% at speed 0, ramps to ~45% above
  // 20 game-units. Lets the player creep onto grass to park (the
  // penalty isn't crippling at standstill) but punishes mid-speed
  // off-road cornering.
  const grassPenalty = state.onGrass
    ? Math.max(0.45, 0.25 + 0.3 * (1 - Math.min(1, absSpd / 20)))
    : 1;

  // Trailer mass factor (H1131: extracted to the exported helper so
  // the live arcade path shares the exact formula).
  const trailerMassFactor = trailer
    ? computeTrailerMassFactor(trailer.loadWeight, car.mass)
    : 1.0;

  const accel =
    car.power *
    powerMult *
    torqueMult *
    shiftMult *
    revLimMult *
    gearMult *
    turboMult *
    inertiaEffect *
    traction *
    dfGrip *
    grassPenalty *
    state.gasAmount *
    trailerMassFactor *
    fxFault.accelMult;

  return {
    pSpeed: state.pSpeed + accel * dt,
    turboBoost: nextTurbo,
    diagnostics: {
      powerMult,
      torqueMult,
      shiftMult,
      revLimMult,
      gearMult,
      turboMult,
      traction,
      dfGrip,
      grassPenalty,
      trailerMassFactor,
      accel,
    },
  };
}
