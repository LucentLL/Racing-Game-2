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
  integrateYawRate,
  applyWheelspinYawBoost,
  applyYawDamping,
  applyLowSpeedCollapse,
  updateHeadingAndRecompose,
  reprojectPSpeed,
  classifyDriftState,
  computePSlipAngle,
  applyLateralVelocityDrag,
  dampLateralVelocityAndRecompose,
  applyWorldWrap,
  DRIFT_ENTER_THRESH_DEFAULT,
  type BodyFrameVelocity,
} from './bicycleModel';
import { projectLateralToBodyFrame } from './frictionCircle';
import {
  computeEffectiveSteerInput,
  applyPowerSteeringFault,
  applyAlignmentPull,
} from './steering';
import {
  applyCollisionBounce,
  applyCollisionSlideLoss,
  computePVelAngleFromMove,
} from './collisionResponse';
import {
  tickPVelAngleFilter,
  selectCamTarget,
  tickPCamAngle,
} from './cameraOrientation';
import { SCALE_MS } from './physicsUnits';

/** Player AABB half-size in game units. Used by the position-
 *  integration step's collision queries. Matches monolith
 *  `const P_SIZE = 5` at L17921. */
const P_SIZE = 5;
import {
  computeMuBase,
  applyTireWidthMu,
  applyEbrakeRearMu,
  computeCorneringStiffness,
  EBRAKE_REAR_GRIP_WINDOW,
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

  /** H595: per-tick collision classification, set by the position-
   *  integration step's collision-response branches:
   *    - 'none'   no collision this tick (cleared at branch entry)
   *    - 'slide'  axis-separated slide (glancing impact)
   *    - 'bounce' full bounce (head-on impact, both axes blocked)
   *  Read by [[runPhase0BTick]] after the integrator returns so the
   *  adapter can fire downstream effects (player.collisionFlash,
   *  crash sound) without each effect needing its own callback in
   *  the input contract. */
  lastCollisionImpact: 'none' | 'slide' | 'bounce';
  /** H595: pre-collision absolute pSpeed at the moment the
   *  position-integration step entered its collision branches.
   *  Adapter uses this to scale crash-sound severity (player
   *  ramming a wall at 80 mph is louder than a 5-mph creep). 0
   *  when lastCollisionImpact === 'none'. */
  lastCollisionPSpeed: number;
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
    lastCollisionImpact: 'none', lastCollisionPSpeed: 0,
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

  /** 0..1 speed-ramp the caller already computes for other
   *  steering effects. Same value the legacy steering layer
   *  uses (typically `min(1, |pSpeed|/10)`, with a heavy-vehicle
   *  floor of 0.15 below 2 gu/s). The Phase 0B fault layer's
   *  alignment-pull term scales by this so pull is strongest at
   *  highway speed and absent at standstill.
   *
   *  Matches monolith `spdFactor` defined at L24640. */
  spdFactor: number;

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

  /** World dimensions in game units — used by the position-
   *  integration step's world-wrap tail. Typically `MAP_W × TILE`
   *  and `MAP_H × TILE`. */
  worldW: number;
  worldH: number;

  /** Collision detector — returns true if a chassis AABB of the
   *  given half-size at world position (x, y) would intersect a
   *  solid tile / barrier. Injected so the integrator stays
   *  decoupled from the world tilemap; caller wires the global
   *  `collide(x, y, size)` function here.
   *
   *  Pass `() => false` if you want to test the integrator
   *  without collision. */
  collide: (x: number, y: number, size: number) => boolean;

  /** Optional gamepad rumble hook — fires on collision response
   *  (axis-separated slide: 0.3/0.5/80ms; full bounce: 0.6/1.0/
   *  150ms). Skip the prop or pass undefined to suppress haptic
   *  feedback (useful for tests and the runtime-validation
   *  branch). */
  gpRumble?: (low: number, high: number, durationMs: number) => void;

  /** Optional bridge-barrier query — returns true when the
   *  proposed chassis center (x, y) at heading `ang` would have
   *  its OBB intersecting an explicit bridge barrier on the
   *  player's current layer. Layered into the position-integration
   *  step's three-tier collision response as an OR with the
   *  tile-based `collide` callback (monolith L26041 +
   *  L26046+L26052+L26058 each consult both).
   *
   *  WHEN OMITTED: the integrator's collision check uses only the
   *  tile-based `collide` callback. Matches the H492-era
   *  pre-bridge behavior (and the monolith's no-op when
   *  BRIDGE_STRUCTURES is empty). Caller wires this when the
   *  bridge-state interface is populated.
   *
   *  CALLER WIRES the player's current layer (-1 / 0 / 1) into
   *  the callback closure — the integrator doesn't carry it.
   *  Matches the existing `world/bridgeGeometry.ts bridgeBlocked`
   *  signature where layer is a position argument; the closure
   *  binds it from caller-side state (player.bridgeLayer once
   *  that field lands). */
  bridgeBlocked?: (x: number, y: number, ang: number) => boolean;

  /** True when the active vehicle is a semi WITH an attached
   *  trailer/tanker. Used by the camera-orientation selector:
   *  reversing a rigged semi follows filtered momentum so the
   *  player can see the trailer behind them during backing
   *  maneuvers; all other vehicles (including a bobtail semi)
   *  keep the camera oriented to chassis heading in reverse.
   *
   *  Matches monolith `CAR().bodyType==='semi' && !!LIFE.trailer`
   *  at L26538. */
  isSemiWithTrailer: boolean;

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
    /** Engine-stall flag (LIFE.broken && breakdownType === 'ENGINE
     *  STALL'). Applies the same PS-loss reduction curve as
     *  steerSlow — the monolith treats them as independent gates
     *  on the same multiplier (an engine stall during an active
     *  steerSlow fault stacks both reductions). */
    engineStallActive: boolean;
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

/** Phase 0B integrator tick. Runs the full thirteen-stage Phase 0B
 *  pipeline end-to-end: chassis-frame setup, slip-angle setup,
 *  tire-force setup, longitudinal-force setup, friction-circle
 *  clamps, velocity integration (long + lat with v8.99.89
 *  coupling), yaw integration (τ/I + wheelspin boost + damping +
 *  low-speed collapse), yaw fault layer (steerSlow / engineStall
 *  / steerPull), heading update + world-velocity recompose,
 *  position integration + collision response + world wrap, pSpeed
 *  reprojection + drift state + pSlipAngle, lateral velocity drag
 *  + three-tier post-damp + recompose, and camera-orientation
 *  derivation (velocity-direction filter + camTarget + smoothed
 *  pCamAngle lerp).
 *
 *  After H493, the orchestrator is FEATURE-COMPLETE for the
 *  Phase 0B branch of monolith update() at L25111-L26548 (minus
 *  the bridge-geometry consult in step 12, which is opt-in and
 *  deferred until the bridge-state interface is ported). The
 *  remaining hops wire the live runtime through this function
 *  instead of arcadeUpdate.
 *
 *  REMAINING BUILDOUT (in order):
 *    H494: feature-flag wiring to route runtime through this
 *    H495: bridge-geometry collision consult (optional;
 *          orchestrator currently treats _bridgeBlocked as
 *          always false and _bridgeUpdateLayer as a no-op) */
export function tickPhase0BIntegrator(
  state: Phase0BIntegratorState,
  inputs: Phase0BStepInputs,
  spec: Phase0BCarSpec,
  settings: Phase0BSettings,
): void {
  // === H683: e-brake timer tick — refresh to EBRAKE_REAR_GRIP_WINDOW
  // (0.75 s) while ebrk is held, decay at 1.0/s otherwise. Every site
  // in bicycleModel.ts + tireCoefficients.ts that reads pEbrakeTimer
  // (mu_R collapse, lateral-damp regime, wheelspin-yaw multiplier, yaw
  // damping tier, drift-entry tracker) depends on this — pre-H683 the
  // timer was initialized to 0 in createPhase0BIntegratorState and no
  // tick ever wrote it, so the handbrake input flowed all the way into
  // inputs.ebrk but the persistent timer-gated effects never fired and
  // pressing the e-brake had no visible effect. Runs FIRST so every
  // downstream phase sees the up-to-date timer for this frame.
  if (inputs.ebrk) {
    state.pEbrakeTimer = EBRAKE_REAR_GRIP_WINDOW;
  } else {
    state.pEbrakeTimer = Math.max(0, state.pEbrakeTimer - inputs.dt);
  }

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
  const vel = integrateVelocities(state, inputs, frame, slip, clamped);

  // === Phase 7: yaw torque + wheelspin yaw + damping + low-speed collapse ===
  const yaw = integrateYaw(state, inputs, spec, frame, clamped, vel);

  // === Phase 8: fault layer on pYawRate (steerSlow, engineStall, steerPull) ===
  applyYawFaults(state, inputs);

  // === Phase 9: heading update + world-velocity recompose ===
  recomposeHeading(state, inputs, vel, yaw);

  // === Phase 10: position integration + collision response + world wrap ===
  integratePosition(state, inputs, frame);

  // === Phase 11: pSpeed reprojection + drift state + pSlipAngle ===
  finalizeDriftState(state, inputs, settings, slip);

  // === Phase 12: lateral velocity drag + three-tier post-damp + recompose ===
  applyLateralDrag(state, inputs);

  // === Phase 13: camera-orientation tick (filter + camTarget + camAngle) ===
  tickCameraOrientation(state, inputs);
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

/** Per-tick yaw-integration result. The collapsed v_lat is what
 *  flows to H491's heading recompose and H492's lateral drag — the
 *  pYawRate value lives on state (mutated step-by-step). */
interface YawIntegration {
  /** Body-frame lateral velocity AFTER the low-speed collapse
   *  (same as vel.v_lat_new unless the car was at standstill). */
  v_lat: number;
}

/** Apply the Phase 0B yaw-integration steps: τ/I integration,
 *  wheelspin yaw boost, yaw damping (three-tier drift / grip /
 *  driver-idle), then the low-speed anti-wiggle collapse on
 *  v_lat + pYawRate.
 *
 *  COMPOSES (in monolith order):
 *    1. integrateYawRate (H460) — τ = a·F_lat_F − b·F_lat_R,
 *       pYawRate += (τ/I)·dt
 *    2. applyWheelspinYawBoost (H461) — v8.52 kinetic-friction
 *       rotation impulse (RWD only, gated on steer, ebrake-tier,
 *       surface-cap, post-drift suppression)
 *    3. applyYawDamping (H462) — three-tier damping (drift-idle
 *       0.8/s, drift-neutral 2.5/s, drift-active 0.15/s, grip
 *       0.4/s)
 *    4. applyLowSpeedCollapse (H463) — both v_lat AND pYawRate
 *       × 0.6 when truly stopped (|pSpeed| < 1 AND world spd² < 4)
 *
 *  MUTATES state.pYawRate at each step.
 *
 *  Returns {v_lat} — possibly collapsed by step 4. The caller's
 *  H491 heading-recompose step needs this value alongside the new
 *  pAngle to re-derive pVx/pVy. */
function integrateYaw(
  state: Phase0BIntegratorState,
  inputs: Phase0BStepInputs,
  spec: Phase0BCarSpec,
  frame: ChassisFrame,
  clamped: ClampedForces,
  vel: VelocityIntegration,
): YawIntegration {
  // 1. τ/I integration from per-axle lateral forces.
  state.pYawRate = integrateYawRate(
    state.pYawRate, clamped.F_lat_F, clamped.F_lat_R,
    frame.a, frame.b, frame.I, inputs.dt,
  );

  // 2. Wheelspin yaw boost — RWD-only, steer-gated, surface-
  //    capped. Uses RAW steerInput (matches monolith L25861).
  state.pYawRate = applyWheelspinYawBoost(
    state.pYawRate, state.pWheelspinRatio, spec.drivetrain,
    inputs.steerAxis, state.pEbrakeTimer, state.pDrifting,
    state.pPostDriftTimer, inputs.onGrass, inputs.onDirt,
    frame.b, clamped.F_circle_R, frame.I, inputs.dt,
  );

  // 3. Yaw damping — three-tier (drift-idle / drift-neutral /
  //    drift-active / grip) using RAW steerInput (matches monolith
  //    L25965 _steerNeutralYaw / _driverIdle gates).
  state.pYawRate = applyYawDamping(
    state.pYawRate, inputs.steerAxis, state.pDrifting,
    inputs.gas, inputs.ebrk, inputs.dt,
  );

  // 4. Low-speed collapse — both v_lat AND pYawRate decay at
  //    standstill. Uses post-rotation state.pVx/pVy from H489's
  //    longitudinal recompose (the world-velocity gate the
  //    monolith uses at L25984).
  const collapsed = applyLowSpeedCollapse(
    vel.v_lat_new, state.pYawRate,
    state.pSpeed, state.pVx, state.pVy,
  );
  state.pYawRate = collapsed.pYawRate;

  return { v_lat: collapsed.v_lat };
}

/** Apply the Phase 0B fault layer on pYawRate (monolith step 10).
 *  Three independent gates, all writing through the same
 *  speed-scaled PS-loss reduction or alignment-pull offset:
 *
 *    1. steerSlow (power-steering-loss fault) — applies
 *       [[applyPowerSteeringFault]] (1 - 0.6 × low-speed ramp)
 *    2. engineStallActive (engine stall kills the PS pump) —
 *       same reduction curve as steerSlow, stacks independently
 *    3. steerPull (alignment fault) — additive offset via
 *       [[applyAlignmentPull]] (signed pull × spdFactor × 0.10),
 *       gated on absSpd > 3
 *
 *  MUTATES state.pYawRate at each gate that fires.
 *
 *  WHY THE TWO PS-LOSS GATES STACK: the monolith treats them as
 *  separate conditions (L25994 + L25999), each multiplying
 *  pYawRate by the same low-speed ramp. An engine stall during
 *  an active steerSlow fault therefore applies the reduction
 *  TWICE — the effective rate at 0 mph drops to 0.4 × 0.4 = 0.16.
 *  That's a 1:1 port of the monolith's compounding behavior, not
 *  a refactor target.
 *
 *  Internal to the orchestrator. Composed monolith range
 *  L25984-L26005. */
function applyYawFaults(
  state: Phase0BIntegratorState,
  inputs: Phase0BStepInputs,
): void {
  const absSpd = Math.abs(state.pSpeed);

  if (inputs.faults.steerSlow) {
    state.pYawRate = applyPowerSteeringFault(state.pYawRate, absSpd, SCALE_MS);
  }
  if (inputs.faults.engineStallActive) {
    state.pYawRate = applyPowerSteeringFault(state.pYawRate, absSpd, SCALE_MS);
  }
  state.pYawRate = applyAlignmentPull(
    state.pYawRate, inputs.faults.steerPull, inputs.spdFactor, absSpd,
  );
}

/** Advance the chassis heading and recompose world velocity —
 *  monolith step 11 (L26009-L26012). Mutates state.pAngle, pVx,
 *  pVy from the post-yaw + post-faults pYawRate plus the
 *  body-frame v_long_new (from H489) and post-collapse v_lat
 *  (from H490). */
function recomposeHeading(
  state: Phase0BIntegratorState,
  inputs: Phase0BStepInputs,
  vel: VelocityIntegration,
  yaw: YawIntegration,
): void {
  const heading = updateHeadingAndRecompose(
    state.pAngle, state.pYawRate, inputs.dt,
    vel.v_long_new, yaw.v_lat,
  );
  state.pAngle = heading.pAngle;
  state.pVx = heading.pVx;
  state.pVy = heading.pVy;
}

/** Apply pSpeed reprojection + drift-state classification +
 *  pSlipAngle update — monolith steps 13 and 14 (L26084-L26146).
 *  Runs AFTER the position integration step has settled pVx/pVy
 *  (collision response can shrink them) AND updated pVelAngle
 *  from the actual committed displacement.
 *
 *  COMPOSES:
 *    1. reprojectPSpeed (H465) — gentle blend of pSpeed toward
 *       the longitudinal projection of world velocity (0.02/frame
 *       grip, 0.005/frame drift, downward blend gated on !gas)
 *    2. classifyDriftState (H466) — slip-threshold hysteresis
 *       with e-brake override + post-drift recovery window,
 *       gated on absSpd OR worldSpd > 5
 *    3. computePSlipAngle (H467) — pAngle − pVelAngle wrapped
 *       to (−π, π]
 *
 *  MUTATES state.pSpeed (step 1); state.pDrifting,
 *  state.pPostDriftTimer (step 2); state.pSlipAngle (step 3).
 *
 *  Internal to the orchestrator. */
function finalizeDriftState(
  state: Phase0BIntegratorState,
  inputs: Phase0BStepInputs,
  settings: Phase0BSettings,
  slip: SlipSetup,
): void {
  // 1. Re-project pSpeed from world velocity (gentle blend, slower
  //    during drift, downward blend gated on !gas).
  state.pSpeed = reprojectPSpeed(
    state.pSpeed, state.pVx, state.pVy, state.pAngle,
    state.pDrifting, inputs.gas,
  );

  // 2. Drift-state classification — slip-threshold hysteresis with
  //    e-brake override and post-drift recovery window. The
  //    settings.physDriftEnterThresh override falls back to 0.26
  //    rad (the v8.99.59 tuned value); 0 is treated as "unset" to
  //    match the monolith's `||0.26` idiom at L26121.
  const driftEnterThresh = settings.physDriftEnterThresh || DRIFT_ENTER_THRESH_DEFAULT;
  const absSpd = Math.abs(state.pSpeed);
  const worldSpd = Math.sqrt(state.pVx * state.pVx + state.pVy * state.pVy);
  const drift = classifyDriftState(
    slip.slipF, slip.slipR,
    state.pDrifting, state.pPostDriftTimer,
    absSpd, worldSpd,
    state.pEbrakeTimer, driftEnterThresh,
  );
  state.pDrifting = drift.pDrifting;
  state.pPostDriftTimer = drift.pPostDriftTimer;

  // 3. pSlipAngle = pAngle - pVelAngle (wrapped). pVelAngle was
  //    just updated by integratePosition from the actual committed
  //    displacement, so this reflects the post-tick body-vs-
  //    velocity offset for HUD/skidmark/audio consumers.
  state.pSlipAngle = computePSlipAngle(state.pAngle, state.pVelAngle);
}

/** Integrate position (px/py) from the world-frame velocity with
 *  three-tier collision response, then apply world-wrap at the
 *  tail — monolith step 12 (L26033-L26077) plus the world-wrap
 *  block at L26356-L26365.
 *
 *  THREE-TIER COLLISION RESPONSE (severity-ordered):
 *    1. Free move — neither nx nor ny collides. Accept the full
 *       velocity-driven displacement; pVelAngle derived from the
 *       committed (nx − oldPx, ny − oldPy) via
 *       [[computePVelAngleFromMove]] (falls back to pAngle for
 *       sub-threshold displacement).
 *    2. Axis-separated slide — (nx, py) OR (px, ny) is clear.
 *       Accept the unblocked-axis move, scale pSpeed / pVx / pVy
 *       by 0.6 ([[applyCollisionSlideLoss]]), pVelAngle derived
 *       from the axis-projected displacement, fire 0.3/0.5/80ms
 *       rumble.
 *    3. Full bounce — both axis-separated moves are blocked.
 *       Scale velocity by -0.2, snap small pSpeed to 0, scale
 *       pYawRate by 0.3 ([[applyCollisionBounce]]), fire
 *       0.6/1.0/150ms rumble. Position stays at oldPx/oldPy
 *       (no committed move) so pVelAngle stays at the previous
 *       frame's value.
 *
 *  REAR-AXLE TRACKING: pRearX/pRearY tracks the CG by a rigid
 *  half-wheelbase offset along heading. After every commit
 *  (free, slide, or bounce), the rear axle is re-derived from
 *  the new CG + heading. The monolith uses `halfL = Lwb * 0.5`
 *  (geometric mid-wheelbase) regardless of weight distribution
 *  (CG could be closer to one axle, but rear-axle TRACKING is
 *  geometric). Frame.b (the dynamic CG → rear offset) is NOT
 *  used here — the 1:1 monolith match uses halfL.
 *
 *  WORLD-WRAP TAIL: [[applyWorldWrap]] handles edge crossings
 *  (px < 0, px ≥ worldW, etc.). On a wrap, pDyn0BInit is
 *  cleared so the Phase 0B per-axle velocity derivation re-seeds
 *  on the next eligible frame (avoids the numerical jump from a
 *  teleported rearX/rearY in the velocity differential).
 *
 *  BRIDGE GEOMETRY DEFERRED: the monolith also consults
 *  `_bridgeBlocked(...)` and `_bridgeUpdateLayer(...)` for OBB
 *  vs explicit bridge barriers + trigger crossings. That feature
 *  ships with bridge-structure data (BRIDGE_STRUCTURES); when
 *  empty, _bridgeBlocked returns false and the system is a
 *  no-op. The orchestrator defers wiring it until the bridge-
 *  state interface is ported in a later hop.
 *
 *  MUTATES state.px, state.py, state.pRearX, state.pRearY,
 *  state.pVelAngle (always); state.pSpeed, state.pVx, state.pVy
 *  (on collision); state.pYawRate (on full bounce);
 *  state.pDyn0BInit (cleared if world-wrap fires).
 *
 *  Internal to the orchestrator. */
function integratePosition(
  state: Phase0BIntegratorState,
  inputs: Phase0BStepInputs,
  frame: ChassisFrame,
): void {
  const halfL = frame.wheelbase * 0.5;
  const oldPx = state.px;
  const oldPy = state.py;
  const nx = state.px + state.pVx * inputs.dt;
  const ny = state.py + state.pVy * inputs.dt;

  // H505: combined blocker — tile-based collide OR the optional
  // bridge-barrier query (when wired by the caller). The monolith
  // composes these with logical AND on the NEGATED check at
  // L26041 + L26046 + L26052 + L26058:
  //   if (!collide(nx,ny,P_SIZE) && !_bridgeBlocked(nx,ny,pAngle,_layer))
  // Pulled into a local lambda so the four-branch collision response
  // below reads cleanly. bridgeBlocked closure binds the caller's
  // current player layer; pAngle for the OBB check is state.pAngle
  // (already the post-yaw value, since this Phase 10 step runs
  // after the Phase 9 heading recompose).
  const isBlocked = (x: number, y: number): boolean =>
    inputs.collide(x, y, P_SIZE)
    || (inputs.bridgeBlocked?.(x, y, state.pAngle) ?? false);

  // H595: reset per-tick collision classification at branch entry.
  // The adapter reads lastCollisionImpact / lastCollisionPSpeed
  // after the integrator returns, so a free-move frame must clear
  // these to 'none'/0 to avoid stuttered flashes on the frame
  // after a hit.
  state.lastCollisionImpact = 'none';
  state.lastCollisionPSpeed = 0;
  const preCollisionAbsSpeed = Math.abs(state.pSpeed);
  if (!isBlocked(nx, ny)) {
    // Free move — full velocity-driven displacement.
    state.px = nx;
    state.py = ny;
    state.pVelAngle = computePVelAngleFromMove(oldPx, oldPy, nx, ny, state.pAngle);
    state.pRearX = state.px - Math.cos(state.pAngle) * halfL;
    state.pRearY = state.py - Math.sin(state.pAngle) * halfL;
  } else if (!isBlocked(nx, state.py)) {
    // Axis-separated slide — X axis clear, Y axis blocked.
    state.px = nx;
    const slid = applyCollisionSlideLoss(state.pSpeed, state.pVx, state.pVy);
    state.pSpeed = slid.pSpeed;
    state.pVx = slid.pVx;
    state.pVy = slid.pVy;
    state.pVelAngle = computePVelAngleFromMove(oldPx, oldPy, state.px, state.py, state.pAngle);
    state.pRearX = state.px - Math.cos(state.pAngle) * halfL;
    state.pRearY = state.py - Math.sin(state.pAngle) * halfL;
    inputs.gpRumble?.(0.3, 0.5, 80);
    state.lastCollisionImpact = 'slide';
    state.lastCollisionPSpeed = preCollisionAbsSpeed;
  } else if (!isBlocked(state.px, ny)) {
    // Axis-separated slide — Y axis clear, X axis blocked.
    state.py = ny;
    const slid = applyCollisionSlideLoss(state.pSpeed, state.pVx, state.pVy);
    state.pSpeed = slid.pSpeed;
    state.pVx = slid.pVx;
    state.pVy = slid.pVy;
    state.pVelAngle = computePVelAngleFromMove(oldPx, oldPy, state.px, state.py, state.pAngle);
    state.pRearX = state.px - Math.cos(state.pAngle) * halfL;
    state.pRearY = state.py - Math.sin(state.pAngle) * halfL;
    inputs.gpRumble?.(0.3, 0.5, 80);
    state.lastCollisionImpact = 'slide';
    state.lastCollisionPSpeed = preCollisionAbsSpeed;
  } else {
    // Full bounce — position stays put; reverse velocity at 20 %,
    // soft-zero small pSpeed, damp yaw to 30 %.
    const bounced = applyCollisionBounce(
      state.pSpeed, state.pVx, state.pVy, state.pYawRate,
    );
    state.pSpeed = bounced.pSpeed;
    state.pVx = bounced.pVx;
    state.pVy = bounced.pVy;
    state.pYawRate = bounced.pYawRate;
    // pVelAngle unchanged — no committed displacement to derive
    // from (matches monolith: the bounce branch doesn't touch
    // pVelAngle at L26069-L26075).
    state.pRearX = state.px - Math.cos(state.pAngle) * halfL;
    state.pRearY = state.py - Math.sin(state.pAngle) * halfL;
    inputs.gpRumble?.(0.6, 1.0, 150);
    state.lastCollisionImpact = 'bounce';
    state.lastCollisionPSpeed = preCollisionAbsSpeed;
  }

  // World-wrap tail (monolith L26356-L26365). Clears pDyn0BInit
  // on wrap so the per-axle velocity derivation re-seeds cleanly
  // on the next eligible frame (the teleport would otherwise
  // produce a spurious velocity differential).
  const wrap = applyWorldWrap(
    state.px, state.py, state.pRearX, state.pRearY,
    inputs.worldW, inputs.worldH,
  );
  state.px = wrap.px;
  state.py = wrap.py;
  state.pRearX = wrap.pRearX;
  state.pRearY = wrap.pRearY;
  if (wrap.wrapped) state.pDyn0BInit = false;
}

/** Apply the Phase 0B lateral-velocity drag — monolith step 15
 *  (L26163-L26241). Two stages:
 *
 *    1. applyLateralVelocityDrag (H468) — pSpeed bleed from
 *       sideways motion. Quadratic in v_lat × driftMult ×
 *       throttle (0.2× drift+throttle, 2.2× drift off-throttle,
 *       1.0× grip), with a sign-aware cross-zero clamp so the
 *       drag never spins pSpeed backward.
 *    2. dampLateralVelocityAndRecompose (H469) — three-tier
 *       post-integration v_lat damping (0.3/s ebrk-active,
 *       0.8/s drift, 5.0/s grip) plus world-frame recompose
 *       using projLong + damped v_lat. The recompose uses the
 *       SAME projLong formula reprojectPSpeed computes inside;
 *       recomputed here since the helper doesn't return it.
 *
 *  WHY ALWAYS APPLIES (not gated on pDrifting): per the
 *  monolith comment block, ANY sideways motion costs scrubbing
 *  energy. Without this, ebrake taps below the drift threshold
 *  could rotate the car without bleeding speed — players would
 *  U-turn at highway speed by spamming ebrake. The v² shape
 *  ensures straight-line tracking costs nothing.
 *
 *  WHY THE LIVE ebrk INPUT (NOT pEbrakeTimer): v8.99.124.04
 *  rewrote the damping gate to use the live ebrk press flag.
 *  Pre-v8.99.124.04 used pEbrakeTimer, which auto-bumped to
 *  0.4 every frame during throttle-sustain drift — combined
 *  with mu_R collapse, v_lat formed a stable orbit with
 *  pYawRate, donuts didn't decay, counter-flicks had no
 *  authority. The live press now decides slide-pull regime;
 *  pEbrakeTimer still drives mu_R collapse (drift feel) but
 *  damping no longer follows it.
 *
 *  MUTATES state.pSpeed (step 1); state.pVx, state.pVy (step 2).
 *
 *  Internal to the orchestrator. */
function applyLateralDrag(
  state: Phase0BIntegratorState,
  inputs: Phase0BStepInputs,
): void {
  // 1. pSpeed lateral-drag bleed (quadratic in v_lat, drift-
  //    and throttle-scaled, cross-zero-clamped).
  state.pSpeed = applyLateralVelocityDrag(
    state.pSpeed, state.pVx, state.pVy, state.pAngle,
    state.pDrifting, inputs.gas, inputs.dt,
  );

  // 2. Three-tier post-integration v_lat damping + world recompose.
  //    projLong is the same value reprojectPSpeed computes
  //    internally — recomputed here since the helper doesn't
  //    return it (and reprojectPSpeed wrote pSpeed, which doesn't
  //    affect pVx/pVy/pAngle that projLong depends on).
  const projLong = state.pVx * Math.cos(state.pAngle)
                 + state.pVy * Math.sin(state.pAngle);
  const recomposed = dampLateralVelocityAndRecompose(
    state.pVx, state.pVy, state.pAngle, projLong,
    state.pDrifting, inputs.ebrk, inputs.dt,
  );
  state.pVx = recomposed.pVx;
  state.pVy = recomposed.pVy;
}

/** Tick the camera-orientation derivation — monolith step at
 *  L26518-L26548 (runs OUTSIDE the bicycle-model conditional in
 *  the monolith; in the orchestrator it runs as the final stage
 *  whenever the Phase 0B branch took ownership of this frame).
 *
 *  COMPOSES (in order):
 *    1. tickPVelAngleFilter (H478) — low-pass pVelAngle into
 *       pVelAngleFiltered (10/s grip, 14/s drift)
 *    2. selectCamTarget (H479) — three-branch selector:
 *       chassis heading when slow OR reversing-not-semi-with-
 *       trailer; filtered velocity otherwise
 *    3. tickPCamAngle (H480) — exponential lerp of pCamAngle
 *       toward camTarget (6/s grip, 4/s drift — INVERTED from
 *       the filter rates by design; see CAM_LERP_RATE_DRIFT
 *       docstring for the "drift cinema feel" rationale)
 *
 *  MUTATES state.pVelAngleFiltered (step 1); state.pCamAngle
 *  (step 3). camTarget is a transient local consumed only by
 *  step 3.
 *
 *  Internal to the orchestrator. */
function tickCameraOrientation(
  state: Phase0BIntegratorState,
  inputs: Phase0BStepInputs,
): void {
  state.pVelAngleFiltered = tickPVelAngleFilter(
    state.pVelAngleFiltered, state.pVelAngle, state.pDrifting, inputs.dt,
  );
  const camTarget = selectCamTarget(
    state.pAngle, state.pVelAngleFiltered, state.pSpeed,
    inputs.isSemiWithTrailer,
  );
  state.pCamAngle = tickPCamAngle(
    state.pCamAngle, camTarget, state.pDrifting, inputs.dt,
  );
}

/** Final per-axle force state after friction-circle clamping —
 *  what the integrator uses for force application. Also carries
 *  the rear-axle friction-circle radius (F_circle_R) so the
 *  wheelspin-yaw boost in H490 can scale its impulse by the
 *  total grip the rear had to play with. */
interface ClampedForces {
  F_long_F: number;
  F_long_R: number;
  F_lat_F: number;
  F_lat_R: number;
  /** Rear-axle friction-circle radius (μ_R · Fz_R). Same value
   *  computeFrictionCircle returns — passed through so the
   *  yaw-integration stage doesn't re-derive Fz_R / μ_R. */
  F_circle_R: number;
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
    F_circle_R: fc.F_circle_R,
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
