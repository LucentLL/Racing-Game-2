/**
 * Calendar lookup tables — DAY_NAMES + MONTH_NAMES + the derived
 * day-of-week / month-index / day-of-month helpers the modular tree
 * uses to map a flat `clock.day` (1-indexed days-since-game-start)
 * into a human-readable date.
 *
 * H520: previously inline in src/ui/screens/home/overlay.ts +
 * src/ui/screens/pauseMenu.ts (both modules carried their own
 * MONTH_NAMES copy; pauseMenu's docstring at L893 explicitly noted
 * "Cleaner to dedupe in a config follow-up"). This hop is that
 * follow-up.
 *
 * MONOLITH FORMAT vs MODULAR:
 *   - Monolith uses LIFE.month (0-indexed, wraps to 0 at month=12)
 *     and LIFE.dayOfMonth (1-indexed). Two separate fields.
 *   - Modular derives both from a single clock.day field via
 *     DAYS_PER_MONTH (30, flat months). The advantage is one
 *     source of truth; the cost is no support for variable month
 *     lengths (monolith's monthDays array would need to port for
 *     real January-vs-February day counts).
 *
 * MONTH_NAMES exported as both full-form ('January') and short-form
 * ('JAN') — full-form drives the calendar grid headers; short-form
 * drives the day-rollover notif. The monolith stores short ('JAN'
 * etc.) on LIFE.monthNames and uses them everywhere; the modular
 * tree adopted full names for calendar legibility but keeps the
 * short variant on hand for the notif path.
 *
 * DAY_NAMES carries the monolith's FRI-start ordering — day 1 is
 * Friday, so index 0 of DAY_NAMES is 'FRI'. This matches the
 * `(LIFE.day - 1) % 7` indexing pattern at monolith L45468 +
 * L46907 (no-show absence weekday check from H515).
 */

/** Short day-of-week names. Indexed by `(day - 1) % 7` — day 1 is
 *  Friday (monolith convention; see L46907 comment in
 *  src/sim/noShowAbsence.ts).
 *
 *  Matches monolith L7806 `dayNames` exactly. */
export const DAY_NAMES: readonly string[] = [
  'FRI', 'SAT', 'SUN', 'MON', 'TUE', 'WED', 'THU',
];

/** Full month names — drives the calendar grid headers in the home
 *  overlay and pause-menu CAL tab. Modular convention. */
export const MONTH_NAMES_FULL: readonly string[] = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Short month names — drives the day-rollover notif and any
 *  compact date string the HUD surfaces. Matches monolith L7807
 *  `monthNames` exactly. */
export const MONTH_NAMES_SHORT: readonly string[] = [
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
];

/** Day-of-week INDEX (0..6) for the given absolute day number.
 *  Wrapped with positive-mod so negative input doesn't return
 *  negative indexes. Index 0 = Friday per monolith convention. */
export function dayOfWeekIndex(day: number): number {
  return ((day - 1) % 7 + 7) % 7;
}

/** Short day-of-week name ('FRI', 'SAT', ...) for the given day. */
export function dayOfWeekName(day: number): string {
  return DAY_NAMES[dayOfWeekIndex(day)];
}

/** Days per calendar month — duplicated here as a const so callers
 *  that derive month/day from clock.day don't have to import from
 *  sim/monthlyBills. The DAYS_PER_MONTH constant in monthlyBills.ts
 *  is the same value; kept in sync by convention.
 *
 *  Modular convention: flat 30-day months. Monolith uses variable
 *  monthDays (Jan 31, Feb 28, ...); that port lands when LIFE.month
 *  starts advancing through the gameLoop tick (currently dead). */
const DAYS_PER_MONTH = 30;

/** 0-indexed month for the given absolute day. Wraps modulo 12.
 *  Day 1 → monthIdx 0 (January); day 31 → monthIdx 1 (February).
 *  Matches drawCalendarTab + drawCalTab's existing inline math. */
export function monthIdxForDay(day: number): number {
  return Math.floor((day - 1) / DAYS_PER_MONTH);
}

/** Day-of-month (1..30) for the given absolute day. Day 1 → 1;
 *  day 30 → 30; day 31 → 1; day 61 → 1. */
export function dayOfMonthForDay(day: number): number {
  return ((day - 1) % DAYS_PER_MONTH) + 1;
}

/** Short calendar date string — "MON DD" (e.g. "JAN 15"). Used by
 *  the HUD compact-date paths + day-rollover notif. Derives the
 *  month + day from absolute `day` via [[monthIdxForDay]] +
 *  [[dayOfMonthForDay]] so callers don't need to track LIFE.month
 *  separately (the modular tree's life.month is a save-only
 *  artifact today). Matches monolith getShortDate at L45474. */
export function getShortDate(day: number): string {
  const m = MONTH_NAMES_SHORT[monthIdxForDay(day) % 12];
  return m + ' ' + dayOfMonthForDay(day);
}

/** Full calendar date string — "DOW MON DD" (e.g. "MON JAN 15").
 *  Matches monolith getDateString at L45467. Used by the day-
 *  rollover notif ("DAY N — MON JAN 15 | ...") and any UI
 *  surface that wants the weekday alongside the calendar date. */
export function getDateString(day: number): string {
  return dayOfWeekName(day) + ' ' + getShortDate(day);
}
