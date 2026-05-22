/**
 * Phase 3 dynamic longitudinal weight transfer (v8.58).
 *
 * Real suspension doesn't transfer load instantly — the chassis
 * pitches forward under braking, squats under throttle, and the
 * load shift takes a fraction of a second to play out. This
 * module models that as a first-order low-pass on a target load-
 * transfer value derived from the longitudinal acceleration:
 *
 *   transferTarget = -mass × a_long × h_cg / wheelbase
 *   pFzTransfer   += (target - pFzTransfer) × (dt / tau)
 *   Fz_F          += pFzTransfer
 *   Fz_R          -= pFzTransfer
 *
 * Where:
 *   +a_long (throttle)  → weight comes OFF front → transfer
 *                          negative → rear loads up
 *   -a_long (braking)   → weight goes ONTO front → transfer
 *                          positive → front loads up
 *
 * The time constant tau is derived from the car's GT4 suspension
 * spring-rate data (susp[2-3] gives the cleanest road-vs-race
 * spread). Stiffer springs → faster transfer → less pitch.
 *
 * Console-flippable via gameplaySettings.suspension. When
 * disabled, static loads are used unchanged.
 *
 * Monolith source: inside update() at L25199-L25249.
 */

import { GRAVITY_GU } from './chassisFrame';

/** Default suspension time constant when GT4 spec lacks susp
 *  data. 0.18 s — a mid-range road-car value that produces
 *  visible but not exaggerated pitch under braking/throttle.
 *  Used when the spring-rate proxy can't be computed.
 *
 *  Matches monolith `let tau = 0.18` at L25232. */
export const SUSPENSION_TAU_DEFAULT = 0.18;

/** Stiffest-suspension lower bound on tau, in seconds. A full-
 *  race car (susp[2-3] ≈ 20) would compute below this; the floor
 *  caps it at 0.06 s so the load transfer doesn't become
 *  arbitrarily fast and create integrator instability.
 *
 *  Matches monolith `Math.max(0.06, ...)` at L25235. */
export const SUSPENSION_TAU_MIN = 0.06;

/** Softest-suspension upper bound on tau, in seconds. Caps soft
 *  road cars at 0.25 s so even a luxury sedan with very soft
 *  springs has a load transfer that fully plays out in under a
 *  second.
 *
 *  Matches monolith `Math.min(0.25, ...)` at L25235. */
export const SUSPENSION_TAU_MAX = 0.25;

/** Tau intercept — the tau value at spring-rate proxy = 0. The
 *  linear formula is `tau = 0.22 - springProxy * 0.008`, which
 *  at proxy=0 yields 0.22 (just above the default). The floor
 *  and ceiling above clamp the actual return into the [0.06,
 *  0.25] range.
 *
 *  Matches monolith `0.22` at L25235. */
export const SUSPENSION_TAU_INTERCEPT = 0.22;

/** Tau slope per unit of spring-rate proxy. Linear formula:
 *  `tau = 0.22 - springProxy × 0.008`. Stiffer springs (higher
 *  proxy) reduce tau (faster transfer); softer springs (lower
 *  proxy) increase tau (slower transfer).
 *
 *  WHY 0.008: empirically tuned so a typical road car (proxy
 *  ≈ 2-4) yields tau ≈ 0.20-0.19 s, while a full-race car
 *  (proxy ≈ 20) yields tau ≈ 0.06 s (the floor). The slope
 *  covers the full spread of cars in the GT4 fleet.
 *
 *  Matches monolith `0.008` at L25235. */
export const SUSPENSION_TAU_SLOPE = 0.008;

/** Compute the suspension time constant (tau) from the GT4 spec's
 *  spring-rate data. Stiffer springs produce faster load transfer
 *  (smaller tau); softer springs produce slower transfer (larger
 *  tau). Used as the time-constant of a first-order low-pass on
 *  the target load shift.
 *
 *  FORMULA (1:1 with monolith):
 *    if susp[2-3] data missing: tau = 0.18  [default]
 *    else:
 *      springProxy = (susp[2] + susp[3]) / 2
 *      tau = clamp(0.22 - springProxy × 0.008, 0.06, 0.25)
 *
 *  WHY susp[2-3]: per the GT4 spec docstring, susp[] is a 16-
 *  entry array where [2] and [3] are the "compression spring
 *  maximum" values for front and rear. They give the cleanest
 *  road-vs-race spread (~2-4 for road cars, ~20 for race cars),
 *  making them the best proxy for "how stiff is the suspension
 *  overall." Other susp[] entries are dampers, ride heights,
 *  etc. — less directly tied to load-transfer speed.
 *
 *  REQUIRES `susp.length >= 4` to access indices 2 and 3.
 *  Missing or short susp arrays fall back to the default tau.
 *
 *  INPUTS:
 *    gt4Susp     cc.gt4.susp from the GT4 spec; undefined or
 *                short arrays trigger the fallback.
 *
 *  Returns tau in seconds, clamped to [0.06, 0.25].
 *
 *  Ported 1:1 from monolith L25232-L25236 (the tau-from-spring-
 *  rate proxy block in the Phase 3 weight-transfer code). */
