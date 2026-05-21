/**
 * Coast-drag computation — the engine brake + rolling friction + aero
 * drag deceleration that fires when the player is off both gas and
 * brake. Pure scalar arithmetic; no state.
 *
 * Three-component drag model (matches every real-car coasting
 * deceleration):
 *
 *   engineBrake          — constant per-car drivetrain drag, dominant
 *                          at low speed (clutched-in idle, gear pulls
 *                          the engine RPM up).
 *   rollingFriction      — constant per-car tire rolling resistance,
 *                          present at any non-zero speed.
 *   aeroFactor·v²        — quadratic aerodynamic drag, dominates at
 *                          highway speed.
 *
 *   total = (engineBrake + rollingFriction + aeroFactor·v²) ·
 *           sign(v) · dt
 *
 * The aero factor's per-car value is calibrated so a sports car at
 * 120 mph decelerates at roughly 0.15 g when the throttle is lifted,
 * matching real-world coast-down telemetry.
 *
 * Monolith source: inside update() at L24086-L24106.
 */

/** Subset of CAR() the coast-drag computation reads. Per-car
 *  constants pulled from the GT4 specs database. */
export interface CoastDragCar {
  /** Engine compression braking force (game units per second²).
   *  Higher for high-compression / Diesel engines; near-zero for
   *  long-stroke 4-cyl. */
  engineBrake: number;
  /** Tire rolling resistance (game units per second²). Per-tire-
   *  spec property — winter tires roll more, performance summers
   *  roll less. */
  rollingFriction: number;
  /** Aerodynamic drag coefficient (game units per second² per
   *  speed²). Quadratic in v; dominant at highway speed. */
  aeroFactor: number;
  /** Turbo lag — used by the spool-down decay below the drag
   *  computation. Cars without turbos have turboLag === 0 and skip
   *  the decay branch. */
  turboLag: number;
}

/** Stop-and-clear threshold. Speeds below this magnitude collapse to
 *  zero rather than continuing the drag loop — avoids floating-point
 *  noise indefinitely jittering pSpeed around zero. Matches monolith
 *  comparator `Math.abs(pSpeed) > 0.3` at L24090. */
export const COAST_STOP_THRESHOLD = 0.3;

/** Turbo boost spool-down rate (game units per second). When coasting
 *  off throttle, the turbo bleeds boost at this rate until it hits
 *  zero. Matches monolith `turboBoost - 2.0 * dt` at L24089. */
export const TURBO_SPOOL_DOWN_RATE = 2.0;

/** Result of one coast tick — the new pSpeed and turboBoost values.
 *  Caller assigns these to the live state. */
export interface CoastTickResult {
  pSpeed: number;
  turboBoost: number;
  /** Did the car come to a full stop this tick? Caller uses this to
   *  clear reverse-intent (`pRevIntent = false`) since a coast-to-
   *  stop means the player is no longer intentionally in reverse —
   *  pressing brake again restarts reverse-intent via the brake
   *  branch upstream. Matches monolith L24100-L24104. */
  stoppedThisTick: boolean;
}

/** One coast-deceleration tick. Decays turbo boost first, then
 *  applies the three-component drag to pSpeed. Speeds below
 *  COAST_STOP_THRESHOLD snap to zero (with `stoppedThisTick = true`
 *  so the caller can clear reverse intent).
 *
 *  NON-OVERSHOOT GUARD. Without the sign check, a high-drag tick
 *  could carry pSpeed past zero into the opposite-sign region — the
 *  engine brake would then perversely accelerate the car backward.
 *  Clamping prevents that: if pSpeed entered the tick positive and
 *  came out negative, force it to zero (and vice versa). Matches
 *  monolith L24095-L24096.
 *
 *  Ported 1:1 from monolith L24086-L24106 (the
 *  `else if(!gas && !brake)` branch inside the gas/brake dispatch). */
export function tickCoastDrag(
  pSpeed: number,
  turboBoost: number,
  car: CoastDragCar,
  dt: number,
): CoastTickResult {
  // Turbo spool-down. Cars without turbos (turboLag === 0) skip
  // the decay so turboBoost doesn't accumulate negative drift.
  let nextTurbo = turboBoost;
  if (car.turboLag > 0) {
    nextTurbo = Math.max(0, turboBoost - TURBO_SPOOL_DOWN_RATE * dt);
  }

  if (Math.abs(pSpeed) > COAST_STOP_THRESHOLD) {
    const drag =
      car.engineBrake + car.rollingFriction + car.aeroFactor * pSpeed * pSpeed;
    const sign = pSpeed > 0 ? 1 : -1;
    let next = pSpeed - sign * drag * dt;
    if (sign > 0 && next < 0) next = 0;
    if (sign < 0 && next > 0) next = 0;
    return {
      pSpeed: next,
      turboBoost: nextTurbo,
      stoppedThisTick: next === 0,
    };
  }
  // |pSpeed| <= COAST_STOP_THRESHOLD — snap to zero. No backward
  // rolling on flat ground (slope rollback would come from a
  // gravity term applied upstream, not from coast drag).
  return { pSpeed: 0, turboBoost: nextTurbo, stoppedThisTick: true };
}
