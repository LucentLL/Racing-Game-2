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
import { DAYS_PER_MONTH } from '@/sim/monthlyBills';
import { HOUSING_TIERS, type HousingTierKey } from '@/config/housing';
import type {
  CarListing,
  HouseListing,
  NewspaperListing,
} from '@/sim/newspaperGenerator';

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
    { label: 'GARAGE',    tab: 'garage',    enabled: true },
    { label: 'BILLS',     tab: 'bills',     enabled: true },
    { label: 'NEWSPAPER', tab: 'newspaper', enabled: true },
    { label: 'EAT',       tab: 'eat',       enabled: true },
    { label: 'CALENDAR',  tab: 'calendar',  enabled: true },
    { label: 'MAIL',      tab: 'mail',      enabled: true },
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
  } else if (tab === 'calendar') {
    drawCalendarTab(ctx, GW, GH, clock, life);
  } else if (tab === 'eat') {
    drawEatTab(ctx, GW, GH, life);
  } else if (tab === 'mail') {
    drawMailTab(ctx, GW, GH, life, clock);
  } else if (tab === 'newspaper') {
    drawNewspaperTab(ctx, GW, GH, life);
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

/** H33 CALENDAR tab — simplified port of monolith drawCalendar
 *  L46326-46450. Shows the current 30-day month as a Sun-Sat grid,
 *  highlights today in cyan, marks bills-due days (day 1 of each
 *  next month) with a B badge. Day 1 of the in-game timeline is
 *  Friday (matches monolith v8.99.42 convention).
 *
 *  Deferred from full monolith:
 *    - prev/next month nav (◀ ▶ arrows)
 *    - getCalEventsForDay event badges (W=work, C=coffee, P=parts
 *      delivery, R=race, T=ticket, H=house-shopping, A=ad-expire)
 *    - missed-payment red days (need per-day persistence)
 *    - LIFE.monthDays (variable month lengths) — we use a flat
 *      30-day month
 *    - LIFE.monthNames (real January-December) — we use a 12-name
 *      cycle */
function drawCalendarTab(ctx: CanvasRenderingContext2D, GW: number, GH: number, clock: Clock, _life: LifeState): void {
  const top = 120;
  let yy = top;

  const monthIdx = Math.floor((clock.day - 1) / DAYS_PER_MONTH);
  const monthName = MONTH_NAMES[monthIdx % 12];
  const dayOfMonth = ((clock.day - 1) % DAYS_PER_MONTH) + 1;
  // The in-game day number of the 1st of this month.
  const firstDayGlobal = clock.day - (dayOfMonth - 1);
  // Day 1 = Friday (monolith convention). dayNames index 0..6 maps to
  // FRI, SAT, SUN, MON, TUE, WED, THU.
  const firstWeekIdx = ((firstDayGlobal - 1) % 7 + 7) % 7;
  // Sun-start grid column for each dayNames index.
  // FRI=col 5, SAT=col 6, SUN=col 0, MON=col 1, TUE=col 2, WED=col 3, THU=col 4
  const TO_GRID_COL = [5, 6, 0, 1, 2, 3, 4];
  const firstCol = TO_GRID_COL[firstWeekIdx];

  // Title + year.
  const yearNum = 1999 + Math.floor(monthIdx / 12);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#0ff';
  ctx.font = 'bold 16px monospace';
  ctx.fillText(`📅 ${monthName.toUpperCase()} ${yearNum}`, GW / 2, yy);
  yy += 22;
  ctx.fillStyle = '#888';
  ctx.font = '11px monospace';
  ctx.fillText(`Day ${clock.day} (in-game) • Today is the ${ordinal(dayOfMonth)}`, GW / 2, yy);
  yy += 18;

  // Day-of-week headers.
  const headers = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  const gridX = 30;
  const gridW = GW - 60;
  const cellW = Math.floor(gridW / 7);
  ctx.fillStyle = '#aaa';
  ctx.font = 'bold 10px monospace';
  for (let c = 0; c < 7; c++) {
    ctx.fillText(headers[c], gridX + c * cellW + cellW / 2, yy);
  }
  yy += 10;

  // Grid body.
  const cellH = 38;
  let col = firstCol;
  let row = 0;
  for (let d = 1; d <= DAYS_PER_MONTH; d++) {
    const cx = gridX + col * cellW;
    const cy = yy + row * cellH;
    const isToday = d === dayOfMonth;
    const isBillDay = d === 1;
    // Background.
    if (isToday) {
      ctx.fillStyle = 'rgba(0, 255, 255, 0.18)';
    } else if (isBillDay) {
      ctx.fillStyle = 'rgba(255, 80, 80, 0.10)';
    } else {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
    }
    ctx.fillRect(cx + 1, cy, cellW - 2, cellH - 1);
    if (isToday) {
      ctx.strokeStyle = '#0ff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(cx + 1, cy, cellW - 2, cellH - 1);
    }
    // Date number.
    ctx.fillStyle = isToday ? '#0ff' : col === 0 ? '#f88' : '#ccc';
    ctx.font = 'bold 10px monospace';
    ctx.fillText(String(d), cx + cellW / 2, cy + 12);
    // Bill badge on day 1.
    if (isBillDay) {
      const bSize = 12;
      const bx = cx + cellW - bSize - 2;
      const by = cy + cellH - bSize - 2;
      ctx.fillStyle = '#640';
      ctx.fillRect(bx, by, bSize, bSize);
      ctx.fillStyle = '#fa0';
      ctx.font = 'bold 9px monospace';
      ctx.fillText('B', bx + bSize / 2, by + bSize - 2);
    }

    col++;
    if (col > 6) {
      col = 0;
      row++;
    }
  }

  // Legend below the grid.
  const legY = yy + Math.ceil((DAYS_PER_MONTH + firstCol) / 7) * cellH + 14;
  ctx.fillStyle = '#888';
  ctx.font = '9px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('Legend:  B = bills due  •  cyan = today  •  red column = Sunday', GW / 2, legY);
  ctx.fillText(`Bills next due in ${daysUntilNextBilling(clock.day)} day(s)`, GW / 2, legY + 14);

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

/** Cyclic 12-month name list. Real game-year tracking lands when
 *  LIFE.monthNames + monthDays port. */
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return n + 'th';
  switch (n % 10) {
    case 1: return n + 'st';
    case 2: return n + 'nd';
    case 3: return n + 'rd';
    default: return n + 'th';
  }
}

// =====================================================================
// H34 EAT tab
// =====================================================================

interface FoodTier {
  key: 'junk' | 'regular' | 'premium';
  icon: string;
  label: string;
  color: string;
  hEffect: string;
}

const FOOD_TIERS: readonly FoodTier[] = [
  { key: 'junk',    icon: '🍔', label: 'Fast Food',     color: '#f80', hEffect: '-1/day' },
  { key: 'regular', icon: '🍲', label: 'Regular Meal',  color: '#ff0', hEffect: '+1/day' },
  { key: 'premium', icon: '🥗', label: 'Premium Meal',  color: '#0f0', hEffect: '+2/day' },
];

/** H34 EAT tab — health/fitness bars + 3 food-tier eat rows.
 *  Real port of monolith drawHomeEat L48772-48850 in simplified form.
 *
 *  Deferred:
 *    - Sleep / nap actions (need timeSlot wiring)
 *    - Buy-food shop section (needs money check + foodStock + price
 *      table — easy follow-up)
 *    - Gym / workout / coffee buffs (need their own subsystems)
 *    - Real health-status getter + per-tier effect application
 *      (ate-junk should hit fitness, ate-premium should boost health,
 *      etc. — we apply the simple ateToday flag for now). */
function drawEatTab(ctx: CanvasRenderingContext2D, GW: number, GH: number, life: LifeState): void {
  let yy = 120;
  ctx.textAlign = 'center';
  ctx.fillStyle = '#0f0';
  ctx.font = 'bold 16px monospace';
  ctx.fillText('❤️ HEALTH & FITNESS', GW / 2, yy);
  yy += 22;

  // Health bar.
  drawStatBar(ctx, GW, yy, 'HEALTH', life.health, '#f44', '#0f0');
  yy += 22;
  // Fitness bar.
  drawStatBar(ctx, GW, yy, 'FITNESS', life.fitness, '#fa0', '#0cf');
  yy += 26;

  // Status / hunger warnings.
  ctx.font = '11px monospace';
  if (life.daysSinceEat >= 2) {
    ctx.fillStyle = '#f88';
    ctx.fillText(`🚨 Starving (${life.daysSinceEat} days)`, GW / 2, yy);
  } else if (life.daysSinceEat >= 1) {
    ctx.fillStyle = '#fa0';
    ctx.fillText('⚠️ Hungry', GW / 2, yy);
  } else if (life.ateToday) {
    ctx.fillStyle = '#8f8';
    ctx.fillText('Fed today ✓', GW / 2, yy);
  } else {
    ctx.fillStyle = '#aaa';
    ctx.fillText('Feeling okay', GW / 2, yy);
  }
  yy += 22;

  // Divider.
  ctx.strokeStyle = '#555';
  ctx.beginPath();
  ctx.moveTo(30, yy);
  ctx.lineTo(GW - 30, yy);
  ctx.stroke();
  yy += 14;
  ctx.fillStyle = '#0f0';
  ctx.font = 'bold 12px monospace';
  ctx.fillText('🍽️ EAT (instant — no time slot)', GW / 2, yy);
  yy += 16;

  // Eat buttons.
  const rowH = 36;
  for (const ft of FOOD_TIERS) {
    const qty = life.foodStock[ft.key] || 0;
    const canEat = qty > 0 && !life.ateToday;
    ctx.fillStyle = canEat ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.04)';
    ctx.fillRect(28, yy, GW - 56, rowH);
    ctx.strokeStyle = canEat ? ft.color : '#444';
    ctx.lineWidth = canEat ? 2 : 1;
    ctx.strokeRect(28, yy, GW - 56, rowH);

    ctx.fillStyle = canEat ? ft.color : '#666';
    ctx.font = 'bold 12px monospace';
    ctx.fillText(`${ft.icon} ${ft.label} × ${qty}`, GW / 2, yy + 14);
    ctx.fillStyle = canEat ? '#aaa' : '#555';
    ctx.font = '9px monospace';
    const msg = life.ateToday
      ? 'Already ate today'
      : qty > 0
        ? `Tap to eat • ${ft.hEffect}`
        : 'None in stock';
    ctx.fillText(msg, GW / 2, yy + 28);
    yy += rowH + 4;
  }

  ctx.textAlign = 'left';
  drawBottomBack(ctx, GW, GH);
}

