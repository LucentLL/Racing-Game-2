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
import { CAR_CATALOG, ALL_CAR_IDS, type CatalogCar } from '@/config/cars/catalog';
import { GT4_SPECS } from '@/config/cars/gt4Database';
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
import { payLoanNow } from '@/sim/payLoanNow';

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

  // Housing section. No PAY button — rent/mortgage prepay is a
  // different mechanic; the monolith's bills-due popup handles housing
  // separately.
  const housingCost = monthlyHousing(life);
  yy = drawBillsSection(ctx, GW, yy, '🏠 HOUSING', '#c8f', housingCost, life.mortgageBalance, [
    {
      label: HOUSING_TIERS[life.housingType as HousingTierKey]?.name || life.housingType,
      monthly: housingCost,
      detail: life.mortgageBalance > 0 ? `Mortgage bal $${life.mortgageBalance.toLocaleString()} • ${life.mortgageMonthsRemaining} mo left` : 'Renter — no balance',
    },
  ], life.money, null);

  // Cars section.
  const carMonthly = monthlyCarPayments(life);
  const carOwed = totalCarLoansOwed(life);
  const payRects: BillsPayRect[] = [];
  yy = drawBillsSection(ctx, GW, yy, '🚗 CARS', '#0cf', carMonthly, carOwed,
    life.carLoans.map((l, idx) => {
      const car = CAR_CATALOG[l.carId];
      return {
        label: car ? car.name : l.carId,
        monthly: l.monthlyPayment,
        detail: `$${l.balance.toLocaleString()} bal • ${l.monthsRemaining} mo left`,
        pay: { list: 'car', idx, cost: l.monthlyPayment },
      };
    }),
    life.money,
    payRects,
  );

  // Bank section.
  const bankMonthly = monthlyBankPayments(life);
  const bankOwed = totalBankLoansOwed(life);
  yy = drawBillsSection(ctx, GW, yy, '🏦 BANK', '#0f8', bankMonthly, bankOwed,
    life.bankLoans.map((l, idx) => ({
      label: `Bank loan • ${l.apr ? (l.apr * 100).toFixed(1) + '% APR' : ''}`,
      monthly: l.monthlyPayment,
      detail: `$${l.amount.toLocaleString()} bal • ${l.monthsRemaining} mo left`,
      pay: { list: 'bank', idx, cost: l.monthlyPayment },
    })),
    life.money,
    payRects,
  );
  // H39: stash for tap dispatch. Transient — not persisted.
  life._billsPayRects = payRects;

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

/** H40 — geometry of a single garage row, stashed on life for tap
 *  dispatch. Rebuilt every draw. */
interface GarageRowRect {
  x: number;
  y: number;
  w: number;
  h: number;
  idx: number;
}

/** H40 — geometry of the MAKE ACTIVE button inside the expand panel. */
interface GarageMakeActiveRect {
  x: number;
  y: number;
  w: number;
  h: number;
  idx: number;
}

interface BillRow {
  label: string;
  monthly: number;
  detail: string;
  /** H39: when set, drawBillsSection renders a PAY button on this row
   *  and pushes its rect into the accumulator so the click handler can
   *  match the tap → loan. Housing rows leave this empty (rent/mortgage
   *  prepay is a different mechanic). */
  pay?: { list: 'car' | 'bank'; idx: number; cost: number };
}

/** H39 PAY-button rect, stashed on life so the bills tap handler can
 *  hit-test without re-deriving section geometry. */
interface BillsPayRect {
  x: number;
  y: number;
  w: number;
  h: number;
  list: 'car' | 'bank';
  idx: number;
  cost: number;
  enabled: boolean;
}

