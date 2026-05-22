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
  worldToBodyVelocity,
  applyAntiparallelVelocityRotation,
  computeLongBlend,
  applyLongitudinalIntegration,
  integrateLateralVelocity,
  type BodyFrameVelocity,
} from './bicycleModel';
import { projectLateralToBodyFrame } from './frictionCircle';
import { computeEffectiveSteerInput } from './steering';
import {
  computeMuBase,
  applyTireWidthMu,
  applyEbrakeRearMu,
  computeCorneringStiffness,
} from './tireCoefficients';
import { tireCurve } from './tire';
import {
  applySuperchargerBoost,
  computePowerToWeightBoost,
  computeDrivetrainCoef,
  computeGearRatioMult,
  computeManualRevLimiterCut,
  composeFDrive,
  distributeDriveToAxles,
  computeBrakeForce,
  BRAKE_MIN_SPEED,
  type AxleLongitudinalForces,
} from './driveForce';
import { applyLsdToAxleForces } from './limitedSlipDiff';
import { getTorqueAtRPM } from './torqueCurve';
import { GRAVITY_GU } from './chassisFrame';
import {
  computeFrictionCircle,
  clampLongitudinalForces,
  computeLateralBudget,
  clampLateralForces,
  detectWheelspinRatio,
  applyStraightLineWheelspinBleed,
} from './frictionCircle';

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

  /** Currently selected gear. 0 = reverse, 1..N = forward gears.
   *  Set by tickGearAndRpm (caller runs that before this
   *  orchestrator each frame). Read by the drive-force pipeline
   *  for torque scaling. */
  pGear: number;

  /** Gear-shift dip countdown (seconds). > 0 during an upshift's
   *  150 ms RPM dip. Set by tickGearAndRpm. Read by the
   *  manual rev limiter and the friction-circle wheelspin
   *  detection. */
  gearShiftTimer: number;
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
    pGear: 1, gearShiftTimer: 0,
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

  /** Transmission mode — LIFE.isManual flag. Manual cars have a
   *  rev limiter that cuts drive force above the current gear's
   *  shift-up speed; automatic cars rely on the auto shifter
   *  for the same governor effect. */
  isManual: boolean;

  /** Welded-diff mod flag — LIFE.welded. When true, both axles'
   *  LSD locks are forced to 100 % (full mechanical lock). */
  isWelded: boolean;

  /** Player has the supercharger mod installed — LIFE.supercharged.
   *  Eligibility additionally requires spec.gt4.canSC === 1 and
   *  settings.supercharger !== false. */
  supercharged: boolean;

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
  /** Torque-curve data — (rpms, norms) arrays for
   *  [[getTorqueAtRPM]] interpolation. Caller resolves from
   *  cc.torqueCurve (catalog.ts). */
  torqueCurve: {
    rpms: readonly number[];
    norms: readonly number[];
  };

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
    canSC?: 0 | 1;      // supercharger-eligible (46/366 cars)
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

/** Phase 0B integrator tick. Currently runs six pipeline stages:
 *  chassis-frame setup, slip-angle setup, tire-force setup,
 *  longitudinal-force setup, friction-circle clamps, and velocity
 *  integration (long + lat with v8.99.89 coupling). The remaining
 *  stages (yaw, heading recompose, position, camera) arrive in
 *  H490+.
 *
 *  Calling this in place of arcadeUpdate would still freeze the
 *  chassis heading — pAngle / pYawRate aren't integrated yet, and
 *  the world position isn't advanced from the integrated velocity.
 *  Continue using arcadeUpdate as the runtime stop-gap until the
 *  pipeline is feature-complete.
 *
 *  REMAINING BUILDOUT (in order):
 *    H490: yaw torque + wheelspin yaw + damping + low-speed collapse
 *    H491: heading recompose + pSpeed reprojection + drift state
 *    H492: lateral velocity drag + post-damp + world recompose
 *    H493: position integration + collision response + world wrap
 *    H494: camera-orientation tick (filter + camTarget + camAngle)
 *    H495: feature-flag wiring to route runtime through this */