function drawStatBar(ctx: CanvasRenderingContext2D, GW: number, yy: number, label: string, pct: number, badColor: string, goodColor: string): void {
  const v = Math.max(0, Math.min(100, pct || 0));
  const w = GW - 60;
  const x = 30;
  ctx.fillStyle = '#222';
  ctx.fillRect(x, yy, w, 14);
  ctx.fillStyle = v < 35 ? badColor : goodColor;
  ctx.fillRect(x, yy, Math.round((w * v) / 100), 14);
  ctx.strokeStyle = '#555';
  ctx.lineWidth = 1;
  ctx.strokeRect(x, yy, w, 14);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 10px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(`${label}: ${Math.round(v)}%`, GW / 2, yy + 11);
}

/** Returns the eat-row index at (tx, ty), or -1 if none. */
function hitEatRow(opts: HomeOverlayOpts, tx: number, ty: number): number {
  // Mirror layout in drawEatTab.
  let yy = 120 + 22 + 22 + 22 + 26 + 22 + 14 + 16;
  const rowH = 36;
  for (let i = 0; i < FOOD_TIERS.length; i++) {
    if (tx >= 28 && tx <= opts.GW - 28 && ty >= yy && ty <= yy + rowH) return i;
    yy += rowH + 4;
  }
  return -1;
}