/** H32/H40 GARAGE tab — simplified real port of monolith drawHomeGarage
 *  L48094-48213. Lists every car in life.ownedCars with sprite + name
 *  + loan status. Tap any row → expand inline to a SPECS panel. The
 *  active car (ownedCars[0]) gets a green border. Inside the expand
 *  panel non-active cars get a MAKE ACTIVE button.
 *
 *  Deferred from full monolith:
 *    - REPAIRS / PARTS sub-views (need repair/parts subsystem)
 *    - Per-car condition stats for non-active cars
 *      (engine/tires/HP/paint live on LIFE for the ACTIVE car only;
 *      per-car snapshots need the carConditions persistence port)
 *    - Car ad sell flow (LIFE.carAds — needs newspaper ad subsystem)
 *    - GET IN button (drive-this-car flow)
 *    - Scroll bar / scroll state (H32 shows up to ~6 cars without
 *      scrolling; the simple test-mode fleet would overflow but
 *      that's a deferred edge case)
 *  Each piece ports in its own H commit. */
function drawGarageTab(ctx: CanvasRenderingContext2D, GW: number, GH: number, life: LifeState): void {
  // H162: SPECS sub-view dispatch. When the player tapped SPECS on a
  // garage row, _garageView flips to 'specs' and _garageSpecsCarId
  // holds the car to inspect; the full tab area takes over with the
  // fleet-normalized gauge view. Back button there flips back to
  // 'list' to return here. List view stays the default.
  const garageView = life._garageView === 'specs' ? 'specs' : 'list';
  if (garageView === 'specs') {
    const cid = (life._garageSpecsCarId as string | undefined) ?? life.ownedCars[0];
    const car = cid ? CAR_CATALOG[cid] : undefined;
    if (car) {
      drawGarageSpecsView(ctx, GW, GH, life, car);
      return;
    }
    // Stale car id — fall through to the normal list.
    life._garageView = 'list';
  }
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
  ctx.fillText(`${n} vehicle${n === 1 ? '' : 's'} owned — tap row for specs`, GW / 2, yy);
  yy += 18;

  const rowH = 56;
  const rowW = GW - 60;
  const rowX = 30;
  const activeId = life.ownedCars[0];
  const expandedIdx = life._garageExpandedIdx as number | undefined;
  const rowRects: GarageRowRect[] = [];
  let makeActiveRect: GarageMakeActiveRect | null = null;

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
    if (i === expandedIdx) tagBits.push('▼');
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
    // H161: per-car odometer. H78 wear-tick already populates
    // life.carOdometers[cid] each frame in drawPlaying; this row
    // surfaces it so the player can SEE accumulated mileage per
    // car. RHD chassis (catalog.rhd === true) display km, LHD
    // display mi — same unit choice + 0.0001278 / 0.0002056 scale
    // the monolith uses at L7708 for the car-pin tooltip.
    {
      const _odoUnits = life.carOdometers?.[cid] ?? 0;
      const _useKm = car.rhd;
      const _dist = _odoUnits * (_useKm ? 0.0002056 : 0.0001278);
      const _suffix = _useKm ? 'km' : 'mi';
      const _odoStr = _dist >= 1000
        ? `${(_dist / 1000).toFixed(1)}k${_suffix}`
        : `${Math.round(_dist)}${_suffix}`;
      ctx.fillStyle = '#9af';
      ctx.font = '9px monospace';
      ctx.fillText(_odoStr, rowX + rowW - 12, yy + 45);
    }

    rowRects.push({ x: rowX, y: yy, w: rowW, h: rowH, idx: i });
    yy += rowH + 6;

    // H40 expand panel for the focused row.
    if (i === expandedIdx) {
      const panelH = 86;
      makeActiveRect = drawGarageExpandPanel(ctx, life, car, isActive, rowX, yy, rowW, panelH);
      yy += panelH + 6;
    }
  }

  if (life.ownedCars.length > 7) {
    ctx.fillStyle = '#888';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`+ ${life.ownedCars.length - 7} more (scroll not yet wired)`, GW / 2, yy + 8);
  }

  // Stash hit-test geometry on life for the click router.
  life._garageRowRects = rowRects;
  life._garageMakeActiveRect = makeActiveRect;

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

/** H40 — paint the SPECS expand panel under a focused garage row.
 *  Returns the MAKE ACTIVE button rect (or null when already active),
 *  so the click handler can hit-test it. */
