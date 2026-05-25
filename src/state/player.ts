/**
 * Player pose + arcade-tier kinematic state.
 *
 * H6: this is INTENTIONALLY simpler than the monolith's player state
 * (which carries 40+ fields for tire slip, gear, RPM, engine load,
 * fuel, etc., in L17648-17985). The fields here are the minimum to
 * drive a triangle around an empty plane — px/py position, pAngle
 * heading, pSpeed scalar speed. Subsequent H commits grow this struct
 * as physics/tire/steering bodies port and start needing real state.
 *
 * The richer state lives on a separate type in src/physics/ when those
 * ports land; this file stays the pose-only contract that render and
 * camera read from.
 *
 * H497: optional `phase0B` sub-object — the per-frame state the
 * Phase 0B physics integrator owns (pVx/pVy, pYawRate, drift
 * bookkeeping, etc.). Lazy-initialized by the integrator adapter on
 * the first frame the feature flag (gameplaySettings.dynPhysics0B) is
 * on; left undefined for the arcade-tier code path. See
 * src/physics/phase0BIntegrator.ts for the field semantics and
 * src/physics/phase0BAdapter.ts (when it lands) for the lifecycle.
 */

import type { Phase0BIntegratorState } from '@/physics/phase0BIntegrator';

/** Player pose + speed.
 *
 *  Units: WORLD-COORD pixels for px/py (1 world unit = 1 canvas pixel,
 *  same coord system the renderer uses). World tile coords from
 *  BASELINE_ROADS multiply by TILE (18) to land in this space.
 *  pAngle = radians; pSpeed = world-units per second.
 *
 *  fuel: 0..1 (1 = full tank). Decrements as the player drives;
 *  refuels at gas stations. Cuts acceleration at 0.
 *
 *  collisionFlash: 0..1 visual + cooldown timer for H18 traffic
 *  collision feedback. Ticks toward 0 each frame. While > 0, the
 *  car border draws red and new collision checks short-circuit (so
 *  one bump doesn't fire 60 times across consecutive frames).
 */