// =====================================================================
// H34 MAIL tab
// =====================================================================

interface MailItem {
  type?: string;
  carName?: string;
  amount?: number;
  day?: number;
}

/** H34 MAIL tab — real port of monolith drawHomeMail L47796-47880 in
 *  simplified form. Shows the list of `life.mail` items with an
 *  empty-state fallback. Packages section ports when pendingParts has
 *  any items (currently always empty).
 *
 *  Deferred:
 *    - 'Accept' action on car offers (would mutate carAds + ownedCars)
 *    - Read/unread badging beyond the simple "mark all read on open"
 *    - Pending-parts ETA + auto-install on delivery (need parts subsystem) */
function drawMailTab(ctx: CanvasRenderingContext2D, GW: number, GH: number, life: LifeState, clock: Clock): void {
  let yy = 120;
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ff0';
  ctx.font = 'bold 16px monospace';
  ctx.fillText('📬 MAILBOX', GW / 2, yy);
  yy += 22;

  const mail = (life.mail || []) as MailItem[];
  const offers = mail.filter((m) => m.type === 'carOffer');
  const packages = life.pendingParts || [];

  if (offers.length === 0 && packages.length === 0) {
    ctx.fillStyle = '#888';
    ctx.font = '12px monospace';
    ctx.fillText('No mail today.', GW / 2, yy + 14);
    ctx.fillStyle = '#666';
    ctx.font = '10px monospace';
    ctx.fillText('Offers arrive Mon-Fri when you list a car.', GW / 2, yy + 36);
    ctx.fillText('Parts you order via DIY delivery land here too.', GW / 2, yy + 50);
    ctx.textAlign = 'left';
    drawBottomBack(ctx, GW, GH);
    return;
  }

  if (offers.length > 0) {
    ctx.fillStyle = '#fa0';
    ctx.font = 'bold 12px monospace';
    ctx.fillText('📰 BUYER OFFERS', GW / 2, yy + 12);
    yy += 22;
    for (const m of offers) {
      ctx.fillStyle = 'rgba(255,170,0,0.08)';
      ctx.fillRect(28, yy, GW - 56, 36);
      ctx.strokeStyle = '#fa0';
      ctx.lineWidth = 1;
      ctx.strokeRect(28, yy, GW - 56, 36);
      ctx.fillStyle = '#fa0';
      ctx.font = 'bold 10px monospace';
      ctx.fillText(m.carName || '—', GW / 2, yy + 13);
      ctx.fillStyle = '#fff';
      ctx.font = '11px monospace';
      ctx.fillText(`Offer: $${(m.amount || 0).toLocaleString()}`, GW / 2, yy + 25);
      ctx.fillStyle = '#888';
      ctx.font = '8px monospace';
      const ago = Math.max(0, clock.day - (m.day || clock.day));
      ctx.fillText(ago === 0 ? 'today' : `${ago}d ago`, GW / 2, yy + 33);
      yy += 40;
    }
  }

  if (packages.length > 0) {
    yy += 6;
    ctx.fillStyle = '#ff0';
    ctx.font = 'bold 12px monospace';
    ctx.fillText('📦 PACKAGES', GW / 2, yy + 12);
    yy += 22;
    // Placeholder rows — parts shape isn't typed in interim port.
    for (const p of packages as Array<{ name?: string }>) {
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(28, yy, GW - 56, 30);
      ctx.strokeStyle = '#ff0';
      ctx.strokeRect(28, yy, GW - 56, 30);
      ctx.fillStyle = '#fff';
      ctx.font = '10px monospace';
      ctx.fillText(p.name || 'Package', GW / 2, yy + 18);
      yy += 34;
    }
  }

  ctx.textAlign = 'left';
  drawBottomBack(ctx, GW, GH);
}