export function tickPhase0BIntegrator(
  state: Phase0BIntegratorState,
  inputs: Phase0BStepInputs,
  spec: Phase0BCarSpec,
  settings: Phase0BSettings,
): void {
  // === Phase 1: chassis-frame setup ===
  const frame = setupChassisFrame(state, spec, settings, inputs.dt);

  // === Phase 2: delta + axle velocities + slip angles ===
  const slip = setupSlipAndDelta(state, inputs, spec, settings, frame);

  if (!slip.use0B) {
    // Legacy path — exit early; caller falls back to arcadeUpdate
    // for this frame. (Will be handled by the feature-flag layer
    // in H494.)
    return;
  }

  // === Phase 3: tire coefficients + lateral force requests ===
  const tire = setupTireForces(state, inputs, spec, settings, slip);

  // === Phase 4: drive force / brake / LSD ===
  const longReq = setupLongitudinalForces(state, inputs, spec, settings);

  // === Phase 5: friction circle clamps + wheelspin + lateral budget ===
  const clamped = applyFrictionCircle(state, inputs, spec, tire, slip, longReq);

  // === Phase 6: velocity integration (long + lat) with v8.99.89 coupling ===
  const _vel = integrateVelocities(state, inputs, frame, slip, clamped);

  // === Subsequent phases (deferred to H490+) ===
  void _vel;
}

/** Per-tick velocity-integration result. v_long_new is consumed
 *  by the heading-recompose step in H490; v_lat_new flows into
 *  the lateral-velocity drag in H491 and the heading-recompose
 *  in H490. */
interface VelocityIntegration {
  /** Updated body-frame longitudinal velocity (v8.99.89
   *  coupling + authoritative-speed blend). */
  v_long_new: number;
  /** Updated body-frame lateral velocity (centripetal coupling
   *  + three-tier damping). */
  v_lat_new: number;
}

/** Apply the Phase 0B velocity-integration steps: antiparallel
 *  rotation, longitudinal coupling+blend, lateral force
 *  projection, lateral integration with damping.
 *
 *  COMPOSES (in monolith order):
 *    1. applyAntiparallelVelocityRotation (H436) — v8.99.69
 *       post-180° momentum-preservation rotation
 *    2. worldToBodyVelocity (H437) — decompose pVx/Vy →
 *       v_long_cur, v_lat_cur
 *    3. computeLongBlend (H438) — drift / mismatch / ebrake
 *       gate selects 0.005 vs 1.0 blend rate
 *    4. applyLongitudinalIntegration (H439) — v_long_coupled =
 *       v_long + v_lat × pYawRate × dt (v8.99.89 SYMMETRIC
 *       KINEMATIC COUPLING fix), then blend toward pSpeed
 *    5. projectLateralToBodyFrame (H458) — lateral force world-
 *       frame projection + body-frame total
 *    6. integrateLateralVelocity (H459) — v_lat_new with
 *       centripetal coupling (-v_long × ω) + v8.99.124.04
 *       three-tier damping
 *
 *  MUTATES state.pVx, state.pVy (step 4's recomposed values
 *  with NEW v_long but OLD v_lat). Caller's H490 heading-
 *  recompose step will re-derive these with the new pAngle +
 *  v_lat_new returned here.
 *
 *  Returns {v_long_new, v_lat_new} for downstream stages. */
function integrateVelocities(
  state: Phase0BIntegratorState,
  inputs: Phase0BStepInputs,
  frame: ChassisFrame,
  slip: SlipSetup,
  clamped: ClampedForces,
): VelocityIntegration {
  // 1. Antiparallel velocity rotation (v8.99.69) — mutates pVx, pVy
  //    when gas held + pSpeed > 5 + preVLong × pSpeed < 0.
  const rotated = applyAntiparallelVelocityRotation(
    state.pVx, state.pVy, state.pAngle, state.pSpeed, inputs.gas,
  );
  state.pVx = rotated.pVx;
  state.pVy = rotated.pVy;

  // 2. Decompose post-rotation world velocity into body frame
  const { v_long, v_lat } = worldToBodyVelocity(state.pVx, state.pVy, state.pAngle);

  // 3. Compute longBlend (0.005 during drift/mismatch/ebrake;
  //    1.0 otherwise).
  const longBlend = computeLongBlend(
    state.pDrifting, state.pPostDriftTimer,
    v_long, state.pSpeed, state.pEbrakeTimer,
  );

  // 4. Longitudinal integration with v8.99.89 coupling +
  //    authoritative-speed blend + recompose pVx/Vy (with OLD
  //    v_lat — H490 will fix that with the new pAngle).
  const longResult = applyLongitudinalIntegration(
    v_long, v_lat, state.pYawRate, inputs.dt,
    state.pSpeed, longBlend, state.pAngle,
  );
  state.pVx = longResult.pVx;
  state.pVy = longResult.pVy;
  // Mirror the scalar v_long_new that applyLongitudinalIntegration
  // computes internally — the lateral integration step needs it for
  // the centripetal coupling term. Same two-line formula as the
  // helper; kept here so the helper's WorldVelocity return doesn't
  // have to widen.
  const v_long_coupled = v_long + v_lat * state.pYawRate * inputs.dt;
  const v_long_new = v_long_coupled + (state.pSpeed - v_long_coupled) * longBlend;

  // 5. Project clamped lateral forces (world frame via perp to
  //    pAngle+delta for front, perp to pAngle for rear) onto
  //    body-frame lateral axis.
  const F_tot_lat_body = projectLateralToBodyFrame(
    clamped.F_lat_F, clamped.F_lat_R,
    state.pAngle, slip.delta,
  );

  // 6. Integrate v_lat with centripetal coupling (-v_long × ω)
  //    + three-tier damping (live ebrk gates slide-feel regime).
  const v_lat_new = integrateLateralVelocity(
    v_lat, F_tot_lat_body, frame.mass,
    v_long_new, state.pYawRate, inputs.dt, inputs.ebrk,
  );

  return { v_long_new, v_lat_new };
}