export function computeSuspensionTau(
  gt4Susp: readonly number[] | undefined,
): number {
  if (!gt4Susp || gt4Susp.length < 4) return SUSPENSION_TAU_DEFAULT;
  const springProxy = (gt4Susp[2] + gt4Susp[3]) * 0.5;
  const raw = SUSPENSION_TAU_INTERCEPT - springProxy * SUSPENSION_TAU_SLOPE;
  if (raw < SUSPENSION_TAU_MIN) return SUSPENSION_TAU_MIN;
  if (raw > SUSPENSION_TAU_MAX) return SUSPENSION_TAU_MAX;
  return raw;
}

/** Minimum dt clamp (seconds) used when computing the numerical
 *  derivative of pSpeed to get longitudinal acceleration. A dt
 *  exactly 0 would divide by zero; values near 0 would amplify
 *  any pSpeed noise into enormous "acceleration" spikes. 0.001 s
 *  (1 ms) is well below any sane frame time so it never engages
 *  on normal frames — it's a divide-by-zero defense, not a real
 *  cap.
 *
 *  Matches monolith `Math.max(0.001, dt)` at L25225. */
export const LONG_ACCEL_DT_FLOOR = 0.001;

/** Maximum |longitudinal acceleration| in game-unit space.
 *  Collision impulses and one-frame teleports can produce
 *  pSpeed jumps that, divided by dt, yield enormous numerical
 *  accelerations — values way beyond any realistic engine or
 *  brake output. Clamping to ±200 gu/s² ≈ ±41 m/s² (~4.2 g)
 *  preserves the realistic peak (typical hard braking is ~1 g,
 *  exceptional sports car braking ~1.5 g, real collision peaks
 *  can be 3-5 g) while killing instability spikes from
 *  collision physics or save-load edge cases.
 *
 *  Matches monolith `Math.max(-200, Math.min(200, ...))` at
 *  L25226. */
export const LONG_ACCEL_CLAMP_MAGNITUDE = 200;

/** Compute the numerical longitudinal acceleration from frame-
 *  over-frame pSpeed values. Includes the collision-spike clamp
 *  that protects the weight-transfer formula from one-frame
 *  pSpeed jumps.
 *
 *  FORMULA (1:1 with monolith):
 *    rawLongAccel = (pSpeed - pPrevSpeed) / max(0.001, dt)
 *    longAccel    = clamp(rawLongAccel, ±200)
 *
 *  WHY NUMERICAL DERIVATIVE (vs reading an acceleration field
 *  directly): the upstream acceleration block produces pSpeed
 *  through a complex pipeline (engine torque, drag, brake force,
 *  collision impulses) that doesn't expose a single "current
 *  acceleration" value. Numerical differentiation of pSpeed is
 *  the simplest way to recover it for the weight-transfer model
 *  without entangling the two pipelines.
 *
 *  WHY 200 gu/s² ≈ 4.2 g CLAMP: preserves real-world braking
 *  peaks (1-1.5 g hard, 3-5 g collision-instant) while killing
 *  the impulse-divided-by-dt spikes that come from collision
 *  physics and one-frame teleports. Without the clamp, a
 *  collision producing a 50-gu/frame speed jump at 60 fps would
 *  feed +3000 gu/s² into the weight-transfer formula and snap
 *  the load distribution to its max-transfer limit for one
 *  frame.
 *
 *  WHY 0.001 dt FLOOR: divide-by-zero defense. Real dt values
 *  are 1/60 ≈ 0.017 s and never go below ~0.005 s even on fast
 *  monitors, so the floor never engages on normal frames.
 *
 *  INPUTS:
 *    pSpeed       current frame's longitudinal speed (signed,
 *                 game units / sec)
 *    pPrevSpeed   previous frame's pSpeed (caller stores after
 *                 the update for next-frame use)
 *    dt           frame timestep, seconds
 *
 *  Returns the clamped a_long in gu/s². Caller passes this to
 *  [[computeWeightTransferTarget]] (next hop) to get the
 *  steady-state load shift.
 *
 *  Ported 1:1 from monolith L25225-L25226 (the numerical-accel
 *  + clamp lines in the Phase 3 weight-transfer block). */
