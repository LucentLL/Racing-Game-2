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
import { CAR_CATALOG } from '@/config/cars/catalog';
import { spriteForCarName } from '@/render/carSprites';
import {
  monthlyHousing,
  monthlyCarPayments,
  monthlyBankPayments,
  monthlyTotalDue,
  totalCarLoansOwed,
  totalBankLoansOwed,
  daysUntilNextBilling,
  isAnyBillPastDue,
} from '@/sim/billsCalc';
import { HOUSING_TIERS, type HousingTierKey } from '@/config/housing';

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
    { label: 'GARAGE',    tab: 'garage',    enabled: true  },
    { label: 'BILLS',     tab: 'bills',     enabled: true  },
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
  } else if (tab === 'bills') {
    drawBillsTab(ctx, GW, GH, life, clock);
  } else if (tab === 'garage') {
    drawGarageTab(ctx, GW, GH, life);
  } else {
    drawTabStub(ctx, GW, GH, tab);
  }

  ctx.textAlign = 'left';
}

/** H31 BILLS tab — simplified port of monolith L49026-49350. Shows
 *  total monthly + days-until-next-billing countdown at the top, then
 *  three sections (HOUSING / CARS / BANK) with their per-line items.
 *
 *  Deferred from the full monolith body:
 *    - Collapsible section headers (currently always-expanded)
 *    - Past-due red banner + per-row red tinting (we show the missed-
 *      payments count instead)
 *    - Manual pay-now buttons (no interaction yet — informational only)
 *    - GET LOAN button on the BANK section (no bank-loan creation
 *      flow yet)
 *  Those land in subsequent H commits. */
function drawBillsTab(ctx: CanvasRenderingContext2D, GW: number, GH: number, life: LifeState, clock: Clock): void {
  const top = 120;
  const sectionPad = 10;
  let yy = top;

  // Header: total monthly + countdown.
  const total = monthlyTotalDue(life);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#c8f';
  ctx.font = 'bold 16px monospace';
  ctx.fillText('💵 BILLS & DEBTS', GW / 2, yy);
  yy += 22;
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 13px monospace';
  ctx.fillText(`$${total.toLocaleString()}/mo total`, GW / 2, yy);
  yy += 16;
  if (isAnyBillPastDue(life)) {
    ctx.fillStyle = '#f44';
    ctx.font = 'bold 11px monospace';
    ctx.fillText(`⚠ ${life.missedPayments} missed payment${(life.missedPayments || 0) === 1 ? '' : 's'}`, GW / 2, yy);
  } else if (total > 0) {
    const days = daysUntilNextBilling(clock.day);
    const color = days <= 1 ? '#f44' : days <= 3 ? '#fa0' : '#888';
    ctx.fillStyle = color;
    ctx.font = '10px monospace';
    ctx.fillText(`Next billing in ${days} day${days === 1 ? '' : 's'}`, GW / 2, yy);
  } else {
    ctx.fillStyle = '#0f0';
    ctx.font = '10px monospace';
    ctx.fillText('No debts — free and clear.', GW / 2, yy);
  }
  yy += sectionPad + 12;

  // Housing section.
  const housingCost = monthlyHousing(life);
  yy = drawBillsSection(ctx, GW, yy, '🏠 HOUSING', '#c8f', housingCost, life.mortgageBalance, [
    {
      label: HOUSING_TIERS[life.housingType as HousingTierKey]?.name || life.housingType,
      monthly: housingCost,
      detail: life.mortgageBalance > 0 ? `Mortgage bal $${life.mortgageBalance.toLocaleString()} • ${life.mortgageMonthsRemaining} mo left` : 'Renter — no balance',
    },
  ]);

  // Cars section.
  const carMonthly = monthlyCarPayments(life);
  const carOwed = totalCarLoansOwed(life);
  yy = drawBillsSection(ctx, GW, yy, '🚗 CARS', '#0cf', carMonthly, carOwed,
    life.carLoans.map((l) => {
      const car = CAR_CATALOG[l.carId];
      return {
        label: car ? car.name : l.carId,
        monthly: l.monthlyPayment,
        detail: `$${l.balance.toLocaleString()} bal • ${l.monthsRemaining} mo left`,
      };
    }),
  );

  // Bank section.
  const bankMonthly = monthlyBankPayments(life);
  const bankOwed = totalBankLoansOwed(life);
  yy = drawBillsSection(ctx, GW, yy, '🏦 BANK', '#0f8', bankMonthly, bankOwed,
    life.bankLoans.map((l) => ({
      label: `Bank loan • ${l.apr ? (l.apr * 100).toFixed(1) + '% APR' : ''}`,
      monthly: l.monthlyPayment,
      detail: `$${l.amount.toLocaleString()} bal • ${l.monthsRemaining} mo left`,
    })),
  );

  ctx.textAlign = 'left';

  // Back button.
  const bx = GW / 2 - 60;
  const by = GH - 80;
  ctx.fillStyle = 'rgba(0, 80, 80, 0.55)';
  ctx.fillRect(bx, by, 120, 32);
  ctx.strokeStyle = '#0ff';
  ctx.lineWidth = 2;
  ctx.strokeRect(bx, by, 120, 32);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 13px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('← BACK', GW / 2, by + 21);
}

