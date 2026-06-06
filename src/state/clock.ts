/**
 * In-game clock. timeOfDay is a fraction of one day: 0=midnight,
 * 0.25=6am sunrise, 0.5=noon, 0.75=6pm sunset, 1.0 wraps back to 0.
 *
 * SLOT-BASED, NOT REAL-TIME. Matches the monolith model: time only
 * changes when the player completes an activity slot (work shift,
 * sleep, relax, race, etc.). doSleep / doRelax in sim/sleepSlot.ts
 * set timeOfDay to a fixed slot fraction (morning=7/24,
 * afternoon=13/24, night=20/24) and bump clock.day when all slots
 * have been used. The N-key dev shortcut also bumps clock.day.
 *
 * No per-frame advance — earlier versions had a tickClock that
 * drifted timeOfDay by dt/GAME_DAY_DURATION_SEC each frame, but
 * that contradicted the monolith slot model and produced a
 * minute-accurate HUD readout that didn't belong in an arcade
 * game. Removed per user feedback.
 *
 * Day counter consumers (bills, jobs, mortgages) read clock.day
 * directly via the lastProcessedDay edge detector in gameLoop.
 */

export interface Clock {
  /** 0..1 fraction of one day. */
  timeOfDay: number;
  /** Day counter. Starts at 1 (Friday — monolith convention v8.99.42). */
  day: number;
}

/** Spawn at 07:00 (morning slot) so a fresh save reads warm but
 *  driveable. */
export function createClock(): Clock {
  return { timeOfDay: 7 / 24, day: 1 };
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