export interface PlayerState {
  px: number;
  py: number;
  pAngle: number;
  pSpeed: number;
  fuel: number;
  collisionFlash: number;
  /** H61 smoothed camera angle — lags player.pAngle by ~6 frames so
   *  the camera doesn't jerk on sharp inputs. Lerps toward pAngle each
   *  frame with shortest-arc handling. Render reads this for the
   *  camera rotate transform; everything else (car body, headlight
   *  cone) still uses player.pAngle so the car itself reacts crisply. */
  pCamAngle: number;
  /** H85 smoothed engine RPM. Integrated toward the per-frame targetRPM
   *  (computed inline in gameLoop drawPlaying) via the monolith's
   *  exponential approach at L26473:  `pRPM += (target-pRPM)*5*dt`.
   *  k=5 → ~200ms to settle within 50% — visibly smooths the gear-shift
   *  RPM drop instead of letting the needle teleport on each upshift.
   *  Seeded to 800 (default idleRPM); arcadeUpdate doesn't read this
   *  yet (no engine-load feedback), it's read by the HUD only. */
  pRpm: number;
  /** H86 previous-frame gear, tracked to detect upshift events. Compared
   *  against the bracket-walk-derived pGear each frame; a strictly-
   *  greater pGear > prevGear flip starts the shift timer. Seeded to 1
   *  matching the bracket walk's pSpeed=0 result. */
  prevGear: number;
  /** H86 gear-shift cooldown in seconds. 1:1 port of monolith
   *  gearShiftTimer at L26420 — set to 0.15 (150ms base) on upshift,
   *  decremented each frame until ≤0. While >0, the RPM target uses
   *  the 0.3× multiplier instead of 0.97× (dip), and the integrator
   *  runs at k=12 instead of k=5 (snappier recovery). H256 wired the
   *  fault-system shiftMult multiplier (trans_slip/trans_hesitation
   *  stretch the dip via FAULT_EFFECTS.shiftMult). */
  gearShiftTimer: number;
  /** H92 driver reverse-intent flag. 1:1 port of monolith pRevIntent
   *  at L17613 — distinguishes "actively driving backward" from passive
   *  backward motion (collision pushback, slope rollback, e-brake spin).
   *  Set true on the brake-while-stopped reverse-accel branch (L24084),
   *  cleared on gas press / forward brake / final-stop snap / coast-
   *  to-zero (L24062, L24069, L24073, L24104). Consumed by reverse
   *  lamps (H90), the REVERSE HUD label (H91), and downstream drift /
   *  collision exclusions when those port. */
  pRevIntent: boolean;
  /** H99 player-requested gear. 1:1 port of monolith manualGear at
   *  L26385. Null means "no manual override — bracket walk picks the
   *  gear automatically". A number locks pGear to that value for the
   *  duration of manualGearTimer (or permanently when LIFE.isManual
   *  ports). Pressing 'e' / 'q' bumps this ±1 in installKeyboard;
   *  tickGearAndRpm applies the override after the bracket walk with
   *  the monolith's safety bumps (auto-upshift on 1.75× over-rev,
   *  auto-downshift on 0.40× lug). */
  manualGear: number | null;
  /** H99 manual-shift revert timer in seconds. 1:1 port of monolith
   *  manualGearTimer at L26401. Set to 4 on each shift request, ticks
   *  down each frame; when ≤0 manualGear clears back to null and the
   *  bracket walk resumes full control. The 4-second window matches
   *  the monolith's auto-trans-with-manual-shift convention — driver
   *  can briefly force a gear (e.g. downshift to pass) without locking
   *  themselves into manual semantics for the rest of the trip. */
  manualGearTimer: number;
  /** H142: elevation level the player is currently driving at — 0 for
   *  ground, the elevated road's z (typically 4) when the player is
   *  within (w/2 + 1) tile of an elevated highway's polyline. Set each
   *  frame by tickPlayerLayerZ; consumed by tickTrafficCollisions to
   *  suppress collisions with traffic on a different z-level so the
   *  player driving on I-485 doesn't crash into ground-road cars under
   *  the bridge (and vice versa). Mirrors monolith `playerZ` global at
   *  L17617 / L23941. */
  layerZ: number;
  /** H156: drift state. True when the player is holding e-brake at
   *  speed with steering input — proceduralEngine reads this to gate
   *  tire grain + synth screech, and to suppress the wheelspin path
   *  (the two share the rear tires; treating both as "active" would
   *  double-loud the screech). Approximated for arcade physics:
   *  ebrk && |speed| > 30 && |steerAxis| > 0.3. */
  drifting: boolean;
  /** H156: tire slip angle in radians-ish. Arcade physics doesn't
   *  model lateral velocity (the car moves strictly along pAngle), so
   *  this is a steer-driven approximation: steerAxis * 0.25 while
   *  drifting, 0 otherwise. proceduralEngine's drift screech fallback
   *  gates on |slipAngle| > 0.15. Real bicycle-model port lands with
   *  the NFS-Blackbox tire physics (monolith L24217+). */
  slipAngle: number;
  /** H156: wheelspin saturation 0..1. proceduralEngine's tireGrain
   *  fires when this exceeds 0.15 OR the wheelGap-launch path
   *  triggers. Arcade approximation: 0.3 on hard-throttle launches
   *  (gas + low gear + high RPM + low speed); 0 otherwise. */
  wheelspinRatio: number;
  /** H156: gear-speed vs actual speed delta. wheelGap > 3 means the
   *  car wants to go ~3 wpx/s faster than it is — happens on
   *  acceleration before drag catches up + during launches. Used by
   *  proceduralEngine's wsLaunch path at L137. Computed in gameLoop
   *  from activeCar.gearSpeeds[player.prevGear] - |player.pSpeed|. */
  wheelGap: number;
  /** H497: Phase 0B integrator state — the per-frame state the
   *  bicycle-model + force-integrator pipeline owns (pVx/pVy world
   *  velocity, pYawRate chassis rotation rate, pRearX/Y rear-axle
   *  tracking, pDrifting state-machine flag with its post-drift
   *  recovery timer, pFzTransfer weight-transfer scalar, pSlipAngle
   *  chassis-vs-velocity offset, pVelAngle / pVelAngleFiltered /
   *  pCamAngle camera-orientation chain, pWheelspinRatio, pDrift
   *  intensity, pEbrakeTimer countdown, pBicycleInit / pDyn0BInit
   *  seed flags). Lazy-initialized by the integrator adapter on the
   *  first frame the feature flag (LIFE.gameplaySettings.
   *  dynPhysics0B + bicycleModel) is on; left undefined while the
   *  arcade-tier path owns the tick.
   *
   *  WHY A SUB-OBJECT (not flattened onto PlayerState): the Phase 0B
   *  state has ~20 fields that overlap partially with PlayerState
   *  (both have px/py/pAngle/pSpeed/pCamAngle/pRpm/pGear). Keeping
   *  it as a discrete sub-object means the adapter sync layer can
   *  copy in one direction at a time (player → integrator at frame
   *  head; integrator → player at frame tail), and the legacy
   *  arcade path doesn't have to know about Phase 0B fields at all.
   *
   *  WHY OPTIONAL: the feature flag may be off (legacy path runs);
   *  the player may be in a vehicle ineligible for the bicycle model
   *  (bike, special, low speed); we want the slot absent rather than
   *  zeroed so eligibility checks short-circuit cleanly. */
  phase0B?: Phase0BIntegratorState;
  /** H590: cruise-control flag. Toggled via 'C' key during
   *  'playing'; auto-disables on brake press. While true,
   *  applyCruiseSpeedCap clamps pSpeed to (currentSpeedLimit +
   *  CRUISE_LIMIT_PADDING_MPH) so the player doesn't trip the
   *  10+over pursuit gate. Cleared on brake / car-switch /
   *  reverse. */
  cruiseOn?: boolean;
}