interface BillRow {
  label: string;
  monthly: number;
  detail: string;
}

/** H32 GARAGE tab — simplified real port of monolith drawHomeGarage
 *  L48094-48213. Lists every car in life.ownedCars with sprite + name
 *  + loan status. The currently-active car (ownedCars[0]) gets a
 *  green border. Tap any other row → that car becomes active.
 *
 *  Deferred from full monolith:
 *    - SPECS / REPAIRS / PARTS sub-views (need getCarConditionForView
 *      + repair/parts subsystem)
 *    - Per-car condition stats (engine/tires/HP/paint live on LIFE
 *      for the ACTIVE car only currently; per-car snapshots need the
 *      carConditions persistence port)
 *    - Car ad sell flow (LIFE.carAds — needs newspaper ad subsystem)
 *    - Expand-panel with GET IN / REPAIRS / etc. buttons
 *    - Scroll bar / scroll state (H32 shows up to ~6 cars without
 *      scrolling; the simple test-mode fleet would overflow but
 *      that's a deferred edge case)
 *  Each piece ports in its own H commit. */
function drawGarageTab(ctx: CanvasRenderingContext2D, GW: number, GH: number, life: LifeState): void {
  const top = 120;
  let yy = top;

  ctx.textAlign = 'center';
  ctx.fillStyle = '#0ff';
  ctx.font = 'bold 16px monospace';
  ctx.fillText('🔧 GARAGE', GW / 2, yy);
  yy += 22;
  ctx.fillStyle = '#888';
  ctx.font = '11px monospace';
  const n = life.ownedCars.length;
  ctx.fillText(`${n} vehicle${n === 1 ? '' : 's'} owned — tap to set active`, GW / 2, yy);
  yy += 18;

  const rowH = 56;
  const rowW = GW - 60;
  const rowX = 30;
  const activeId = life.ownedCars[0];

  for (let i = 0; i < life.ownedCars.length && i < 7; i++) {
    const cid = life.ownedCars[i];
    const car = CAR_CATALOG[cid];
    if (!car) continue;
    const isActive = cid === activeId;
    const loan = life.carLoans.find((l) => l.carId === cid);

    // Row background.
    ctx.fillStyle = isActive ? 'rgba(0, 255, 100, 0.14)' : 'rgba(120, 120, 140, 0.10)';
    ctx.fillRect(rowX, yy, rowW, rowH);
    ctx.strokeStyle = isActive ? '#0f0' : '#555';
    ctx.lineWidth = isActive ? 2 : 1;
    ctx.strokeRect(rowX, yy, rowW, rowH);

    // Sprite preview on the left — fall back to a colored swatch if
    // sprite isn't loaded yet.
    const sprite = spriteForCarName(car.name);
    const spriteX = rowX + 8;
    const spriteY = yy + 8;
    const spriteW = 56;
    const spriteH = 40;
    if (sprite && sprite.complete && sprite.naturalWidth > 0) {
      const sm = ctx.imageSmoothingEnabled;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(sprite, spriteX, spriteY, spriteW, spriteH);
      ctx.imageSmoothingEnabled = sm;
    } else {
      ctx.fillStyle = car.color;
      ctx.fillRect(spriteX, spriteY, spriteW, spriteH);
    }

    // Name + tags.
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 12px monospace';
    ctx.textAlign = 'left';
    const nameMax = 36;
    const shown = car.name.length > nameMax ? car.name.slice(0, nameMax - 1) + '…' : car.name;
    ctx.fillText(shown, spriteX + spriteW + 12, yy + 16);

    ctx.fillStyle = '#aaa';
    ctx.font = '10px monospace';
    const tagBits: string[] = [];
    tagBits.push(car.drv);
    tagBits.push(car.defaultManual ? 'M' : 'A');
    if (isActive) tagBits.push('ACTIVE');
    ctx.fillText(tagBits.join(' • '), spriteX + spriteW + 12, yy + 32);

    if (loan) {
      ctx.fillStyle = '#fa0';
      ctx.font = '9px monospace';
      ctx.fillText(`$${loan.monthlyPayment}/mo • ${loan.monthsRemaining}mo left`, spriteX + spriteW + 12, yy + 47);
    } else if (car.price > 0) {
      ctx.fillStyle = '#0f8';
      ctx.font = '9px monospace';
      ctx.fillText('OWNED OUTRIGHT', spriteX + spriteW + 12, yy + 47);
    }

    // Price (right-aligned).
    ctx.textAlign = 'right';
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 11px monospace';
    ctx.fillText(`$${car.price.toLocaleString()}`, rowX + rowW - 12, yy + 18);
    ctx.fillStyle = '#888';
    ctx.font = '9px monospace';
    ctx.fillText('MSRP', rowX + rowW - 12, yy + 30);

    yy += rowH + 6;
  }

  if (life.ownedCars.length > 7) {
    ctx.fillStyle = '#888';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`+ ${life.ownedCars.length - 7} more (scroll not yet wired)`, GW / 2, yy + 8);
  }

  ctx.textAlign = 'left';

  // Back button — same anchor as bills.
  const bx = GW / 2 - 60;
  const by = GH - 80;
  ctx.fillStyle = 'rgba(0, 80, 80, 0.55)';
  ctx.fillRect(bx, by, 120, 32);
  ctx.strokeStyle = '#0ff';
  ctx.lineWidth = 2;
  ctx.strokeRect(bx, by, 120, 32);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 13px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('← BACK', GW / 2, by + 21);
}