// =====================================================================
// H34 NEWSPAPER tab
// =====================================================================

/** Per-tab geometry pinned at the top so hit-tests and draw share. */
const NEWS_TAB_Y = 120 + 22 + 16; // section-toggle y (header + subtitle)
const NEWS_TAB_W = 110;
const NEWS_TAB_H = 28;
const NEWS_TAB_GAP = 8;
const NEWS_ROW_TOP = NEWS_TAB_Y + NEWS_TAB_H + 16;
const NEWS_ROW_H = 50;
const NEWS_ROW_GAP = 6;

/** H35 NEWSPAPER tab — real port of monolith drawHomeNewspaper
 *  L50045-50260 in simplified form. Two section tabs (CARS / HOMES)
 *  keyed on life.newspaperSection; below them, real listing rows from
 *  life.newspaper (filled by generateNewspaperListings on home open).
 *
 *  Deferred from the full monolith body:
 *    - Tap-a-row → place pin + open seller/realtor visit (needs the
 *      map-pin + visit subsystems)
 *    - Affordability green/yellow coloring beyond the simple price-vs-
 *      money check we do today
 *    - Daily refresh + per-listing expiresDay aging (fillNewspaper port) */
function drawNewspaperTab(ctx: CanvasRenderingContext2D, GW: number, GH: number, life: LifeState): void {
  let yy = 120;
  ctx.textAlign = 'center';
  ctx.fillStyle = '#0cf';
  ctx.font = 'bold 16px monospace';
  ctx.fillText('📰 CHARLOTTE OBSERVER', GW / 2, yy);
  yy += 22;
  ctx.fillStyle = '#888';
  ctx.font = '11px monospace';
  ctx.fillText('Classifieds', GW / 2, yy);
  yy += 16;

  // Section tabs.
  const tabs: { label: string; key: 'cars' | 'homes' }[] = [
    { label: 'CARS',  key: 'cars'  },
    { label: 'HOMES', key: 'homes' },
  ];
  const tabsTotalW = tabs.length * NEWS_TAB_W + (tabs.length - 1) * NEWS_TAB_GAP;
  const tabX0 = GW / 2 - tabsTotalW / 2;
  for (let i = 0; i < tabs.length; i++) {
    const t = tabs[i];
    const x = tabX0 + i * (NEWS_TAB_W + NEWS_TAB_GAP);
    const active = life.newspaperSection === t.key;
    ctx.fillStyle = active ? 'rgba(0, 200, 255, 0.18)' : 'rgba(80, 80, 100, 0.10)';
    ctx.fillRect(x, yy, NEWS_TAB_W, NEWS_TAB_H);
    ctx.strokeStyle = active ? '#0cf' : '#555';
    ctx.lineWidth = active ? 2 : 1;
    ctx.strokeRect(x, yy, NEWS_TAB_W, NEWS_TAB_H);
    ctx.fillStyle = active ? '#0cf' : '#aaa';
    ctx.font = 'bold 11px monospace';
    ctx.fillText(t.label, x + NEWS_TAB_W / 2, yy + 18);
  }
  yy = NEWS_ROW_TOP;

  // Filter and render.
  const all = life.newspaper || [];
  const filtered: NewspaperListing[] = life.newspaperSection === 'homes'
    ? all.filter((l): l is HouseListing => l.type === 'house')
    : all.filter((l): l is CarListing => l.type === 'car');

  if (filtered.length === 0) {
    ctx.fillStyle = '#888';
    ctx.font = '12px monospace';
    ctx.fillText('No listings today.', GW / 2, yy + 20);
    ctx.fillStyle = '#666';
    ctx.font = '9px monospace';
    ctx.fillText('A fresh paper drops every day.', GW / 2, yy + 38);
    ctx.textAlign = 'left';
    drawBottomBack(ctx, GW, GH);
    return;
  }

  const maxRows = 6;
  const rowsToDraw = Math.min(filtered.length, maxRows);
  const rowX = 28;
  const rowW = GW - 56;
  for (let i = 0; i < rowsToDraw; i++) {
    const listing = filtered[i];
    if (listing.type === 'car') {
      drawCarListingRow(ctx, listing, rowX, yy, rowW, life.money);
    } else {
      drawHouseListingRow(ctx, listing, rowX, yy, rowW, life.money);
    }
    yy += NEWS_ROW_H + NEWS_ROW_GAP;
  }
  if (filtered.length > maxRows) {
    ctx.fillStyle = '#888';
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`+ ${filtered.length - maxRows} more (scroll pending)`, GW / 2, yy + 8);
    yy += 14;
  }

  // H36 footer hint.
  ctx.fillStyle = '#666';
  ctx.font = '9px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('Tap a row to pin/unpin • Fresh paper daily', GW / 2, yy + 14);

  ctx.textAlign = 'left';
  drawBottomBack(ctx, GW, GH);
}

