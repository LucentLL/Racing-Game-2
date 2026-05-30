/**
 * Home-screen menu — the H key / 🏠 button surface that opens during
 * 'playing' state. Renders over the HUD canvas while LIFE.homeScreenOpen
 * is true. Eight tabs (main / bills / garage / newspaper / eat /
 * calendar / mail / sleep) each fully ported (H30-H38 + H213-H214 +
 * H564-H575). H619 swept the obsolete H30-era "placeholder for now"
 * header.
 *
 * Layout:
 *   - Dimmed full-screen backdrop so the world reads but doesn't compete
 *   - "AT HOME" title + day/time/money summary up top
 *   - main tab grid + per-tab bodies below
 *   - Close hint at bottom (H or tap close)
 */

import type { LifeState } from '@/state/life';
import type { Clock } from '@/state/clock';
import { CAR_CATALOG, ALL_CAR_IDS, type CatalogCar } from '@/config/cars/catalog';
import { GT4_SPECS } from '@/config/cars/gt4Database';
import { spriteForCarName } from '@/render/carSprites';
import { SCALE_MS, MILES_PER_GAME_UNIT, KM_PER_GAME_UNIT } from '@/physics/physicsUnits';
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
import { MONTH_NAMES_FULL as MONTH_NAMES, getDateString } from '@/config/calendar';
import { HOUSING_TIERS, type HousingTierKey } from '@/config/housing';
import type {
  CarListing,
  HouseListing,
  NewspaperListing,
} from '@/sim/newspaperGenerator';
import { payLoanNow } from '@/sim/payLoanNow';
import { getCarMods } from '@/sim/carMods';
import { getCarValue } from '@/sim/race';
import { showNotif } from '@/ui/notif';
import {
  PARTS_SHOP,
  filterAvailableParts,
  getVenueOptions,
  applyPart,
  type ShopPart,
} from '@/sim/partsShop';
import { openBankLoanOffer } from '@/sim/bankLoan';
import {
  drawBillsReceipt,
  handleBillsReceiptTap,
} from '@/ui/modals/billsReceipt';
import {
  acceptCarOffer,
  cancelCarAd,
  type CarAd,
} from '@/sim/carAds';
import { drawCharacterBase } from '@/render/characterBase';
import { getHealthStatus } from '@/sim/health';
import { getStreetTier } from '@/sim/streetTier';
import {
  drawBankLoanOffer,
  handleBankLoanOfferTap,
} from '@/ui/modals/bankLoanOffer';
import {
  drawRepairPopup,
  handleRepairPopupTap,
} from '@/ui/modals/repairPopup';
import type { Fault } from '@/sim/faults';
import {
  drawCellBadges,
  drawNavArrows,
  drawCalendarLegend,
  hitCalendarNav,
} from '@/ui/overlays/calendarBadges';
import { evaluateGymWorkout } from '@/sim/health';
import { doSleep, doRelax, nextUnusedSlot } from '@/sim/sleepSlot';
import {
  drawPinPicker,
  handlePinPickerClick,
  type PinPickerState,
  type PinListing,
  type PlacedPin,
} from '@/ui/modals/pinPicker';
import type { CarPin } from '@/state/life';
import { GT2_COLORS } from '@/ui/gt2Chrome';

export type HomeTab = 'main' | 'garage' | 'bills' | 'newspaper' | 'eat' | 'calendar' | 'mail';

export interface HomeOverlayOpts {
  /** Canvas internal w / h. */
  GW: number;
  GH: number;
  life: LifeState;
  clock: Clock;
  /** Currently-open tab. 'main' shows the tab picker; others dispatch
   *  to drawBillsTab / drawGarageTab / drawCalendarTab / drawEatTab /
   *  drawMailTab / drawNewspaperTab in render() below. */
  tab: HomeTab;
}

export interface HomeOverlayDeps {
  /** Switch sub-tab (or close via tab='main' + the close button). */
  setTab(tab: HomeTab): void;
  /** Dismiss the overlay entirely. */
  close(): void;
  /** H564: GET IN / RESUME action on a garage expanded panel. The
   *  monolith pairs the activeCar swap with a clearAllInputs + reset
   *  pSpeed and exits the home overlay (`switch & exit`). Caller
   *  routes to sim/switchCar.switchCar and closes the overlay. */
  getIn?(carId: string): void;
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

  // H732: GT2 charcoal backdrop. Keeps some translucency so the
  // world subtly reads through the corners (carries the v8.x
  // atmosphere); flips the palette from navy to amber-friendly
  // charcoal to match the rest of the GT2 reskin landed H726-H731.
  ctx.fillStyle = 'rgba(28, 28, 28, 0.92)';
  ctx.fillRect(0, 0, GW, GH);

  // H574: rich header. Main-tab header gets full daily-status
  // summary (portrait, health bar, bills countdown, debt total,
  // rep bars); sub-tab header collapses to a compact one-row money
  // + time-slot indicator so the tab body has more vertical space.
  // 1:1 with monolith L47215-L47283.
  if (tab === 'main') {
    drawRichHeader(ctx, life, clock, GW);
  } else {
    drawCompactHeader(ctx, life, clock, GW);
  }

  if (tab === 'main') {
    drawMainButtons(ctx, GW, GH, life, clock);
    // H214: SLEEP / RELAX buttons. Side-by-side mid-day, single
    // full-width SLEEP when all slots used (the only way to roll
    // the day). Positioned below the main tab grid + above the
    // CLOSE button. Drawn AFTER drawMainButtons so its taps don't
    // get eaten by the grid behind it.
    drawSleepButtons(ctx, GW, GH, life);
  } else if (tab === 'bills') {
    drawBillsTab(ctx, GW, GH, life, clock);
    // H569: bank loan offer modal sits on top of the bills tab when
    // active. 1:1 with monolith L47571 paint order (drawBankLoanOffer
    // runs after drawHomeBills).
    if (life.bankLoanOffer) {
      drawBankLoanOffer(ctx, life, GW, GH);
    }
  } else if (tab === 'garage') {
    drawGarageTab(ctx, GW, GH, life);
    // H564: sell-confirm modal sits on top of the garage tab body
    // when active. Drawn last so the YES/CANCEL buttons paint over
    // any garage row underneath. 1:1 with monolith L47596 paint
    // order (drawSellConfirm runs after drawHomeGarage).
    if (life._sellConfirm) {
      drawSellConfirm(ctx, life, GW, GH);
    }
    // H570: repair popup sits on top of the garage tab body when
    // active (specifically the REPAIRS sub-view, but the modal
    // paint is unconditional — sub-view dispatch keeps it
    // hidden unless the player is on REPAIRS).
    if (life.repairPopup) {
      drawRepairPopup(ctx, life, GW, GH);
    }
  } else if (tab === 'calendar') {
    drawCalendarTab(ctx, GW, GH, clock, life);
  } else if (tab === 'eat') {
    drawEatTab(ctx, GW, GH, life);
  } else if (tab === 'mail') {
    drawMailTab(ctx, GW, GH, life, clock);
  } else if (tab === 'newspaper') {
    drawNewspaperTab(ctx, GW, GH, life);
    // H189: pin-picker modal layered ON TOP of the newspaper list
    // when a row is tapped (life.pinPicker set). 1:1 with monolith
    // L47565 paint order. The picker covers the whole canvas at
    // 92% alpha; taps route to handlePinPickerClick (handler wiring
    // lives in handleHomeOverlayClick below).
    if (life.pinPicker) {
      drawPinPicker(ctx, { state: life.pinPicker, GW, GH });
    }
  } else {
    drawTabStub(ctx, GW, GH, tab);
  }

