/**
 * Phase 0B integrator runtime adapter — the lifecycle owner.
 *
 * H501: this is the dispatcher the runtime cutover (H502) will call
 * each frame instead of arcadeUpdate, when the feature flag is on.
 * It owns:
 *
 *   - Feature-flag gating ([[shouldUsePhase0B]])
 *   - Per-frame settings projection from LIFE.gameplaySettings into
 *     the integrator's [[Phase0BSettings]] shape
 *     ([[buildPhase0BSettings]])
 *   - Lazy initialization of player.phase0B sub-object on the first
 *     eligible frame
 *   - State sync from PlayerState → Phase0BIntegratorState at the
 *     head of each tick (other gameplay code may have mutated
 *     pose-level fields since last tick)
 *   - Eligibility check via [[isBicycleModelEligible]]; ineligible
 *     frames return `tookOwnership: false` so the caller can fall
 *     back to arcadeUpdate
 *   - Building [[Phase0BStepInputs]] from input / surface / faults /
 *     spec — calling [[computeDesiredYawRate]] for the pAngVel,
 *     [[computeMassDamp]] for the rotational-inertia scalar,
 *     [[computeEffectiveSteerInput]] for the post-sensitivity steer
 *   - Calling [[tickPhase0BIntegrator]]
 *   - State sync from Phase0BIntegratorState → PlayerState at the
 *     tail of each tick (render code reads PlayerState's flat fields)
 *
 * This module is importable but UNUSED until H502 wires it into
 * gameLoop.drawPlaying. Until then the legacy arcadeUpdate path
 * continues to own the tick.
 */

import type { PlayerState } from '@/state/player';
import type { InputState } from '@/state/input';
import type { CatalogCar } from '@/config/cars/catalog';
import type { LifeState } from '@/state/life';
import type { TileMap } from '@/world/tileMap';
import type { FaultEffects } from '@/sim/faultEffects';

import {
  createPhase0BIntegratorState,
  tickPhase0BIntegrator,
  type Phase0BIntegratorState,
  type Phase0BStepInputs,
  type Phase0BSettings,
} from './phase0BIntegrator';
import { isBicycleModelEligible } from './bicycleModel';
import { buildPhase0BCarSpec, computeCarTurnRate } from './phase0BCatalogAdapter';
import { GT4_SPECS } from '@/config/cars/gt4Database';
import { buildPhase0BFaults } from './phase0BFaultsAdapter';
import {
  computeMassDamp,
  computeDesiredYawRate,
  computeEffectiveSteerInput,
} from './steering';
import { isOnGrass, isOnDirt, collide } from '@/world/tileMap';
import { MAP_W, MAP_H, TILE } from '@/config/world/tiles';
import { bridgeBlocked, bridgeMinBarrierDist } from '@/world/bridgeGeometry';
import { getSteerSens } from '@/input/steerSens';
import { BRIDGE_STRUCTURES, playerBridgeLayer } from '@/world/bridgeRuntime';
import { effectiveTopSpeed } from './topSpeedCap';
import { gpRumble } from '@/input/gamepad';
import { playCrashSound } from '@/engine/audio/sfx';

// H503: per-car turnRate is now derived via computeCarTurnRate (the
// 1:1 port of the monolith's L7390-L7437 derivation). The previous
// DEFAULT_TURN_RATE = 2.5 constant is removed — every eligible car
// gets its real catalog/GT4-spec-derived value now.

/** Default steering-sensitivity slider value (caller's range is
 *  0.5..2.0; centered at 1.0 = no scaling). Fallback when the OPT
 *  panel hasn't written a per-input-type key onto
 *  gameplaySettings yet (fresh save, pre-H560 saves). */
const DEFAULT_SENS_SLIDER = 1.0;
void DEFAULT_SENS_SLIDER;

/** H819: delegate to the shared resolver so the physics read the SAME
 *  key the OPT slider writes (touch vs pad). Previously hardcoded to
 *  padSteerSens, which the slider didn't write on touch-capable
 *  devices → the slider did nothing. */
function resolveSensSlider(life: LifeState): number {
  return getSteerSens(life);
}

