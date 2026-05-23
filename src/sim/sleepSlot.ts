/**
 * Time-slot advance: SLEEP (full rest) and RELAX (half rest) on
 * the home-overlay main tab.
 *
 * Slot order: morning → afternoon → night. Each call marks the
 * current slot used + advances to the next unused one. When all
 * three are used, the next call rolls the day (clock.day++) and
 * resets slotsUsed + timeSlot.
 *
 * Day rollover side effects (monthly pay/bills, newspaper refresh,
 * daily latch clears) all fire through the existing per-frame
 * tickClock path — H22/H23 + H201 already handle them. doSleep
 * just bumps clock.day and lets that logic run on the next frame.
 *
 * 1:1 port of monolith L46862-46897 mainline branch minus the
 * absence-penalty / coffeeBuff / pendingParts / autosave hooks
 * (each depends on un-ported subsystems).
 *
 * Player can work a night shift, get back home BEFORE midnight,
 * tap SLEEP from the night slot → that completes the day correctly
 * (night marked used, all slots used, day rolls over). Or tap
 * RELAX mid-day to advance from morning to afternoon without
 * burning a full sleep cycle.
 */

import type { LifeState } from '@/state/life';
import type { Clock } from '@/state/clock';
import { applyNoShowAbsence, type NoShowAbsenceResult } from '@/sim/noShowAbsence';

/** Slot order in advance direction. Matches monolith L46870. */
const SLOT_ORDER: readonly ('morning' | 'afternoon' | 'night')[] = ['morning', 'afternoon', 'night'];

/** Clock time-of-day fraction each slot starts at. Lights the
 *  world appropriately when advance happens. Monolith uses
 *  LIFE.hour/minute; we use clock.timeOfDay (0..1 fraction). */
const SLOT_TIME_OF_DAY: Record<'morning' | 'afternoon' | 'night', number> = {
  morning: 7 / 24,
  afternoon: 13 / 24,
  night: 20 / 24,
};

export type SleepResult =
  | { kind: 'advanced'; nextSlot: 'morning' | 'afternoon' | 'night' }
  | { kind: 'rolled'; noShow: NoShowAbsenceResult }; // day rolled — see clock.day++; noShow non-null when player skipped work today

/** Apply full rest + advance. 1:1 port of monolith doSleep L46868.
 *
 *  Mutates:
 *    - slotsUsed[currentSlot] = true
 *    - If next unused slot exists: timeSlot = it, clock.timeOfDay
 *      = SLOT_TIME_OF_DAY[next], jobDoneToday = false (so the
 *      player can work another slot today), health += small full-
 *      rest bonus, daysSinceSleep = 0.
 *    - Else: clock.day++, slotsUsed reset, timeSlot = 'morning',
 *      timeOfDay = 7/24, health += small + daysSinceSleep = 0.
 *      Day rollover logic (H201) fires on next frame and clears
 *      the per-day latches.
 *
 *  Returns a discriminated result so the caller can notify
 *  ('Morning — Day N' vs 'Day N+1 starts'). */