  // H575: bills receipt popup — sits ON TOP of any tab body. Only
  // paints when life.billsDuePrompt is set (fireMonthlyBills flips
  // it on the next month-boundary tick). Paint-after-tabs so the
  // amber-bordered panel covers whichever tab the player was on.
  if (life.billsDuePrompt) {
    drawBillsReceipt(ctx, life, GW, GH);
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

  // H569: GET BANK LOAN button at the bottom of the BANK section.
  // Opens the bank-loan-offer modal (drawBankLoanOffer overlays the
  // bills tab from then on). Suppressed when an offer is already
  // open so the button doesn't peek through the modal backdrop.
  if (!life.bankLoanOffer) {
    const glX = 28;
    const glY = yy + 4;
    const glW = GW - 56;
    const glH = 28;
    ctx.fillStyle = 'rgba(0, 200, 100, 0.20)';
    ctx.fillRect(glX, glY, glW, glH);
    ctx.strokeStyle = '#0f8';
    ctx.lineWidth = 1;
    ctx.strokeRect(glX, glY, glW, glH);
    ctx.fillStyle = '#0f8';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('💰 GET BANK LOAN', GW / 2, glY + 18);
    life._billsBankLoanBtnRect = { x: glX, y: glY, w: glW, h: glH };
  } else {
    life._billsBankLoanBtnRect = null;
  }

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

/** H40 — geometry of the MAKE ACTIVE button inside the expand panel.
 *  Preserved for backward-compat; H564's GarageExpandedBtnRect supersedes
 *  it for the full 6-button layout but the field stays on life so any
 *  downstream consumer that reads it doesn't break. */
interface GarageMakeActiveRect {
  x: number;
  y: number;
  w: number;
  h: number;
  idx: number;
}

/** H576 — geometry of one row in the ACTIVE ADS section. Discriminated
 *  by kind: 'cancel' = the ad row itself (tap cancels); 'accept' =
 *  the best-offer row (tap sells the car for that offer). Cached on
 *  life._garageAdRects so the click router can dispatch directly. */
interface GarageAdHitRect {
  kind: 'cancel' | 'accept';
  adIdx: number;
  /** Only set on 'accept' rects — the offer's index within ad.offers. */
  offerIdx?: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** H564 — geometry of one of the 6 action buttons inside the
 *  expanded car panel. Cached on life._garageExpandedBtnRects per
 *  paint so the click router hit-tests without re-running layout. */
interface GarageExpandedBtnRect {
  x: number;
  y: number;
  w: number;
  h: number;
  carId: string;
  action: 'getIn' | 'specs' | 'repairs' | 'parts' | 'sell' | 'list';
  enabled: boolean;
}

/** H564 — height of the expanded panel as a function of mods/loan
 *  presence. Used by the scroll layout so totalH stays in sync with
 *  the actual painted height. Mirrors monolith _garageExpandedH at
 *  L47937-47944. */
function garageExpandedH(hasMods: boolean, hasLoan: boolean): number {
  let h = 4; // top gap
  if (hasMods) h += 12;
  if (hasLoan) h += 12;
  h += 4;                          // gap before buttons
  h += 26 + 4 + 26 + 4 + 26;       // 3 rows of 26px buttons w/ 4px gaps
  return h;
}

/** H564 — sell-confirm modal state. Set when the player taps SELL on
 *  a garage expanded panel; cleared by the modal's own YES/CANCEL.
 *  Carries the car id + cached YES/CANCEL Y rects for the click
 *  router. 1:1 with monolith LIFE._sellConfirm at L42714-42782. */
export interface SellConfirmState {
  carId: string;
  _yesY?: number;
  _cancelY?: number;
}

/** Modal paint. Pre-existing inputs come off life.{carLoans,
 *  pendingParts}. Lot offers 50% of fair value; loan payoff is
 *  monthlyPayment × monthsRemaining for any matching loan; NET is
 *  offer minus payoff. Pending-parts warning surfaces in-flight
 *  repair work that'll be cancelled with the car. */
export function drawSellConfirm(
  ctx: CanvasRenderingContext2D,
  life: LifeState,
  GW: number,
  GH: number,
): void {
  const sc = life._sellConfirm as SellConfirmState | undefined | null;
  if (!sc) return;
  const car = CAR_CATALOG[sc.carId];
  if (!car) { life._sellConfirm = null; return; }
  const activeId = life.ownedCars[0];
  const value = getCarValue(life, sc.carId, activeId);
  const offer = Math.round(value * 0.5);
  const loan = life.carLoans.find((l) => l.carId === sc.carId);
  const payoff = loan ? loan.monthlyPayment * loan.monthsRemaining : 0;
  const net = offer - payoff;

  // Dim background.
  ctx.fillStyle = 'rgba(0,0,0,0.85)';
  ctx.fillRect(0, 0, GW, GH);
  ctx.textAlign = 'center';
  const popW = GW - 40;
  const popX = 20;
  let yy = Math.floor(GH * 0.20);

  ctx.fillStyle = '#f80';
  ctx.font = 'bold 14px monospace';
  ctx.fillText('⚠ SELL TO LOT?', GW / 2, yy);
  yy += 20;
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 11px monospace';
  ctx.fillText(car.name, GW / 2, yy);
  yy += 16;
  ctx.fillStyle = '#aaa';
  ctx.font = '9px monospace';
  ctx.fillText('Lot offers 50% of fair value', GW / 2, yy);
  yy += 12;
  ctx.fillStyle = '#0f0';
  ctx.font = 'bold 12px monospace';
  ctx.fillText('Offer: $' + offer.toLocaleString(), GW / 2, yy);
  yy += 16;
  if (loan) {
    ctx.fillStyle = '#f88';
    ctx.font = '9px monospace';
    ctx.fillText('Loan payoff: $' + payoff.toLocaleString(), GW / 2, yy);
    yy += 12;
    ctx.fillStyle = net >= 0 ? '#0f0' : '#f44';
    ctx.font = 'bold 11px monospace';
    ctx.fillText('NET: ' + (net >= 0 ? '+$' : '-$') + Math.abs(net).toLocaleString(), GW / 2, yy);
    yy += 16;
  }
  const pendingCount = (life.pendingParts as Array<{ carId?: string }> | undefined)
    ?.filter((p) => p.carId === sc.carId).length ?? 0;
  if (pendingCount > 0) {
    ctx.fillStyle = '#ff0';
    ctx.font = '9px monospace';
    ctx.fillText(
      '⚠ ' + pendingCount + ' in-flight job' + (pendingCount > 1 ? 's' : '')
      + ' will be cancelled',
      GW / 2, yy,
    );
    yy += 14;
  }
  // YES button (red).
  const btnW = popW - 80;
  const btnX = popX + 40;
  sc._yesY = yy + 8;
  ctx.fillStyle = 'rgba(255,60,60,0.15)';
  ctx.fillRect(btnX, sc._yesY, btnW, 28);
  ctx.strokeStyle = '#f44';
  ctx.strokeRect(btnX, sc._yesY, btnW, 28);
  ctx.fillStyle = '#f44';
  ctx.font = 'bold 11px monospace';
  ctx.fillText('YES — SELL IT', GW / 2, sc._yesY + 18);
  yy += 36;
  // CANCEL button (grey).
  sc._cancelY = yy + 4;
  ctx.fillStyle = 'rgba(255,255,255,0.1)';
  ctx.fillRect(btnX, sc._cancelY, btnW, 28);
  ctx.strokeStyle = '#aaa';
  ctx.strokeRect(btnX, sc._cancelY, btnW, 28);
  ctx.fillStyle = '#aaa';
  ctx.font = 'bold 11px monospace';
  ctx.fillText('CANCEL', GW / 2, sc._cancelY + 18);
  ctx.textAlign = 'left';
}

/** Quick-sell at 50% of car value. Removes the car from ownedCars,
 *  subtracts any loan payoff from the cash refund, prunes carAds
 *  matching this id, fires showNotif. If the scrapped car was the
 *  active one, the new active is ownedCars[0] after removal; the
 *  monolith additionally calls loadCarCondition to restore that
 *  car's stat snapshot — modular folds that into switchCar later. */
export function quickSellCar(life: LifeState, carId: string): void {
  const car = CAR_CATALOG[carId];
  if (!car) return;
  const activeId = life.ownedCars[0];
  const value = getCarValue(life, carId, activeId);
  const offer = Math.round(value * 0.5);
  const loan = life.carLoans.find((l) => l.carId === carId);
  const payoff = loan ? loan.monthlyPayment * loan.monthsRemaining : 0;
  life.money += offer - payoff;
  life.ownedCars = life.ownedCars.filter((c) => c !== carId);
  life.carLoans = life.carLoans.filter((l) => l.carId !== carId);
  life.carAds = (life.carAds as Array<{ carId?: string }> | undefined)
    ?.filter((a) => a?.carId !== carId) ?? [];
  // Reset the expanded-row pointer so the panel doesn't try to
  // paint an out-of-bounds row next frame.
  life._garageExpandedIdx = undefined;
  showNotif(
    life,
    'Sold ' + car.name + (loan
      ? ' (NET ' + (offer - payoff >= 0 ? '+$' : '-$') + Math.abs(offer - payoff).toLocaleString() + ')'
      : ' for $' + offer.toLocaleString()),
    180,
  );
}

/** Create a newspaper ad for the given car. Shape matches the
 *  monolith's `{carId, askPrice, daysListed, offers}` at L43741.
 *  The newspaper-offer generator (generateCarAdOffers) hasn't
 *  ported yet — once it does, the ad's offers array fills up on
 *  weekday rollovers. Until then the ad sits idle but at least
 *  shows up in the LIST AD subline as "already listed". */
export function listCarInNewspaper(life: LifeState, carId: string): void {
  if (life.ownedCars.length <= 1) {
    showNotif(life, "Can't sell your only car!", 120);
    return;
  }
  const ads = (life.carAds as Array<{ carId?: string }> | undefined) ?? [];
  if (ads.find((a) => a?.carId === carId)) {
    showNotif(life, 'Already listed!', 120);
    return;
  }
  const activeId = life.ownedCars[0];
  const value = getCarValue(life, carId, activeId);
  const askPrice = Math.round(value * 0.9);
  ads.push({ carId, askPrice, daysListed: 0, offers: [] } as unknown as Record<string, unknown>);
  life.carAds = ads as unknown[];
  const car = CAR_CATALOG[carId];
  showNotif(
    life,
    '📰 ' + (car?.name ?? carId) + ' listed at $' + askPrice.toLocaleString() + '. Check offers daily.',
    180,
  );
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
  const rawView = life._garageView;
  const garageView: 'specs' | 'parts' | 'repairs' | 'list' =
    rawView === 'specs' || rawView === 'parts' || rawView === 'repairs' ? rawView : 'list';
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
  if (garageView === 'parts') {
    const cid = (life._garagePartsCarId as string | undefined) ?? life.ownedCars[0];
    const car = cid ? CAR_CATALOG[cid] : undefined;
    if (car) {
      drawGaragePartsView(ctx, GW, GH, life, car);
      return;
    }
    life._garageView = 'list';
  }
  if (garageView === 'repairs') {
    const cid = (life._garageRepairsCarId as string | undefined) ?? life.ownedCars[0];
    const car = cid ? CAR_CATALOG[cid] : undefined;
    if (car) {
      drawGarageRepairsView(ctx, GW, GH, life, car);
      return;
    }
    life._garageView = 'list';
  }
  const top = 120;
  let yy = top;

  // H733: GT2 italic display title + textMute subtitle, matching
  // the H726 carSwitch / H729 spec sheet header treatment.
  ctx.textAlign = 'center';
  ctx.fillStyle = GT2_COLORS.text;
  ctx.font = 'italic bold 16px monospace';
  ctx.fillText('GARAGE', GW / 2, yy);
  yy += 22;
  ctx.fillStyle = GT2_COLORS.textMute;
  ctx.font = '11px monospace';
  const n = life.ownedCars.length;
  ctx.fillText(`${n} VEHICLE${n === 1 ? '' : 'S'} OWNED · TAP ROW FOR SPECS`, GW / 2, yy);
  yy += 18;

  const rowH = 56;
  const rowGap = 6;
  const rowW = GW - 60;
  const rowX = 30;
  const activeId = life.ownedCars[0];
  const expandedIdx = life._garageExpandedIdx as number | undefined;
  const rowRects: GarageRowRect[] = [];
  let makeActiveRect: GarageMakeActiveRect | null = null;
  const expandedBtnRects: GarageExpandedBtnRect[] = [];

  // H257: scrollable garage. Removes the hard cap at 7 cars (test mode
  // and long-tenured play both blow past it). Compute total content
  // height first; clamp _garageScrollY against (totalH - visibleH);
  // clip the canvas to the visible band before drawing; draw a
  // scroll indicator on the right edge when there's overflow.
  // Mirrors monolith pattern at L48124-48207 (drawHomeGarage).
  const listTop = yy;
  const visibleH = GH - 60 - listTop;
  // H564: expanded panel height is now per-car (depends on whether
  // MODS / LOAN lines paint). Cache per-car height for both the
  // scroll-math pass and the actual draw pass below.
  const expandedHByIdx = new Map<number, number>();
  let totalH = 0;
  for (let i = 0; i < life.ownedCars.length; i++) {
    const cid = life.ownedCars[i];
    if (!CAR_CATALOG[cid]) continue;
    totalH += rowH + rowGap;
    if (i === expandedIdx) {
      const hasMods = getCarMods(cid, life, activeId, {}).length > 0;
      const hasLoan = !!life.carLoans.find((l) => l.carId === cid);
      const eh = garageExpandedH(hasMods, hasLoan);
      expandedHByIdx.set(i, eh);
      totalH += eh + rowGap;
    }
  }
  // H576: ACTIVE ADS section adds to totalH so the scroll-clip math
  // accounts for the ads region. Header 18px + per-ad 24px + per-
  // accepted-offer 22px; 4px leading gap. Skipped entirely when no
  // ads are listed.
  const adsForLayout = (life.carAds as CarAd[] | undefined) ?? [];
  let adsBlockH = 0;
  if (adsForLayout.length > 0) {
    adsBlockH = 4 + 18;
    for (const ad of adsForLayout) {
      adsBlockH += 24;
      if (ad.offers && ad.offers.length > 0) adsBlockH += 22;
    }
  }
  totalH += adsBlockH;
  const scrollMax = Math.max(0, totalH - visibleH);
  life._garageScrollMax = scrollMax;
  const scrollY = Math.max(0, Math.min(scrollMax, life._garageScrollY ?? 0));
  life._garageScrollY = scrollY;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, listTop, GW, visibleH);
  ctx.clip();

  yy = listTop - scrollY;

  for (let i = 0; i < life.ownedCars.length; i++) {
    const cid = life.ownedCars[i];
    const car = CAR_CATALOG[cid];
    if (!car) continue;
    const isActive = cid === activeId;
    const loan = life.carLoans.find((l) => l.carId === cid);

    // Row background — GT2 amber-tinted panel for the active car;
    // dim charcoal panel for the rest. Matches the H726 car-switch
    // row palette so the two screens read as the same widget.
    ctx.fillStyle = isActive ? 'rgba(255, 122, 24, 0.16)' : GT2_COLORS.panel;
    ctx.fillRect(rowX, yy, rowW, rowH);
    ctx.strokeStyle = isActive ? GT2_COLORS.active : '#3a3a3a';
    ctx.lineWidth = isActive ? 2 : 1;
    ctx.strokeRect(rowX, yy, rowW, rowH);
    if (isActive) {
      ctx.fillStyle = GT2_COLORS.active;
      ctx.fillRect(rowX, yy, 3, rowH);
    }

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
    ctx.fillStyle = GT2_COLORS.text;
    ctx.font = 'bold 12px monospace';
    ctx.textAlign = 'left';
    const nameMax = 36;
    const shown = car.name.length > nameMax ? car.name.slice(0, nameMax - 1) + '…' : car.name;
    ctx.fillText(shown, spriteX + spriteW + 12, yy + 16);

    ctx.fillStyle = GT2_COLORS.textMute;
    ctx.font = '10px monospace';
    const tagBits: string[] = [];
    tagBits.push(car.drv);
    tagBits.push(car.defaultManual ? 'M' : 'A');
    if (isActive) tagBits.push('ACTIVE');
    if (i === expandedIdx) tagBits.push('▼');
    ctx.fillText(tagBits.join(' · '), spriteX + spriteW + 12, yy + 32);

    if (loan) {
      ctx.fillStyle = GT2_COLORS.amber;
      ctx.font = '9px monospace';
      ctx.fillText(`Cr ${loan.monthlyPayment} / mo · ${loan.monthsRemaining}mo left`, spriteX + spriteW + 12, yy + 47);
    } else if (car.price > 0) {
      ctx.fillStyle = GT2_COLORS.amberDark;
      ctx.font = '9px monospace';
      ctx.fillText('OWNED OUTRIGHT', spriteX + spriteW + 12, yy + 47);
    }

    // Price (right-aligned).
    ctx.textAlign = 'right';
    ctx.fillStyle = GT2_COLORS.text;
    ctx.font = 'bold 11px monospace';
    ctx.fillText(`Cr ${car.price.toLocaleString()}`, rowX + rowW - 12, yy + 18);
    ctx.fillStyle = GT2_COLORS.textDim;
    ctx.font = '9px monospace';
    ctx.fillText('MSRP', rowX + rowW - 12, yy + 30);
    // H161: per-car odometer. H78 wear-tick already populates
    // life.carOdometers[cid] each frame in drawPlaying; this row
    // surfaces it so the player can SEE accumulated mileage per
    // car. RHD chassis (catalog.rhd === true) display km, LHD
    // display mi — same unit choice + MILES/KM_PER_GAME_UNIT scale
    // the monolith uses at L7708 for the car-pin tooltip.
    {
      const _odoUnits = life.carOdometers?.[cid] ?? 0;
      const _useKm = car.rhd;
      const _dist = _odoUnits * (_useKm ? KM_PER_GAME_UNIT : MILES_PER_GAME_UNIT);
      const _suffix = _useKm ? 'km' : 'mi';
      const _odoStr = _dist >= 1000
        ? `${(_dist / 1000).toFixed(1)}k${_suffix}`
        : `${Math.round(_dist)}${_suffix}`;
      ctx.fillStyle = GT2_COLORS.amber;
      ctx.font = '9px monospace';
      ctx.fillText(_odoStr, rowX + rowW - 12, yy + 45);
    }

    rowRects.push({ x: rowX, y: yy, w: rowW, h: rowH, idx: i });
    yy += rowH + rowGap;

    // H564 expanded panel for the focused row — full 6-button port
    // of monolith _drawGarageCarExpanded with MODS/LOAN lines.
    if (i === expandedIdx) {
      const eh = expandedHByIdx.get(i) ?? garageExpandedH(false, false);
      drawGarageExpandPanel(ctx, life, car, isActive, rowX, yy, rowW, eh, expandedBtnRects);
      yy += eh + rowGap;
    }
  }

  // H576: ACTIVE ADS section. Sits inside the same scroll-clip as
  // the cars list so a long fleet + many ads scroll together.
  // Per-ad row → tap to cancel; per-offer row (only when offers
  // exist) → tap to accept the best offer.
  const adRects: GarageAdHitRect[] = [];
  if (adsForLayout.length > 0) {
    yy += 4;
    ctx.fillStyle = '#fa0';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('📰 ACTIVE ADS', GW / 2, yy + 10);
    yy += 18;
    for (let ai = 0; ai < adsForLayout.length; ai++) {
      const ad = adsForLayout[ai];
      const c = CAR_CATALOG[ad.carId];
      if (!c) {
        ad._renderY = -1;
        ad._offerY = -1;
        continue;
      }
      ctx.fillStyle = 'rgba(255, 160, 0, 0.10)';
      ctx.fillRect(12, yy, GW - 24, 20);
      ctx.strokeStyle = '#f80';
      ctx.lineWidth = 1;
      ctx.strokeRect(12, yy, GW - 24, 20);
      ctx.fillStyle = '#fa0';
      ctx.font = 'bold 9px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(c.name + ' — Ask $' + ad.askPrice.toLocaleString() + ' (' + ad.daysListed + 'd)', GW / 2, yy + 9);
      ctx.fillStyle = '#888';
      ctx.font = '8px monospace';
      ctx.fillText(
        ad.offers.length > 0
          ? ad.offers.length + ' offer' + (ad.offers.length === 1 ? '' : 's') + ' — TAP to cancel'
          : 'No offers yet — TAP to cancel',
        GW / 2, yy + 17,
      );
      ad._renderY = yy;
      adRects.push({ kind: 'cancel', adIdx: ai, x: 12, y: yy, w: GW - 24, h: 20 });
      yy += 24;
      if (ad.offers.length > 0) {
        const bestIdx = ad.offers.reduce(
          (bi, o, i, arr) => o.amount > arr[bi].amount ? i : bi,
          0,
        );
        const best = ad.offers[bestIdx];
        ctx.fillStyle = 'rgba(0, 255, 0, 0.10)';
        ctx.fillRect(20, yy, GW - 40, 18);
        ctx.strokeStyle = '#0f0';
        ctx.lineWidth = 1;
        ctx.strokeRect(20, yy, GW - 40, 18);
        ctx.fillStyle = '#0f0';
        ctx.font = 'bold 9px monospace';
        ctx.fillText('BEST: $' + best.amount.toLocaleString() + ' — TAP TO ACCEPT', GW / 2, yy + 8);
        ctx.fillStyle = '#888';
        ctx.font = '7px monospace';
        ctx.fillText('or tap ad row above to cancel', GW / 2, yy + 16);
        ad._offerY = yy;
        adRects.push({ kind: 'accept', adIdx: ai, offerIdx: bestIdx, x: 20, y: yy, w: GW - 40, h: 18 });
        yy += 22;
      } else {
        ad._offerY = -1;
      }
    }
  }

  ctx.restore();

  // H257: scroll indicator. Right-edge thin bar sized by visible
  // fraction; only painted when content actually overflows.
  if (scrollMax > 0) {
    const scrollPct = scrollY / scrollMax;
    const barH = Math.max(20, visibleH * (visibleH / totalH));
    const barY = listTop + scrollPct * (visibleH - barH);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.fillRect(GW - 4, barY, 3, barH);
  }

  // Stash hit-test geometry on life for the click router.
  life._garageRowRects = rowRects;
  life._garageMakeActiveRect = makeActiveRect;
  life._garageExpandedBtnRects = expandedBtnRects;
  life._garageAdRects = adRects;

  ctx.textAlign = 'left';

  // H733: Back button reclothed as GT2 amber pill.
  const bx = GW / 2 - 60;
  const by = GH - 80;
  ctx.fillStyle = GT2_COLORS.amber;
  fillRoundRectHome(ctx, bx, by, 120, 32, 5);
  ctx.fillStyle = GT2_COLORS.bgDeep;
  ctx.font = 'bold 13px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('← BACK', GW / 2, by + 21);
}

/** H564 — full action panel under a focused garage row. 1:1 port of
 *  monolith _drawGarageCarExpanded at L48021-48092. MODS / LOAN
 *  status lines at top, then 3 rows of split action buttons:
 *  GET IN/RESUME + SPECS, REPAIRS + PARTS, SELL + LIST.
 *
 *  Button rects accumulate into the supplied array so the home
 *  overlay click router can hit-test in one pass without rerunning
 *  layout — same pattern the monolith uses with _btnRects at L48021.
 *
 *  Disabled-state rules (mirror monolith L48081-48088):
 *    - SELL: disabled when only car owned OR car is leased
 *    - LIST: disabled when only car OR leased OR already listed
 *  GET IN reads as "RESUME" + "Already active" when on the active
 *  car (still tappable; the handler no-ops via switchCar's sameCar
 *  result). REPAIRS subhead flips red when faults > 0. */
function drawGarageExpandPanel(
  ctx: CanvasRenderingContext2D,
  life: LifeState,
  car: CatalogCar,
  isActive: boolean,
  px: number,
  py: number,
  pw: number,
  ph: number,
  btnRects: GarageExpandedBtnRect[],
): void {
  // H733: Panel background — charcoal panel + amber edge when
  // active. Reads as a nested GT2 row consistent with the rest of
  // the H732 / H727 / H726 chrome.
  ctx.fillStyle = GT2_COLORS.bgDeep;
  ctx.fillRect(px, py, pw, ph);
  ctx.strokeStyle = isActive ? GT2_COLORS.active : '#3a3a3a';
  ctx.lineWidth = 1;
  ctx.strokeRect(px, py, pw, ph);

  let curY = py + 4;

  const activeId = life.ownedCars[0];
  const mods = getCarMods(car.id, life, activeId, {});
  if (mods.length > 0) {
    ctx.fillStyle = GT2_COLORS.amber;
    ctx.font = 'bold 9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('⚡ MODS: ' + mods.map((m) => m.label).join(' · '), px + pw / 2, curY + 8);
    curY += 12;
  }

  // LOAN total-owed line.
  const loan = life.carLoans.find((l) => l.carId === car.id);
  if (loan) {
    const tot = loan.monthlyPayment * loan.monthsRemaining;
    ctx.fillStyle = '#ff9090';
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Total owed: Cr ' + tot.toLocaleString(), px + pw / 2, curY + 8);
    curY += 12;
  }
  curY += 4;

  // Button-row geometry. halfW splits the panel into two columns
  // with a 4px gap between them (matches monolith L48059).
  const isOnly = life.ownedCars.length <= 1;
  const isLeased = false; // CarLoan type doesn't carry 'lease' yet — defer
  const hasAd = !!(life.carAds as Array<{ carId?: string }> | undefined)?.find((a) => a?.carId === car.id);
  const faultCount = isActive ? (life.faults?.length ?? 0) : 0;

  const innerPad = 12;
  const halfW = (pw - innerPad * 2 - 4) / 2;
  const leftX = px + innerPad;
  const rightX = leftX + halfW + 4;
  const btnH = 26;
  // H733: Buttons are now filled rounded amber pills. The `color`
  // param is ignored visually (kept for call-site parity); BUY-class
  // primary actions (RESUME on active, REPAIRS when faults are
  // pending) take the bright active orange so the player's eye
  // jumps to them. Everything else sits on the amber face.
  const drawBtn = (
    bx: number, by: number, bw: number, bh: number,
    label: string, sublabel: string, _color: string,
    action: GarageExpandedBtnRect['action'], enabled: boolean,
    primary = false,
  ): void => {
    const face = !enabled
      ? GT2_COLORS.amberDim
      : primary
        ? GT2_COLORS.active
        : GT2_COLORS.amber;
    ctx.fillStyle = face;
    fillRoundRectHome(ctx, bx, by, bw, bh, 4);
    ctx.fillStyle = enabled ? GT2_COLORS.bgDeep : GT2_COLORS.textDim;
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(label, bx + bw / 2, by + 13);
    if (sublabel) {
      ctx.font = '8px monospace';
      ctx.fillText(sublabel, bx + bw / 2, by + 22);
    }
    btnRects.push({ x: bx, y: by, w: bw, h: bh, carId: car.id, action, enabled });
  };

  // Row 1 — GET IN / RESUME (left, primary when active) + SPECS (right).
  drawBtn(
    leftX, curY, halfW, btnH,
    isActive ? '🚗 RESUME' : '🚗 GET IN',
    isActive ? 'Already active' : 'Switch & exit',
    '#0ff', 'getIn', true,
    /* primary= */ isActive,
  );
  drawBtn(rightX, curY, halfW, btnH, '📊 SPECS', 'View stats', '#0ff', 'specs', true);
  curY += btnH + 4;

  // Row 2 — REPAIRS (left, primary when faults are pending) + PARTS (right).
  const repairsLabel = faultCount > 0
    ? ('🔧 REPAIRS (' + faultCount + '!)')
    : '🔧 REPAIRS';
  drawBtn(
    leftX, curY, halfW, btnH,
    repairsLabel, 'Fix issues',
    '#0ff', 'repairs', true,
    /* primary= */ faultCount > 0,
  );
  drawBtn(rightX, curY, halfW, btnH, '📦 PARTS', 'Inventory & install', '#0ff', 'parts', true);
  curY += btnH + 4;

  // Row 3 — SELL TO LOT (left) + LIST AD (right).
  const sellEnabled = !isOnly && !isLeased;
  const listEnabled = !isOnly && !isLeased && !hasAd;
  const sellPrice = Math.round(getCarValue(life, car.id, activeId) * 0.5);
  const listPrice = Math.round(getCarValue(life, car.id, activeId) * 0.9);
  const sellSub = isOnly
    ? 'only car'
    : isLeased ? 'leased' : 'Cr ' + sellPrice.toLocaleString();
  const listSub = isOnly
    ? 'only car'
    : isLeased ? 'leased' : hasAd ? 'already listed' : 'Cr ' + listPrice.toLocaleString();
  drawBtn(leftX, curY, halfW, btnH, '💵 SELL TO LOT', sellSub, '#f80', 'sell', sellEnabled);
  drawBtn(rightX, curY, halfW, btnH, '📰 LIST AD', listSub, '#fa0', 'list', listEnabled);

  ctx.textAlign = 'left';
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

  // H734: GT2 italic display title, white car name, textMute fleet
  // comparison subhead. Matches the H729 spec-sheet header treatment.
  ctx.textAlign = 'center';
  ctx.fillStyle = GT2_COLORS.text;
  ctx.font = 'italic bold 16px monospace';
  ctx.fillText('SPECS', GW / 2, topY);
  ctx.font = 'bold 11px monospace';
  const nm = car.name.length > 32 ? car.name.slice(0, 31) + '…' : car.name;
  ctx.fillText(nm, GW / 2, topY + 16);
  ctx.fillStyle = GT2_COLORS.textMute;
  ctx.font = '9px monospace';
  ctx.fillText(`COMPARED TO ALL ${range._n} CARS IN THE WORLD`, GW / 2, topY + 30);

  // Per-stat values for this car. H483: SCALE_MS imported from
  // canonical physicsUnits module. Unit display: km/h for RHD, mph
  // for LHD (matches H80 effective-unit logic).
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
  // H734: gauge bars keep their semantic colors (top/power/accel/
  // braking distinguished at-a-glance is the whole point of the
  // view); labels + value text re-tint to amber for chrome unity.
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
    ctx.fillStyle = GT2_COLORS.text;
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(g.label, LABEL_X, yy + 12);
    // Bar bg — GT2 charcoal trough.
    ctx.fillStyle = GT2_COLORS.bgDeep;
    ctx.fillRect(BAR_X, yy + 5, BAR_W, BAR_H);
    ctx.strokeStyle = '#3a3a3a';
    ctx.lineWidth = 1;
    ctx.strokeRect(BAR_X, yy + 5, BAR_W, BAR_H);
    // Fill — semantic color so the player can tell stat lanes apart.
    ctx.fillStyle = g.color;
    ctx.fillRect(BAR_X + 1, yy + 6, (BAR_W - 2) * frac, BAR_H - 2);
    // Value text
    ctx.fillStyle = g.color;
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(g.fmt(v, frac), VAL_X, yy + 13);
    // Percentile small-text
    ctx.fillStyle = GT2_COLORS.textDim;
    ctx.font = '8px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`${Math.round(frac * 100)}% of fleet`, LABEL_X, yy + 24);
    yy += ROW_H;
  }

  // Detail rows.
  yy += 8;
  ctx.fillStyle = GT2_COLORS.amber;
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
    ctx.fillStyle = GT2_COLORS.textMute;
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(k, LABEL_X, yy);
    ctx.fillStyle = GT2_COLORS.text;
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(v, VAL_X, yy);
    yy += 14;
  }
  ctx.textAlign = 'left';

