/**
 * Phase 0B force-integrator orchestrator. Composes the per-frame
 * physics primitives (chassis frame, weight transfer, tire forces,
 * friction circle, yaw integration, position update) into a single
 * `tickPhase0BIntegrator` entry point that mutates a
 * Phase0BIntegratorState in place.
 *
 * INCREMENTAL BUILDOUT: this file starts as the scaffold + chassis-
 * frame setup (mass / wdF / lever arms / yaw inertia / static
 * normal loads / downforce / weight transfer). Subsequent hops
 * (H485+) extend the tick body with:
 *   - delta computation (bicycle-model inverse + drift bypass)
 *   - per-axle velocity decomposition + slip angles
 *   - tire force curve evaluation + friction circle
 *   - longitudinal force pipeline (drive / brake / LSD)
 *   - velocity integration (long + lat) with v8.99.89 coupling
 *   - yaw torque integration + wheelspin yaw boost + damping
 *   - heading recompose + pSpeed reprojection + drift state
 *   - lateral velocity drag + post-damp + recompose
 *   - position integration + collision response
 *   - world wrap + camera-orientation tick
 *
 * Until that buildout is complete, callers should keep using
 * arcadeUpdate.ts (the H6 stop-gap). When this orchestrator is
 * feature-complete, a runtime feature flag will route the playing-
 * state tick through it for A/B comparison.
 *
 * Monolith source: the entire Phase 0B branch at update()
 * L25111-L26012.
 */

import {
  sanitizeChassisMass,
  computeWeightDistribution,
  computeAxleLeverArms,
  computeChassisYawInertia,
  computeStaticNormalLoads,
  applyAerodynamicDownforce,
} from './chassisFrame';
import { tickDynamicWeightTransfer } from './weightTransfer';
import { computeBicycleWheelbase } from './bicycleModel';

/** Persistent Phase 0B integrator state. Carries the per-axle
 *  velocity, yaw, and bookkeeping fields that survive across
 *  frames. Distinct from the legacy PlayerState — this is the
 *  data the bicycle model + force integrator need that the
 *  arcade tier doesn't track.
 *
 *  Caller embeds this in player state and passes it to
 *  [[tickPhase0BIntegrator]] each frame. */
export interface Phase0BIntegratorState {
  // === Position (world frame) ===
  /** CG world X position. */
  px: number;
  /** CG world Y position. */
  py: number;
  /** Rear-axle world X. Tracks CG via the bicycle-model rigid
   *  offset (Phase 0A) or its own integration (Phase 0B with
   *  lateral slip). */
  pRearX: number;
  /** Rear-axle world Y. */
  pRearY: number;

  // === Heading + yaw ===
  /** Chassis heading angle (rad). */
  pAngle: number;
  /** Chassis yaw rate (rad/s). Integrated by the force
   *  integrator from τ/I; can diverge from pAngVel (the
   *  "desired" yaw from steering input). */
  pYawRate: number;

  // === World-frame velocity ===
  /** World-frame velocity X (game units / sec). Updated by the
   *  long + lat integration steps with v8.99.89 symmetric
   *  coupling. */
  pVx: number;
  /** World-frame velocity Y. */
  pVy: number;

  // === Scalar speed ===
  /** Authoritative signed speed (gu/s). Set by the accel
   *  pipeline, re-projected from world velocity each frame
   *  (gentle blend during grip, slower during drift). */
  pSpeed: number;
  /** Previous frame's pSpeed — used by the numerical-derivative
   *  longitudinal-accel computation in Phase 3 weight transfer. */
  pPrevSpeed: number;

  // === Velocity direction ===
  /** Velocity direction (rad). Distinct from pAngle when the
   *  chassis is slipping — the angle the world-frame velocity
   *  vector points in. */
  pVelAngle: number;
  /** Low-passed pVelAngle for camera use. */
  pVelAngleFiltered: number;
  /** Camera-orientation angle, smoothed from pAngle / filtered
   *  velocity based on speed + drift state. */
  pCamAngle: number;