function drawGarageExpandPanel(
  ctx: CanvasRenderingContext2D,
  life: LifeState,
  car: CatalogCar,
  isActive: boolean,
  px: number,
  py: number,
  pw: number,
  ph: number,
): GarageMakeActiveRect | null {
  // Panel background — slightly darker so it reads as nested.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.30)';
  ctx.fillRect(px, py, pw, ph);
  ctx.strokeStyle = isActive ? '#0a4' : '#444';
  ctx.lineWidth = 1;
  ctx.strokeRect(px, py, pw, ph);

  // Header.
  ctx.fillStyle = '#0ff';
  ctx.font = 'bold 10px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('SPECS', px + 10, py + 14);

  // Left column: catalog stats.
  ctx.fillStyle = '#aaa';
  ctx.font = '10px monospace';
  ctx.fillText(`HP:    ${car.hp}`, px + 10, py + 30);
  ctx.fillText(`Drive: ${car.drv}`, px + 10, py + 44);
  ctx.fillText(`Trans: ${car.defaultManual ? 'Manual' : 'Auto'}`, px + 10, py + 58);
  ctx.fillText(`Year:  ${car.modelYear}`, px + 10, py + 72);

  // H162: SPECS button on the bottom-left — rendered for ALL cars
  // (active or not) so the player can pop the full fleet-normalized
  // gauge view. The rect is stashed on life so handleHomeOverlayClick
  // can hit-test without re-laying out, and carries the focused
  // car's id (handler reads it on tap to know what to inspect).
  const specsBtnW = 90;
  const specsBtnH = 22;
  const specsBtnX = px + 10;
  const specsBtnY = py + ph - specsBtnH - 8;
  ctx.fillStyle = 'rgba(0, 200, 220, 0.20)';
  ctx.fillRect(specsBtnX, specsBtnY, specsBtnW, specsBtnH);
  ctx.strokeStyle = '#0cf';
  ctx.lineWidth = 1;
  ctx.strokeRect(specsBtnX, specsBtnY, specsBtnW, specsBtnH);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 10px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('SPECS', specsBtnX + specsBtnW / 2, specsBtnY + 14);
  life._garageSpecsBtnRect = {
    x: specsBtnX,
    y: specsBtnY,
    w: specsBtnW,
    h: specsBtnH,
    carId: car.id,
  };

  // Right column: condition. Only the active car has live numbers in
  // the interim port (LIFE holds engine/tires/carHP/paint for the
  // active slot only). Non-active cars get a stub note + the MAKE
  // ACTIVE button to flip them in.
  const colX = px + pw / 2 + 10;
  if (isActive) {
    drawCondBar(ctx, colX, py + 22, 'Engine', life.engine);
    drawCondBar(ctx, colX, py + 38, 'Tires',  life.tires);
    drawCondBar(ctx, colX, py + 54, 'HP',     life.carHP);
    drawCondBar(ctx, colX, py + 70, 'Paint',  life.paint);
    return null;
  }
  ctx.fillStyle = '#666';
  ctx.font = 'italic 9px monospace';
  ctx.fillText('Condition snapshot not tracked', colX, py + 30);
  ctx.fillText('for non-active cars yet — make', colX, py + 42);
  ctx.fillText('this car ACTIVE to see stats.', colX, py + 54);

  // MAKE ACTIVE button at the bottom-right of the right column.
  const btnW = 110;
  const btnH = 22;
  const btnX = px + pw - btnW - 10;
  const btnY = py + ph - btnH - 8;
  ctx.fillStyle = 'rgba(0, 200, 100, 0.25)';
  ctx.fillRect(btnX, btnY, btnW, btnH);
  ctx.strokeStyle = '#0f8';
  ctx.lineWidth = 1;
  ctx.strokeRect(btnX, btnY, btnW, btnH);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 10px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('MAKE ACTIVE', btnX + btnW / 2, btnY + 14);

  return {
    x: btnX,
    y: btnY,
    w: btnW,
    h: btnH,
    idx: (life._garageExpandedIdx as number),
  };
}

