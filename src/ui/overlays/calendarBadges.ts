/**
 * Shared calendar-cell badge painter + month-nav arrow renderer.
 *
 * Both the pause-menu CAL tab and the home-overlay Calendar tab paint
 * an identical month grid; the only differences between them are the
 * top/bottom Y anchors (CLOSE button height on pause menu vs. BACK
 * button on home overlay). The cell-internals (date number + bill
 * badge + event badges) and the prev/next nav arrows are the same
 * across both surfaces — extracted here so a future spec change
 * touches one place.
 *
 * Ported from monolith drawCalendar L46326-L46476: badge type/slot
 * color tables + 3-col badge grid (max 9 per cell) + ◀ ▶ nav arrows.
 */

import type { LifeState } from '@/state/life';
import { getCalEventsForDay } from '@/sim/calendarLog';

/** Type-letter → background color. Mirrors monolith L46403. */
export const BADGE_TYPE_BG: Readonly<Record<string, string>> = {
  W: '#046', // Work
  C: '#040', // Cruise
  B: '#640', // Bills
  P: '#660', // Pay
  R: '#600', // Race
  T: '#606', // Tow / transport
  H: '#406', // Health / Hospital
  A: '#600', // Arrest / Activity
};

/** Slot → text color used for the letter inside each badge. Mirrors
 *  monolith L46401. */
export const BADGE_SLOT_COLOR: Readonly<Record<string, string>> = {
  morning:   '#fa8',
  afternoon: '#ff0',
  night:     '#88f',
  '':        '#aaa',
};

/** Legend rows for the bottom strip — letter + label + bg color. */
export const BADGE_LEGEND: ReadonlyArray<{ letter: string; label: string; bg: string }> = [
  { letter: 'W', label: 'Work',   bg: '#046' },
  { letter: 'C', label: 'Cruise', bg: '#040' },
  { letter: 'B', label: 'Bills',  bg: '#640' },
  { letter: 'P', label: 'Pay',    bg: '#660' },
  { letter: 'R', label: 'Race',   bg: '#600' },
  { letter: 'A', label: 'Arrest', bg: '#600' },
];

/** Paints up to 9 event badges inside the cell at (cx, cy, cellW,
 *  cellH). Reads life.calendarLog filtered by (month, dom). Pre-pends
 *  a synthetic B (bills) badge on day 1 if no real one is in the log
 *  yet — matches monolith L46422-L46426. */
export function drawCellBadges(
  ctx: CanvasRenderingContext2D,
  life: LifeState,
  month: number,
  dom: number,
  cx: number,
  cy: number,
  cellW: number,
  cellH: number,
): void {
  const events = getCalEventsForDay(life, month, dom).slice();
  // Synthetic bills badge on day 1 when nothing matched (matches
  // monolith's auto-bill UI cue regardless of log state).
  if (dom === 1 && !events.some((e) => e.type === 'B')) {
    events.unshift({ day: 0, month, dom, type: 'B', slot: '', label: 'Bills due' });
  }
  const max = Math.min(events.length, 9);
  if (max <= 0) return;
  const badgeSize = Math.min(
    Math.floor((cellW - 4) / 3),
    Math.floor((cellH - 14) / 3),
    10,
  );
  if (badgeSize < 4) return; // cell too small to read badges
  const cols = 3;
  for (let bi = 0; bi < max; bi++) {
    const ev = events[bi];
    const bCol = bi % cols;
    const bRow = Math.floor(bi / cols);
    const bx = cx + 2 + bCol * (badgeSize + 1);
    const by = cy + 13 + bRow * (badgeSize + 1);
    ctx.fillStyle = BADGE_TYPE_BG[ev.type] ?? '#333';
    ctx.fillRect(bx, by, badgeSize, badgeSize);
    ctx.fillStyle = BADGE_SLOT_COLOR[ev.slot] ?? '#aaa';
    ctx.font = 'bold ' + (badgeSize - 2) + 'px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(ev.type, bx + badgeSize / 2, by + badgeSize - 1);
  }
}

/** Cached arrow hit-rect — read by the click router after paint. */
export interface CalNavRects {
  prev: { x: number; y: number; w: number; h: number };
  next: { x: number; y: number; w: number; h: number };
}

/** Paints ◀ ▶ arrows on either side of the month title row + returns
 *  the hit rects for the click router. Y is the title's baseline Y
 *  the caller painted the month name at; arrows render at the same Y
 *  with generous 52×28 tap zones. */
export function drawNavArrows(
  ctx: CanvasRenderingContext2D,
  GW: number,
  titleY: number,
): CalNavRects {
  ctx.fillStyle = '#0ff';
  ctx.font = 'bold 18px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('◀', 22, titleY);
  ctx.fillText('▶', GW - 22, titleY);
  return {
    prev: { x: 0, y: titleY - 14, w: 52, h: 28 },
    next: { x: GW - 52, y: titleY - 14, w: 52, h: 28 },
  };
}

/** Paints the bottom legend strip — letter/color swatches in a row
 *  + slot color hint underneath. Mirrors monolith L46452-L46475. */
export function drawCalendarLegend(
  ctx: CanvasRenderingContext2D,
  GW: number,
  legY: number,
): void {
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.fillRect(4, legY - 2, GW - 8, 30);
  const legW = Math.floor((GW - 12) / BADGE_LEGEND.length);
  for (let i = 0; i < BADGE_LEGEND.length; i++) {
    const lg = BADGE_LEGEND[i];
    const lx = 6 + i * legW;
    ctx.fillStyle = lg.bg;
    ctx.fillRect(lx, legY, 10, 10);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 7px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(lg.letter, lx + 5, legY + 8);
    ctx.fillStyle = '#888';
    ctx.font = '7px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(lg.label, lx + 12, legY + 8);
  }
  ctx.fillStyle = '#888';
  ctx.font = '7px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('🌅 morning  ☀️ afternoon  🌙 night', GW / 2, legY + 22);
}

/** Hit-test the prev/next arrows. Returns -1 for prev, +1 for next,
 *  or 0 when nothing matched. */
export function hitCalendarNav(
  tx: number,
  ty: number,
  rects: CalNavRects | null | undefined,
): -1 | 0 | 1 {
  if (!rects) return 0;
  const inside = (r: { x: number; y: number; w: number; h: number }): boolean =>
    tx >= r.x && tx <= r.x + r.w && ty >= r.y && ty <= r.y + r.h;
  if (inside(rects.prev)) return -1;
  if (inside(rects.next)) return 1;
  return 0;
}