  // === Drift state ===
  /** Drift flag (Phase 0B Session B derives this from slip). */
  pDrifting: boolean;
  /** Drift intensity 0..1 — used by skidmark / audio / RPM-pump
   *  feedback. */
  pDrift: number;
  /** Post-drift recovery countdown (seconds). Armed to 0.5 on
   *  drift exit; blocks wheelspin-yaw re-entry. */
  pPostDriftTimer: number;
  /** E-brake countdown (seconds). Drives rear-μ collapse and
   *  damping regime selection. */
  pEbrakeTimer: number;
  /** Chassis-vs-velocity slip angle (rad), wrapped to (-π, π].
   *  Updated each frame from pAngle - pVelAngle. */
  pSlipAngle: number;

  // === Weight transfer state ===
  /** Current longitudinal load transfer (signed; positive = on
   *  front). First-order low-pass toward the
   *  target = -mass × a_long × h_cg / Lwb. */
  pFzTransfer: number;

  // === Initialization flags ===
  /** True after the Phase 0A bicycle-model state (pRearX/Y) has
   *  been seeded from CG. Cleared on car-switch / teleport /
   *  world-wrap. */
  pBicycleInit: boolean;
  /** True after the Phase 0B force-integrator state (pVx/Vy,
   *  pYawRate) has been seeded. Cleared on car-switch /
   *  teleport / world-wrap. */
  pDyn0BInit: boolean;

  // === Derived (read by HUD / effects) ===
  /** Wheelspin ratio from the friction-circle pre-clamp
   *  detection. 0 = no wheelspin; up to 2 at full saturation.
   *  Drives skidmark / audio / RPM pump. */
  pWheelspinRatio: number;
  /** Engine RPM (smoothed). Set by tickGearAndRpm; the Phase 0B
   *  integrator doesn't write this but the orchestrator reads it
   *  for the rev-limiter cut on F_drive. */
  pRpm: number;
}

/** Create a fresh Phase0BIntegratorState seeded with the player's
 *  starting position + heading. All other fields initialize to
 *  zero / false / null-equivalents — the per-frame init guards
 *  (pBicycleInit / pDyn0BInit) handle the rest at first tick.
 *
 *  Useful for new-game / car-switch / teleport seeding. The
 *  resulting state is safe to pass to tickPhase0BIntegrator
 *  immediately — the integrator's init paths will populate the
 *  derived fields (pVx/Vy from cos(pAngle)*pSpeed, pYawRate=0,
 *  rear-axle from CG offset) on the first eligible frame. */
export function createPhase0BIntegratorState(
  px: number,
  py: number,
  pAngle: number,
  pSpeed: number = 0,
): Phase0BIntegratorState {
  return {
    px, py, pRearX: px, pRearY: py,
    pAngle, pYawRate: 0,
    pVx: 0, pVy: 0,
    pSpeed, pPrevSpeed: pSpeed,
    pVelAngle: pAngle, pVelAngleFiltered: pAngle, pCamAngle: pAngle,
    pDrifting: false, pDrift: 0, pPostDriftTimer: 0, pEbrakeTimer: 0, pSlipAngle: 0,
    pFzTransfer: 0,
    pBicycleInit: false, pDyn0BInit: false,
    pWheelspinRatio: 0, pRpm: 800,
  };
}

/** Per-frame Phase 0B integrator inputs. Carries the user input,
 *  the active car's spec, the surface classification, and the
 *  fault-system aggregator output. The orchestrator reads only —
 *  doesn't mutate the inputs. */
export interface Phase0BStepInputs {
  /** User inputs. */
  gas: boolean;
  brake: boolean;
  /** Live ebrk input flag (NOT the residual timer). */
  ebrk: boolean;
  /** Analog steering axis, -1..1. */
  steerAxis: number;
  /** Analog brake input 0..1 (digital → 0/1, analog supports
   *  pedal pressure). */
  brakeAmount: number;
  /** Analog gas input 0..1. */
  gasAmount: number;

  /** Frame timestep (s). */
  dt: number;

  /** Surface classification (from playerSurface.ts). */
  onGrass: boolean;
  /** Surface is dirt/canyon (tile 12/14/16). */
  onDirt: boolean;

  /** Fault-system aggregated scalars (1 = no fault). */
  faults: {
    /** Acceleration multiplier (accel-related faults compose). */
    accelMult: number;
    /** Brake-force multiplier (brake-related faults). */
    brakeMult: number;
    /** Grip multiplier (tire/suspension faults reduce peak μ). */
    gripMult: number;
    /** Fuel-burn multiplier (engine inefficiency faults). */
    fuelMult: number;
    /** Steering-pull signed bias (alignment faults, ±0.6). */
    steerPull: number;
    /** Power-steering-loss flag (steerSlow fault). */
    steerSlow: boolean;
    /** Shift-time multiplier (transmission faults). */
    shiftMult: number;
    /** Tachometer flutter flag. */
    rpmFlutter: boolean;
  };
}