  // H734: Back button as regular GT2 amber pill (no darker active
  // styling — per user policy, dark = selected/focused, not random
  // emphasis).
  const bx = GW / 2 - 60;
  const by = GH - 80;
  ctx.fillStyle = GT2_COLORS.amber;
  fillRoundRectHome(ctx, bx, by, 120, 32, 5);
  ctx.fillStyle = GT2_COLORS.bgDeep;
  ctx.font = 'bold 13px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('← BACK', GW / 2, by + 21);
  life._garageSpecsBackRect = { x: bx, y: by, w: 120, h: 32 };
}

/** H567 — geometry of one ORDER button inside the parts list. Cached
 *  on life._garagePartsBtnRects per paint so the click router can
 *  dispatch by tap → part index without re-running layout. */
interface GaragePartsBtnRect {
  x: number;
  y: number;
  w: number;
  h: number;
  partIdx: number; // index into the filtered parts array (NOT PARTS_SHOP)
  enabled: boolean;
}

/** H567 — Parts sub-view. Opened via life._garageView='parts' from
 *  the PARTS button on the garage expanded car panel. Shows a
 *  scrollable list of every part the active car is eligible for,
 *  with an ORDER button per row that deducts cash + applies the
 *  stat bump immediately (no pendingParts queue yet — see
 *  src/sim/partsShop.ts module doc for the deferred sim work).
 *
 *  Each row shows:
 *    - Part name (header)
 *    - Type badge (Delivery / DIY / Mechanic)
 *    - Stat readout ("+50% tires", "Mod: Welded Diff", etc.)
 *    - Primary price (DIY for delivery+diy parts; Mechanic for
 *      mechanic-only parts since DIY of those is rare and slow)
 *    - ORDER button — greyed when player can't afford OR DIY-gated
 *      and skill too low
 *  Per-venue picker (DIY/Mechanic/Dealer simultaneously) is
 *  deferred to a follow-up; the primary venue logic above mirrors
 *  the monolith's "tap the row to pick venue" UX simplified for
 *  the first port. */
