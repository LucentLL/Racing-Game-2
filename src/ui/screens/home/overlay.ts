/**
 * H30 home-screen menu shell. Paints a tabbed menu over the HUD canvas
 * during 'playing' state when LIFE.homeScreenOpen is true. Each tab is
 * a placeholder for now — drawTitle/drawBills/etc. bodies port in
 * subsequent H commits and plug in via the dispatch table.
 *
 * Layout:
 *   - Dimmed full-screen backdrop so the world reads but doesn't compete
 *   - "AT HOME" title + day/time/money summary up top
 *   - 6 tab buttons in a 3×2 grid centered
 *   - Close hint at bottom (H or tap close)
 *
 * INTENTIONALLY simpler than the monolith's drawHomeScreen
 * (L47297-49869, with the full tabbed UI for GARAGE / SPECS / REPAIRS /
 * PARTS / MAIL / EAT / HOUSING / BILLS / BANK / NEWSPAPER). The shell
 * here only does the entry surface + tab buttons; tab bodies fill in
 * over time.
 */

import type { LifeState } from '@/state/life';
import type { Clock } from '@/state/clock';
import { formatClockTime } from '@/state/clock';

export type HomeTab = 'main' | 'garage' | 'bills' | 'newspaper' | 'eat' | 'calendar' | 'mail';

export interface HomeOverlayOpts {
  /** Canvas internal w / h. */
  GW: number;
  GH: number;
  life: LifeState;
  clock: Clock;
  /** Currently-open tab. 'main' shows the tab picker; others show a
   *  placeholder body for now. */
  tab: HomeTab;
}

export interface HomeOverlayDeps {
  /** Switch sub-tab (or close via tab='main' + the close button). */
  setTab(tab: HomeTab): void;
  /** Dismiss the overlay entirely. */
  close(): void;
}

interface ButtonRect {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  tab: HomeTab | 'close';
  enabled: boolean;
}

const BTN_W = 130;
const BTN_H = 44;
const BTN_GAP = 10;

/** Lays out the 6 tab buttons + the close button. Returns ButtonRects
 *  in canvas-space coords (origin at top-left). Shared between draw
 *  and click handler so geometry stays single-sourced. */
function layoutMainButtons(GW: number, GH: number): ButtonRect[] {
  const cx = GW / 2;
  // 3 cols × 2 rows centered around mid-screen.
  const totalW = BTN_W * 3 + BTN_GAP * 2;
  const totalH = BTN_H * 2 + BTN_GAP;
  const x0 = cx - totalW / 2;
  const y0 = GH / 2 - totalH / 2 + 20;
  const tabs: { label: string; tab: HomeTab; enabled: boolean }[] = [
    { label: 'GARAGE',    tab: 'garage',    enabled: false },
    { label: 'BILLS',     tab: 'bills',     enabled: false },
    { label: 'NEWSPAPER', tab: 'newspaper', enabled: false },
    { label: 'EAT',       tab: 'eat',       enabled: false },
    { label: 'CALENDAR',  tab: 'calendar',  enabled: false },
    { label: 'MAIL',      tab: 'mail',      enabled: false },
  ];
  const out: ButtonRect[] = [];
  tabs.forEach((t, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    out.push({
      x: x0 + col * (BTN_W + BTN_GAP),
      y: y0 + row * (BTN_H + BTN_GAP),
      w: BTN_W,
      h: BTN_H,
      label: t.label,
      tab: t.tab,
      enabled: t.enabled,
    });
  });
  // Close button.
  out.push({
    x: cx - 50,
    y: GH - 70,
    w: 100,
    h: 36,
    label: 'EXIT (H)',
    tab: 'close',
    enabled: true,
  });
  return out;
}

function hit(rect: ButtonRect, tx: number, ty: number): boolean {
  return tx >= rect.x && tx <= rect.x + rect.w && ty >= rect.y && ty <= rect.y + rect.h;
}