export function doSleep(life: LifeState, clock: Clock): SleepResult {
  // Mark the current slot used.
  if (life.timeSlot) life.slotsUsed[life.timeSlot] = true;

  // Find next unused slot in order from after currentSlot.
  const curIdx = SLOT_ORDER.indexOf(life.timeSlot);
  let nextSlot: 'morning' | 'afternoon' | 'night' | null = null;
  for (let i = curIdx + 1; i < SLOT_ORDER.length; i++) {
    if (!life.slotsUsed[SLOT_ORDER[i]]) {
      nextSlot = SLOT_ORDER[i];
      break;
    }
  }

  // Full-rest health bonus (5pt). Clamps to 100.
  life.health = Math.min(100, life.health + 5);
  life.daysSinceSleep = 0;

  if (nextSlot) {
    life.timeSlot = nextSlot;
    clock.timeOfDay = SLOT_TIME_OF_DAY[nextSlot];
    life.jobDoneToday = false; // allow working another slot today
    return { kind: 'advanced', nextSlot };
  }

  // All slots used — roll the day. The H201 day-rollover block
  // in gameLoop's tickClock branch fires on the next frame and
  // clears _availJobs/_jobListings/jobDoneToday/gymVisitedToday/
  // ateToday. We reset slotsUsed + timeSlot here ourselves since
  // those are H214-introduced and the rollover hook doesn't
  // know about them yet.
  //
  // H515: BEFORE the slotsUsed reset, run the v8.99.51 no-show
  // absence check (1:1 with monolith L46900-L46936 inside doSleep's
  // all-slots-done branch). The eligibility check reads
  // life.slotsUsed.morning / .afternoon to decide whether the
  // player worked any slot today — if they skipped them all (rare
  // realistic case: gas-tank-on-empty day with no shift completed),
  // the absence ladder bites + may fire the player. Caller surfaces
  // the returned NoShowAbsenceResult as the right notif.
  //
  // Pre-bump clock.day in the call since the absence check's dow
  // math reads the NEW day (the player slept INTO the new day; the
  // absence is filed against today's expected work-day). Matches
  // monolith ordering: L46911-L46915 reads LIFE.day before the
  // L46961 increment.
  const noShow = applyNoShowAbsence(life, clock.day);
  clock.day++;
  clock.timeOfDay = 7 / 24;
  life.slotsUsed = { morning: false, afternoon: false, night: false };
  life.timeSlot = 'morning';
  return { kind: 'rolled', noShow };
}

/** Apply half rest + advance. 1:1 port of monolith doRelax L46862.
 *
 *  Same advance logic as doSleep but with a smaller health bonus
 *  (2pt) and daysSinceSleep stays (RELAX is awake-rest, not sleep).
 *  Bumps slotsActiveToday by 0.5 so the gym-slot gate (H213) sees
 *  the partial use. */
export function doRelax(life: LifeState, clock: Clock): SleepResult {
  life.slotsActiveToday = (life.slotsActiveToday || 0) + 0.5;

  if (life.timeSlot) life.slotsUsed[life.timeSlot] = true;
  const curIdx = SLOT_ORDER.indexOf(life.timeSlot);
  let nextSlot: 'morning' | 'afternoon' | 'night' | null = null;
  for (let i = curIdx + 1; i < SLOT_ORDER.length; i++) {
    if (!life.slotsUsed[SLOT_ORDER[i]]) {
      nextSlot = SLOT_ORDER[i];
      break;
    }
  }

  life.health = Math.min(100, life.health + 2);

  if (nextSlot) {
    life.timeSlot = nextSlot;
    clock.timeOfDay = SLOT_TIME_OF_DAY[nextSlot];
    life.jobDoneToday = false;
    return { kind: 'advanced', nextSlot };
  }

  // H515: no-show absence check before reset (see doSleep above
  // for the rationale). RELAX is awake-rest but the day still
  // rolls, so the same monolith L46900-L46936 ladder applies.
  const noShow = applyNoShowAbsence(life, clock.day);
  clock.day++;
  clock.timeOfDay = 7 / 24;
  life.slotsUsed = { morning: false, afternoon: false, night: false };
  life.timeSlot = 'morning';
  return { kind: 'rolled', noShow };
}

/** Helper for UI — returns the next unused slot's name (or null
 *  when all used). Drives the 'To Afternoon' / 'To Night' / 'End
 *  day' label on the SLEEP/RELAX buttons. */
export function nextUnusedSlot(life: LifeState): 'morning' | 'afternoon' | 'night' | null {
  const curIdx = SLOT_ORDER.indexOf(life.timeSlot);
  for (let i = curIdx + 1; i < SLOT_ORDER.length; i++) {
    if (!life.slotsUsed[SLOT_ORDER[i]]) return SLOT_ORDER[i];
  }
  return null;
}