/** Heavy-vehicle threshold (kg) for the spdFactor floor —
 *  vehicles ≥3000 kg at <2 gu/s get spdFactor clamped to ≥0.15 so
 *  semi/box-truck parking-lot maneuvering still has some steering
 *  authority. Matches monolith L24652. */
const HEAVY_VEHICLE_THRESHOLD_KG = 3000;
/** Speed (gu/s) below which the heavy-vehicle spdFactor floor
 *  engages. Matches monolith `absSpd < 2` at L24652. */
const HEAVY_VEHICLE_LOW_SPEED_GATE = 2;
/** Floor value for the heavy-vehicle spdFactor clamp. 15% of full
 *  stick → ~3°/s cab yaw at standstill, enough to shuffle a
 *  trailer's articulation in a parking lot. Matches monolith
 *  L24654. */
const HEAVY_VEHICLE_SPDFACTOR_FLOOR = 0.15;

/** Speed (gu/s) above which the `isThrottle` gate fires. The
 *  monolith composes `isThrottle = gas && !brake && absSpd > 3`
 *  at L24164 — see that constant's docstring on [[DesiredYawRateInputs]].
 *  Matches monolith `absSpd > 3`. */
const IS_THROTTLE_SPEED_GATE = 3;

/** Read the feature flag — true when both `bicycleModel` and
 *  `dynPhysics0B` gameplay settings are enabled. The runtime
 *  dispatcher in H502 will check this before routing through the
 *  adapter; when false, the arcadeUpdate path keeps ownership.
 *
 *  Returns false defensively when life or the gameplaySettings
 *  sub-object is missing (pre-LIFE start-flow path). */
export function shouldUsePhase0B(life: LifeState | undefined): boolean {
  const gp = life?.gameplaySettings;
  if (!gp) return false;
  return !!gp.bicycleModel && !!gp.dynPhysics0B;
}

/** Pull a numeric override out of LIFE.gameplaySettings, returning
 *  the default when the slot is absent OR contains a non-number
 *  (booleans / undefined). The gameplaySettings index signature
 *  is `number | boolean | undefined`, so a `|| default` idiom
 *  would incorrectly coerce `false` → default and `true` → 1; the
 *  explicit typeof check is the right move. */
