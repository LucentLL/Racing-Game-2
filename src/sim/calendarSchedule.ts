/**
 * H1082: forward-looking calendar schedule — the events the player can
 * PLAN around, derived from the recurring rules the sim already runs:
 *
 *   - Work shift  — employed AND a weekday (MON–FRI). Weekends are off
 *                   (matches noShowAbsence.ts's weekend exemption).
 *   - Payday      — employed AND Friday (matches payday.ts runFridayPayout,
 *                   where dayOfWeekIndex 0 = Friday).
 *   - Bills due   — the 1st of every month (monthly billing cycle).
 *
 * These are PREDICTIONS, not history: the calendar renders them ghosted
 * and only for today + future days, so they read as "coming up" beside
 * the solid logged badges from calendarLog (what actually happened).
 *
 * getDayPlan bundles the logged + scheduled events for one day plus the
 * per-slot usage (today only) for the day-detail zoom panel.
 */

import type { LifeState, CalendarEvent } from '@/state/life';
import { dayOfWeekIndex, monthIdxForDay, dayOfMonthForDay } from '@/config/calendar';
import { getCalEventsForDay } from '@/sim/calendarLog';

/** dow indices for Saturday (1) + Sunday (2) — the no-work weekend.
 *  Day 1 is Friday (index 0), so SAT=1, SUN=2. */
const WEEKEND_DOW = new Set<number>([1, 2]);

function mk(day: number, type: string, slot: string, label: string): CalendarEvent {
  return { day, month: monthIdxForDay(day), dom: dayOfMonthForDay(day), type, slot, label };
}

/** Scheduled (not-yet-happened) events for an absolute in-game day.
 *  Order: bills → work → pay. Empty on weekends when unemployed, etc.
 *  Callers should only render these for absDay >= today (past days use
 *  the log). */
export function getScheduledEventsForDay(life: LifeState, absDay: number): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  const dow = dayOfWeekIndex(absDay);
  const employed = !!life.playerJob;
  if (dayOfMonthForDay(absDay) === 1) out.push(mk(absDay, 'B', '', 'Bills due'));
  if (employed && !WEEKEND_DOW.has(dow)) out.push(mk(absDay, 'W', '', `${life.playerJob} shift`));
  if (employed && dow === 0) out.push(mk(absDay, 'P', '', 'Payday'));
  return out;
}

/** True when the day is a scheduled work day (employed weekday). */
export function isScheduledWorkDay(life: LifeState, absDay: number): boolean {
  return !!life.playerJob && !WEEKEND_DOW.has(dayOfWeekIndex(absDay));
}

export interface DayPlan {
  absDay: number;
  isToday: boolean;
  isPast: boolean;
  isFuture: boolean;
  /** Logged history for the day (calendarLog). */
  logged: CalendarEvent[];
  /** Predicted upcoming events (today + future only; [] for past). */
  scheduled: CalendarEvent[];
  /** Per-slot usage — today only (null otherwise). */
  slotUsage: { morning: boolean; afternoon: boolean; night: boolean } | null;
}

/** Bundle the logged + scheduled events and (for today) the slot usage
 *  for the day-detail zoom panel. */
export function getDayPlan(life: LifeState, absDay: number, todayDay: number): DayPlan {
  const isToday = absDay === todayDay;
  const isPast = absDay < todayDay;
  const logged = getCalEventsForDay(life, monthIdxForDay(absDay), dayOfMonthForDay(absDay));
  return {
    absDay,
    isToday,
    isPast,
    isFuture: absDay > todayDay,
    logged,
    scheduled: isPast ? [] : getScheduledEventsForDay(life, absDay),
    slotUsage: isToday ? { ...life.slotsUsed } : null,
  };
}
