/**
 * Brake / reverse-from-standstill tick. Fires inside update() when
 * the player holds brake with no gas. Three-state machine:
 *
 *   pSpeed > 0.5             → forward braking (analog: light trigger
 *                              = gentle, full pull = hard brake).
 *   0.01 < pSpeed <= 0.5     → final braking to full stop without
 *                              jumping into reverse.
 *   -topSpeed*0.15 < pSpeed  → reverse acceleration (only from
 *     <= 0.01                  near-standstill; the engine drives
 *                              the car backward at 25% of forward
 *                              power).
 *
 * Outside the reverse cap (pSpeed <= -topSpeed*0.15) the brake does
 * nothing — the upstream reverse-cap clamp keeps pSpeed pinned at
 * the floor.
 *
 * pRevIntent flag tracks "is the player intentionally driving in
 * reverse?" — drives the reverse-light visual + the
 * brake-vs-throttle dispatch upstream. Cleared on forward braking
 * or final-stop; set ONLY in the reverse-acceleration branch.
 *
 * Monolith source: inside update() at L24063-L24085 (the
 * `else if(brake && !gas)` branch inside the gas/brake dispatch).
 */

/** Subset of CAR() the braking tick reads. */
export interface BrakingCar {
  /** Brake force (game units per second²). Analog brake amount
   *  scales this on the way in; fxFault.brakeMult scales it
   *  again for damage / fluid leak effects. */
  brakePower: number;
  /** Engine power. Reused at 25% (REVERSE_POWER_FRACTION) for
   *  reverse-acceleration when the player holds brake at
   *  standstill. */
  power: number;
  /** Top speed — used for the reverse cap (15% of forward top
   *  speed). */
  topSpeed: number;
}

/** Fault-effect fields the braking tick reads. */
export interface BrakingFaultEffects {
  /** Brake-system fault multiplier — 1.0 = full brakes, lower
   *  = brake fluid leak / pad wear / overheat. */
  brakeMult: number;
}

/** Tick state needed by the braking branch. */
export interface BrakingTickState {
  pSpeed: number;
  /** Whether the player is INTENTIONALLY in reverse — true only
   *  when the reverse-from-standstill branch fires. Reverse
   *  lights gate on this flag, not on pSpeed sign, so the lamps
   *  stay dark for passive backward motion (collision pushback,
   *  e-brake spin, slope rollback, etc.). */
  pRevIntent: boolean;
  /** Analog brake pedal 0..1. Keyboard = binary 1.0 when held;
   *  trigger / mobile pedal = continuous. */
  brakeAmount: number;
}

/** Result of one braking tick — new pSpeed + new pRevIntent. */
export interface BrakingTickResult {
  pSpeed: number;
  pRevIntent: boolean;
}

/** Forward-braking threshold (game units). Above this, normal
 *  analog braking applies; below, the final-stop branch fires. */
export const BRAKE_FORWARD_THRESHOLD = 0.5;

/** Final-stop threshold (game units). Between this and
 *  BRAKE_FORWARD_THRESHOLD, pSpeed snaps to 0 — keeps the player
 *  from accidentally crossing into reverse while finishing a
 *  forward stop. */
export const BRAKE_FINAL_STOP_THRESHOLD = 0.01;

/** Reverse top-speed cap as a fraction of forward topSpeed. Real
 *  cars in reverse max out around 15-25 mph regardless of forward
 *  capability — the limit is gearing, not engine power. */
export const REVERSE_CAP_FRACTION = 0.15;

/** Power scale for reverse acceleration. 25% of forward power
 *  matches realistic reverse-gear ratios (deeper than 1st but
 *  applied through a single low-output gear set, not the full
 *  6-speed). */
export const REVERSE_POWER_FRACTION = 0.25;

/** Apply one brake / reverse-from-standstill tick.
 *
 *  Returns the new pSpeed + pRevIntent values. Caller assigns.
 *
 *  STATE MACHINE:
 *
 *    pSpeed > 0.5 (forward braking):
 *      pSpeed -= brakePower · brakeAmount · brakeMult · dt
 *      Clamp to 0 (don't undershoot, otherwise the brake would
 *      pivot the car into reverse mid-stop). Clear pRevIntent —
 *      braking forward motion is not reverse intent.
 *
 *    0.01 < pSpeed <= 0.5 (final stop):
 *      pSpeed = 0. Clear pRevIntent. Final approach to zero
 *      without crossing into reverse.
 *
 *    -topSpeed*0.15 < pSpeed <= 0.01 (reverse from standstill):
 *      pSpeed -= power · 0.25 · brakeAmount · dt
 *      Set pRevIntent = true — this is the ONLY branch that
 *      intentionally drives the car backward.
 *
 *    pSpeed <= -topSpeed * 0.15 (reverse cap):
 *      No action. Upstream clamp keeps pSpeed at the floor.
 *
 *  Ported 1:1 from monolith L24063-L24085. */
export function tickBraking(
  car: BrakingCar,
  state: BrakingTickState,
  fxFault: BrakingFaultEffects,
  dt: number,
): BrakingTickResult {
  const { pSpeed, brakeAmount } = state;

  if (pSpeed > BRAKE_FORWARD_THRESHOLD) {
    // Forward braking — analog.
    let next = pSpeed - car.brakePower * brakeAmount * fxFault.brakeMult * dt;
    if (next < 0) next = 0;
    return { pSpeed: next, pRevIntent: false };
  }

  if (pSpeed > BRAKE_FINAL_STOP_THRESHOLD) {
    // Final braking to full stop. Don't jump into reverse.
    return { pSpeed: 0, pRevIntent: false };
  }

  if (pSpeed > -car.topSpeed * REVERSE_CAP_FRACTION) {
    // Reverse from standstill. ONLY branch that sets pRevIntent.
    return {
      pSpeed: pSpeed - car.power * REVERSE_POWER_FRACTION * brakeAmount * dt,
      pRevIntent: true,
    };
  }

  // Below reverse cap — brake does nothing (upstream clamp holds).
  return { pSpeed, pRevIntent: state.pRevIntent };
}