function drawCarListingRow(
  ctx: CanvasRenderingContext2D,
  listing: CarListing,
  rowX: number,
  yy: number,
  rowW: number,
  money: number,
): void {
  const affordable = money >= listing.price;
  ctx.fillStyle = listing.isPinned ? 'rgba(255, 200, 60, 0.10)' : 'rgba(0, 200, 255, 0.07)';
  ctx.fillRect(rowX, yy, rowW, NEWS_ROW_H);
  ctx.strokeStyle = listing.isPinned ? '#fc6' : affordable ? '#0f8' : '#555';
  ctx.lineWidth = listing.isPinned ? 2 : 1;
  ctx.strokeRect(rowX, yy, rowW, NEWS_ROW_H);
  if (listing.isPinned) drawPinBadge(ctx, rowX + rowW - 18, yy + 14);

  ctx.textAlign = 'left';
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 11px monospace';
  const name = listing.name.length > 40 ? listing.name.slice(0, 39) + '…' : listing.name;
  ctx.fillText(name, rowX + 8, yy + 14);

  ctx.fillStyle = '#aaa';
  ctx.font = '9px monospace';
  const condTxt = listing.isNew ? 'NEW' : `${listing.cond}% cond`;
  const mileTxt = listing.isNew ? '' : ` • ${listing.mileage.toLocaleString()} mi`;
  ctx.fillText(`${condTxt}${mileTxt} • ${listing.hp} hp`, rowX + 8, yy + 28);

  if (listing.problem) {
    ctx.fillStyle = '#fa6';
    ctx.font = '9px monospace';
    ctx.fillText(`⚠ ${listing.problem}`, rowX + 8, yy + 42);
  } else if (listing.isNew) {
    ctx.fillStyle = '#0f8';
    ctx.font = '9px monospace';
    ctx.fillText('Dealer-fresh • clean title', rowX + 8, yy + 42);
  } else {
    ctx.fillStyle = '#888';
    ctx.font = '9px monospace';
    ctx.fillText('Private seller', rowX + 8, yy + 42);
  }

  ctx.textAlign = 'right';
  ctx.fillStyle = affordable ? '#0f8' : '#fff';
  ctx.font = 'bold 13px monospace';
  ctx.fillText(`$${listing.price.toLocaleString()}`, rowX + rowW - 10, yy + 18);
  ctx.fillStyle = affordable ? '#8f8' : '#888';
  ctx.font = '9px monospace';
  ctx.fillText(affordable ? 'AFFORDABLE' : 'OUT OF REACH', rowX + rowW - 10, yy + 33);
}