/** H162: fleet-min/max cache for fleet-normalized SPECS gauges.
 *  Same caching pattern as monolith L48249 — invalidated when
 *  ALL_CAR_IDS.length changes (e.g. new DLC pack). Computed lazily
 *  on first open; subsequent specs views read the cache in O(1).
 *  Bikes excluded so a 600cc sport bike's mediocre top-speed bar
 *  doesn't squash every supercar in the fleet to 95-100%. */
interface SpecsFleetRange { min: number; max: number; }
interface SpecsFleetRanges {
  _n: number;
  topSpeed: SpecsFleetRange;
  hp: SpecsFleetRange;
  accel: SpecsFleetRange;
  braking: SpecsFleetRange;
}
let _specsFleetCache: SpecsFleetRanges | null = null;
function computeSpecsFleetRange(): SpecsFleetRanges {
  if (_specsFleetCache && _specsFleetCache._n === ALL_CAR_IDS.length) {
    return _specsFleetCache;
  }
  const r: SpecsFleetRanges = {
    _n: ALL_CAR_IDS.length,
    topSpeed: { min: Infinity, max: -Infinity },
    hp:       { min: Infinity, max: -Infinity },
    accel:    { min: Infinity, max: -Infinity },
    braking:  { min: Infinity, max: -Infinity },
  };
  for (const id of ALL_CAR_IDS) {
    const c = CAR_CATALOG[id];
    if (!c || c.isBike) continue;
    const accel = (c.hp / Math.max(1, c.kg)) * 1000;
    const samples = { topSpeed: c.topSpeed, hp: c.hp, accel, braking: c.brakePower };
    (['topSpeed', 'hp', 'accel', 'braking'] as const).forEach((s) => {
      if (samples[s] < r[s].min) r[s].min = samples[s];
      if (samples[s] > r[s].max) r[s].max = samples[s];
    });
  }
  (['topSpeed', 'hp', 'accel', 'braking'] as const).forEach((s) => {
    if (!isFinite(r[s].min)) r[s].min = 0;
    if (!isFinite(r[s].max)) r[s].max = 1;
    if (r[s].max - r[s].min < 0.0001) r[s].max = r[s].min + 0.0001;
  });
  _specsFleetCache = r;
  return r;
}

/** H162 SPECS sub-view — fleet-normalized horizontal gauge bars +
 *  detail rows for one car. Ported from monolith L48279-L48450; the
 *  monolith ships 5 gauges (handling included) but our build doesn't
 *  have tractionMult / turnRate yet — those derive from a tire
 *  physics port that hasn't landed. Skipping handling for now;
 *  re-add the row when those fields appear on CatalogCar.
 *
 *  Stashes the back rect on life._garageSpecsBackRect so
 *  handleHomeOverlayClick can route the tap back to the list view
 *  without going all the way out to the main tab picker. */