/** Spawn pose. H8: tile coord (1000, 1100) is approx downtown
 *  Charlotte (near I-277 inner-loop intersection). Multiply by TILE
 *  to get world coords. Subsequent ports replace this with a road-
 *  surface lookup (so the player can never spawn on grass / inside a
 *  building / over water). */
export function createPlayerState(): PlayerState {
  const TILE = 18;
  return {
    px: 1000 * TILE,
    py: 1100 * TILE,
    pAngle: 0,
    pSpeed: 0,
    fuel: 1,
    collisionFlash: 0,
    pCamAngle: 0,
    pRpm: 800,
    prevGear: 1,
    gearShiftTimer: 0,
    pRevIntent: false,
    manualGear: null,
    manualGearTimer: 0,
    layerZ: 0,
    drifting: false,
    slipAngle: 0,
    wheelspinRatio: 0,
    wheelGap: 0,
  };
}

/** Per-frame camera-angle smoothing. Lerps pCamAngle toward pAngle via
 *  shortest-arc (so wrapping ±π doesn't unwind the long way around).
 *  Smoothing factor `k` is time-rate (1 = instant, 0.15 = ~6 frames at
 *  60fps to converge).
 *
 *  ARCADE TIER: tracks heading (pAngle) only. For the realistic
 *  momentum-following camera that drives the v8.41+ feel — including
 *  the velocity-direction filter and drift-mode rate boost — use
 *  `tickCameraAngleRealistic` below. */