function numericSetting(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

/** Project LIFE.gameplaySettings into the integrator's
 *  [[Phase0BSettings]] shape. All the integrator's master enables +
 *  numeric tuning overrides map through directly; the supercharger
 *  flag defaults to true (matches monolith `gp.supercharger !== false`
 *  pattern at L24684 — opt-out rather than opt-in). */
export function buildPhase0BSettings(life: LifeState): Phase0BSettings {
  const gp = life.gameplaySettings;
  return {
    bicycleModel: !!gp.bicycleModel,
    dynPhysics0B: !!gp.dynPhysics0B,
    suspension: !!gp.suspension,
    chassisI: !!gp.chassisI,
    downforce: !!gp.downforce,
    lsd: !!gp.lsd,
    tyreData: !!gp.tyreData,
    physDriftEnterThresh: numericSetting(gp.physDriftEnterThresh, 0),
    physMuBase: numericSetting(gp.physMuBase, 0),
    physMassMomentum: numericSetting(gp.physMassMomentum, 0),
    physMomentumCoef: numericSetting(gp.physMomentumCoef, 0),
    // H849: brake-to-drift on by default (game-feel brief). Default 1.0
    // when unset; a saved 0 disables it (pure sim).
    physBrakeDrift: numericSetting(gp.physBrakeDrift, 1),
    // H853: arcade-assist auto-countersteer. Mild 0.3 by default (the
    // "arcade-ish, forgiving" target); a saved 0 makes it pure sim.
    physArcadeAssist: numericSetting(gp.physArcadeAssist, 0.3),
    supercharger: gp.supercharger !== false,
  };
}

/** Sync the gameplay-relevant fields from the integrator's
 *  authoritative state back into PlayerState for render consumers.
 *
 *  WHAT'S COPIED: the eight fields PlayerState exposes that the
 *  integrator owns when the Phase 0B branch is active —
 *    px, py        position
 *    pAngle        heading
 *    pSpeed        scalar speed
 *    pCamAngle     smoothed camera-orientation angle
 *    drifting      drift state flag
 *    slipAngle     chassis-vs-velocity offset (rad)
 *    wheelspinRatio  saturation 0..1
 *
 *  WHAT'S NOT: pRpm and prevGear stay owned by gameLoop's
 *  tickGearAndRpm step (the integrator carries pRpm / pGear as
 *  read-only state for its own internal use, but doesn't update
 *  them). fuel / collisionFlash / pRevIntent / manualGear /
 *  manualGearTimer / layerZ / wheelGap stay on PlayerState alone —
 *  the integrator doesn't model them. */
function syncIntegratorStateToPlayer(
  state: Phase0BIntegratorState,
  player: PlayerState,
): void {
  player.px = state.px;
  player.py = state.py;
  player.pAngle = state.pAngle;
  player.pSpeed = state.pSpeed;
  player.pCamAngle = state.pCamAngle;
  player.drifting = state.pDrifting;
  player.slipAngle = state.pSlipAngle;
  player.wheelspinRatio = state.pWheelspinRatio;
}

/** Result of a single integrator-adapter tick. `tookOwnership=true`
 *  means the integrator advanced position / velocity / heading
 *  this frame; `false` means it deferred to the legacy path
 *  (caller should call arcadeUpdate). */
export interface Phase0BTickResult {
  tookOwnership: boolean;
}

/** Run one Phase 0B integrator tick if the bicycle-model branch is
 *  eligible this frame; otherwise defer to the caller's legacy
 *  fallback.
 *
 *  Returns {tookOwnership: true} when the integrator owned the
 *  frame's px/py/pAngle/pSpeed/etc. updates; the caller must NOT
 *  also call arcadeUpdate or the position will double-step.
 *
 *  Returns {tookOwnership: false} when eligibility failed (bike,
 *  non-GT4, drift state with dynPhysics0B off, low speed, etc.).
 *  The integrator's chassis-frame setup runs unconditionally
 *  inside tickPhase0BIntegrator's Phase 1 step BEFORE the
 *  eligibility check — so state.pFzTransfer + state.pPrevSpeed
 *  stay current — but the integrator's later phases bail and the
 *  caller's arcadeUpdate fallback advances the motion fields
 *  instead.
 *
 *  CALLER GUARANTEES (or undefined behavior):
 *    - shouldUsePhase0B(life) must have returned true; this adapter
 *      doesn't re-check the master feature flag.
 *    - activeCar must be a populated CatalogCar (no pre-LIFE
 *      start-flow path — caller short-circuits to arcadeUpdate
 *      when activeCar is undefined).
 *    - life must be defined (settings + faults sourced from it).
 *
 *  STATE MUTATIONS:
 *    - player.phase0B: lazy-created on first call; never torn down.
 *    - player.px / py / pAngle / pSpeed / pCamAngle / drifting /
 *      slipAngle / wheelspinRatio: synced from state when
 *      tookOwnership=true.
 *    - player.phase0B.*: any field tickPhase0BIntegrator mutates. */
export function runPhase0BTick(
  player: PlayerState,
  input: InputState,
  dt: number,
  activeCar: CatalogCar,
  life: LifeState,
  tileMap: TileMap,
  faultEffects: FaultEffects,
): Phase0BTickResult {
  const spec = buildPhase0BCarSpec(activeCar);
  // H585: apply the OPT Top Speed Cap to the spec the integrator
  // consumes. effectiveTopSpeed returns the catalog topSpeed when
  // the OPT slider is unset, so this is a no-op for pre-H585
  // saves / fresh games.
  spec.topSpeed = effectiveTopSpeed(activeCar, life);
  const settings = buildPhase0BSettings(life);

  // Lazy-init phase0B state on first frame the adapter runs.
  if (!player.phase0B) {
    player.phase0B = createPhase0BIntegratorState(
      player.px, player.py, player.pAngle, player.pSpeed,
    );
  }
  const state = player.phase0B;

  // Sync pose-level fields from PlayerState in case other gameplay
  // code (cutscene teleport, respawn, etc.) mutated them since
  // last tick.
  state.px = player.px;
  state.py = player.py;
  state.pAngle = player.pAngle;
  state.pSpeed = player.pSpeed;

  const absSpd = Math.abs(state.pSpeed);
  const worldSpd = Math.sqrt(state.pVx * state.pVx + state.pVy * state.pVy);

  // Eligibility check — bail to legacy if not eligible. The
  // integrator's internal Phase 2 setupSlipAndDelta makes the
  // same check; pre-checking here lets us short-circuit the
  // inputs-building cost when the branch wouldn't fire anyway.
  const eligible = isBicycleModelEligible(
    spec.isBike, settings.dynPhysics0B, state.pDrifting, spec.isGt4,
    /* hasTrailer */ false, absSpd, worldSpd, settings.bicycleModel,
  );
  if (!eligible) {
    return { tookOwnership: false };
  }

  // ===== Build per-frame scalars =====
  const massDamp = computeMassDamp(spec.mass, /* trailerLoadWeight */ null);
  const speedRatio = Math.min(1, absSpd / spec.topSpeed);
  let spdFactor = Math.min(1, absSpd / 10);
  if (spec.mass >= HEAVY_VEHICLE_THRESHOLD_KG && absSpd < HEAVY_VEHICLE_LOW_SPEED_GATE) {
    spdFactor = Math.max(spdFactor, HEAVY_VEHICLE_SPDFACTOR_FLOOR);
  }
  // H582: read the live OPT steering-sens slider from
  // gameplaySettings.padSteerSens (clamped to [0.5, 2.0]). Player
  // tuning from OPT now actually scales steering input.
  const sensSlider = resolveSensSlider(life);
  const steerInputEff = computeEffectiveSteerInput(
    input.steerAxis, spec.isBike, sensSlider,
  );
  const isThrottle = input.gas && !input.brake && absSpd > IS_THROTTLE_SPEED_GATE;
  const onGrass = isOnGrass(tileMap, state.px, state.py);
  const onDirt = isOnDirt(tileMap, state.px, state.py);
  const faults = buildPhase0BFaults(faultEffects, life.broken, life.breakdownType);

  // ===== Compute upstream desired yaw rate (pAngVel) =====
  // H503: per-car turnRate from the 1:1 monolith derivation
  // (baseTurn × wb / grip / yaw / tire / susp factors / chassis-
  // length inertia). Replaces the 2.5 rad/s placeholder constant
  // from H501; cars now respond with their real catalog tuning.
  const turnRate = computeCarTurnRate(activeCar, GT4_SPECS[activeCar.name]);
  const pAngVel = computeDesiredYawRate({
    steerInputEff,
    steerInput: input.steerAxis,
    pDrifting: state.pDrifting,
    pSpeed: state.pSpeed,
    slipAngle: state.pSlipAngle,
    turnRate,
    drivetrain: spec.drivetrain,
    speedRatio, spdFactor, massDamp, absSpd,
    gas: input.gas, brake: input.brake,
    brakeAmount: input.brake ? 1 : 0,
    isThrottle,
    onGrass, hasTrailer: false,
    steerSlow: faults.steerSlow,
    engineStallActive: faults.engineStallActive,
    steerPull: faults.steerPull,
  });

  // ===== Build the integrator's per-frame inputs =====
  const inputs: Phase0BStepInputs = {
    gas: input.gas,
    brake: input.brake,
    ebrk: input.ebrk,
    steerAxis: input.steerAxis,
    // Use the analog amounts from mergeInputs instead of the boolean
    // 0/1 collapse. Without this, partial pedal travel produced full-
    // throttle accel + full-brake decel in the integrator path even
    // after the arcade-tier fix — user reported 25 % gas → burnout.
    // Fall back to the boolean when amounts are undefined (legacy
    // InputState shapes from tests / external callers).
    brakeAmount: input.brake ? Math.max(0, Math.min(1, input.brakeAmount ?? 1)) : 0,
    gasAmount:   input.gas   ? Math.max(0, Math.min(1, input.gasAmount   ?? 1)) : 0,
    pAngVel,
    sensSlider,
    spdFactor,
    isManual: life.isManual,
    isWelded: life.welded,
    supercharged: life.supercharged,
    dt,
    onGrass, onDirt,
    faults,
    worldW: MAP_W * TILE,
    worldH: MAP_H * TILE,
    collide: (x, y, size) => collide(tileMap, x, y, size),
    // H799: bridge parapet barriers participate in the integrator's
    // native axis-separated collision (slide at 0.6× along the clear
    // axis, 20% bounce when cornered) — monolith L26041-L26075 parity.
    // H785's post-tick hard revert (position snap + pSpeed = 0) made
    // every rail brush a dead stop; gameLoop now skips that fallback
    // when this integrator owns the frame. Layer binds at call time so
    // mid-frame trigger flips (handled post-tick) see the next frame.
    //
    // ANTI-WEDGE CLEARANCE RULE (H800, replaces the H799 blanket
    // hatch): yaw integrates without collision (monolith parity), so
    // the nose can ROTATE into a rail until the OBB overlaps at the
    // CURRENT position — then every probed move (even away) re-detects
    // the same overlap and the car wedges permanently. The H799 hatch
    // (suspend blocking entirely while overlapped) let the player ram
    // THROUGH the parapet on the second attempt. Now, while overlapped,
    // a probed move is blocked only if it brings the car CLOSER to the
    // nearest rail: backing out / sliding along stays possible, pushing
    // through stays blocked.
    bridgeBlocked: bridgeBlocked(
      state.px, state.py, state.pAngle,
      playerBridgeLayer.layer, BRIDGE_STRUCTURES, TILE,
      // H839: rail OBB = the actual car half-size (was fixed 17×10).
      activeCar.size[0] / 2, activeCar.size[1] / 2,
    )
      ? ((): ((x: number, y: number, ang: number) => boolean) => {
          const dNow = bridgeMinBarrierDist(
            state.px, state.py, playerBridgeLayer.layer, BRIDGE_STRUCTURES, TILE,
          );
          // STRICT decrease blocks. Any per-substep tolerance ratchets:
          // dNow re-anchors at the crept position every substep, so a
          // shallow-angle ram whose lateral closure stays under the
          // tolerance walks straight through the rail ~0.1px at a time
          // (drive-tested). Float-noise epsilon only; exact-parallel
          // slides keep distance constant and still pass.
          return (x, y) =>
            bridgeMinBarrierDist(x, y, playerBridgeLayer.layer, BRIDGE_STRUCTURES, TILE)
              < dNow - 1e-9;
        })()
      : (x, y, ang) =>
          bridgeBlocked(x, y, ang, playerBridgeLayer.layer, BRIDGE_STRUCTURES, TILE,
            activeCar.size[0] / 2, activeCar.size[1] / 2),
    // H594: wire gamepad rumble so the integrator's collision
    // responses (slide: 0.3/0.5/80ms; full bounce: 0.6/1.0/150ms)
    // produce haptic feedback. The integrator already calls
    // inputs.gpRumble?.() at the slide / bounce branches — the
    // adapter just hadn't been threading the function through.
    gpRumble,
    isSemiWithTrailer: false,
  };

  // ===== Tick the integrator =====
  tickPhase0BIntegrator(state, inputs, spec, settings);

  // ===== Sync authoritative state back to PlayerState =====
  syncIntegratorStateToPlayer(state, player);

  // H595: drive collision visual + audio effects from the
  // integrator's per-tick collision classification. Phase 0B's
  // position-integration step sets state.lastCollisionImpact to
  // 'slide' / 'bounce' / 'none' and stashes the pre-collision
  // speed. The adapter is the right place to convert those into
  // PlayerState mutations (collisionFlash) and SFX (playCrashSound)
  // — the integrator stays pure-physics. Slide/bounce both pulse
  // the chassis outline yellow for 0.5s; crash sound severity
  // scales with pre-collision speed so a 5-mph creep into a wall
  // is a soft thump and a 100-mph wreck is a loud bang. Bounce
  // gets a +0.25 floor so a head-on at low speed still registers
  // with a thud rather than going silent.
  if (state.lastCollisionImpact !== 'none') {
    const FLASH_DURATION = 0.5;
    player.collisionFlash = FLASH_DURATION;
    const MAX_SPEED_FOR_AUDIO = 200;
    const speedSeverity = Math.min(1, state.lastCollisionPSpeed / MAX_SPEED_FOR_AUDIO);
    const severity = state.lastCollisionImpact === 'bounce'
      ? Math.max(0.25, speedSeverity)
      : speedSeverity;
    if (severity > 0.05) playCrashSound(severity);
  }

  return { tookOwnership: true };
}