export function computeLongitudinalAccel(
  pSpeed: number,
  pPrevSpeed: number,
  dt: number,
): number {
  const rawLongAccel = (pSpeed - pPrevSpeed) / Math.max(LONG_ACCEL_DT_FLOOR, dt);
  if (rawLongAccel > LONG_ACCEL_CLAMP_MAGNITUDE) return LONG_ACCEL_CLAMP_MAGNITUDE;
  if (rawLongAccel < -LONG_ACCEL_CLAMP_MAGNITUDE) return -LONG_ACCEL_CLAMP_MAGNITUDE;
  return rawLongAccel;
}

/** CG height above ground, in game units. ~0.45 m / 0.2056 m/gu
 *  ≈ 2.19 gu. This is the moment arm for longitudinal weight
 *  transfer: a higher CG produces more load shift under
 *  acceleration (think SUV pitch under braking vs. sports-car
 *  pitch).
 *
 *  CONSTANT (NOT PER-CAR): the monolith uses a single CG height
 *  across all cars rather than deriving it per-vehicle. Real
 *  sports cars sit ~0.40-0.50 m CG; SUVs ~0.70-0.80 m; F1 cars
 *  ~0.25 m. 0.45 m is a "typical road car" choice that produces
 *  the right feel for the GT4 fleet's center of mass.
 *
 *  Per-car CG height could be added in a future phase (the GT4
 *  spec doesn't currently carry it), at which point this would
 *  become a fallback default.
 *
 *  Matches monolith `h_cg_gu = 2.19` at L25227. */
export const CG_HEIGHT_GU = 2.19;

/** Maximum weight-transfer magnitude as a FRACTION of the
 *  lighter axle's static load. 0.80 means the lighter axle can
 *  lose at most 80 % of its static weight to transfer — the
 *  remaining 20 % stays put (and gets a further floor in
 *  [[applySuspensionFloors]] which keeps Fz at ≥ 10 % of static).
 *
 *  WHY CAP HERE TOO: under extreme braking or collision spikes
 *  the transferTarget formula `-m × a × h / L` can exceed the
 *  lighter axle's entire static weight, producing a target that
 *  would put one axle in the air. The 80 % cap is a sanity
 *  bound on the *target* of the low-pass relaxation; the
 *  separate Fz floor at 10 % is a final safety net on the
 *  applied loads.
 *
 *  Matches monolith `*0.80` at L25229. */
export const MAX_TRANSFER_FRACTION = 0.80;

/** Compute the steady-state target weight transfer (ΔFz_front)
 *  from the chassis's current longitudinal acceleration. This is
 *  the value the low-pass filter relaxes toward each frame.
 *
 *  FORMULA (1:1 with monolith):
 *    transferTarget = -mass × a_long × h_cg / wheelbase
 *    maxTransfer    = mass × g × min(wdF, 1-wdF) × 0.80
 *    return clamp(transferTarget, ±maxTransfer)
 *
 *  SIGN CONVENTION:
 *    +ΔFz (positive return)  → weight goes TO front (braking,
 *                               a_long < 0)
 *    -ΔFz (negative return)  → weight comes OFF front (throttle,
 *                               a_long > 0)
 *
 *  The negative sign in front of `mass × a_long × h_cg / Lwb`
 *  is what flips the convention: positive longitudinal accel
 *  (throttle) produces negative transferTarget (weight goes
 *  rear), which matches the physical intuition.
 *
 *  PHYSICS DERIVATION: under longitudinal acceleration a, the
 *  inertial force m × a acts at the CG. That force, applied at
 *  height h above the ground, produces a moment around the rear
 *  axle of `m × a × h`, which redistributes load from one axle
 *  to the other by a magnitude `m × a × h / L` where L is
 *  wheelbase. Standard physics-of-cars derivation.
 *
 *  WHY THE 80%-OF-LIGHTER-AXLE CAP: under extreme braking or
 *  collision-spike a_long, the raw target can demand more
 *  transfer than the lighter axle's entire static weight,
 *  producing a target that would put one axle in the air. The
 *  cap bounds the *target* of the relaxation; a separate Fz
 *  floor (10 % of static, see [[applySuspensionFloors]])
 *  guarantees the applied loads stay positive.
 *
 *  INPUTS:
 *    mass         chassis mass (kg), post-sanitize
 *    longAccel    longitudinal accel (gu/s²), clamped — pass the
 *                 output of [[computeLongitudinalAccel]]
 *    wheelbase    Lwb in game units
 *    wdF          front-weight fraction from
 *                 [[computeWeightDistribution]]
 *
 *  Ported 1:1 from monolith L25227-L25230 (the transferTarget +
 *  maxTransfer + clamp block in the Phase 3 weight-transfer
 *  code). */
