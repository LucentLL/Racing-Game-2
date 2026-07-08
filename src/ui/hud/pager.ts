/**
 * H1068 (BL-5 first slice): the PAGER — street-racing's comms medium.
 *
 * 1999, no computers: race business arrives on a beeper. A page pops
 * the device into the corner of the HUD for a few seconds — grey
 * shell, backlit green-grey LCD, ALL-CAPS message with a character
 * budget like a real pager — then collapses to a small unread badge
 * until the player reads the RACE tab (which lists recent pages and
 * marks them read).
 *
 * Producers (this slice): nightfall street-race availability
 * (sleepSlot advance → "RACE 2NITE · CITY · MIN $X"). Blacklist
 * challenge-unlock taunt pages + meet/tournament pages land with
 * BL-3/BL-5 per docs/BLACKLIST.md.
 *
 * State: life.pages[] (JSON-safe, wholesale-saved). Transient pop
 * timer uses the _-prefixed convention.
 */

import type { LifeState } from '@/state/life';

export interface PagerPage {
  day: number;
  slot: string;
  type: 'race' | 'blacklist' | 'info';
  /** ALL-CAPS LCD text. Keep ≤ 40 chars — real beepers were terse. */
  text: string;
  read: boolean;
  expiresDay: number;
}

interface PagerLife {
  pages?: PagerPage[];
  _pagerPopFrames?: number;
}

const POP_FRAMES = 420; // ~7s at 60fps

/** Append a page + arm the pop-in. Trims the log to the last 12. */
export function pushPage(life: LifeState, page: PagerPage): void {
  const lf = life as unknown as PagerLife;
  if (!Array.isArray(lf.pages)) lf.pages = [];
  lf.pages.push(page);
  if (lf.pages.length > 12) lf.pages.splice(0, lf.pages.length - 12);
  lf._pagerPopFrames = POP_FRAMES;
}

/** Drop expired pages (day-rollover housekeeping). */
export function expirePages(life: LifeState, day: number): void {
  const lf = life as unknown as PagerLife;
  if (!Array.isArray(lf.pages)) return;
  lf.pages = lf.pages.filter((p) => p.expiresDay >= day);
}

export function unreadPageCount(life: LifeState): number {
  const lf = life as unknown as PagerLife;
  return (lf.pages ?? []).reduce((n, p) => n + (p.read ? 0 : 1), 0);
}

/** Latest pages, newest first (RACE tab list). */
export function recentPages(life: LifeState, n: number): PagerPage[] {
  const lf = life as unknown as PagerLife;
  return (lf.pages ?? []).slice(-n).reverse();
}

export function markPagesRead(life: LifeState): void {
  const lf = life as unknown as PagerLife;
  for (const p of lf.pages ?? []) p.read = true;
}

/** Draw the pop-in (while armed) or the unread badge. Call from the
 *  HUD pass every frame — decrements its own timer. */
export function drawPager(
  ctx: CanvasRenderingContext2D,
  life: LifeState,
  GW: number,
  GH: number,
): void {
  const lf = life as unknown as PagerLife;
  const pages = lf.pages ?? [];
  const latest = pages[pages.length - 1];
  const pop = lf._pagerPopFrames ?? 0;
  const unread = unreadPageCount(life);

  if (pop > 0 && latest) {
    lf._pagerPopFrames = pop - 1;
    // Slide in/out over the first/last 20 frames.
    const t = Math.min(1, Math.min(pop, POP_FRAMES - pop) / 20);
    const w = 196; const h = 52;
    // H1081: anchored to the UPPER-CENTER clear band (below the FPS
    // line, between the top-corner gauges) instead of the old bottom-
    // right corner, where it sat UNDER the pedals / shifter on the
    // mobile HUD (user report). Slides DOWN from above the top edge.
    const x = (GW - w) / 2;
    const topY = 46;
    const y = topY - (1 - t) * (h + 20);

    // Device shell — dark grey beeper with a clip notch.
    ctx.fillStyle = '#23252a';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#0c0d10';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
    ctx.fillStyle = '#15161a';
    ctx.fillRect(x + w - 14, y + 6, 8, 12); // side button

    // LCD window.
    const lx = x + 8; const ly = y + 8; const lw = w - 28; const lh = h - 16;
    ctx.fillStyle = '#9aa88f';
    ctx.fillRect(lx, ly, lw, lh);
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fillRect(lx, ly, lw, 3);
    ctx.fillStyle = '#2a3324';
    ctx.font = 'bold 8px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('■ PAGE ' + pages.length.toString().padStart(2, '0'), lx + 5, ly + 11);
    ctx.font = 'bold 10px monospace';
    const msg = latest.text.toUpperCase();
    ctx.fillText(msg.slice(0, 30), lx + 5, ly + 24);
    if (msg.length > 30) {
      ctx.font = 'bold 9px monospace';
      ctx.fillText(msg.slice(30, 58), lx + 5, ly + 34);
    }
    // Blinking cursor block.
    if (Math.floor(pop / 20) % 2 === 0) {
      ctx.fillStyle = '#2a3324';
      ctx.fillRect(lx + lw - 9, ly + lh - 10, 5, 7);
    }
    ctx.textAlign = 'left';
    return;
  }

  if (unread > 0) {
    // H1081: collapsed badge sits in the same upper-center band as the
    // pop-in (was the bottom-right corner, under the pedals).
    const x = GW / 2 - 13; const y = 46;
    ctx.fillStyle = '#23252a';
    ctx.fillRect(x, y, 26, 14);
    ctx.fillStyle = '#9aa88f';
    ctx.fillRect(x + 3, y + 3, 12, 8);
    ctx.fillStyle = '#f7a623';
    ctx.font = 'bold 9px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(String(unread), x + 18, y + 11);
  }
}