/** Final per-axle force state after friction-circle clamping —
 *  what the integrator uses for force application. */
interface ClampedForces {
  F_long_F: number;
  F_long_R: number;
  F_lat_F: number;
  F_lat_R: number;
}

/** Apply the friction-circle constraints in canonical order:
 *  longitudinal first (combined-slip-reduced cap), then lateral
 *  (sqrt budget), with wheelspin detection from PRE-clamp values
 *  feeding the straight-line speed bleed.
 *
 *  COMPOSES:
 *    1. computeFrictionCircle (H452) — μ·Fz + Pacejka combined-
 *       slip cap on F_long
 *    2. clampLongitudinalForces (H453) — ±F_long_cap
 *    3. computeLateralBudget × 2 (H454) — sqrt(F_circle² - F_long²)
 *    4. clampLateralForces (H455) — ±F_lat_budget
 *    5. detectWheelspinRatio (H456) — pre-clamp F_long_req vs
 *       full F_circle, gated on isThrottle + drivetrain
 *    6. applyStraightLineWheelspinBleed (H457) — pSpeed scrub
 *       when wheelspinRatio > 0.1 (caller mutates state.pSpeed)
 *
 *  MUTATES state.pWheelspinRatio (for downstream consumers —
 *  HUD, skidmark, audio) and state.pSpeed (when bleed fires).
 *
 *  Returns the post-clamp force quartet. Internal to the
 *  orchestrator. */
function applyFrictionCircle(
  state: Phase0BIntegratorState,
  inputs: Phase0BStepInputs,
  spec: Phase0BCarSpec,
  tire: TireForces,
  slip: SlipSetup,
  longReq: AxleLongitudinalForces,
): ClampedForces {
  // We need post-weight-transfer Fz_F/R again — but the frame
  // computation upstream already produced those values. Re-derive
  // by composing from the same primitives — the result is
  // identical to setupChassisFrame's `loads` (post-downforce +
  // post-weight-transfer). To avoid a duplicate computation,
  // refactor the orchestrator's data flow so the frame's Fz
  // values flow through to here directly.
  //
  // For now (since this hop's scope is the friction-circle stage
  // itself, not the data-flow refactor), recompute via the
  // chassisFrame primitives one more time.
  //
  // FUTURE HOP: thread the ChassisFrame's Fz_F/Fz_R values into
  // this function as a parameter and remove this re-derivation.
  const mass = sanitizeChassisMass(spec.mass);
  const wdF = computeWeightDistribution(spec.gt4?.wdF);
  let staticLoads = computeStaticNormalLoads(mass, wdF);
  staticLoads = applyAerodynamicDownforce(
    staticLoads, spec.gt4?.df, state.pSpeed, inputs.dt > 0,
  );
  // Note: weight-transfer Fz_F/R are NOT re-derived here — the
  // first-pass `setupChassisFrame` already mutated state.pFzTransfer
  // to its post-tick value. We apply that transfer to the
  // downforce-adjusted loads:
  const Fz_F = staticLoads.Fz_F + state.pFzTransfer;
  const Fz_R = staticLoads.Fz_R - state.pFzTransfer;

  // 1. Friction circle + combined-slip-reduced long cap
  const fc = computeFrictionCircle(
    tire.mu_F, tire.mu_R, Fz_F, Fz_R,
    slip.slipF, slip.slipR,
  );

  // 2. Clamp longitudinal to ±F_long_cap (combined-slip reduced)
  const longClamped = clampLongitudinalForces(
    longReq, fc.F_long_cap_F, fc.F_long_cap_R,
  );

  // 3. Lateral budget = √(F_circle² - F_long²) per axle
  const F_lat_budget_F = computeLateralBudget(fc.F_circle_F, longClamped.F_long_F);
  const F_lat_budget_R = computeLateralBudget(fc.F_circle_R, longClamped.F_long_R);

  // 4. Clamp lateral to ±budget
  const latClamped = clampLateralForces(
    tire.F_lat_F_req, tire.F_lat_R_req, F_lat_budget_F, F_lat_budget_R,
  );

  // 5. Wheelspin detection — uses PRE-clamp F_long_req values
  //    against the FULL friction circle (not the reduced cap).
  //    Captures "demand exceeded total grip" — the player-
  //    perceptible wheelspin condition.
  const wheelspinRatio = detectWheelspinRatio(
    longReq.F_long_F, longReq.F_long_R, fc.F_circle_F, fc.F_circle_R,
    inputs.gas, spec.drivetrain,
  );
  state.pWheelspinRatio = wheelspinRatio;

  // 6. Straight-line wheelspin speed bleed (real-tire heat / smoke
  //    energy loss). Mutates state.pSpeed when ratio > 0.1.
  state.pSpeed = applyStraightLineWheelspinBleed(
    state.pSpeed, wheelspinRatio, inputs.gas, inputs.dt,
  );

  return {
    F_long_F: longClamped.F_long_F,
    F_long_R: longClamped.F_long_R,
    F_lat_F: latClamped.F_lat_F,
    F_lat_R: latClamped.F_lat_R,
  };
}