function drawGaragePartsView(
  ctx: CanvasRenderingContext2D,
  GW: number,
  GH: number,
  life: LifeState,
  car: CatalogCar,
): void {
  const topY = 120;
  // H735: GT2 italic display title.
  ctx.textAlign = 'center';
  ctx.fillStyle = GT2_COLORS.text;
  ctx.font = 'italic bold 16px monospace';
  ctx.fillText('PARTS', GW / 2, topY);
  ctx.fillStyle = GT2_COLORS.textMute;
  ctx.font = '9px monospace';
  const nm = car.name.length > 32 ? car.name.slice(0, 31) + '…' : car.name;
  ctx.fillText('Install on ' + nm, GW / 2, topY + 14);
  ctx.fillText('Cash: Cr ' + life.money.toLocaleString() + ' · Skill: ' + Math.round(life.mechSkill ?? 0), GW / 2, topY + 26);

  const listTop = topY + 40;
  const listBot = GH - 100; // reserve room for BACK button
  const visibleH = listBot - listTop;

  // Filter parts catalog by mod eligibility (drops WELD DIFF when
  // already welded, SUPERCHARGER when already supercharged, etc.).
  const eligible = filterAvailableParts(life, car);

  // Layout pass — measure total content height so scroll math
  // works once the list overflows the band.
  const rowH = 56;
  const rowGap = 4;
  const totalH = eligible.length * (rowH + rowGap);
  const scrollMax = Math.max(0, totalH - visibleH);
  life._garagePartsScrollMax = scrollMax;
  const scrollY = Math.max(0, Math.min(scrollMax, (life._garagePartsScrollY as number | undefined) ?? 0));
  life._garagePartsScrollY = scrollY;

  // Clip + translate the list region so rows scroll under the
  // header / BACK button.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, listTop, GW, visibleH);
  ctx.clip();
  let yy = listTop - scrollY;

  const btnRects: GaragePartsBtnRect[] = [];
  if (eligible.length === 0) {
    ctx.fillStyle = GT2_COLORS.textMute;
    ctx.font = '10px monospace';
    ctx.fillText('No parts available for this car.', GW / 2, yy + 24);
  }
  for (let i = 0; i < eligible.length; i++) {
    const part = eligible[i];
    const venues = getVenueOptions(part, car, life);
    // Primary venue per part type: mechanic-required parts route
    // primary=mechanic; everything else routes primary=DIY (cheapest
    // when skill clears).
    const primary = part.type === 'mechanic' ? venues.mechanic : venues.diy;
    const price = primary.price;
    const canAfford = life.money >= price;
    const enabled = canAfford && primary.canDo;

    // H735: Row background — uniform GT2 charcoal panel. Disabled
    // rows DO NOT get a darker face (per user policy: dark =
    // selected, not random emphasis). Disabled state reads via the
    // dim text inside the row instead.
    ctx.fillStyle = GT2_COLORS.panel;
    ctx.fillRect(12, yy, GW - 24, rowH);
    ctx.strokeStyle = '#3a3a3a';
    ctx.lineWidth = 1;
    ctx.strokeRect(12, yy, GW - 24, rowH);

    // Type badge (delivery / DIY / mechanic) — semantic color kept
    // so the player can scan by type at a glance.
    ctx.textAlign = 'left';
    ctx.fillStyle = part.type === 'delivery' ? '#ffb84a'
                   : part.type === 'diy'       ? '#7fe5a8'
                   :                              '#ff9090';
    ctx.font = 'bold 8px monospace';
    ctx.fillText(part.type.toUpperCase(), 20, yy + 12);

    // Part name.
    ctx.fillStyle = enabled ? GT2_COLORS.text : GT2_COLORS.textMute;
    ctx.font = 'bold 11px monospace';
    ctx.fillText(part.name, 60, yy + 12);

    // Stat readout — "+N% tires" / "Mod: Welded Diff" / etc.
    ctx.fillStyle = enabled ? GT2_COLORS.textMute : GT2_COLORS.textDim;
    ctx.font = '9px monospace';
    let effLabel: string;
    if (part.stat === 'welded') effLabel = 'Mod: Welded Diff (100% diff lock)';
    else if (part.stat === 'supercharged') effLabel = 'Mod: Supercharger (+25-40% torque)';
    else if (part.stat === 'all') effLabel = '+' + part.add + '% engine / tires / body';
    else effLabel = '+' + part.add + '% ' + (part.stat === 'hp' ? 'body' : part.stat);
    ctx.fillText(effLabel, 20, yy + 27);

    // Subline: venue label + time.
    ctx.fillStyle = GT2_COLORS.textDim;
    ctx.font = '8px monospace';
    const timeLabel = primary.time === 0 ? 'instant' : primary.time + 'd';
    ctx.fillText(primary.label + ' · ' + timeLabel, 20, yy + 40);

    // ORDER button (right side) — regular amber pill always; the
    // "(short Cr X)" sub-line on disabled rows tells the player
    // why they can't tap it. Dimming the face would imply
    // selection per the H734 button-state policy.
    const btnW = 88;
    const btnH = 28;
    const btnX = GW - 12 - btnW - 8;
    const btnY = yy + (rowH - btnH) / 2;
    ctx.fillStyle = GT2_COLORS.amber;
    fillRoundRectHome(ctx, btnX, btnY, btnW, btnH, 4);
    ctx.textAlign = 'center';
    ctx.fillStyle = enabled ? GT2_COLORS.bgDeep : GT2_COLORS.textDim;
    ctx.font = 'bold 11px monospace';
    ctx.fillText('ORDER', btnX + btnW / 2, btnY + 12);
    ctx.font = 'bold 10px monospace';
    ctx.fillText('Cr ' + price.toLocaleString(), btnX + btnW / 2, btnY + 24);

    btnRects.push({ x: btnX, y: btnY, w: btnW, h: btnH, partIdx: i, enabled });
    yy += rowH + rowGap;
  }
  ctx.restore();

  // Scroll indicator — amber thumb to match the H726 carSwitch idiom.
  if (scrollMax > 0) {
    const pct = scrollY / scrollMax;
    const barH = Math.max(20, visibleH * (visibleH / totalH));
    const barY = listTop + pct * (visibleH - barH);
    ctx.fillStyle = GT2_COLORS.amber;
    ctx.fillRect(GW - 4, barY, 3, barH);
  }

  // Stash hit-rects + the filtered list so the click router can
  // look up the part by partIdx without re-running the filter.
  life._garagePartsBtnRects = btnRects;
  life._garagePartsEligible = eligible as unknown[];

  // BACK button — regular amber pill.
  const bx = GW / 2 - 60;
  const by = GH - 80;
  ctx.fillStyle = GT2_COLORS.amber;
  fillRoundRectHome(ctx, bx, by, 120, 32, 5);
  ctx.fillStyle = GT2_COLORS.bgDeep;
  ctx.font = 'bold 13px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('← BACK', GW / 2, by + 21);
  life._garagePartsBackRect = { x: bx, y: by, w: 120, h: 32 };
}

/** H570 — geometry of one fault row inside the REPAIRS view. Cached
 *  on life._garageRepairsFaultRects so the click router can dispatch
 *  by tap → fault index. */