/** Per-car spec data for the Phase 0B integrator. Read-only;
 *  the orchestrator pulls all per-car constants from here so the
 *  integrator can be tested with hand-built specs. */
export interface Phase0BCarSpec {
  /** Mass (kg). */
  mass: number;
  /** Body length (game units) — used by bicycle-model wheelbase
   *  derivation. */
  bodyLength: number;
  /** Per-car power scaling (cc.powerMult — engine mods, fuel
   *  quality). */
  powerMult: number;
  /** Per-car traction-control scaling (cc.tractionMult). */
  tractionMult: number;
  /** Gear-shift-up speeds (gu/s) indexed by gear. */
  gearSpeeds: readonly number[];
  /** Number of forward gears. */
  gears: number;
  /** Idle RPM. */
  idleRPM: number;
  /** Redline RPM. */
  redline: number;
  /** Top speed (gu/s). */
  topSpeed: number;
  /** Horsepower (used by power-to-weight boost). */
  hp: number;
  /** Drivetrain layout. */
  drivetrain: 'FF' | 'FR' | 'MR' | 'RR' | '4WD';
  /** GT4-spec data (optional — present for GT4-class cars). */
  gt4?: {
    wdF?: number;       // front weight percentage
    lng?: number;       // body length (mm)
    wid?: number;       // body width (mm)
    df?: readonly number[]; // [dfF, dfR] downforce
    susp?: readonly number[]; // suspension data
    twF?: number;       // tire width front (mm)
    twR?: number;       // tire width rear (mm)
    lsd?: readonly number[]; // [initF, initR, accelF, accelR, decelF, decelR]
    pIF?: number;       // front power input share (4WD)
    pIR?: number;       // rear power input share (4WD)
  };
  /** Is this a bike? (Bikes bypass the bicycle model.) */
  isBike: boolean;
  /** Is this a GT4-class car? (Required for bicycle-model
   *  eligibility.) */
  isGt4: boolean;
}

/** Settings that gate Phase 0B integrator behavior. Reflects the
 *  console-flippable knobs in LIFE.gameplaySettings. */
export interface Phase0BSettings {
  /** Master enable for bicycle-model branch. */
  bicycleModel: boolean;
  /** Master enable for the dynamic Phase 0B force integrator
   *  (vs Phase 0A geometric yaw assignment). */
  dynPhysics0B: boolean;
  /** Master enable for Phase 3 dynamic weight transfer. */
  suspension: boolean;
  /** Master enable for Phase 7 chassis-dimension yaw inertia. */
  chassisI: boolean;
  /** Master enable for Phase 6 aerodynamic downforce. */
  downforce: boolean;
  /** Master enable for Phase 2 LSD effects. */
  lsd: boolean;
  /** Master enable for Phase 4 tire-data scaling on μ and C_α. */
  tyreData: boolean;
  /** Override for the driftEnterThresh (radians; default 0.26). */
  physDriftEnterThresh: number;
  /** Override for the physMuBase (default 1.0). */
  physMuBase: number;
  /** Override for the physMassMomentum knob (default 0.0003). */
  physMassMomentum: number;
  /** Override for the physMomentumCoef knob (default 6.0). */
  physMomentumCoef: number;
  /** Master enable for Phase 9 supercharger mod. */
  supercharger: boolean;
}

/** Result of the chassis-frame setup phase — computed at the head
 *  of each integrator tick. Not state (recomputed every frame
 *  from spec + current velocity / transfer state). */
interface ChassisFrame {
  mass: number;
  wheelbase: number;
  wdF: number;
  /** CG → front axle. */
  a: number;
  /** CG → rear axle. */
  b: number;
  /** Yaw moment of inertia. */
  I: number;
  /** Front axle normal load (Fz_F) post-weight-transfer +
   *  downforce. */
  Fz_F: number;
  /** Rear axle normal load. */
  Fz_R: number;
}

