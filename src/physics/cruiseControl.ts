/**
 * Cruise control — caps forward speed to (current speed limit + 9 mph)
 * when active. v8.24 feature: lets the player set-and-forget on
 * highways without exceeding the pursuit-trigger threshold (10+ mph
 * over the limit fires cops).
 *
 * Two surface-level concerns from the monolith are split out into
 * pure functions here:
 *
 *   applyCruiseSpeedCap(pSpeed, ...) — the per-tick cap.
 *   cruiseShouldAutoDisable(brake)   — the on-brake auto-cancel.
 *
 * Both are pure: no state mutation, no DOM access. Callers handle
 * the cruise flag, notification UI, and button visual sync.
 *
 * Monolith source:
 *   speed cap         (inside update() at L24127-L24133)
 *   auto-cancel       (inside update() at L23869-L23870)
 */

/** mph → m/s conversion factor (`1 m/s = 2.237 mph`). Hoisted to
 *  module scope so callers can reuse it for derived speed math
 *  without re-deriving the magic constant. */
export const MPH_PER_MS = 2.237;

/** Cruise speed allowance above the posted limit. The +9 keeps the
 *  capped speed at 1 mph BELOW the 10+over pursuit threshold so a
 *  cruise-on player never inadvertently triggers cops. Per
 *  monolith comment at L24128. */
export const CRUISE_LIMIT_PADDING_MPH = 9;

/** Apply the cruise-control speed cap. When `cruiseOn` and the
 *  player is going forward (`pSpeed > 0`), clamp `pSpeed` to
 *  `(speedLimitMph + CRUISE_LIMIT_PADDING_MPH)` converted to
 *  internal speed units via `SCALE_MS / MPH_PER_MS`. Otherwise
 *  return `pSpeed` unchanged.
 *
 *  Reverse motion (`pSpeed < 0`) and stationary (`pSpeed === 0`)
 *  pass through unchanged — cruise control doesn't apply when
 *  rolling backward, so the reverse cap from the regular reverse-
 *  speed clamp upstream is the sole authority for negative speeds.
 *
 *  Ported 1:1 from monolith L24127-L24133:
 *    if(cruiseControl && pSpeed > 0){
 *      const cruiseMaxMph = currentSpeedLimit + 9;
 *      const cruiseMaxSpd = cruiseMaxMph / 2.237 * SCALE_MS;
 *      if(pSpeed > cruiseMaxSpd) pSpeed = cruiseMaxSpd;
 *    }
 */
export function applyCruiseSpeedCap(
  pSpeed: number,
  cruiseOn: boolean,
  speedLimitMph: number,
  SCALE_MS: number,
): number {
  if (!cruiseOn) return pSpeed;
  if (pSpeed <= 0) return pSpeed;
  const cruiseMaxMph = speedLimitMph + CRUISE_LIMIT_PADDING_MPH;
  const cruiseMaxSpd = (cruiseMaxMph / MPH_PER_MS) * SCALE_MS;
  if (pSpeed > cruiseMaxSpd) return cruiseMaxSpd;
  return pSpeed;
}

/** Whether cruise control should auto-disable on this tick. Cruise
 *  drops out the instant the player taps the brake — matches every
 *  real-car cruise control's deadman behavior, and makes "I tried to
 *  slow down for a turn and cruise kept overriding me" impossible.
 *
 *  Returns true ONLY when cruise is currently on AND brake is being
 *  applied; false otherwise. Caller is responsible for flipping the
 *  cruise flag, firing the notification ("🚗 CRUISE OFF — brake"),
 *  and syncing the cruise button's visual state.
 *
 *  Ported 1:1 from monolith L23869-L23870:
 *    if(cruiseControl && brake){ cruiseControl = false;
 *      showNotif('🚗 CRUISE OFF — brake'); updateCruiseBtnVisual(); }
 */
export function cruiseShouldAutoDisable(
  cruiseOn: boolean,
  brake: boolean,
): boolean {
  return cruiseOn && brake;
}
