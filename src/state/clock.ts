/**
 * In-game clock. timeOfDay is a fraction of one day: 0=midnight,
 * 0.25=6am sunrise, 0.5=noon, 0.75=6pm sunset, 1.0 wraps back to 0.
 *
 * Wall-clock time isn't simulated; only the time-of-day fraction.
 * Day counter increments on each wrap. LIFE-tier sim systems (bills,
 * jobs, mortgages) consume the day count when they port.
 *
 * Tuning: GAME_DAY_DURATION_SEC sets the real seconds per in-game
 * day. 360 (= 6 real minutes) feels right for an arcade game — long
 * enough that a single drive doesn't whip-cycle the lighting, short
 * enough that the player sees a sunset within a session.
 */

export interface Clock {
  /** 0..1 fraction of one day. */
  timeOfDay: number;
  /** Day counter. Starts at 1 (Friday — monolith convention v8.99.42). */
  day: number;
}

/** Real seconds per simulated day. */
export const GAME_DAY_DURATION_SEC = 360;

/** Spawn at 07:00 (early-morning) so a fresh save reads warm but
 *  driveable. */
export function createClock(): Clock {
  return { timeOfDay: 7 / 24, day: 1 };
}

/** Per-frame tick. dt = real seconds since last frame. */
export function tickClock(clock: Clock, dt: number): void {
  clock.timeOfDay += dt / GAME_DAY_DURATION_SEC;
  while (clock.timeOfDay >= 1) {
    clock.timeOfDay -= 1;
    clock.day++;
  }
}

/** Format `timeOfDay` as a 24-hour HH:MM string. */
export function formatClockTime(clock: Clock): string {
  const totalMin = Math.floor(clock.timeOfDay * 24 * 60);
  const hh = Math.floor(totalMin / 60);
  const mm = totalMin % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** Night-intensity scalar for headlights / per-light bloom passes.
 *  H680: binary on/off instead of a dawn/dusk ramp. User feedback:
 *  "car lights should flick on or off, not fade in as the time of day
 *  changes." Headlights, taillight halos, running lights, and the
 *  player headlight cone all derive their alpha from this value, so
 *  collapsing the ramp here makes every dependent light source pop
 *  on/off at the same instant.
 *
 *  Threshold is the midpoint of each old ramp:
 *    - Dawn ramp 0.20→0.27 had midpoint 0.235 (~05:38).
 *    - Dusk ramp 0.73→0.82 had midpoint 0.775 (~18:36).
 *  Lights are on for timeOfDay ≤ 0.235 OR ≥ 0.775. World-tint pass
 *  (src/render/dayNightTint.ts) still uses its own keyframes so the
 *  ambient color still cross-fades smoothly — only the per-light
 *  alpha snaps. */
export function nightIntensity(timeOfDay: number): number {
  return (timeOfDay <= 0.235 || timeOfDay >= 0.775) ? 1 : 0;
}