/** Paint the overlay onto the HUD canvas. */
export function drawHomeOverlay(ctx: CanvasRenderingContext2D, opts: HomeOverlayOpts): void {
  const { GW, GH, life, clock, tab } = opts;

  // Dimmed backdrop.
  ctx.fillStyle = 'rgba(8, 8, 18, 0.85)';
  ctx.fillRect(0, 0, GW, GH);

  // Header: AT HOME — Day N • HH:MM • $money
  ctx.fillStyle = '#0ff';
  ctx.font = 'bold 22px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('AT HOME', GW / 2, 50);

  ctx.fillStyle = '#fff';
  ctx.font = '14px monospace';
  const headerLine = `Day ${clock.day} • ${formatClockTime(clock)} • $${life.money.toLocaleString()}`;
  ctx.fillText(headerLine, GW / 2, 76);

  ctx.fillStyle = '#888';
  ctx.font = '11px monospace';
  ctx.fillText(`${life.playerAlias || 'NO NAME'} • ${life.playerJob || 'UNEMPLOYED'} • ${life.housingType}`, GW / 2, 96);

  if (tab === 'main') {
    drawMainButtons(ctx, GW, GH);
  } else {
    drawTabStub(ctx, GW, GH, tab);
  }

  ctx.textAlign = 'left';
}

function drawMainButtons(ctx: CanvasRenderingContext2D, GW: number, GH: number): void {
  const buttons = layoutMainButtons(GW, GH);
  ctx.font = 'bold 14px monospace';
  ctx.textAlign = 'center';
  for (const b of buttons) {
    const bg = b.tab === 'close'
      ? 'rgba(80, 30, 30, 0.55)'
      : b.enabled
      ? 'rgba(0, 80, 80, 0.55)'
      : 'rgba(60, 60, 70, 0.35)';
    const border = b.tab === 'close' ? '#c44' : b.enabled ? '#0ff' : '#555';
    const fg = b.tab === 'close' ? '#fcc' : b.enabled ? '#fff' : '#888';

    ctx.fillStyle = bg;
    ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.strokeStyle = border;
    ctx.lineWidth = 2;
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.fillStyle = fg;
    ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 + 5);

    if (!b.enabled && b.tab !== 'close') {
      ctx.fillStyle = '#fa0';
      ctx.font = '9px monospace';
      ctx.fillText('(coming soon)', b.x + b.w / 2, b.y + b.h - 6);
      ctx.font = 'bold 14px monospace';
    }
  }
  ctx.fillStyle = '#666';
  ctx.font = '11px monospace';
  ctx.fillText('Press H or tap EXIT to close', GW / 2, GH - 18);
}

function drawTabStub(ctx: CanvasRenderingContext2D, GW: number, GH: number, tab: HomeTab): void {
  ctx.fillStyle = '#fa0';
  ctx.font = 'bold 18px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(tab.toUpperCase(), GW / 2, GH / 2 - 20);
  ctx.fillStyle = '#aaa';
  ctx.font = '12px monospace';
  ctx.fillText('Tab body pending — port in a follow-up H commit.', GW / 2, GH / 2 + 8);
  // Back button.
  const bx = GW / 2 - 60;
  const by = GH / 2 + 40;
  ctx.fillStyle = 'rgba(0, 80, 80, 0.55)';
  ctx.fillRect(bx, by, 120, 32);
  ctx.strokeStyle = '#0ff';
  ctx.lineWidth = 2;
  ctx.strokeRect(bx, by, 120, 32);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 13px monospace';
  ctx.fillText('← BACK', GW / 2, by + 21);
}

/** Returns the back-button rect for the tab-stub view. Single source
 *  of geometry — duplicates the math inside drawTabStub above. */
function tabStubBackRect(GW: number, GH: number): ButtonRect {
  return {
    x: GW / 2 - 60,
    y: GH / 2 + 40,
    w: 120,
    h: 32,
    label: '← BACK',
    tab: 'main',
    enabled: true,
  };
}

/** Routes a tap on the overlay to a tab switch or close. Returns
 *  true if the tap was consumed (caller doesn't propagate further). */
export function handleHomeOverlayClick(
  tx: number,
  ty: number,
  opts: HomeOverlayOpts,
  deps: HomeOverlayDeps,
): boolean {
  if (opts.tab !== 'main') {
    // Tab body view — only the back button is hot.
    const back = tabStubBackRect(opts.GW, opts.GH);
    if (hit(back, tx, ty)) {
      deps.setTab('main');
      return true;
    }
    return true; // swallow taps inside the overlay even if no button hit
  }
  const buttons = layoutMainButtons(opts.GW, opts.GH);
  for (const b of buttons) {
    if (!hit(b, tx, ty)) continue;
    if (b.tab === 'close') {
      deps.close();
      return true;
    }
    if (!b.enabled) return true; // swallow but no-op
    deps.setTab(b.tab as HomeTab);
    return true;
  }
  return true; // overlay swallows all taps even on the dim backdrop
}