function drawHouseListingRow(
  ctx: CanvasRenderingContext2D,
  listing: HouseListing,
  rowX: number,
  yy: number,
  rowW: number,
  money: number,
): void {
  // Rental "affordable" = 2× monthly liquid; owned = 5% down liquid.
  const affordable = listing.isRental
    ? money >= listing.price * 2
    : money >= listing.price * 0.05;
  ctx.fillStyle = listing.isPinned ? 'rgba(255, 200, 60, 0.10)' : 'rgba(200, 150, 255, 0.07)';
  ctx.fillRect(rowX, yy, rowW, NEWS_ROW_H);
  ctx.strokeStyle = listing.isPinned ? '#fc6' : affordable ? '#0f8' : '#555';
  ctx.lineWidth = listing.isPinned ? 2 : 1;
  ctx.strokeRect(rowX, yy, rowW, NEWS_ROW_H);
  if (listing.isPinned) drawPinBadge(ctx, rowX + rowW - 18, yy + 14);

  ctx.textAlign = 'left';
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 11px monospace';
  ctx.fillText(listing.name, rowX + 8, yy + 14);

  ctx.fillStyle = '#aaa';
  ctx.font = '9px monospace';
  ctx.fillText(listing.address, rowX + 8, yy + 28);

  ctx.fillStyle = '#c8f';
  ctx.font = '9px monospace';
  const tag = listing.isRental
    ? `RENTAL • ${listing.slots} slot${listing.slots === 1 ? '' : 's'}`
    : `FOR SALE • ${listing.slots} slot${listing.slots === 1 ? '' : 's'}`;
  ctx.fillText(tag, rowX + 8, yy + 42);

  ctx.textAlign = 'right';
  ctx.fillStyle = affordable ? '#0f8' : '#fff';
  ctx.font = 'bold 13px monospace';
  if (listing.isRental) {
    ctx.fillText(`$${listing.price.toLocaleString()}/mo`, rowX + rowW - 10, yy + 18);
  } else {
    ctx.fillText(`$${listing.price.toLocaleString()}`, rowX + rowW - 10, yy + 18);
  }
  ctx.fillStyle = '#888';
  ctx.font = '9px monospace';
  if (listing.isRental) {
    ctx.fillText('rent', rowX + rowW - 10, yy + 33);
  } else {
    ctx.fillText(`~$${listing.monthlyEst.toLocaleString()}/mo mortgage`, rowX + rowW - 10, yy + 33);
  }
}

