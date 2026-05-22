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
import {
  computeBicycleWheelbase,
  computeBicycleMaxDelta,
  selectBicycleDelta,
  isBicycleModelEligible,
  initDyn0BIntegratorState,
  computeAxleVelocities,
  computeSlipAngles,
  type BodyFrameVelocity,
} from './bicycleModel';
import { computeEffectiveSteerInput } from './steering';

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

  /** "Desired yaw rate" coming from the upstream steering
   *  pipeline (computeGripBaseSteer / computeDriftPAngVel +
   *  drivetrain modifiers + fault layer). The bicycle-model
   *  inverse uses this to back-compute delta. Caller composes
   *  the steering chain upstream and hands the result here.
   *
   *  Matches the monolith's `const desiredYaw = pAngVel` at
   *  L24832. */
  pAngVel: number;

  /** User steering-sensitivity setting (0.5..2.0 slider). The
   *  caller picks between touchSteerSens / padSteerSens based
   *  on input device. Pass 1.0 if unknown — that's the default. */
  sensSlider: number;

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

/** Per-tick output of the delta + axle-velocity + slip-angle
 *  setup phase. Computed each frame from the current state +
 *  inputs + chassis frame; not persistent. */
interface SlipSetup {
  /** Front-wheel steering angle (rad). Comes from the three-
   *  branch selector ([[selectBicycleDelta]]) when the bicycle
   *  model is active, or 0 when the legacy path runs. */
  delta: number;
  /** Front-axle body-frame velocity (v_long, v_lat). */
  vF: BodyFrameVelocity;
  /** Rear-axle body-frame velocity. */
  vR: BodyFrameVelocity;
  /** Front-axle slip angle (rad). */
  slipF: number;
  /** Rear-axle slip angle (rad). */
  slipR: number;
  /** True if Phase 0B integrator branch is active this frame
   *  (caller uses this to decide whether the rest of the
   *  Phase 0B pipeline runs vs. the legacy path). */
  use0B: boolean;
  /** True if Phase 0A bicycle-model branch is active this
   *  frame (grip-only, no force integrator). */
  useBicyclePos: boolean;
}

/** Compute per-frame slip-angle setup: bicycle-model
 *  eligibility check, delta computation, Phase 0B per-axle
 *  state seeding (if first eligible frame), per-axle velocity
 *  decomposition, slip-angle pair.
 *
 *  COMPOSES (in order):
 *    1. isBicycleModelEligible (H409) — gate
 *    2. computeEffectiveSteerInput (H396) — post-sensitivity
 *       stick input
 *    3. computeBicycleMaxDelta (H404) — grip/drift cap
 *    4. selectBicycleDelta (H410) — three-branch selector
 *       (drift / low-speed grip / high-speed grip)
 *    5. initDyn0BIntegratorState (H435) — first-frame seed if
 *       !pDyn0BInit (sets pVx/Vy from cos(pAngle)*pSpeed,
 *       pYawRate = 0)
 *    6. computeAxleVelocities (H440) — v_axle = v_cg + ω × r
 *    7. computeSlipAngles (H441) — atan2(vF_lat, |vF_long|+ε) - δ
 *
 *  Returns the per-axle slip + velocity data the downstream
 *  tire-physics primitives consume. Internal to the
 *  orchestrator. */
function setupSlipAndDelta(
  state: Phase0BIntegratorState,
  inputs: Phase0BStepInputs,
  spec: Phase0BCarSpec,
  settings: Phase0BSettings,
  frame: ChassisFrame,
): SlipSetup {
  const vAbs = Math.abs(state.pSpeed);
  const worldSpd = Math.sqrt(state.pVx * state.pVx + state.pVy * state.pVy);

  const eligible = isBicycleModelEligible(
    spec.isBike,
    settings.dynPhysics0B,
    state.pDrifting,
    spec.isGt4,
    /* hasTrailer */ false, // caller can wire LIFE.trailer through inputs in a future hop
    vAbs, worldSpd,
    settings.bicycleModel,
  );

  if (!eligible) {
    // Legacy path — the bicycle-model + force-integrator branch
    // doesn't fire. Return zeroed slip data; downstream
    // primitives short-circuit when use0B is false.
    return {
      delta: 0,
      vF: { v_long: 0, v_lat: 0 },
      vR: { v_long: 0, v_lat: 0 },
      slipF: 0,
      slipR: 0,
      use0B: false,
      useBicyclePos: false,
    };
  }

  // Compute the steering input via the post-sensitivity helper.
  const steerInputEff = computeEffectiveSteerInput(
    inputs.steerAxis, spec.isBike, inputs.sensSlider,
  );
  const maxDelta = computeBicycleMaxDelta(state.pDrifting);
  const delta = selectBicycleDelta(
    steerInputEff, inputs.pAngVel, frame.wheelbase, vAbs, maxDelta,
    state.pDrifting, settings.dynPhysics0B,
  );

  // First eligible frame: seed pVx/Vy from heading × speed,
  // pYawRate = 0. Subsequent frames use the integrated state.
  if (!state.pDyn0BInit) {
    const seed = initDyn0BIntegratorState(state.pAngle, state.pSpeed);
    state.pVx = seed.pVx;
    state.pVy = seed.pVy;
    state.pYawRate = seed.pYawRate;
    state.pDyn0BInit = true;
  }

  // Per-axle world-frame velocities + body-frame decomposition.
  const axles = computeAxleVelocities(
    state.pVx, state.pVy, state.pYawRate, state.pAngle,
    frame.a, frame.b,
  );

  // Slip angles — front uses delta, rear doesn't.
  const { slipF, slipR } = computeSlipAngles(axles.vF, axles.vR, delta);

  return {
    delta,
    vF: axles.vF,
    vR: axles.vR,
    slipF, slipR,
    use0B: settings.dynPhysics0B,
    useBicyclePos: true,
  };
}

/** Phase 0B integrator tick. Currently runs two pipeline stages:
 *  chassis-frame setup + slip-angle setup. The remaining stages
 *  (tire forces, friction circle, velocity integration, yaw, etc.)
 *  arrive in H486+.
 *
 *  Calling this in place of arcadeUpdate would still freeze the
 *  car — position/velocity aren't integrated yet. Continue using
 *  arcadeUpdate as the runtime stop-gap until the pipeline is
 *  feature-complete.
 *
 *  REMAINING BUILDOUT (in order):
 *    H486: tire forces + friction circle clamps
 *    H487: drive force + LSD + brake force
 *    H488: long + lat velocity integration with v8.99.89 coupling
 *    H489: yaw torque + wheelspin yaw + damping + low-speed collapse
 *    H490: heading recompose + pSpeed reprojection + drift state
 *    H491: lateral velocity drag + post-damp + world recompose
 *    H492: position integration + collision response + world wrap
 *    H493: camera-orientation tick (filter + camTarget + camAngle)
 *    H494: feature-flag wiring to route runtime through this */
export function tickPhase0BIntegrator(
  state: Phase0BIntegratorState,
  inputs: Phase0BStepInputs,
  spec: Phase0BCarSpec,
  settings: Phase0BSettings,
): void {
  // === Phase 1: chassis-frame setup ===
  const frame = setupChassisFrame(state, spec, settings, inputs.dt);

  // === Phase 2: delta + axle velocities + slip angles ===
  const _slip = setupSlipAndDelta(state, inputs, spec, settings, frame);

  // === Subsequent phases (deferred to H486+) ===
  // Slip data feeds tire-force evaluation, friction circle
  // clamping, and force integration in later hops.
  void _slip;
}