/** Apply the supercharger boost to a normalized torque value if
 *  the player has the mod installed, the car supports it (canSC),
 *  and the setting is enabled. Otherwise pass through. */
function maybeApplySupercharger(
  torqueNorm: number,
  pRPM: number,
  idleRPM: number,
  redline: number,
  hasSCMod: boolean,
  canSC: boolean,
  settingOn: boolean,
): number {
  if (!hasSCMod || !canSC || !settingOn) return torqueNorm;
  return applySuperchargerBoost(torqueNorm, pRPM, idleRPM, redline);
}

/** Compute per-axle longitudinal forces — drive (under throttle)
 *  or brake (under brake input). Composes the driveForce.ts
 *  pipeline (supercharger → power-boost → drivetrain coef → gear
 *  ratio → manual rev limiter → F_drive → axle distribution)
 *  and the LSD application (limitedSlipDiff.ts), or falls into
 *  the brake-force branch.
 *
 *  COMPOSES (throttle branch):
 *    1. getTorqueAtRPM (existing) — normalized torque from curve
 *    2. maybeApplySupercharger (this file) — Phase 9 boost gate
 *    3. computePowerToWeightBoost (H443)
 *    4. computeDrivetrainCoef (H444)
 *    5. computeGearRatioMult (H445)
 *    6. computeManualRevLimiterCut (H446)
 *    7. composeFDrive (H447) — multiplicative chain
 *    8. distributeDriveToAxles (H448) — drivetrain layout split
 *    9. applyLsdToAxleForces (H451) — Phase 2 LSD effectiveness
 *
 *  COMPOSES (brake branch):
 *    1. computeBrakeForce (H449) — F_long_F/R with per-drivetrain
 *       front/rear bias (60/40 default, 55/45 for MR/RR)
 *
 *  Returns the per-axle longitudinal force PAIR. These are still
 *  REQUESTED values — the friction circle clamp in the next
 *  pipeline stage caps them to ±F_long_cap. Internal to the
 *  orchestrator. */