/** Hit-test the newspaper section tabs. Returns the section key or
 *  null. */
function hitNewspaperTabs(opts: HomeOverlayOpts, tx: number, ty: number): 'cars' | 'homes' | null {
  const tabsTotalW = 2 * NEWS_TAB_W + NEWS_TAB_GAP;
  const tabX0 = opts.GW / 2 - tabsTotalW / 2;
  if (ty < NEWS_TAB_Y || ty > NEWS_TAB_Y + NEWS_TAB_H) return null;
  for (let i = 0; i < 2; i++) {
    const x = tabX0 + i * (NEWS_TAB_W + NEWS_TAB_GAP);
    if (tx >= x && tx <= x + NEWS_TAB_W) return i === 0 ? 'cars' : 'homes';
  }
  return null;
}

/** Hit-test a newspaper listing row. Returns the listing under (tx,ty)
 *  or null. Mirrors the layout in drawNewspaperTab. */
function hitNewspaperRow(opts: HomeOverlayOpts, tx: number, ty: number): NewspaperListing | null {
  const all = opts.life.newspaper || [];
  const filtered: NewspaperListing[] = opts.life.newspaperSection === 'homes'
    ? all.filter((l): l is HouseListing => l.type === 'house')
    : all.filter((l): l is CarListing => l.type === 'car');
  const rowX = 28;
  const rowW = opts.GW - 56;
  const maxRows = 6;
  const rowsToCheck = Math.min(filtered.length, maxRows);
  let yy = NEWS_ROW_TOP;
  for (let i = 0; i < rowsToCheck; i++) {
    if (tx >= rowX && tx <= rowX + rowW && ty >= yy && ty <= yy + NEWS_ROW_H) {
      return filtered[i];
    }
    yy += NEWS_ROW_H + NEWS_ROW_GAP;
  }
  return null;
}

/** H36 pin marker for a pinned newspaper row. Tiny yellow badge at the
 *  top-right of the row. */
function drawPinBadge(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
  ctx.textAlign = 'center';
  ctx.font = '12px monospace';
  ctx.fillStyle = '#fc6';
  ctx.fillText('📌', cx, cy);
}

function drawBottomBack(ctx: CanvasRenderingContext2D, GW: number, GH: number): void {
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
  if (tab !== 'main') return bottomBackRect(GW, GH);
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
        const cid = opts.life.ownedCars[rowIdx];
        opts.life.ownedCars.splice(rowIdx, 1);
        opts.life.ownedCars.unshift(cid);
        return true;
      }
    } else if (opts.tab === 'eat') {
      const idx = hitEatRow(opts, tx, ty);
      if (idx >= 0) {
        const tier = FOOD_TIERS[idx];
        const qty = opts.life.foodStock[tier.key] || 0;
        if (qty > 0 && !opts.life.ateToday) {
          opts.life.foodStock[tier.key] = qty - 1;
          opts.life.ateToday = true;
          opts.life.daysSinceEat = 0;
          opts.life.lastMealTier = tier.key;
          // Simple per-tier health/fitness deltas — placeholder until
          // the real applyEatEffects body ports.
          if (tier.key === 'junk') {
            opts.life.fitness = Math.max(0, opts.life.fitness - 1);
          } else if (tier.key === 'premium') {
            opts.life.health = Math.min(100, opts.life.health + 2);
          }
        }
        return true;
      }
    } else if (opts.tab === 'newspaper') {
      const section = hitNewspaperTabs(opts, tx, ty);
      if (section) {
        opts.life.newspaperSection = section;
        return true;
      }
      // H36 tap-to-pin: toggle isPinned on the tapped listing. Pinned
      // rows survive daily fillNewspaperListings refresh.
      const row = hitNewspaperRow(opts, tx, ty);
      if (row) {
        row.isPinned = !row.isPinned;
        return true;
      }
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