export function tickCameraAngle(player: PlayerState, dt: number, k: number = 8.0): void {
  // Shortest-arc delta in (-π, π].
  let delta = player.pAngle - player.pCamAngle;
  delta = ((delta + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  // Exponential approach. At k=8 / dt=1/60 → 0.125 of remaining delta
  // per frame, ≈ 6 frames to settle within 50%.
  const t = 1 - Math.exp(-k * dt);
  player.pCamAngle += delta * t;
}

/** Shortest-arc wrap into (-π, π]. Used by both the velocity-angle
 *  filter and the camera lerp to handle the ±π discontinuity without
 *  unwinding the long way around. */
function wrapShortestArc(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** Inputs to the realistic camera-angle tick. */
export interface CameraTickRealisticState {
  /** Player heading angle. Camera falls back to this at low speed
   *  and during reverse (except the semi-with-trailer special). */
  pAngle: number;
  /** Camera angle — mutated by this function. */
  pCamAngle: number;
  /** Player velocity direction angle. Tracks the actual direction
   *  the CG is moving, not the heading direction. Diverges from
   *  pAngle during slip. */
  pVelAngle: number;
  /** Low-pass-filtered velocity angle. The bicycle model's
   *  pVelAngle jitters on real kinematic slip; the camera reads
   *  the filtered copy so the world doesn't shake while slip
   *  detection, rendering, and sound still see the raw value.
   *  Mutated by this function. */
  pVelAngleFiltered: number;
  /** Signed forward speed (game units). Used by the
   *  high-vs-low-speed branch and the reverse-detection check. */
  pSpeed: number;
  /** True while the car is in drift state (extended slip).
   *  Bumps both the filter rate and the camera lerp rate so the
   *  drift-cam reacts faster. */
  pDrifting: boolean;
  /** Body type of the current car ('semi', 'sedan', 'bike', etc.).
   *  Only `'semi'` matters here — semis with attached trailers get
   *  momentum-following even in reverse (the driver needs to see
   *  the trailer during backing maneuvers). */
  bodyType: string;
  /** Whether a trailer is hitched. Combined with bodyType === 'semi'
   *  to enable the reverse-momentum-camera special. */
  hasTrailer: boolean;
}

/** Speed threshold above which the camera follows momentum direction
 *  instead of heading. Below 5 game-units the camera stays oriented
 *  to the heading (otherwise the world spins around the player at
 *  near-zero speeds when momentum direction is undefined). */
export const CAM_MOMENTUM_MIN_SPEED = 5;

/** Reverse-detection threshold. pSpeed < -0.5 → in reverse; between
 *  -0.5 and +5 the camera stays on heading. */
export const CAM_REVERSE_THRESHOLD = -0.5;

/** Velocity-angle low-pass filter rate (rad/sec) under normal grip.
 *  10 rad/s = ~6-frame convergence at 60fps. */
export const CAM_FILTER_RATE_NORMAL = 10;

/** Filter rate during drift state. Faster so the drift cam still
 *  reacts to direction changes. */
export const CAM_FILTER_RATE_DRIFT = 14;

/** Camera-angle lerp rate under normal grip (units same as the
 *  filter rate). */
export const CAM_LERP_RATE_NORMAL = 6;

/** Camera-angle lerp rate during drift state. Slower than normal
 *  (4 vs 6) so the drift cam holds its frame longer — gives the
 *  cinematic "skid in slow motion" feel rather than chasing the
 *  car around the slide. */
export const CAM_LERP_RATE_DRIFT = 4;

/** v8.41 realistic camera-angle tick — follows momentum direction
 *  with low-pass filtering, falling back to heading at low speed
 *  and (usually) in reverse. Mutates `state.pVelAngleFiltered` and
 *  `state.pCamAngle` in place.
 *
 *  TWO-STAGE PIPELINE:
 *
 *  STAGE 1 — VELOCITY-ANGLE FILTER. pVelAngle is the instantaneous
 *  CG velocity direction from the bicycle model; reflects real
 *  kinematic slip which the physics needs but which jitters the
 *  camera. Low-pass filter into pVelAngleFiltered using the drift-
 *  rate-boosted exponential approach. The shortest-arc wrap handles
 *  the ±π discontinuity.
 *
 *  STAGE 2 — CAMERA TARGET SELECTION + LERP:
 *
 *    |pSpeed| <= CAM_MOMENTUM_MIN_SPEED → camTarget = pAngle.
 *      Camera stays on heading at near-zero speeds (momentum
 *      direction is undefined / noisy).
 *
 *    pSpeed < CAM_REVERSE_THRESHOLD (in reverse), NOT a semi with
 *    trailer → camTarget = pAngle.
 *      Backing up in a car / truck shouldn't spin the world. The
 *      semi-with-trailer special preserves momentum-following so
 *      the driver can see the trailer behind them during backing
 *      maneuvers (per v8.92 design note).
 *
 *    otherwise → camTarget = pVelAngleFiltered.
 *      Forward motion (or semi-trailer reverse): follow the
 *      filtered velocity direction.
 *
 *    Camera lerps toward camTarget at the drift-boosted rate.
 *
 *  Ported 1:1 from monolith camera angle block at L26518-L26548. */
export function tickCameraAngleRealistic(
  state: CameraTickRealisticState,
  dt: number,
): void {
  // STAGE 1 — velocity-angle filter.
  const velDiff = wrapShortestArc(state.pVelAngle - state.pVelAngleFiltered);
  const filterRate = state.pDrifting ? CAM_FILTER_RATE_DRIFT : CAM_FILTER_RATE_NORMAL;
  state.pVelAngleFiltered += velDiff * filterRate * dt;

  // STAGE 2 — camera target selection.
  let camTarget = state.pAngle;
  if (Math.abs(state.pSpeed) > CAM_MOMENTUM_MIN_SPEED) {
    const semiTrailerRev = state.bodyType === 'semi' && state.hasTrailer;
    if (state.pSpeed < CAM_REVERSE_THRESHOLD && !semiTrailerRev) {
      camTarget = state.pAngle;
    } else {
      camTarget = state.pVelAngleFiltered;
    }
  }

  // Lerp toward camTarget with shortest-arc wrap.
  const camDiff = wrapShortestArc(camTarget - state.pCamAngle);
  const lerpRate = state.pDrifting ? CAM_LERP_RATE_DRIFT : CAM_LERP_RATE_NORMAL;
  state.pCamAngle += camDiff * lerpRate * dt;
}
