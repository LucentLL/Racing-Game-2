/**
 * Calendar — month grid with per-day event badges.
 *
 * Used in TWO contexts (v8.98.31 detection):
 *   - Main menu CAL tab (menuOpen && menuTab==='cal') → top offset 48
 *     to clear the menu tabs at y=28-46.
 *   - Home screen 'calendar' tab → top offset 32 to clear the compact
 *     home sub-tab header.
 *   - Otherwise → top offset 0 (full-bleed; rare path).
 *
 * Without that detection a fillRect(0,0,GW,GH) wipes the surrounding
 * chrome and the menu looks stuck — the v8.98.31 fix.
 *
 * Grid layout: Sun-start columns. Day-of-week derivation maps the
 * dayNames index (FRI/SAT/SUN/MON/TUE/WED/THU, ordered by historical
 * convention — LIFE.day=1 is Friday) into Sun-start grid columns via
 * toGridCol = [5,6,0,1,2,3,4]. Grid cell height shrinks when _top>0 to
 * leave room for the legend + back button below.
 *
 * Per-day badges (up to 9 per cell): W=Work, C=Coffee, B=Bills,
 * P=Parts, R=Race, T=Tow, H=Health, A=Ad. Bills badge is auto-injected
 * for the 1st of every month. Each badge has a per-slot background tint
 * (morning=#fa8, afternoon=#ff0, night=#88f).
 *
 * Navigation: ◀ / ▶ arrows shift LIFE.calViewMonth by ±1. Hit rects
 * (LIFE._calPrevArrowRect, LIFE._calNextArrowRect) are wide (52px) for
 * generous tap zones.
 *
 * Ported from monolith L46408-46560.
 *
 * SCAFFOLD status: type contract + entry point stubbed with TODO line
 * refs.
 */

/** Single per-day event badge. */
export interface CalEvent {
  /** Badge type letter — drives color + display char. */
  type: 'W' | 'C' | 'B' | 'P' | 'R' | 'T' | 'H' | 'A';
  /** Slot tint (morning/afternoon/night) or '' for no tint. */
  slot: 'morning' | 'afternoon' | 'night' | '';
  /** Tooltip / accessibility label. */
  label: string;
}

/** Per-frame inputs for the calendar draw pass. */
export interface CalendarOpts {
  /** Render context — drives the top-offset detection. */
  context: 'menu' | 'home' | 'fullscreen';
  /** Current absolute game day (LIFE.day) — drives weekday derivation. */
  day: number;
  /** Current calendar month (LIFE.month, 0-11). */
  month: number;
  /** Day-of-month (1-N). */
  dayOfMonth: number;
  /** Month-view offset (LIFE.calViewMonth) — 0 = current, ±N = browse. */
  viewMonthOffset: number;
  /** Month metadata (12-entry arrays). */
  monthNames: string[];
  monthDays: number[];
  /** Caller-supplied event lookup — returns events for (viewMonth, dateNum). */
  getEventsForDay(viewMonth: number, dateNum: number): CalEvent[];
  /** Canvas internal width / height. */
  GW: number;
  GH: number;
}

/** Draws the calendar — month header + nav arrows + day-of-week row +
 *  6-row date grid + per-day badges + legend. Top offset varies by
 *  context (v8.98.31). TODO(D30-followup): port from L46408-46560. */
export function drawCalendar(
  _ctx: CanvasRenderingContext2D,
  _opts: CalendarOpts,
): void {
  // TODO: L46408-46560. dayNames offset rule: LIFE.day=1 is Friday.
  // toGridCol = [5,6,0,1,2,3,4] maps dayNames idx to Sun-start col.
  // Inject Bills badge on dateNum===1 if not already present.
}