interface GarageRepairsFaultRect {
  x: number;
  y: number;
  w: number;
  h: number;
  faultIdx: number;
}

/** H570 — Repairs sub-view. Opened via life._garageView='repairs'
 *  from the REPAIRS button on the garage expanded car panel. Shows
 *  the player's diagnosed faults (life.faults) with tap-to-pop
 *  venue picker via the repair popup. Empty state surfaces the
 *  green "✓ No diagnosed issues" line.
 *
 *  Proactive parts orders (oil change / brake pads / etc. on a
 *  healthy car) flow through the separate PARTS sub-view from H567
 *  — REPAIRS here is fault-only.
 *
 *  1:1 with monolith drawGarageRepairs L48466-L48555 simplified to
 *  the faults section. The proactive parts catalog the monolith
 *  also lists inside drawGarageRepairs is intentionally NOT
 *  duplicated here — modular keeps the two surfaces distinct so
 *  the player flow is "diagnosed problem → REPAIRS, healthy
 *  upkeep → PARTS". */
function drawGarageRepairsView(
  ctx: CanvasRenderingContext2D,
  GW: number,
  GH: number,
  life: LifeState,
  car: CatalogCar,
): void {
  const topY = 120;
  ctx.textAlign = 'center';
  ctx.fillStyle = '#0ff';
  ctx.font = 'bold 14px monospace';
  ctx.fillText('🔧 REPAIRS', GW / 2, topY);
  // Car name + condition summary.
  ctx.fillStyle = '#888';
  ctx.font = '9px monospace';
  const nm = car.name.length > 32 ? car.name.slice(0, 31) + '…' : car.name;
  ctx.fillText(
    nm + ' • Eng ' + Math.round(life.engine) + '% Tire ' + Math.round(life.tires) + '% Body ' + Math.round(life.carHP) + '%',
    GW / 2, topY + 14,
  );
  // Skill bar.
  const skill = life.mechSkill ?? 0;
  ctx.fillStyle = '#0f0';
  ctx.font = 'bold 9px monospace';
  ctx.fillText('🔧 Skill: ' + skill + '/100', GW / 2, topY + 28);
  const skBarW = GW - 60;
  ctx.fillStyle = '#333';
  ctx.fillRect(30, topY + 32, skBarW, 5);
  ctx.fillStyle = '#0f0';
  ctx.fillRect(30, topY + 32, skBarW * (skill / 100), 5);

  const listTop = topY + 50;
  const listBot = GH - 100;
  const visibleH = listBot - listTop;
  const faults = (life.faults ?? []) as Fault[];

  // Scroll layout.
  const rowH = 30;
  const rowGap = 4;
  const totalH = Math.max(20, faults.length * (rowH + rowGap));
  const scrollMax = Math.max(0, totalH - visibleH);
  life._garageRepairsScrollMax = scrollMax;
  const scrollY = Math.max(0, Math.min(scrollMax, (life._garageRepairsScrollY as number | undefined) ?? 0));
  life._garageRepairsScrollY = scrollY;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, listTop, GW, visibleH);
  ctx.clip();
  let yy = listTop - scrollY;

  const rects: GarageRepairsFaultRect[] = [];
  if (faults.length === 0) {
    ctx.fillStyle = '#0f0';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('✓ No diagnosed issues', GW / 2, yy + 16);
    ctx.fillStyle = '#666';
    ctx.font = '9px monospace';
    ctx.fillText('Faults surface here when wear, impact, or breakdown', GW / 2, yy + 34);
    ctx.fillText('triggers diagnose them. Use PARTS for proactive upkeep.', GW / 2, yy + 46);
  }
  for (let i = 0; i < faults.length; i++) {
    const f = faults[i];
    ctx.fillStyle = 'rgba(255, 80, 80, 0.15)';
    ctx.fillRect(12, yy, GW - 24, rowH);
    ctx.strokeStyle = '#f88';
    ctx.lineWidth = 1;
    ctx.strokeRect(12, yy, GW - 24, rowH);
    // Fault name + cost preview.
    ctx.fillStyle = '#f88';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(f.name + ' — from $' + f.cost.toLocaleString(), GW / 2, yy + 12);
    // Effect line + tap hint.
    ctx.fillStyle = '#888';
    ctx.font = '8px monospace';
    const statLbl = f.stat === 'hp' ? 'body' : f.stat;
    ctx.fillText('+' + f.add + '% ' + statLbl + ' on fix • TAP to pick venue', GW / 2, yy + 24);
    rects.push({ x: 12, y: yy, w: GW - 24, h: rowH, faultIdx: i });
    yy += rowH + rowGap;
  }
  ctx.restore();

  // Scroll indicator.
  if (scrollMax > 0) {
    const pct = scrollY / scrollMax;
    const barH = Math.max(20, visibleH * (visibleH / totalH));
    const barY = listTop + pct * (visibleH - barH);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.fillRect(GW - 4, barY, 3, barH);
  }

  life._garageRepairsFaultRects = rects;

  // BACK button.
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
  life._garageRepairsBackRect = { x: bx, y: by, w: 120, h: 32 };
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
function drawCalendarTab(ctx: CanvasRenderingContext2D, GW: number, GH: number, clock: Clock, life: LifeState): void {
  const top = 120;
  let yy = top;

  // H566: calViewMonth offset selects which month to render. 0 =
  // current month, signed offsets navigate via ◀ ▶. Mirrors monolith
  // L46338 / L46362.
  const currentMonthIdx = Math.floor((clock.day - 1) / DAYS_PER_MONTH);
  const viewOffset = life.calViewMonth ?? 0;
  const viewMonthIdx = currentMonthIdx + viewOffset;
  const viewMonthOfYear = ((viewMonthIdx % 12) + 12) % 12;
  const monthName = MONTH_NAMES[viewMonthOfYear];
  const dayOfMonth = ((clock.day - 1) % DAYS_PER_MONTH) + 1;
  // First in-game day of the VIEW month — used for the day-of-week
  // alignment of the 1st. Was clock.day-based previously; now correctly
  // derived from viewMonthIdx so navigating months still aligns the
  // grid header.
  const firstDayGlobal = viewMonthIdx * DAYS_PER_MONTH + 1;
  const firstWeekIdx = ((firstDayGlobal - 1) % 7 + 7) % 7;
  const TO_GRID_COL = [5, 6, 0, 1, 2, 3, 4];
  const firstCol = TO_GRID_COL[firstWeekIdx];

  // Title + year + viewing tag.
  const yearNum = 1999 + Math.floor(viewMonthIdx / 12);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#0ff';
  ctx.font = 'bold 16px monospace';
  ctx.fillText(`📅 ${monthName.toUpperCase()} ${yearNum}`, GW / 2, yy);
  // H566: ◀ ▶ nav arrows on either side of the title row. Cached
  // rects stashed on life for handleHomeOverlayClick.
  life._calNavRects = drawNavArrows(ctx, GW, yy);
  yy += 22;
  ctx.fillStyle = '#888';
  ctx.font = '11px monospace';
  if (viewOffset === 0) {
    ctx.fillText(`Day ${clock.day} (in-game) • Today is the ${ordinal(dayOfMonth)}`, GW / 2, yy);
  } else {
    ctx.fillText('(viewing)', GW / 2, yy);
  }
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
  const isCurrentMonth = viewOffset === 0;
  for (let d = 1; d <= DAYS_PER_MONTH; d++) {
    const cx = gridX + col * cellW;
    const cy = yy + row * cellH;
    const isToday = isCurrentMonth && d === dayOfMonth;
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
    ctx.textAlign = 'center';
    ctx.fillText(String(d), cx + cellW / 2, cy + 12);
    // H566: per-day event badges from calendarLog (auto-prepends a
    // synthetic B on day 1 if not already in the log).
    drawCellBadges(ctx, life, viewMonthOfYear, d, cx, cy, cellW, cellH);

    col++;
    if (col > 6) {
      col = 0;
      row++;
    }
  }

  // H566: legend below the grid — letter / color swatch row + slot
  // hint. Bills-next-due line stays below as supplemental info.
  const gridRows = Math.ceil((DAYS_PER_MONTH + firstCol) / 7);
  const legY = yy + gridRows * cellH + 14;
  drawCalendarLegend(ctx, GW, legY);
  ctx.fillStyle = '#888';
  ctx.font = '9px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(`Bills next due in ${daysUntilNextBilling(clock.day)} day(s)`, GW / 2, legY + 38);

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

// H520: MONTH_NAMES canonicalized in src/config/calendar.ts —
// the local duplicate is gone. Imported alias keeps the existing
// usage in drawCalendarTab untouched.

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

/** H613: real buyGroceries port from monolith L45824-45837. Replaces
 *  the inline placeholder that silently no-op'd on insufficient funds
 *  and didn't show a success notif.
 *
 *  Behavior:
 *    - Insufficient cash → "Need $<cost>!" notif, bails.
 *    - Otherwise: deduct cost, increment stock, notif with store name
 *      + meals added + cost.
 *
 *  Deferred (matches the FOOD_TIERS deferred-list at the top of this
 *  module): time-slot consumption (consumeTimeSlotForActivity) — the
 *  timeSlot subsystem is still unknown in LifeState. */
function buyGroceries(
  life: HomeOverlayOpts['life'],
  opt: GroceryOption,
): void {
  if (life.money < opt.cost) {
    showNotif(life, 'Need $' + opt.cost + '!');
    return;
  }
  life.money -= opt.cost;
  life.foodStock[opt.key] = (life.foodStock[opt.key] || 0) + opt.qty;
  showNotif(
    life,
    opt.icon + ' ' + opt.store + ' run! +' + opt.qty +
      ' meals (-$' + opt.cost + ')',
  );
}

/** H612: real eatFood port from monolith L45809-45824. Replaces the
 *  inline placeholder that incorrectly deducted fitness for junk meals
 *  (monolith doesn't touch fitness on eat — junk's penalty applies in
 *  updateDailyHealth's lastMealTier branch, NOT immediately).
 *
 *  Behavior:
 *    - Bails with "No <tier> food left!" notif if stock is empty.
 *    - Decrements stock, sets ateToday + lastMealTier, resets
 *      daysSinceEat (hunger streak).
 *    - Immediate health bonus: premium +2, regular +1, junk none.
 *    - Notif with tier label + total-meals-left count.
 *
 *  NOTE: monolith's ateToday gate (`if (!LIFE.ateToday)`) is implicit
 *  here — the caller's hit-test already runs `if (!opts.life.ateToday)`
 *  before invoking, so a tap on a second meal silently no-ops; the
 *  helper itself doesn't re-gate so future callers (e.g. cheats / debug
 *  buttons) can force a second meal cleanly. */
function eatFood(
  life: HomeOverlayOpts['life'],
  tier: 'junk' | 'regular' | 'premium',
): void {
  const stock = life.foodStock[tier] || 0;
  if (stock <= 0) {
    showNotif(life, 'No ' + tier + ' food left!');
    return;
  }
  if (life.ateToday) return;
  life.foodStock[tier] = stock - 1;
  life.ateToday = true;
  life.lastMealTier = tier;
  life.daysSinceEat = 0;
  if (tier === 'premium') life.health = Math.min(100, life.health + 2);
  else if (tier === 'regular') life.health = Math.min(100, life.health + 1);
  const labels = {
    junk: '🍔 Fast food',
    regular: '🍲 Regular meal',
    premium: '🥗 Premium meal',
  } as const;
  const fs = life.foodStock;
  const total = (fs.junk || 0) + (fs.regular || 0) + (fs.premium || 0);
  showNotif(life, labels[tier] + '! (' + total + ' meals left)');
}

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

  // H213: GYM section. 3-option workout strip (Light / Medium /
  // Heavy) with affordability + slot-availability gating. The
  // workout level → $cost / fitness+health gain math lives in
  // evaluateGymWorkout (already ported); this UI just surfaces it
  // and dispatches taps to the apply path. 1:1 port of monolith
  // L48879-48908.
  yy += 4;
  ctx.strokeStyle = '#555';
  ctx.beginPath();
  ctx.moveTo(30, yy);
  ctx.lineTo(GW - 30, yy);
  ctx.stroke();
  yy += 12;
  ctx.textAlign = 'center';
  ctx.fillStyle = '#0ff';
  ctx.font = 'bold 12px monospace';
  ctx.fillText('🏋️ GYM (uses time slot)', GW / 2, yy);
  yy += 4;

  const slotAvail = (life.slotsActiveToday ?? 0) < 3;
  if (life.gymVisitedToday) {
    ctx.fillStyle = '#8f8';
    ctx.font = '8px monospace';
    ctx.fillText('Already worked out today ✓', GW / 2, yy + 8);
    yy += 12;
  } else if (!slotAvail) {
    ctx.fillStyle = '#f44';
    ctx.font = '8px monospace';
    ctx.fillText('No time slots left today!', GW / 2, yy + 8);
    yy += 12;
  }
  yy += 10;

  const gymOpts = [
    { level: 1 as const, icon: '🚶', label: 'Light Workout',  cost: 0,  desc: 'Free • 💪+2 ❤️+1', color: '#8f0' },
    { level: 2 as const, icon: '🏃', label: 'Medium Workout', cost: 10, desc: '$10 • 💪+4 ❤️+2', color: '#0ff' },
    { level: 3 as const, icon: '🏋️', label: 'Heavy Workout',  cost: 20, desc: '$20 • 💪+6 ❤️+3', color: '#f0f' },
  ];
  const gymBtnYs: Array<{ y: number; level: 1 | 2 | 3; canGym: boolean }> = [];
  for (const go of gymOpts) {
    const canGym = life.money >= go.cost
      && slotAvail
      && !life.gymVisitedToday
      && (go.level < 3 || life.health >= 15);
    ctx.fillStyle = canGym ? 'rgba(255, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.03)';
    ctx.fillRect(12, yy, GW - 24, 26);
    ctx.strokeStyle = canGym ? go.color : '#444';
    ctx.lineWidth = 1;
    ctx.strokeRect(12, yy, GW - 24, 26);
    ctx.fillStyle = canGym ? go.color : '#666';
    ctx.font = 'bold 10px monospace';
    ctx.fillText(go.icon + ' ' + go.label, GW / 2, yy + 10);
    ctx.fillStyle = '#aaa';
    ctx.font = '8px monospace';
    let desc = go.desc;
    if (go.level >= 3 && life.health < 15) desc = 'Too unhealthy!';
    else if (go.level >= 2 && life.daysSinceEat >= 2) desc += ' ⚠ hungry penalty';
    ctx.fillText(desc, GW / 2, yy + 21);
    gymBtnYs.push({ y: yy, level: go.level, canGym });
    yy += 30;
  }
  (life as { _gymBtnYs?: typeof gymBtnYs })._gymBtnYs = gymBtnYs;

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
  carId?: string;
  amount?: number;
  day?: number;
  /** H568: per-message read latch. Flipped to true once the mail
   *  tab is viewed so the main-tab MAIL badge clears. Mirrors
   *  monolith L47804 — drawHomeMail iterates LIFE.mail and sets
   *  m.read=true regardless of whether the player visually
   *  acknowledges any individual row. */
  read?: boolean;
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
  // H568: viewing the mailbox marks every message read so the main-tab
  // MAIL badge clears. Matches monolith L47804 — kill the badge once
  // the player has SEEN the inbox, regardless of which row they tap.
  for (const m of mail) m.read = true;
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

/** H189: build a PinPickerState from a tapped newspaper row.
 *  H542 wired worldX/Y onto each NewspaperListing at generation
 *  time (via [[randomRoadPos]]), so the picker reads them straight
 *  off the row — replacing the prior random-any-tile synth that
 *  ignored road type AND re-rolled on every pin-picker open. */
function makePinPickerStateFromRow(row: NewspaperListing, idx: number): PinPickerState {
  const expiresDay = row.expiresDay ?? 0;
  const listing: PinListing = {
    type: row.type,
    name: row.name,
    price: row.price,
    isRental: row.type === 'house' ? (row as HouseListing).isRental : undefined,
    worldX: row.worldX,
    worldY: row.worldY,
    expiresDay,
  };
  return { listing, index: idx };
}

/** H189: PinPickerDeps for the home-overlay commit path. PIN IT
 *  pushes a CarPin into LIFE.carPins, flips the source row's
 *  isPinned flag so daily-refresh keeps it, and clears the modal.
 *  CANCEL just clears the modal. */
function makePinPickerDeps(life: LifeState): import('@/ui/modals/pinPicker').PinPickerDeps {
  return {
    commit: (pin: PlacedPin) => {
      const carPin: CarPin = {
        worldX: pin.worldX,
        worldY: pin.worldY,
        color: pin.color,
        label: pin.label,
        index: pin.index,
        expiresDay: pin.expiresDay,
        listing: pin.listing,
      };
      (life.carPins ?? (life.carPins = [])).push(carPin);
      const src = life.newspaper?.[pin.index];
      if (src) src.isPinned = true;
      life.pinPicker = null;
    },
    cancel: () => {
      life.pinPicker = null;
    },
    showNotif: (msg) => {
      life.notif = msg;
      life.notifTimer = 120;
    },
  };
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

/** H214: SLEEP / RELAX side-by-side mid-day, single SLEEP when all
 *  slots used. 1:1 port of monolith L47494-47553 button layout
 *  minus the payday/skipped-day subtitle (those depend on the
 *  un-ported pay/absence pipeline; surfaced via the existing day-
 *  rollover path). Y values cached on life._sleepBtns for the
 *  tap router. */
function drawSleepButtons(ctx: CanvasRenderingContext2D, GW: number, GH: number, life: LifeState): void {
  const sleepY = GH - 130;
  const next = nextUnusedSlot(life);
  const nextNames: Record<'morning' | 'afternoon' | 'night', string> = {
    morning: 'Morning', afternoon: 'Afternoon', night: 'Night',
  };
  const btns: Array<{ x: number; y: number; w: number; h: number; action: 'sleep' | 'relax' }> = [];

  if (next) {
    // Mid-day split: RELAX | SLEEP. H732: GT2 amber pills, with
    // SLEEP taking the brighter active-orange (primary intent;
    // ends a slot rather than just nudging time forward).
    const halfW = (GW - 28) / 2;
    const nextLabel = nextNames[next];

    // LEFT — RELAX (secondary, amber).
    ctx.fillStyle = GT2_COLORS.amber;
    fillRoundRectHome(ctx, 12, sleepY, halfW, 32, 5);
    ctx.fillStyle = GT2_COLORS.bgDeep;
    ctx.font = 'bold 12px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('🛋 RELAX', 12 + halfW / 2, sleepY + 14);
    ctx.font = '8px monospace';
    ctx.fillText('To ' + nextLabel + ' (half rest)', 12 + halfW / 2, sleepY + 26);
    btns.push({ x: 12, y: sleepY, w: halfW, h: 32, action: 'relax' });

    // RIGHT — SLEEP (primary, active orange).
    ctx.fillStyle = GT2_COLORS.active;
    fillRoundRectHome(ctx, 14 + halfW, sleepY, halfW, 32, 5);
    ctx.fillStyle = GT2_COLORS.bgDeep;
    ctx.font = 'bold 12px monospace';
    ctx.fillText('😴 SLEEP', 14 + halfW + halfW / 2, sleepY + 14);
    ctx.font = '8px monospace';
    ctx.fillText('To ' + nextLabel + ' (full rest)', 14 + halfW + halfW / 2, sleepY + 26);
    btns.push({ x: 14 + halfW, y: sleepY, w: halfW, h: 32, action: 'sleep' });
  } else {
    // All slots used — single full-width SLEEP (active orange).
    ctx.fillStyle = GT2_COLORS.active;
    fillRoundRectHome(ctx, 12, sleepY, GW - 24, 32, 5);
    ctx.fillStyle = GT2_COLORS.bgDeep;
    ctx.font = 'bold 13px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('😴 SLEEP', GW / 2, sleepY + 14);
    ctx.font = '9px monospace';
    ctx.fillText('End day', GW / 2, sleepY + 26);
    btns.push({ x: 12, y: sleepY, w: GW - 24, h: 32, action: 'sleep' });
  }
  ctx.textAlign = 'left';
  (life as { _sleepBtns?: typeof btns })._sleepBtns = btns;
}

/** H574: rich main-tab header. 1:1 port of monolith L47226-L47267.
 *  Portrait at top-left, "🏠 HOME" title, name/age/date subhead,
 *  cash line, compact health bar at top-right, housing+bills summary
 *  with days-until-next-billing countdown, cars-breakdown sub-line
 *  when carPay>0, total-debt line when debts exist, and WORK +
 *  STREET rep bars side-by-side below.
 *
 *  Total vertical footprint: ~82px (portrait at y=4, last rep bar
 *  baseline at y=78). drawMainButtons + drawSleepButtons compose
 *  below without overlap. */
function drawRichHeader(
  ctx: CanvasRenderingContext2D,
  life: LifeState,
  clock: Clock,
  GW: number,
): void {
  // Portrait swatch top-left.
  const portraitSize = 28;
  drawCharacterBase(ctx, life.gender, life.fitness, life.skinTone, 4, 4, portraitSize);
  ctx.strokeStyle = GT2_COLORS.amber;
  ctx.lineWidth = 1;
  ctx.strokeRect(4, 4, portraitSize, portraitSize);

  // Title — italic display "HOME" instead of the emoji + label, to
  // match GT2's poster header treatment (H732).
  ctx.textAlign = 'center';
  ctx.fillStyle = GT2_COLORS.text;
  ctx.font = 'italic bold 18px monospace';
  ctx.fillText('HOME', GW / 2 + 14, 22);

  // Name + age + date.
  ctx.fillStyle = GT2_COLORS.textMute;
  ctx.font = '11px monospace';
  ctx.fillText(
    (life.playerAlias || 'NO NAME') + ' (' + life.age + ') — ' + getDateString(clock.day),
    GW / 2, 36,
  );

  // Cash — Cr coin convention (matches the GT2 modals landed H726-H731).
  ctx.fillStyle = GT2_COLORS.amber;
  ctx.font = 'bold 12px monospace';
  ctx.fillText('Cr ' + life.money.toLocaleString(), GW / 2, 50);

  // Compact health bar at top-right.
  const hStatus = getHealthStatus(life.health);
  const hbW = 60, hbH = 6;
  const hbX = GW - hbW - 8;
  const hbY = 44;
  ctx.fillStyle = '#333';
  ctx.fillRect(hbX, hbY, hbW, hbH);
  ctx.fillStyle = hStatus.color;
  ctx.fillRect(hbX, hbY, Math.round(hbW * (life.health / 100)), hbH);
  ctx.fillStyle = hStatus.color;
  ctx.font = '7px monospace';
  ctx.textAlign = 'right';
  ctx.fillText(hStatus.icon + Math.round(life.health) + '%', hbX - 2, hbY + 5);
  ctx.textAlign = 'center';

  // Housing + bills summary line.
  const housingCost = monthlyHousing(life);
  const carPay = monthlyCarPayments(life);
  const totalBills = housingCost + carPay;
  const daysUntilBill = daysUntilNextBilling(clock.day);
  ctx.fillStyle = GT2_COLORS.textMute;
  ctx.font = '9px monospace';
  const housingName = HOUSING_TIERS[life.housingType as HousingTierKey]?.name ?? life.housingType;
  const billLine = carPay > 0
    ? 'Bills: Cr ' + totalBills.toLocaleString() + ' / mo · ' + daysUntilBill + 'd left'
    : housingName + ' · Cr ' + housingCost.toLocaleString() + ' / mo · ' + daysUntilBill + 'd';
  ctx.fillText(billLine, GW / 2, 62);

  // Cars-breakdown sub-line. Only shows when there are car loans.
  let totalDebtY = 72;
  if (carPay > 0) {
    ctx.fillStyle = GT2_COLORS.textDim;
    ctx.font = '8px monospace';
    ctx.fillText('rent Cr ' + housingCost + ' + cars Cr ' + carPay, GW / 2, 71);
    totalDebtY = 80;
  }

  // Total debt line (mortgage + car loans + bank loans).
  const totalDebt = (life.mortgageBalance ?? 0)
    + totalCarLoansOwed(life)
    + totalBankLoansOwed(life);
  if (totalDebt > 0) {
    ctx.fillStyle = '#ff7a7a';
    ctx.font = '8px monospace';
    ctx.fillText('Total debt: Cr ' + totalDebt.toLocaleString(), GW / 2, totalDebtY);
  }

  // Reputation bars — WORK on left, STREET on right. Only WORK
  // shows when the player has a job (no rep math otherwise).
  // Bar colors stay semantic (red→yellow→green) so the player can
  // read tier at a glance even on a charcoal backplate.
  const repY = 84;
  const barW = (GW - 60) / 2;
  if (life.playerJob) {
    ctx.fillStyle = GT2_COLORS.textDim;
    ctx.font = '7px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('WORK ' + (life.workRep ?? 0), 14, repY - 4);
    ctx.fillStyle = '#222';
    ctx.fillRect(14, repY - 2, barW, 3);
    const workCol = (life.workRep ?? 0) >= 60 ? '#0f0' : (life.workRep ?? 0) >= 30 ? '#ff0' : '#f44';
    ctx.fillStyle = workCol;
    ctx.fillRect(14, repY - 2, barW * ((life.workRep ?? 0) / 100), 3);
    if ((life.payMultiplier ?? 1) > 1.0) {
      ctx.fillStyle = GT2_COLORS.amber;
      ctx.font = '7px monospace';
      ctx.fillText(Math.round((life.payMultiplier ?? 1) * 100) + '%', 14 + barW + 2, repY - 4);
    }
  }
  // STREET rep bar — always renders (player has a streetRep score
  // even before their first race; tier just reads OPEN).
  const sTier = getStreetTier(life);
  ctx.textAlign = 'right';
  ctx.fillStyle = GT2_COLORS.textDim;
  ctx.font = '7px monospace';
  ctx.fillText(sTier.name + ' ' + (life.streetRep ?? 0), GW - 14, repY - 4);
  ctx.fillStyle = '#222';
  ctx.fillRect(GW - 14 - barW, repY - 2, barW, 3);
  ctx.fillStyle = sTier.color;
  ctx.fillRect(GW - 14 - barW, repY - 2, barW * ((life.streetRep ?? 0) / 100), 3);
  ctx.textAlign = 'center';
}

/** H574: compact header used by sub-tabs (BILLS / GARAGE / EAT /
 *  CALENDAR / NEWSPAPER / MAIL). Money + slot indicator on one row
 *  so the tab body has more vertical room. 1:1 with monolith
 *  L47269-L47283. */
function drawCompactHeader(
  ctx: CanvasRenderingContext2D,
  life: LifeState,
  clock: Clock,
  GW: number,
): void {
  ctx.textAlign = 'center';
  ctx.fillStyle = GT2_COLORS.amber;
  ctx.font = 'bold 11px monospace';
  ctx.fillText('Cr ' + life.money.toLocaleString(), GW / 2, 14);
  const slotMeta: Record<'morning' | 'afternoon' | 'night', { icon: string; name: string; col: string }> = {
    morning:   { icon: '🌅', name: 'MORNING',   col: '#fa8' },
    afternoon: { icon: '☀️', name: 'AFTERNOON', col: '#ff0' },
    night:     { icon: '🌙', name: 'NIGHT',     col: '#88f' },
  };
  const slot = slotMeta[life.timeSlot] ?? slotMeta.morning;
  const slotsLeft = (['morning', 'afternoon', 'night'] as const)
    .filter((k) => !life.slotsUsed[k]).length;
  ctx.fillStyle = slot.col;
  ctx.font = 'bold 9px monospace';
  ctx.fillText(
    slot.icon + ' ' + slot.name + ' — ' + getDateString(clock.day)
    + ' • ' + slotsLeft + ' slot' + (slotsLeft !== 1 ? 's' : '') + ' left',
    GW / 2, 26,
  );
}

function drawMainButtons(ctx: CanvasRenderingContext2D, GW: number, GH: number, life: LifeState, clock: Clock): void {
  const buttons = layoutMainButtons(GW, GH);
  ctx.font = 'bold 14px monospace';
  ctx.textAlign = 'center';
  for (const b of buttons) {
    // H732: GT2 amber tile faces. Close gets the bright active
    // orange (primary exit gesture); disabled tabs drop to the
    // amberDim palette so they read greyed.
    const face = b.tab === 'close'
      ? GT2_COLORS.active
      : b.enabled
        ? GT2_COLORS.amber
        : GT2_COLORS.amberDim;
    const fg = b.enabled || b.tab === 'close' ? GT2_COLORS.bgDeep : GT2_COLORS.textDim;

    ctx.fillStyle = face;
    fillRoundRectHome(ctx, b.x, b.y, b.w, b.h, 6);
    ctx.fillStyle = fg;
    ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 + 5);

    if (!b.enabled && b.tab !== 'close') {
      ctx.fillStyle = GT2_COLORS.textDim;
      ctx.font = '9px monospace';
      ctx.fillText('(coming soon)', b.x + b.w / 2, b.y + b.h - 6);
      ctx.font = 'bold 14px monospace';
    }

    // H568: per-tab urgency badge — top-right corner of each tab
    // button. 1:1 with monolith L47337-L47410. CALENDAR + MAIN +
    // CLOSE get no badge; every other tab computes its own urgency
    // state inline.
    if (b.enabled && b.tab !== 'close' && b.tab !== 'main') {
      const badge = computeTabBadge(b.tab, life, clock);
      if (badge) drawTabBadge(ctx, b.x + b.w, b.y, badge);
    }
  }
  ctx.fillStyle = GT2_COLORS.textDim;
  ctx.font = '11px monospace';
  ctx.fillText('Press H or tap EXIT to close', GW / 2, GH - 18);
  ctx.font = 'bold 14px monospace';
}

/** Local rounded-rect helper — matches the inline copies in the
 *  partsLineup / partsSubmenu / partsDetail modules. */
function fillRoundRectHome(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
  ctx.fill();
}

/** H568: badge descriptor — text shown inside the pill and the pill's
 *  background color. text length drives the pill width (1 char → 14px
 *  circle, 2+ chars → 16px rounded rect). */
interface TabBadge {
  text: string;
  color: string;
}

/** Computes the urgency-badge state for a given tab. Returns null when
 *  the tab has nothing to surface. Mirrors monolith L47337-L47389. */
function computeTabBadge(tab: HomeTab, life: LifeState, clock: Clock): TabBadge | null {
  if (tab === 'mail') {
    const mail = (life.mail ?? []) as MailItem[];
    const unreadOffers = mail.filter((m) => !m.read).length;
    // Arrived-packages count. pendingParts shape is opaque so far —
    // defensive read for readyDay / readyHour.
    const day = clock.day;
    const hour = Math.floor(clock.timeOfDay * 24);
    const arrivedPkgs = ((life.pendingParts ?? []) as Array<{ readyDay?: number; readyHour?: number }>)
      .filter((p) => {
        const rd = p.readyDay;
        if (typeof rd !== 'number') return false;
        if (day > rd) return true;
        if (day === rd && hour >= (p.readyHour ?? 0)) return true;
        return false;
      }).length;
    const total = unreadOffers + arrivedPkgs;
    if (total > 0) return { color: '#f44', text: String(Math.min(99, total)) };
    return null;
  }
  if (tab === 'garage') {
    const nf = (life.faults ?? []).length;
    if (nf > 0) return { color: '#f44', text: String(Math.min(99, nf)) };
    return null;
  }
  if (tab === 'eat') {
    if (!life.ateToday) return { color: '#f44', text: '!' };
    if ((life.health ?? 100) < 50) return { color: '#fa0', text: '!' };
    return null;
  }
  if (tab === 'newspaper') {
    const expiring = (life.newspaper ?? []).filter((c) => {
      const exp = (c as { expiresDay?: number }).expiresDay;
      const dl = typeof exp === 'number' ? exp - clock.day : 99;
      return dl <= 2 && dl >= 0;
    }).length;
    if (expiring > 0) return { color: '#fa0', text: String(Math.min(99, expiring)) };
    return null;
  }
  if (tab === 'bills') {
    if (isAnyBillPastDue(life)) return { color: '#f44', text: '!' };
    const cost = monthlyTotalDue(life);
    if (cost <= 0) return null;
    const du = daysUntilNextBilling(clock.day);
    if (du <= 1) return { color: '#f44', text: du + 'd' };
    if (du <= 3) return { color: '#fa0', text: du + 'd' };
    return null;
  }
  return null;
}

/** Paints the badge pill at the top-right corner of a tab button.
 *  Anchor is the button's top-right corner; the pill extends up-left
 *  by ~7-9px on each axis. 1:1 with monolith L47394-L47410. */
function drawTabBadge(
  ctx: CanvasRenderingContext2D,
  anchorX: number,
  anchorY: number,
  badge: TabBadge,
): void {
  const w = badge.text.length > 1 ? 16 : 14;
  const cx = anchorX - 8;
  const cy = anchorY + 10;
  ctx.fillStyle = badge.color;
  if (w === 14) {
    ctx.beginPath();
    ctx.arc(cx, cy, 7, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // Rounded rect for the wider 2-char pill.
    const bx = cx - 8;
    const by = cy - 7;
    const bw = 16;
    const bh = 14;
    const r = 7;
    ctx.beginPath();
    ctx.moveTo(bx + r, by);
    ctx.lineTo(bx + bw - r, by);
    ctx.arcTo(bx + bw, by, bx + bw, by + r, r);
    ctx.lineTo(bx + bw, by + bh - r);
    ctx.arcTo(bx + bw, by + bh, bx + bw - r, by + bh, r);
    ctx.lineTo(bx + r, by + bh);
    ctx.arcTo(bx, by + bh, bx, by + bh - r, r);
    ctx.lineTo(bx, by + r);
    ctx.arcTo(bx, by, bx + r, by, r);
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 9px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(badge.text, cx, cy + 3);
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
  // H575: bills receipt modal eats every tap when up. Sits at the
  // top of the home-overlay click pipeline so taps can't fall
  // through to the tab body (especially the close button) while
  // the player is acknowledging a bills cycle.
  if (opts.life.billsDuePrompt) {
    handleBillsReceiptTap(tx, ty, opts.life);
    return true;
  }

  // H189: pin-picker modal eats EVERY tap while it's up — checked
  // first so the BACK button below can't accidentally close the
  // tab out from under an open picker. Mirrors the monolith's
  // L50854-50857 priority (newspaper tap dispatch checks pinPicker
  // before anything else).
  if (opts.life.pinPicker) {
    handlePinPickerClick(tx, ty, {
      state: opts.life.pinPicker,
      GW: opts.GW,
      GH: opts.GH,
    }, makePinPickerDeps(opts.life));
    return true;
  }

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
    // H570: repair popup eats every tap while up. Sits FIRST so a
    // tap doesn't fall through to the REPAIRS row beneath. Routes
    // venue + cancel through handleRepairPopupTap.
    if (opts.tab === 'garage' && opts.life.repairPopup) {
      handleRepairPopupTap(tx, ty, opts.life);
      return true;
    }
    // H570: REPAIRS sub-view tap router. BACK returns to garage
    // list; fault row taps open the repair popup.
    if (opts.tab === 'garage' && opts.life._garageView === 'repairs') {
      const rBack = opts.life._garageRepairsBackRect as
        { x: number; y: number; w: number; h: number } | undefined;
      if (rBack && tx >= rBack.x && tx <= rBack.x + rBack.w && ty >= rBack.y && ty <= rBack.y + rBack.h) {
        opts.life._garageView = 'list';
        return true;
      }
      const rects = (opts.life._garageRepairsFaultRects as GarageRepairsFaultRect[] | undefined) ?? [];
      const faults = (opts.life.faults ?? []) as Fault[];
      for (const r of rects) {
        if (tx >= r.x && tx <= r.x + r.w && ty >= r.y && ty <= r.y + r.h) {
          const fault = faults[r.faultIdx];
          if (fault) {
            opts.life.repairPopup = { fault, faultIdx: r.faultIdx };
          }
          return true;
        }
      }
      return true;
    }
    // H567: parts sub-view tap router. BACK returns to garage list;
    // ORDER deducts cash + calls applyPart immediately (no
    // pendingParts queue yet). Modal-ish: any tap while in parts
    // view returns true so stray taps don't fall through.
    if (opts.tab === 'garage' && opts.life._garageView === 'parts') {
      const pBack = opts.life._garagePartsBackRect as {
        x: number; y: number; w: number; h: number;
      } | undefined;
      if (pBack && tx >= pBack.x && tx <= pBack.x + pBack.w && ty >= pBack.y && ty <= pBack.y + pBack.h) {
        opts.life._garageView = 'list';
        return true;
      }
      const partsBtns = (opts.life._garagePartsBtnRects as GaragePartsBtnRect[] | undefined) ?? [];
      const eligible = (opts.life._garagePartsEligible as ShopPart[] | undefined) ?? [];
      const cid = opts.life._garagePartsCarId as string | undefined;
      const car = cid ? CAR_CATALOG[cid] : undefined;
      for (const b of partsBtns) {
        if (tx >= b.x && tx <= b.x + b.w && ty >= b.y && ty <= b.y + b.h) {
          if (!b.enabled) return true;
          const part = eligible[b.partIdx];
          if (!part) return true;
          const venues = getVenueOptions(part, car, opts.life);
          const primary = part.type === 'mechanic' ? venues.mechanic : venues.diy;
          if (opts.life.money < primary.price) {
            showNotif(opts.life, "Can't afford " + part.name, 120);
            return true;
          }
          opts.life.money -= primary.price;
          applyPart(opts.life, part);
          // DIY install gives a small skill bump (mirrors monolith
          // installOwnedPart L48721 + the implicit DIY-completion
          // skill gain in completePending's diy branch).
          if (primary === venues.diy) {
            opts.life.mechSkill = Math.min(100, (opts.life.mechSkill ?? 0) + 1);
          }
          showNotif(opts.life, '🔧 ' + part.name + ' installed (-$' + primary.price.toLocaleString() + ')', 180);
          return true;
        }
      }
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
      // H564: sell-confirm modal eats every tap while up. YES → quick
      // sell; CANCEL → dismiss. Other taps fall through to nothing
      // (modal is a hard stop). Sits BEFORE the row/button hit-tests
      // so the player can't tap through to swap cars under it.
      const sc = opts.life._sellConfirm as SellConfirmState | null | undefined;
      if (sc) {
        const popW = opts.GW - 40;
        const popX = 20;
        const btnW = popW - 80;
        const btnX = popX + 40;
        if (sc._yesY && ty >= sc._yesY && ty <= sc._yesY + 28
            && tx >= btnX && tx <= btnX + btnW) {
          const id = sc.carId;
          opts.life._sellConfirm = null;
          quickSellCar(opts.life, id);
          return true;
        }
        if (sc._cancelY && ty >= sc._cancelY && ty <= sc._cancelY + 28
            && tx >= btnX && tx <= btnX + btnW) {
          opts.life._sellConfirm = null;
          return true;
        }
        return true; // swallow stray taps
      }

      // H564: expanded panel button rects. Walk every cached button
      // and dispatch by action. Disabled buttons (sell/list when
      // single car / leased / already listed) no-op silently. Sits
      // BEFORE the row hit-test so a tap on a button doesn't also
      // collapse the panel.
      const btnRects = (opts.life._garageExpandedBtnRects as GarageExpandedBtnRect[] | undefined) ?? [];
      for (const b of btnRects) {
        if (tx >= b.x && tx <= b.x + b.w && ty >= b.y && ty <= b.y + b.h) {
          if (!b.enabled) return true;
          if (b.action === 'getIn') {
            if (deps.getIn) deps.getIn(b.carId);
            return true;
          }
          if (b.action === 'specs') {
            opts.life._garageView = 'specs';
            opts.life._garageSpecsCarId = b.carId;
            return true;
          }
          if (b.action === 'repairs') {
            opts.life._garageView = 'repairs';
            opts.life._garageRepairsCarId = b.carId;
            opts.life._garageRepairsScrollY = 0;
            return true;
          }
          if (b.action === 'parts') {
            opts.life._garageView = 'parts';
            opts.life._garagePartsCarId = b.carId;
            opts.life._garagePartsScrollY = 0;
            return true;
          }
          if (b.action === 'sell') {
            opts.life._sellConfirm = { carId: b.carId };
            return true;
          }
          if (b.action === 'list') {
            listCarInNewspaper(opts.life, b.carId);
            return true;
          }
          return true;
        }
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
      // H576: ACTIVE ADS section taps. ad row → cancel; offer row →
      // accept best offer (sells the car). Walks the cached rects so
      // the layout-vs-hit-test math stays single-sourced.
      const adRects = (opts.life._garageAdRects as GarageAdHitRect[] | undefined) ?? [];
      for (const r of adRects) {
        if (tx >= r.x && tx <= r.x + r.w && ty >= r.y && ty <= r.y + r.h) {
          if (r.kind === 'cancel') {
            cancelCarAd(opts.life, r.adIdx);
          } else if (r.kind === 'accept' && typeof r.offerIdx === 'number') {
            acceptCarOffer(opts.life, r.adIdx, r.offerIdx);
          }
          return true;
        }
      }
    } else if (opts.tab === 'bills') {
      // H569: bank loan offer modal eats every tap while up. Sits
      // BEFORE the PAY-NOW + GET BANK LOAN hit-tests so taps don't
      // fall through to the bills section beneath.
      if (opts.life.bankLoanOffer) {
        handleBankLoanOfferTap(tx, ty, opts.life);
        return true;
      }
      // H569: GET BANK LOAN button — opens the offer modal at the
      // default $5k / 48mo. Player flips amount + term via the
      // modal's pickers from there.
      const glRect = opts.life._billsBankLoanBtnRect as
        { x: number; y: number; w: number; h: number } | null | undefined;
      if (glRect && tx >= glRect.x && tx <= glRect.x + glRect.w
          && ty >= glRect.y && ty <= glRect.y + glRect.h) {
        openBankLoanOffer(opts.life);
        return true;
      }
      // H39 PAY-NOW: walk the rects we stashed during draw.
      const rects = (opts.life._billsPayRects as BillsPayRect[] | undefined) || [];
      for (const r of rects) {
        if (!r.enabled) continue;
        if (tx >= r.x && tx <= r.x + r.w && ty >= r.y && ty <= r.y + r.h) {
          payLoanNow(opts.life, r.list, r.idx);
          return true;
        }
      }
    } else if (opts.tab === 'calendar') {
      // H566: ◀ ▶ month navigation arrows.
      const dir = hitCalendarNav(tx, ty, opts.life._calNavRects);
      if (dir !== 0) {
        opts.life.calViewMonth = (opts.life.calViewMonth ?? 0) + dir;
        return true;
      }
    } else if (opts.tab === 'eat') {
      const idx = hitEatRow(opts, tx, ty);
      if (idx >= 0) {
        const tier = FOOD_TIERS[idx];
        eatFood(opts.life, tier.key);
        return true;
      }
      // H38 grocery shop. Subordinate to the eat-row hit so the eat
      // rows above can't accidentally consume a shop tap.
      const sIdx = hitShopRow(opts, tx, ty);
      if (sIdx >= 0) {
        buyGroceries(opts.life, GROCERY_OPTIONS[sIdx]);
        return true;
      }
      // H213: gym workout taps. drawEatTab caches the 3 button Ys
      // on life._gymBtnYs; we hit-test against them and dispatch to
      // evaluateGymWorkout + apply the deltas. canGym was computed
      // at paint time so the disabled state is consistent (taps on
      // greyed-out rows fall through silently).
      const gymBtns = (opts.life as {
        _gymBtnYs?: Array<{ y: number; level: 1 | 2 | 3; canGym: boolean }>;
      })._gymBtnYs;
      if (gymBtns) {
        for (const btn of gymBtns) {
          if (!btn.canGym) continue;
          if (tx >= 12 && tx <= opts.GW - 12 && ty >= btn.y && ty <= btn.y + 26) {
            const result = evaluateGymWorkout(opts.life, btn.level);
            if (result.applied) {
              opts.life.money -= result.cost;
              opts.life.fitness = Math.max(0, Math.min(100, opts.life.fitness + result.fitGain));
              opts.life.health = Math.max(0, Math.min(100, opts.life.health + result.healthDelta));
              opts.life.gymVisitedToday = true;
              opts.life.lastWorkoutLevel = btn.level;
              opts.life.slotsActiveToday = (opts.life.slotsActiveToday ?? 0) + 1;
              opts.life.notif = '💪 Worked out (+' + result.fitGain + ' fit)';
              opts.life.notifTimer = 120;
            }
            return true;
          }
        }
      }
    } else if (opts.tab === 'newspaper') {
      // H189: pinPicker taps are caught at the top of
      // handleHomeOverlayClick — by the time we reach here, the
      // picker is either closed or has already consumed the tap.
      const section = hitNewspaperTabs(opts, tx, ty);
      if (section) {
        opts.life.newspaperSection = section;
        return true;
      }
      // H189: row tap. If carPins already has an entry for this row,
      // remove it (notif 'Pin removed'). Otherwise open the pin
      // picker. Mirrors monolith L50872-50885. The H36 isPinned flag
      // is kept in lockstep with carPins membership so the daily-
      // refresh-survival logic in fillNewspaperListings keeps
      // working without rewriting it in this commit.
      const row = hitNewspaperRow(opts, tx, ty);
      if (row) {
        const idx = opts.life.newspaper.indexOf(row);
        // H239: existing-pin lookup uses the listing OBJECT
        // REFERENCE instead of pin.index. carPin.index can drift
        // stale across newspaper splices (car/house purchases,
        // daily refresh); the listing reference is the
        // authoritative identity. H208 + H212 + fillNewspaperListings
        // do their best to keep .index accurate, but using the
        // reference here makes the comparison correct even when
        // an .index slip sneaks through.
        const existing = (opts.life.carPins ?? []).findIndex((p) => p.listing === row);
        if (existing >= 0) {
          opts.life.carPins.splice(existing, 1);
          row.isPinned = false;
          opts.life.notif = 'Pin removed';
          opts.life.notifTimer = 120;
        } else {
          opts.life.pinPicker = makePinPickerStateFromRow(row, idx);
        }
        return true;
      }
    }
    return true; // swallow taps inside the overlay even if no button hit
  }
  // H214: SLEEP / RELAX hit-test. Rendered only on the main tab,
  // BEFORE the tab-grid hit-test so the SLEEP/RELAX cards (which
  // sit below the grid) consume their taps first. Cached Y values
  // on life._sleepBtns by drawSleepButtons.
  if (opts.tab === 'main') {
    const sleepBtns = (opts.life as {
      _sleepBtns?: Array<{ x: number; y: number; w: number; h: number; action: 'sleep' | 'relax' }>;
    })._sleepBtns;
    if (sleepBtns) {
      for (const btn of sleepBtns) {
        if (tx < btn.x || tx > btn.x + btn.w || ty < btn.y || ty > btn.y + btn.h) continue;
        const result = btn.action === 'sleep'
          ? doSleep(opts.life, opts.clock)
          : doRelax(opts.life, opts.clock);
        if (result.kind === 'advanced') {
          const labels = { morning: 'Morning', afternoon: 'Afternoon', night: 'Night' } as const;
          opts.life.notif = labels[result.nextSlot] + ' — Day ' + opts.clock.day;
        } else if (result.noShow?.kind === 'fired') {
          // H515: no-show ladder fired the player. Surface that instead
          // of the generic day-rolled message — losing the job is the
          // important news today.
          opts.life.notif = '🚨 FIRED from ' + result.noShow.jobName + ' — too many no-shows!';
        } else if (result.noShow?.kind === 'absence') {
          // H515: no-show absence ticked but the player kept their job.
          opts.life.notif = '⚠️ No-show. Rep: ' + result.noShow.workRep
            + ' (' + result.noShow.absences + ' consecutive)';
        } else {
          opts.life.notif = 'Day ' + opts.clock.day + ' starts';
        }
        opts.life.notifTimer = 120;
        return true;
      }
    }
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