function setupLongitudinalForces(
  state: Phase0BIntegratorState,
  inputs: Phase0BStepInputs,
  spec: Phase0BCarSpec,
  settings: Phase0BSettings,
): AxleLongitudinalForces {
  const mass = sanitizeChassisMass(spec.mass);

  if (inputs.gas) {
    // Throttle branch — compose the engine-torque pipeline.
    let torqueNorm = getTorqueAtRPM(
      spec.torqueCurve.rpms, spec.torqueCurve.norms, state.pRpm,
    );
    torqueNorm = maybeApplySupercharger(
      torqueNorm, state.pRpm, spec.idleRPM, spec.redline,
      inputs.supercharged, spec.gt4?.canSC === 1, settings.supercharger,
    );

    const powBoost = computePowerToWeightBoost(spec.hp, mass);
    const drivetrainCoef = computeDrivetrainCoef(spec.drivetrain, powBoost);
    const gearRatioMult = computeGearRatioMult(spec.gearSpeeds, state.pGear);
    const manualRevCut = computeManualRevLimiterCut(
      state.pSpeed, spec.gearSpeeds, state.pGear,
      inputs.isManual, state.gearShiftTimer,
    );

    const F_drive = composeFDrive(
      torqueNorm, spec.powerMult, inputs.gasAmount, mass, GRAVITY_GU,
      drivetrainCoef, spec.tractionMult, gearRatioMult, manualRevCut,
    );

    let forces = distributeDriveToAxles(
      F_drive, spec.drivetrain, spec.gt4?.pIF, spec.gt4?.pIR,
    );

    // Phase 2 LSD (caller-gated: throttle held + setting on + lsd
    // spec exists). Brake branch bypasses the diff entirely.
    if (settings.lsd && spec.gt4?.lsd) {
      forces = applyLsdToAxleForces(
        forces, spec.drivetrain,
        spec.gt4.lsd[2], spec.gt4.lsd[3], inputs.isWelded,
      );
    }
    return forces;
  }

  if (inputs.brake && state.pSpeed > BRAKE_MIN_SPEED) {
    return computeBrakeForce(
      inputs.brakeAmount, mass, GRAVITY_GU, spec.drivetrain,
    );
  }

  // Coast — no longitudinal force (engineBrake / coast drag is
  // handled separately by the acceleration block in the existing
  // pipeline; this orchestrator focuses on the bicycle-model
  // FORCE input, not the scalar pSpeed integration).
  return { F_long_F: 0, F_long_R: 0 };
}

/** Per-axle tire-physics setup for one tick — μ values, cornering
 *  stiffness, and the REQUESTED lateral forces (before friction-
 *  circle clamping). Computed once per frame at this stage and
 *  consumed by the friction-circle clamps and force-integration
 *  steps downstream. */
interface TireForces {
  /** Front-axle peak friction coefficient. */
  mu_F: number;
  /** Rear-axle peak friction coefficient (includes e-brake
   *  collapse during the ebrake window). */
  mu_R: number;
  /** Front-axle cornering stiffness (game-force per radian of
   *  slip). */
  C_alpha_F: number;
  /** Rear-axle cornering stiffness. */
  C_alpha_R: number;
  /** Front-axle lateral force REQUESTED by the Pacejka-style
   *  tire curve (before friction-circle clamping). */
  F_lat_F_req: number;
  /** Rear-axle lateral force REQUESTED. */
  F_lat_R_req: number;
}

/** Compose the per-axle tire-physics inputs:
 *    1. computeMuBase (H431) — surface + fault scaling
 *    2. applyTireWidthMu (H432) — Phase 4 per-axle μ split
 *    3. applyEbrakeRearMu (H433) — rear-only collapse during
 *       ebrake window
 *    4. computeCorneringStiffness (H434) — per-axle C_α with
 *       Phase 4 tire-width scaling
 *    5. lateralTireForce(slipF, C_alpha_F) × 2 — Pacejka-style
 *       curve evaluation (already in tire.ts as
 *       lateralTireForce; falls off past slipPeak ~9.7°)
 *
 *  These are the RAW lateral force demands from the tire slip
 *  curves. The friction-circle clamp in the next pipeline
 *  stage caps each axle's F_lat to whatever budget remains
 *  after F_long allocation.
 *
 *  Internal to the orchestrator. */
function setupTireForces(
  state: Phase0BIntegratorState,
  inputs: Phase0BStepInputs,
  spec: Phase0BCarSpec,
  settings: Phase0BSettings,
  slip: SlipSetup,
): TireForces {
  // 1. mu_base: surface + fault
  const muBase = computeMuBase(
    settings.physMuBase, inputs.onGrass, inputs.onDirt,
    inputs.faults.gripMult,
  );

  // 2. Per-axle mu split with Phase 4 tire-width scaling
  let { mu_F, mu_R } = applyTireWidthMu(
    muBase, spec.gt4?.twF, spec.gt4?.twR, settings.tyreData,
  );

  // 3. E-brake collapses rear mu while pEbrakeTimer > 0
  mu_R = applyEbrakeRearMu(mu_R, state.pEbrakeTimer);

  // 4. Per-axle cornering stiffness with Phase 4 tire-width scaling
  const { C_alpha_F, C_alpha_R } = computeCorneringStiffness(
    sanitizeChassisMass(spec.mass),
    spec.gt4?.twF, spec.gt4?.twR, settings.tyreData,
  );

  // 5. Pacejka-style tire-curve evaluation per axle
  const F_lat_F_req = tireCurve(slip.slipF, C_alpha_F);
  const F_lat_R_req = tireCurve(slip.slipR, C_alpha_R);

  return { mu_F, mu_R, C_alpha_F, C_alpha_R, F_lat_F_req, F_lat_R_req };
}