function drawGarageSpecsView(
  ctx: CanvasRenderingContext2D,
  GW: number,
  GH: number,
  life: LifeState,
  car: CatalogCar,
): void {
  const topY = 120;
  const range = computeSpecsFleetRange();

  // Header.
  ctx.textAlign = 'center';
  ctx.fillStyle = '#0ff';
  ctx.font = 'bold 14px monospace';
  ctx.fillText('📊 SPECS', GW / 2, topY);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 11px monospace';
  const nm = car.name.length > 32 ? car.name.slice(0, 31) + '…' : car.name;
  ctx.fillText(nm, GW / 2, topY + 16);
  ctx.fillStyle = '#888';
  ctx.font = '9px monospace';
  ctx.fillText(`compared to all ${range._n} cars in the world`, GW / 2, topY + 30);

  // Per-stat values for this car. SCALE_MS = 4.864 (m/s ↔ game-units),
  // unit display: km/h for RHD, mph for LHD (matches H80 effective-unit
  // logic; LHD multiplier 2.237 mph/m/s, RHD 3.6 km/h/m/s).
  const SCALE_MS = 4.864;
  const _dispMul = car.rhd ? 3.6 : 2.237;
  const _topDisp = (car.topSpeed / SCALE_MS) * _dispMul;
  const _unit = car.rhd ? 'km/h' : 'mph';
  const accel = (car.hp / Math.max(1, car.kg)) * 1000;
  const carVals = {
    topSpeed: car.topSpeed,
    hp: car.hp,
    accel,
    braking: car.brakePower,
  };

  // Gauge rows. fmt receives (rawValue, fillFraction) — stats with
  // real-world units (Top Speed, Power) show the converted number;
  // dimensionless ratios (Accel, Braking) show fleet score × 100.
  type GaugeRow = {
    key: 'topSpeed' | 'hp' | 'accel' | 'braking';
    label: string;
    fmt: (v: number, f: number) => string;
    color: string;
  };
  const rows: GaugeRow[] = [
    { key: 'topSpeed', label: 'Top Speed', color: '#0ff', fmt: () => `${Math.round(_topDisp)} ${_unit}` },
    { key: 'hp',       label: 'Power',     color: '#ff0', fmt: (v) => `${Math.round(v)} hp` },
    { key: 'accel',    label: 'Accel',     color: '#0f0', fmt: (_v, f) => `${Math.round(f * 100)} / 100` },
    { key: 'braking',  label: 'Braking',   color: '#f80', fmt: (_v, f) => `${Math.round(f * 100)} / 100` },
  ];

  const LABEL_X = 30;
  const BAR_X = 110;
  const BAR_W = GW - BAR_X - 90;
  const BAR_H = 10;
  const VAL_X = GW - 30;
  let yy = topY + 60;
  const ROW_H = 36;
  for (const g of rows) {
    const v = carVals[g.key];
    const rg = range[g.key];
    let frac = (v - rg.min) / (rg.max - rg.min);
    if (!isFinite(frac)) frac = 0;
    frac = Math.max(0, Math.min(1, frac));
    // Label
    ctx.fillStyle = '#aaa';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(g.label, LABEL_X, yy + 12);
    // Bar bg + frame
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(BAR_X, yy + 5, BAR_W, BAR_H);
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 1;
    ctx.strokeRect(BAR_X, yy + 5, BAR_W, BAR_H);
    // Fill
    ctx.fillStyle = g.color;
    ctx.fillRect(BAR_X + 1, yy + 6, (BAR_W - 2) * frac, BAR_H - 2);
    // Value text
    ctx.fillStyle = g.color;
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(g.fmt(v, frac), VAL_X, yy + 13);
    // Percentile small-text
    ctx.fillStyle = '#666';
    ctx.font = '8px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`${Math.round(frac * 100)}% of fleet`, LABEL_X, yy + 24);
    yy += ROW_H;
  }

  // Detail rows.
  yy += 8;
  ctx.fillStyle = '#888';
  ctx.font = 'bold 9px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('— DETAILS —', LABEL_X, yy);
  yy += 14;
  const gt4 = GT4_SPECS[car.name];
  const dimStr = (mm: number | undefined): string => (mm ? `${(mm / 1000).toFixed(2)} m` : '—');
  const eng = gt4 ? [gt4.disp, gt4.eType].filter(Boolean).join(' ') : '—';
  const drvLong: Record<string, string> = {
    FF: 'Front-engine FWD',
    FR: 'Front-engine RWD',
    MR: 'Mid-engine RWD',
    RR: 'Rear-engine RWD',
    '4WD': 'All-wheel drive',
  };
  const detailRows: ReadonlyArray<readonly [string, string]> = [
    ['Drivetrain',   drvLong[car.drv] || car.drv],
    ['Gears',        String(car.gears)],
    ['Transmission', car.defaultManual ? 'MANUAL' : 'AUTOMATIC'],
    ['Steering',     car.rhd ? 'RHD' : 'LHD'],
    ['Mass',         `${car.kg} kg`],
    ['Wheelbase',    dimStr(gt4?.wb)],
    ['Length',       dimStr(gt4?.lng)],
    ['Width',        dimStr(gt4?.wid)],
    ['Engine',       eng || '—'],
    ['Aspiration',   gt4?.asp ?? 'NA'],
    ['Redline',      `${car.redline.toLocaleString()} rpm`],
    ['Tires F',      gt4?.tsF ?? '—'],
    ['Tires R',      gt4?.tsR ?? '—'],
  ];
  for (const [k, v] of detailRows) {
    ctx.fillStyle = '#888';
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(k, LABEL_X, yy);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(v, VAL_X, yy);
    yy += 14;
  }
  ctx.textAlign = 'left';

  // Back button — distinct from the tab back so it routes to list,
  // not the main tab picker.
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
  life._garageSpecsBackRect = { x: bx, y: by, w: 120, h: 32 };
}

