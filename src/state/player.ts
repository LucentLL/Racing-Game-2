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
 */

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
   *  runs at k=12 instead of k=5 (snappier recovery). The fault-system
   *  shiftMult multiplier is deferred until faults port. */
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
  };
}

/** Per-frame camera-angle smoothing. Lerps pCamAngle toward pAngle via
 *  shortest-arc (so wrapping ±π doesn't unwind the long way around).
 *  Smoothing factor `k` is time-rate (1 = instant, 0.15 = ~6 frames at
 *  60fps to converge). */
export function tickCameraAngle(player: PlayerState, dt: number, k: number = 8.0): void {
  // Shortest-arc delta in (-π, π].
  let delta = player.pAngle - player.pCamAngle;
  delta = ((delta + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  // Exponential approach. At k=8 / dt=1/60 → 0.125 of remaining delta
  // per frame, ≈ 6 frames to settle within 50%.
  const t = 1 - Math.exp(-k * dt);
  player.pCamAngle += delta * t;
}