/** Compute the chassis-frame setup for one tick. Composes the
 *  six chassisFrame.ts primitives plus the Phase 3 weight-
 *  transfer relaxation:
 *    1. sanitizeChassisMass
 *    2. computeWeightDistribution
 *    3. computeBicycleWheelbase + computeAxleLeverArms
 *    4. computeChassisYawInertia
 *    5. computeStaticNormalLoads
 *    6. applyAerodynamicDownforce
 *    7. tickDynamicWeightTransfer (mutates pFzTransfer, pPrevSpeed)
 *
 *  Internal to the orchestrator; called from tickPhase0BIntegrator
 *  at the head of each frame. The result feeds the per-axle
 *  tire-physics primitives downstream. */
function setupChassisFrame(
  state: Phase0BIntegratorState,
  spec: Phase0BCarSpec,
  settings: Phase0BSettings,
  dt: number,
): ChassisFrame {
  const mass = sanitizeChassisMass(spec.mass);
  const wheelbase = computeBicycleWheelbase(spec.bodyLength);
  const wdF = computeWeightDistribution(spec.gt4?.wdF);
  const { a, b } = computeAxleLeverArms(wheelbase, wdF);
  const I = computeChassisYawInertia(
    mass, wheelbase, spec.gt4?.lng, spec.gt4?.wid, settings.chassisI,
  );
  let loads = computeStaticNormalLoads(mass, wdF);
  loads = applyAerodynamicDownforce(loads, spec.gt4?.df, state.pSpeed, settings.downforce);

  if (settings.suspension) {
    // First eligible frame: seed pPrevSpeed, skip the integration.
    const isFirst = !state.pDyn0BInit;
    const result = tickDynamicWeightTransfer(
      loads, state.pFzTransfer, state.pPrevSpeed, state.pSpeed,
      dt, mass, wheelbase, wdF, spec.gt4?.susp, isFirst,
    );
    loads = result.loads;
    state.pFzTransfer = result.pFzTransfer;
    state.pPrevSpeed = result.pPrevSpeed;
  } else {
    // Weight transfer disabled — static loads pass through. Still
    // track pPrevSpeed so a later toggle-on doesn't see a stale
    // value.
    state.pPrevSpeed = state.pSpeed;
  }

  return {
    mass, wheelbase, wdF, a, b, I,
    Fz_F: loads.Fz_F, Fz_R: loads.Fz_R,
  };
}

/** Phase 0B integrator tick — placeholder until the full pipeline
 *  is wired. Currently runs ONLY the chassis-frame setup, which
 *  mutates pFzTransfer + pPrevSpeed but doesn't yet integrate
 *  position / velocity / heading. Calling this in place of
 *  arcadeUpdate would freeze the car.
 *
 *  Subsequent H<NNN> hops extend the body with the remaining
 *  pipeline stages. Build order:
 *    H485: delta + per-axle velocities + slip angles
 *    H486: tire forces + friction circle clamps
 *    H487: drive force + LSD + brake force
 *    H488: longitudinal + lateral velocity integration
 *    H489: yaw torque + wheelspin yaw + damping + low-speed collapse
 *    H490: heading recompose + pSpeed reprojection + drift state
 *    H491: lateral velocity drag + post-damp + world recompose
 *    H492: position integration + collision response + world wrap
 *    H493: camera-orientation tick
 *    H494: feature-flag wiring to route runtime through this
 *
 *  Until then, this function exists as a structural placeholder
 *  so the type contracts and the chassis-frame composition are
 *  fixed and reviewable.
 *
 *  See module docstring for the full pipeline order. */
export function tickPhase0BIntegrator(
  state: Phase0BIntegratorState,
  inputs: Phase0BStepInputs,
  spec: Phase0BCarSpec,
  settings: Phase0BSettings,
): void {
  // === Phase 1: chassis-frame setup ===
  // Mass, wdF, lever arms, yaw inertia, normal loads, downforce,
  // Phase 3 weight transfer.
  const _frame = setupChassisFrame(state, spec, settings, inputs.dt);

  // === Subsequent phases (deferred to H485+) ===
  // The chassis-frame data (_frame) flows into the tire-physics
  // primitives, slip-angle computation, and force integration in
  // later hops. Suppressing the unused-variable lint here is
  // intentional — the variable exists to anchor the structure
  // for incremental buildout.
  void _frame;
}