export function computeWeightTransferTarget(
  mass: number,
  longAccel: number,
  wheelbase: number,
  wdF: number,
): number {
  const transferTarget = -mass * longAccel * CG_HEIGHT_GU / wheelbase;
  const maxTransfer = mass * GRAVITY_GU * Math.min(wdF, 1 - wdF) * MAX_TRANSFER_FRACTION;
  if (transferTarget > maxTransfer) return maxTransfer;
  if (transferTarget < -maxTransfer) return -maxTransfer;
  return transferTarget;
}

/** Minimum axle load FRACTION (of static load). After dynamic
 *  weight transfer is applied, neither axle is allowed to drop
 *  below 10 % of its static load — no axle fully unloads, no
 *  wheelies during extreme braking/throttle, no division-by-zero
 *  in the friction-circle budget.
 *
 *  WHY A FLOOR EVEN AFTER THE TARGET CAP: the 80 %-of-lighter-
 *  axle target cap ([[MAX_TRANSFER_FRACTION]] in
 *  [[computeWeightTransferTarget]]) bounds the *target* of the
 *  low-pass relaxation. The relaxation itself can momentarily
 *  overshoot during a sign-change transient (e.g. rapid
 *  throttle-to-brake reversal), so the *applied* load needs an
 *  independent floor for friction-circle sanity. 10 % keeps
 *  μ × Fz well above zero so the friction-circle clamp doesn't
 *  divide by zero.
 *
 *  Matches monolith `*0.10` at L25243-L25244. */
export const SUSPENSION_FZ_FLOOR_FRACTION = 0.10;

/** Axle normal-load tuple — re-exported from chassisFrame's
 *  StaticNormalLoads with the same shape. Kept as a local
 *  interface to avoid cross-module export churn. */
export interface AxleLoads {
  Fz_F: number;
  Fz_R: number;
}

/** Apply the suspension safety floor — clamp each axle's normal
 *  load to ≥ 10 % of its static value. No axle fully unloads
 *  even under the most extreme accel/decel; no wheelies in the
 *  integrator.
 *
 *  FORMULA (1:1 with monolith):
 *    Fz_F_min = mass × g × wdF × 0.10        [10 % of static F]
 *    Fz_R_min = mass × g × (1 - wdF) × 0.10  [10 % of static R]
 *    Fz_F     = max(Fz_F, Fz_F_min)
 *    Fz_R     = max(Fz_R, Fz_R_min)
 *
 *  WHY IT'S A SEPARATE STAGE FROM THE TARGET CAP: see
 *  [[SUSPENSION_FZ_FLOOR_FRACTION]] doc — the target cap bounds
 *  the relaxation target; the floor protects the applied loads
 *  during sign-change transients of the low-pass.
 *
 *  WHY THIS MATTERS FOR DOWNSTREAM PHYSICS: the friction-circle
 *  budget is `μ × Fz`. A zero Fz would zero out the entire
 *  cornering force available at that axle, producing
 *  instantaneous loss of lateral control. A near-zero Fz would
 *  divide-by-zero or produce numerical instability when the
 *  integrator tries to compute slip angles. 10 % preserves
 *  enough budget for the integrator to remain stable through
 *  unusual events (collision spikes, save-load edge cases).
 *
 *  INPUTS:
 *    loads      current {Fz_F, Fz_R} after weight-transfer
 *               application; not mutated
 *    mass       chassis mass (kg), post-sanitize
 *    wdF       front-weight fraction
 *
 *  Returns the floored {Fz_F, Fz_R}. Pure function.
 *
 *  Ported 1:1 from monolith L25243-L25246 (the safety-floor
 *  block at the tail of the Phase 3 weight-transfer
 *  application). */
export function applySuspensionFloors(
  loads: AxleLoads,
  mass: number,
  wdF: number,
): AxleLoads {
  const Fz_F_min = mass * GRAVITY_GU * wdF * SUSPENSION_FZ_FLOOR_FRACTION;
  const Fz_R_min = mass * GRAVITY_GU * (1 - wdF) * SUSPENSION_FZ_FLOOR_FRACTION;
  return {
    Fz_F: loads.Fz_F < Fz_F_min ? Fz_F_min : loads.Fz_F,
    Fz_R: loads.Fz_R < Fz_R_min ? Fz_R_min : loads.Fz_R,
  };
}