/** Returns the garage row index at (tx, ty), or -1 if none. Same
 *  geometry as drawGarageTab. */
function hitGarageRow(opts: HomeOverlayOpts, tx: number, ty: number): number {
  const top = 120 + 22 + 18; // header height
  const rowH = 56;
  const rowGap = 6;
  const rowX = 30;
  const rowW = opts.GW - 60;
  for (let i = 0; i < opts.life.ownedCars.length && i < 7; i++) {
    const yy = top + i * (rowH + rowGap);
    if (tx >= rowX && tx <= rowX + rowW && ty >= yy && ty <= yy + rowH) return i;
  }
  return -1;
}

function drawBillsSection(
  ctx: CanvasRenderingContext2D,
  GW: number,
  yy: number,
  title: string,
  color: string,
  monthlyTotal: number,
  totalOwed: number,
  rows: BillRow[],
): number {
  // Section header.
  const headerH = 28;
  ctx.fillStyle = 'rgba(80, 80, 100, 0.18)';
  ctx.fillRect(20, yy, GW - 40, headerH);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.strokeRect(20, yy, GW - 40, headerH);
  ctx.fillStyle = color;
  ctx.font = 'bold 12px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(title, 28, yy + 12);
  ctx.font = '9px monospace';
  ctx.fillStyle = '#aaa';
  ctx.fillText(`${rows.length} item${rows.length === 1 ? '' : 's'}`, 28, yy + 22);
  ctx.textAlign = 'right';
  if (monthlyTotal > 0 || totalOwed > 0) {
    ctx.fillStyle = '#ff0';
    ctx.font = 'bold 11px monospace';
    ctx.fillText(`$${totalOwed.toLocaleString()} owed`, GW - 28, yy + 12);
    ctx.fillStyle = '#aaa';
    ctx.font = '9px monospace';
    ctx.fillText(`$${monthlyTotal.toLocaleString()}/mo`, GW - 28, yy + 22);
  } else {
    ctx.fillStyle = '#0f0';
    ctx.font = '9px monospace';
    ctx.fillText('— none —', GW - 28, yy + 17);
  }
  yy += headerH + 4;

  // Rows.
  for (const row of rows) {
    const rowH = 32;
    ctx.fillStyle = 'rgba(120, 120, 140, 0.08)';
    ctx.fillRect(28, yy, GW - 56, rowH);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'left';
    const lbl = row.label.length > 36 ? row.label.slice(0, 35) + '…' : row.label;
    ctx.fillText(lbl, 34, yy + 12);
    ctx.fillStyle = '#aaa';
    ctx.font = '9px monospace';
    ctx.fillText(row.detail, 34, yy + 24);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ff0';
    ctx.font = 'bold 10px monospace';
    ctx.fillText(`$${row.monthly.toLocaleString()}/mo`, GW - 34, yy + 18);
    yy += rowH + 3;
  }
  ctx.textAlign = 'left';
  return yy + 6;
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

/** Back-button rect for the bills / garage tabs (anchored to bottom,
 *  like the monolith). Both fleshed-out tabs share the same anchor. */
function bottomBackRect(GW: number, GH: number): ButtonRect {
  return {
    x: GW / 2 - 60,
    y: GH - 80,
    w: 120,
    h: 32,
    label: '← BACK',
    tab: 'main',
    enabled: true,
  };
}

/** Dispatch back-button geometry by tab. Each fleshed-out tab can
 *  override its own back position; stub tabs share the centered
 *  default. */
function backRectForTab(tab: HomeTab, GW: number, GH: number): ButtonRect {
  if (tab === 'bills' || tab === 'garage') return bottomBackRect(GW, GH);
  return tabStubBackRect(GW, GH);
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
    // Tab body view — back button first (consistent across tabs).
    const back = backRectForTab(opts.tab, opts.GW, opts.GH);
    if (hit(back, tx, ty)) {
      deps.setTab('main');
      return true;
    }
    // Per-tab body interactions.
    if (opts.tab === 'garage') {
      const rowIdx = hitGarageRow(opts, tx, ty);
      if (rowIdx > 0) {
        // Move tapped car to position 0 (= active).
        const cid = opts.life.ownedCars[rowIdx];
        opts.life.ownedCars.splice(rowIdx, 1);
        opts.life.ownedCars.unshift(cid);
        return true;
      }
      // rowIdx === 0 (already active) or -1 (miss) — fall through.
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