/** H40 small horizontal condition bar with a percentage label. Used
 *  in the garage SPECS panel for the active car. */
function drawCondBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  label: string,
  pct: number,
): void {
  const v = Math.max(0, Math.min(100, pct || 0));
  const barW = 80;
  const barH = 8;
  ctx.fillStyle = '#aaa';
  ctx.font = '9px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(label, x, y + 8);
  const bx = x + 50;
  ctx.fillStyle = '#222';
  ctx.fillRect(bx, y + 1, barW, barH);
  ctx.fillStyle = v < 35 ? '#f44' : v < 70 ? '#fa0' : '#0f8';
  ctx.fillRect(bx, y + 1, Math.round((barW * v) / 100), barH);
  ctx.strokeStyle = '#555';
  ctx.strokeRect(bx, y + 1, barW, barH);
  ctx.fillStyle = '#ccc';
  ctx.font = '9px monospace';
  ctx.textAlign = 'right';
  ctx.fillText(`${Math.round(v)}%`, x + 50 + barW + 18, y + 8);
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

/** H38 grocery shop tiers — real port of monolith buyGroceries
 *  L45824-45837. cost / qty pairs match the monolith exactly so the
 *  per-meal economy ($2/junk, $5/regular, $11.25/premium) is preserved.
 *
 *  Deferred from monolith: time-slot consumption
 *  (consumeTimeSlotForActivity) — the timeSlot subsystem is still
 *  `unknown` in LifeState; player can buy any number of times per day
 *  for now. Defaults will land when timeSlot ports. */
interface GroceryOption {
  key: 'junk' | 'regular' | 'premium';
  icon: string;
  store: string;
  cost: number;
  qty: number;
}

const GROCERY_OPTIONS: readonly GroceryOption[] = [
  { key: 'junk',    icon: '🏪',  store: 'Corner Store',      cost:  8, qty: 4 },
  { key: 'regular', icon: '🛒',  store: 'Grocery Store',     cost: 25, qty: 5 },
  { key: 'premium', icon: '🥦',  store: 'Health Food Store', cost: 45, qty: 4 },
];

/** H34/H38 EAT tab — health/fitness bars + 3 food-tier eat rows + 3
 *  grocery shop rows. Real port of monolith drawHomeEat L48772-48850 +
 *  the SHOP section logic L45824-45837 in simplified form.
 *
 *  Deferred:
 *    - Sleep / nap actions (need timeSlot wiring)
 *    - Time-slot consumption on grocery buy (timeSlot still unknown)
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

  // H38 SHOP section.
  yy += 4;
  ctx.strokeStyle = '#555';
  ctx.beginPath();
  ctx.moveTo(30, yy);
  ctx.lineTo(GW - 30, yy);
  ctx.stroke();
  yy += 12;
  ctx.fillStyle = '#0cf';
  ctx.font = 'bold 12px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('🛒 SHOP — stock up on meals', GW / 2, yy);
  yy += 14;

  const shopH = 28;
  for (const opt of GROCERY_OPTIONS) {
    const canBuy = life.money >= opt.cost;
    ctx.fillStyle = canBuy ? 'rgba(0, 200, 255, 0.10)' : 'rgba(255,255,255,0.04)';
    ctx.fillRect(28, yy, GW - 56, shopH);
    ctx.strokeStyle = canBuy ? '#0cf' : '#444';
    ctx.lineWidth = canBuy ? 2 : 1;
    ctx.strokeRect(28, yy, GW - 56, shopH);

    ctx.fillStyle = canBuy ? '#fff' : '#666';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`${opt.icon} ${opt.store}`, 38, yy + 12);
    ctx.fillStyle = canBuy ? '#aaa' : '#555';
    ctx.font = '9px monospace';
    ctx.fillText(`+${opt.qty} ${opt.key} meal${opt.qty === 1 ? '' : 's'}`, 38, yy + 23);

    ctx.textAlign = 'right';
    ctx.fillStyle = canBuy ? '#0f8' : '#f88';
    ctx.font = 'bold 11px monospace';
    ctx.fillText(`$${opt.cost}`, GW - 38, yy + 18);

    yy += shopH + 4;
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

/** Y where the EAT row block starts. Mirrors the math in drawEatTab. */
const EAT_ROWS_TOP = 120 + 22 + 22 + 22 + 26 + 22 + 14 + 16;
const EAT_ROW_H = 36;
const EAT_ROW_GAP = 4;
/** Y where the SHOP row block starts (after 3 EAT rows + section
 *  divider/title). */
const SHOP_ROWS_TOP = EAT_ROWS_TOP + FOOD_TIERS.length * (EAT_ROW_H + EAT_ROW_GAP) + 4 + 12 + 14;
const SHOP_ROW_H = 28;
const SHOP_ROW_GAP = 4;

/** Returns the eat-row index at (tx, ty), or -1 if none. */
function hitEatRow(opts: HomeOverlayOpts, tx: number, ty: number): number {
  let yy = EAT_ROWS_TOP;
  for (let i = 0; i < FOOD_TIERS.length; i++) {
    if (tx >= 28 && tx <= opts.GW - 28 && ty >= yy && ty <= yy + EAT_ROW_H) return i;
    yy += EAT_ROW_H + EAT_ROW_GAP;
  }
  return -1;
}

/** H38 — returns the grocery-shop-row index at (tx, ty), or -1. */
function hitShopRow(opts: HomeOverlayOpts, tx: number, ty: number): number {
  let yy = SHOP_ROWS_TOP;
  for (let i = 0; i < GROCERY_OPTIONS.length; i++) {
    if (tx >= 28 && tx <= opts.GW - 28 && ty >= yy && ty <= yy + SHOP_ROW_H) return i;
    yy += SHOP_ROW_H + SHOP_ROW_GAP;
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

function drawBillsSection(
  ctx: CanvasRenderingContext2D,
  GW: number,
  yy: number,
  title: string,
  color: string,
  monthlyTotal: number,
  totalOwed: number,
  rows: BillRow[],
  money: number,
  payRectAccumulator: BillsPayRect[] | null,
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
  const PAY_BTN_W = 72;
  const PAY_BTN_H = 22;
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

    // Right side: monthly cost + optional PAY button.
    const hasPay = !!row.pay;
    const monthlyX = hasPay ? GW - 34 - PAY_BTN_W - 8 : GW - 34;
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ff0';
    ctx.font = 'bold 10px monospace';
    ctx.fillText(`$${row.monthly.toLocaleString()}/mo`, monthlyX, yy + 18);

    if (hasPay && row.pay) {
      const enabled = money >= row.pay.cost;
      const btnX = GW - 34 - PAY_BTN_W;
      const btnY = yy + (rowH - PAY_BTN_H) / 2;
      ctx.fillStyle = enabled ? 'rgba(0, 200, 100, 0.30)' : 'rgba(80, 80, 80, 0.20)';
      ctx.fillRect(btnX, btnY, PAY_BTN_W, PAY_BTN_H);
      ctx.strokeStyle = enabled ? '#0f8' : '#555';
      ctx.lineWidth = 1;
      ctx.strokeRect(btnX, btnY, PAY_BTN_W, PAY_BTN_H);
      ctx.fillStyle = enabled ? '#fff' : '#666';
      ctx.font = 'bold 9px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`PAY $${row.pay.cost.toLocaleString()}`, btnX + PAY_BTN_W / 2, btnY + 14);
      if (payRectAccumulator) {
        payRectAccumulator.push({
          x: btnX,
          y: btnY,
          w: PAY_BTN_W,
          h: PAY_BTN_H,
          list: row.pay.list,
          idx: row.pay.idx,
          cost: row.pay.cost,
          enabled,
        });
      }
    }
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
    // H162: garage SPECS sub-view has its OWN back button that returns
    // to the list, not the main tab picker. Intercept before the
    // generic tab back-button below so the specs-back tap doesn't fall
    // through and close the whole garage. SPECS back rect stashed on
    // life by drawGarageSpecsView each frame.
    if (opts.tab === 'garage' && opts.life._garageView === 'specs') {
      const sBack = opts.life._garageSpecsBackRect as {
        x: number; y: number; w: number; h: number;
      } | undefined;
      if (sBack && tx >= sBack.x && tx <= sBack.x + sBack.w && ty >= sBack.y && ty <= sBack.y + sBack.h) {
        opts.life._garageView = 'list';
        return true;
      }
      // While in specs the row hit-test below is irrelevant — return
      // here so a stray tap doesn't accidentally close the panel.
      return true;
    }
    // Tab body view — back button first (consistent across tabs).
    const back = backRectForTab(opts.tab, opts.GW, opts.GH);
    if (hit(back, tx, ty)) {
      deps.setTab('main');
      return true;
    }
    // Per-tab body interactions.
    if (opts.tab === 'garage') {
      // H162: SPECS button on the expand panel — opens the fleet-
      // normalized perf gauge view. Stashed rect carries the focused
      // car's id so the sub-view knows what to inspect.
      const sRect = opts.life._garageSpecsBtnRect as {
        x: number; y: number; w: number; h: number; carId: string;
      } | undefined;
      if (sRect && tx >= sRect.x && tx <= sRect.x + sRect.w && ty >= sRect.y && ty <= sRect.y + sRect.h) {
        opts.life._garageView = 'specs';
        opts.life._garageSpecsCarId = sRect.carId;
        return true;
      }
      // H40: MAKE ACTIVE button first (it overlays the expand panel).
      const maRect = opts.life._garageMakeActiveRect as GarageMakeActiveRect | null | undefined;
      if (maRect && tx >= maRect.x && tx <= maRect.x + maRect.w && ty >= maRect.y && ty <= maRect.y + maRect.h) {
        const idx = maRect.idx;
        const cid = opts.life.ownedCars[idx];
        if (cid) {
          opts.life.ownedCars.splice(idx, 1);
          opts.life.ownedCars.unshift(cid);
          // Newly-active car is now at index 0. Re-anchor expanded
          // index so the panel stays open on the same car.
          opts.life._garageExpandedIdx = 0;
        }
        return true;
      }
      // H40 row tap → toggle expand. Use the stashed rowRects so the
      // hit-test matches the actual drawn position (which shifts when
      // a row above is already expanded).
      const rects = (opts.life._garageRowRects as GarageRowRect[] | undefined) || [];
      for (const r of rects) {
        if (tx >= r.x && tx <= r.x + r.w && ty >= r.y && ty <= r.y + r.h) {
          opts.life._garageExpandedIdx = opts.life._garageExpandedIdx === r.idx ? undefined : r.idx;
          return true;
        }
      }
    } else if (opts.tab === 'bills') {
      // H39 PAY-NOW: walk the rects we stashed during draw.
      const rects = (opts.life._billsPayRects as BillsPayRect[] | undefined) || [];
      for (const r of rects) {
        if (!r.enabled) continue;
        if (tx >= r.x && tx <= r.x + r.w && ty >= r.y && ty <= r.y + r.h) {
          payLoanNow(opts.life, r.list, r.idx);
          return true;
        }
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
      // H38 grocery shop. Subordinate to the eat-row hit so the eat
      // rows above can't accidentally consume a shop tap.
      const sIdx = hitShopRow(opts, tx, ty);
      if (sIdx >= 0) {
        const opt = GROCERY_OPTIONS[sIdx];
        if (opts.life.money >= opt.cost) {
          opts.life.money -= opt.cost;
          opts.life.foodStock[opt.key] = (opts.life.foodStock[opt.key] || 0) + opt.qty;
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
