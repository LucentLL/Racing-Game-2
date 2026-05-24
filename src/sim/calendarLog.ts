/**
 * Calendar event log — append-only ring of player-facing events
 * (paydays, bills, race wins/losses, work shifts, arrests) keyed
 * by in-game day. Surfaces in the home / pause-menu CALENDAR tab
 * (port pending) which paints a monthly grid with per-day markers
 * showing whether anything significant happened.
 *
 * H548: 1:1 port of monolith logCalEvent at L46318-L46322 and
 * getCalEventsForDay at L46323-L46325.
 *
 * Cap at 365 entries — older events fall off the tail. Matches
 * monolith's `slice(-365)` truncation. Roughly a year's worth
 * of events; longer-running saves lose history beyond that
 * window (intentional per monolith — the calendar tab only
 * ever renders the current/visible month anyway).
 *
 * One letter `type` tags (monolith convention):
 *   'P' — payday
 *   'B' — bill (housing or car payment)
 *   'W' — work shift
 *   'C' — cruise / discretionary outing
 *   'R' — race win or loss
 *   'A' — activity / arrest / "absorbed" event
 *
 * No producers wired in this hop beyond H544's runFridayPayout
 * (see payday.ts). Other event sources (race-finish 'R', monthly
 * bills 'B', work-completion 'W', etc.) wire at the respective
 * porting hops — each call site lives next to the event source
 * which makes the natural insertion point.
 */

import type { LifeState, CalendarEvent } from '@/state/life';
import { monthIdxForDay, dayOfMonthForDay } from '@/config/calendar';

/** Maximum entries retained on life.calendarLog. Older events
 *  fall off the tail when the log grows past this. Matches
 *  monolith L46321 `slice(-365)`. */
export const CALENDAR_LOG_CAP = 365;

/** Push a calendar event for the supplied in-game day. month / dom
 *  derive from the day via the canonical [[monthIdxForDay]] /
 *  [[dayOfMonthForDay]] helpers so callers don't need to track
 *  month state separately.
 *
 *  Ported 1:1 from monolith logCalEvent at L46318-L46322. */
export function logCalEvent(
  life: LifeState,
  day: number,
  type: string,
  slot: string,
  label: string,
): void {
  const entry: CalendarEvent = {
    day,
    month: monthIdxForDay(day),
    dom: dayOfMonthForDay(day),
    type,
    slot: slot || '',
    label: label || '',
  };
  life.calendarLog.push(entry);
  if (life.calendarLog.length > CALENDAR_LOG_CAP) {
    life.calendarLog = life.calendarLog.slice(-CALENDAR_LOG_CAP);
  }
}

/** Filter calendarLog to events whose month + day-of-month match
 *  the supplied coords. Used by the future calendar-tab grid
 *  renderer to look up per-cell markers.
 *
 *  Ported 1:1 from monolith getCalEventsForDay at L46323-L46325. */
export function getCalEventsForDay(
  life: LifeState,
  month: number,
  dom: number,
): CalendarEvent[] {
  return life.calendarLog.filter((e) => e.month === month && e.dom === dom);
}