/** Per-frame result of [[tickDynamicWeightTransfer]]: the
 *  updated axle loads, the new pFzTransfer state for next
 *  frame's low-pass, and the pPrevSpeed seed for next frame's
 *  numerical-accel computation. */
export interface WeightTransferTickResult {
  loads: AxleLoads;
  pFzTransfer: number;
  pPrevSpeed: number;
}

/** Advance the dynamic weight-transfer state by one tick.
 *  Orchestrates the full Phase 3 pipeline:
 *
 *    1. Compute longitudinal accel from pSpeed/pPrevSpeed
 *       ([[computeLongitudinalAccel]])
 *    2. Compute weight-transfer target with caps
 *       ([[computeWeightTransferTarget]])
 *    3. Compute suspension time constant from GT4 spring data
 *       ([[computeSuspensionTau]])
 *    4. Update pFzTransfer via first-order low-pass:
 *         alpha = min(1, dt / tau)
 *         pFzTransfer += (target - pFzTransfer) × alpha
 *    5. Apply transfer to axle loads (Fz_F += ΔFz, Fz_R -= ΔFz)
 *    6. Apply 10 %-of-static safety floor
 *       ([[applySuspensionFloors]])
 *
 *  FIRST-FRAME INIT (pDyn0BInit guard at L25218-L25222):
 *  On the first eligible frame there's no pPrevSpeed history,
 *  so the numerical-accel formula would compute against an
 *  uninitialized value. The init path bypasses the integration:
 *    pFzTransfer = 0
 *    pPrevSpeed  = pSpeed
 *    loads       = unchanged
 *
 *  Caller signals this with `isFirstFrame = true` on the first
 *  call (typically when `!pDyn0BInit`), then `false` thereafter.
 *
 *  INPUTS:
 *    loads          current {Fz_F, Fz_R} from
 *                   [[applyAerodynamicDownforce]] (or static
 *                   loads if downforce disabled)
 *    pFzTransfer    persistent low-pass state (caller stores
 *                   from previous frame; 0 on init)
 *    pPrevSpeed     persistent prev-frame pSpeed (caller stores;
 *                   = pSpeed on init)
 *    pSpeed         current frame's longitudinal speed
 *    dt             frame timestep, seconds
 *    mass           chassis mass (kg), post-sanitize
 *    wheelbase      Lwb in game units
 *    wdF            front-weight fraction
 *    gt4Susp        cc.gt4.susp from GT4 spec; undefined OK
 *    isFirstFrame   true if this is the first eligible frame
 *                   (no pPrevSpeed history yet); false for
 *                   subsequent frames
 *
 *  Returns the new {loads, pFzTransfer, pPrevSpeed} tuple.
 *  Caller assigns each to its persistent state slot.
 *
 *  PRE-CONDITION: this function assumes `gameplaySettings.
 *  suspension !== false`. Caller is responsible for the
 *  feature-flag check — when suspension is disabled, the entire
 *  weight-transfer step is skipped and `loads` flow through
 *  unchanged. (This matches the monolith's `if(_suspActive)`
 *  guard at L25218.)
 *
 *  Ported 1:1 from monolith L25218-L25249 (the Phase 3 weight-
 *  transfer block, excluding the outer _suspActive gate). */
export function tickDynamicWeightTransfer(
  loads: AxleLoads,
  pFzTransfer: number,
  pPrevSpeed: number,
  pSpeed: number,
  dt: number,
  mass: number,
  wheelbase: number,
  wdF: number,
  gt4Susp: readonly number[] | undefined,
  isFirstFrame: boolean,
): WeightTransferTickResult {
  if (isFirstFrame) {
    return {
      loads,
      pFzTransfer: 0,
      pPrevSpeed: pSpeed,
    };
  }
  const longAccel = computeLongitudinalAccel(pSpeed, pPrevSpeed, dt);
  const target = computeWeightTransferTarget(mass, longAccel, wheelbase, wdF);
  const tau = computeSuspensionTau(gt4Susp);
  const alpha = Math.min(1, dt / tau);
  const newPFzTransfer = pFzTransfer + (target - pFzTransfer) * alpha;
  const transferred: AxleLoads = {
    Fz_F: loads.Fz_F + newPFzTransfer,
    Fz_R: loads.Fz_R - newPFzTransfer,
  };
  return {
    loads: applySuspensionFloors(transferred, mass, wdF),
    pFzTransfer: newPFzTransfer,
    pPrevSpeed: pSpeed,
  };
}
