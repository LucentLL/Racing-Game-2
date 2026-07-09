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
  /** H1090: the tap-to-open message-list modal is showing. */
  _pagerOpen?: boolean;
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

/** H1083: y just below the top-left RPM gauge disc. The mobile HUD
 *  canvas is 1:1 with CSS px (fitCanvases: hudCanvas.width=vw,
 *  height=vh), and the RPM gauge box mirrors the steering-wheel width
 *  min(400, vw*0.5-24, vh*0.42); the visible disc diameter is box×78/110
 *  from a 4px top margin. Anchoring off the same formula keeps the pager
 *  clear of the gauge in both portrait and landscape. */
function pagerAnchor(GW: number, GH: number): { x: number; y: number } {
  const box = Math.max(60, Math.min(400, GW * 0.5 - 24, GH * 0.42));
  const gaugeBottom = 4 + box * (78 / 110);
  return { x: 8, y: Math.round(gaugeBottom + 14) };
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
  const anchor = pagerAnchor(GW, GH);

  if (pop > 0 && latest) {
    lf._pagerPopFrames = pop - 1;
    // Slide in/out over the first/last 20 frames.
    const t = Math.min(1, Math.min(pop, POP_FRAMES - pop) / 20);
    const w = 196; const h = 52;
    // H1083: LEFT edge, just below the RPM gauge (the spot the user
    // marked with a cyan box). H1081's top-center placement tucked it
    // BEHIND the top-corner gauges. Slides in from the left edge.
    const x = anchor.x - (1 - t) * (w + 20);
    const y = anchor.y;

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

  // H1090: collapsed badge — shown whenever there are ANY pages (read or not)
  // so the pager stays TAPPABLE to review history, not just while unread. The
  // orange unread count only shows when unread > 0.
  if (pages.length > 0) {
    const x = anchor.x; const y = anchor.y;
    ctx.fillStyle = '#23252a';
    ctx.fillRect(x, y, 26, 14);
    ctx.fillStyle = '#9aa88f';
    ctx.fillRect(x + 3, y + 3, 12, 8);
    if (unread > 0) {
      ctx.fillStyle = '#f7a623';
      ctx.font = 'bold 9px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(String(unread), x + 18, y + 11);
    } else {
      // read: a dim antenna tick so the icon still reads as a pager.
      ctx.fillStyle = '#4a4d55';
      ctx.fillRect(x + 18, y + 2, 2, 5);
    }
  }
}

// ---------------------------------------------------------------------------
// H1090: tap-to-open message list.
// ---------------------------------------------------------------------------

export function isPagerOpen(life: LifeState): boolean {
  return (life as unknown as PagerLife)._pagerOpen === true;
}
export function setPagerOpen(life: LifeState, open: boolean): void {
  (life as unknown as PagerLife)._pagerOpen = open;
}

/** Hit-test the pager pop-in / collapsed badge (screen coords). True when the
 *  tap lands on the pager so the caller can open the message list. Generous
 *  touch target around the small badge. */
export function pagerHitTest(life: LifeState, tx: number, ty: number, GW: number, GH: number): boolean {
  const lf = life as unknown as PagerLife;
  const pages = lf.pages ?? [];
  if (pages.length === 0) return false;
  const anchor = pagerAnchor(GW, GH);
  const popped = (lf._pagerPopFrames ?? 0) > 0;
  const w = popped ? 196 : 44;   // badge is tiny — pad the touch box
  const h = popped ? 52 : 30;
  return tx >= anchor.x - 6 && tx <= anchor.x + w && ty >= anchor.y - 6 && ty <= anchor.y + h;
}

/** Full-screen pager MESSAGE LIST modal — the beeper's history, newest first.
 *  Any tap closes it (see gameLoop's tap router). Opening marks all read. */
export function drawPagerList(ctx: CanvasRenderingContext2D, life: LifeState, GW: number, GH: number): void {
  const pages = recentPages(life, 12);
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(0, 0, GW, GH);
  const w = Math.min(360, GW - 32);
  const rowH = 34;
  const bodyH = Math.max(1, pages.length) * rowH;
  const h = 44 + bodyH + 34;
  const x = Math.round((GW - w) / 2);
  const y = Math.round(Math.max(16, (GH - h) / 2));
  // Beeper shell.
  ctx.fillStyle = '#23252a';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#0c0d10';
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
  ctx.fillStyle = '#9aa88f';
  ctx.font = 'bold 13px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('📟 PAGER', GW / 2, y + 25);
  // LCD rows.
  const lx = x + 10; const lw = w - 20; let ly = y + 40;
  if (pages.length === 0) {
    ctx.fillStyle = '#9aa88f';
    ctx.fillRect(lx, ly, lw, rowH - 4);
    ctx.fillStyle = '#2a3324';
    ctx.font = 'bold 10px monospace';
    ctx.fillText('NO MESSAGES', GW / 2, ly + 19);
  } else {
    ctx.textAlign = 'left';
    for (const p of pages) {
      ctx.fillStyle = '#9aa88f';
      ctx.fillRect(lx, ly, lw, rowH - 4);
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(lx, ly, lw, 2);
      ctx.fillStyle = '#3a4a2c';
      ctx.font = 'bold 8px monospace';
      ctx.fillText(`DAY ${p.day} · ${p.slot.toUpperCase()}`, lx + 6, ly + 11);
      ctx.fillStyle = '#222a1c';
      ctx.font = 'bold 10px monospace';
      ctx.fillText(p.text.toUpperCase().slice(0, 36), lx + 6, ly + 24);
      ly += rowH;
    }
  }
  // Close hint bar.
  ctx.fillStyle = '#15161a';
  ctx.fillRect(x, y + h - 26, w, 26);
  ctx.fillStyle = '#9aa88f';
  ctx.font = 'bold 11px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('TAP TO CLOSE', GW / 2, y + h - 9);
  ctx.restore();
}
