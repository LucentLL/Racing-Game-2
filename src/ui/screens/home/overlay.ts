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
import {
  getCarUpgrades, getEffectiveCar, getUpgradeHeadroom,
  UPGRADE_CATEGORIES, brakeStageMult, BRAKE_MAX_PCT,
  suspTurnBonus, SUSP_MAX_PCT, gripStageBonus, GRIP_MAX_PCT, type UpgradeKind,
} from '@/config/cars/upgradeHeadroom';
import {
  getUpgradeStagePlan, orderUpgrade, hasPendingUpgrade,
  orderUpgradeParts, findOwnedUpgradePartIdx, UPGRADE_PART_SHIP_DAYS,
  carAtShop,
} from '@/sim/upgradeCost';
import { drawFocusRing, type FocusRect } from '@/ui/focusNav';
import { drawDrivetrainGlyph } from '@/ui/widgets/drivetrainGlyph';
import {
  drawCarSpritePreview, drawCarSpriteFocus, carPreviewTransform, componentBoxesFor,
} from '@/ui/widgets/carSpritePreview';
import {
  buildXrayCondition, type XrayCondition, type XrayComponentId,
} from '@/render/carBody/xrayDrivetrain';
import type { BodyDamage } from '@/render/carBody/damage';
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
import { monthlyInsurance, insuranceFleetPremium } from '@/sim/insurance';
import { MONTH_NAMES_FULL as MONTH_NAMES, getDateString } from '@/config/calendar';
import { getDayPlan, getScheduledEventsForDay, type DayPlan } from '@/sim/calendarSchedule';
import { BADGE_TYPE_BG, BADGE_SLOT_COLOR } from '@/ui/overlays/calendarBadges';
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
  orderPart,
  type ShopPart,
} from '@/sim/partsShop';
import { getFaultVenueOptions } from '@/sim/repairCost';
import {
  MECH_CATEGORIES, CATEGORY_META, ensureCatSkill, getCatSkill, categoryForFault,
} from '@/sim/repairSkills';
import {
  inspectFaultIds, hasHiddenTestDriveFault,
  inspectDailyLatchStore as inspectDailyLatch,
  markSubChecked, buildInspectGray,
} from '@/sim/inspectOwnCar';
import {
  INSPECT_SUBS, LIFT_VISIBLE_TD_IDS, inspectToolsFor,
} from '@/sim/inspectComponents';
import { consumeActivitySlot } from '@/sim/sleepSlot';
import { groupToolbox, ensureToolbox } from '@/sim/toolbox';
import { openBankLoanOffer } from '@/sim/bankLoan';
import {
  drawBillsReceipt,
  handleBillsReceiptTap,
} from '@/ui/modals/billsReceipt';
import {
  acceptCarOffer,
  cancelCarAd,
  declineCarOffer,
  findAdOfferForMail,
  type CarAd,
} from '@/sim/carAds';
import { drawCharacterBase } from '@/render/characterBase';
import { drawAvatar, AVATAR_SLOTS } from '@/render/avatar';
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
import { GT2_COLORS, drawGt2Backdrop } from '@/ui/gt2Chrome';
import { listMaps, getMapDef, type MapDef } from '@/world/mapRegistry';
import { getActiveMapId } from '@/world/mapRuntime';

/** H1247: true while the player is in a RACE-TRACK PIT BOX rather than their
 *  own garage. The overlay is the same component either way — it just shows a
 *  much smaller menu, because bills, the newspaper, meals, mail and sleeping
 *  are not things you do in a pit garage. */
export function atTrackPit(): boolean {
  const id = getActiveMapId();
  return id !== 'city' && !!getMapDef(id).pitTile;
}

/** H1247: what the player has chosen to do when they get to the start line.
 *  Null until picked; consumed by trackRace. */
export type TrackMode = 'testlap' | 'qualify' | 'race';
import {
  PARTS_CATEGORIES,
  drawCategoryGlyph,
  type PartsCategory,
} from '@/ui/modals/partsLineup';
import { PART_NAME_TO_CATEGORY } from '@/ui/modals/partsSubmenu';

export type HomeTab = 'main' | 'garage' | 'bills' | 'newspaper' | 'eat' | 'calendar' | 'mail' | 'outfit';

export interface HomeOverlayOpts {
  /** Canvas internal w / h. */
  GW: number;
  GH: number;
  life: LifeState;
  clock: Clock;
  /** H1284: ctx.carConditions — per-car condition records for GARAGED cars,
   *  so the SPECS X-ray inspection can tint a non-active car's internals.
   *  Optional; absent (older callers) falls back to a clean green X-ray. */
  carConditions?: Record<string, import('@/save/carCondition').CarConditionData>;
  /** Currently-open tab. 'main' shows the tab picker; others dispatch
   *  to drawBillsTab / drawGarageTab / drawCalendarTab / drawEatTab /
   *  drawMailTab / drawNewspaperTab in render() below. */
  tab: HomeTab;
  /** H1112: index of the controller-focused hub button (into
   *  layoutMainButtons). Only meaningful on the 'main' tab. */
  focusIdx?: number;
  /** H1112: draw the focus ring (true only when a gamepad is driving the
   *  menu, so mouse/touch players don't see a stray cursor). */
  showFocus?: boolean;
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
  /** H1030: start a street race — close the home overlay + switchMap to the
   *  track (which auto-starts the staging countdown). mapId = dragstrip / circle. */
  startRace?(mapId: string): void;
  /** H1076: open the mail-order PARTS CATALOG (autoParts overlay in
   *  mail mode). Optional until the gameLoop dep lands. */
  openCatalog?(): void;
}

interface ButtonRect {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  /** H1030: 'race' is a pseudo-action (opens the race-picker modal), not a
   *  tab. H1076: 'catalog' likewise opens the mail-order parts overlay. */
  tab: HomeTab | 'close' | 'race' | 'catalog';
  enabled: boolean;
}

const BTN_W = 130;
const BTN_H = 44;
const BTN_GAP = 10;

/** Lays out the 6 tab buttons + the close button. Returns ButtonRects
 *  in canvas-space coords (origin at top-left). Shared between draw,
 *  the click handler, AND the H1112 controller focus cursor so the
 *  cursor lands on exactly the same geometry a tap would hit. */
export function layoutMainButtons(GW: number, GH: number): ButtonRect[] {
  const cx = GW / 2;
  // 3 cols × 2 rows centered around mid-screen.
  const totalW = BTN_W * 3 + BTN_GAP * 2;
  const totalH = BTN_H * 2 + BTN_GAP;
  const x0 = cx - totalW / 2;
  // H1069: clamp the grid+RACE block ABOVE the sleep row. On the PC
  // HUD canvas (fixed 427px logical height) the centered layout put
  // the 🏁 RACE pill at y 296-336 while the full-width SLEEP/RELAX
  // row (GH-130 = 297, drawn AFTER this grid and hit-tested FIRST)
  // painted straight over it — RACE was invisible AND unclickable on
  // PC (user report). Mobile portrait (~800px tall) never overlapped,
  // which is why phones showed it. Geometry clamp, not a platform
  // gate — mobile landscape had the same collision.
  const sleepY = GH - 130; // must match drawSleepButtons
  const RACE_H = 40, RACE_GAP = 14, MARGIN = 6;
  let y0 = GH / 2 - totalH / 2 + 20;
  const overflow = (y0 + totalH + RACE_GAP + RACE_H) - (sleepY - MARGIN);
  if (overflow > 0) y0 -= overflow;
  // H1247: a PIT BOX is not a house. Bills, the newspaper, meals, mail,
  // clothes, mail-order and sleeping all belong at home; what you can do in a
  // pit garage is work on the car and go racing. Same component, smaller menu.
  if (atTrackPit()) {
    const pitW = 200, pitH = 46, pitGap = 12;
    const py0 = GH / 2 - (pitH * 2 + pitGap) / 2;
    return [
      { x: cx - pitW / 2, y: py0, w: pitW, h: pitH, label: '🔧 GARAGE', tab: 'garage', enabled: true },
      { x: cx - pitW / 2, y: py0 + pitH + pitGap, w: pitW, h: pitH, label: '🏁 RACE', tab: 'race', enabled: true },
      { x: cx - 50, y: GH - 70, w: 100, h: 36, label: 'EXIT (H)', tab: 'close', enabled: true },
    ];
  }
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
  // H1030/H1075/H1076: the action row below the grid — RACE (picker
  // modal), OUTFIT (avatar tab), CATALOG (mail-order parts). The
  // H1069 clamp above guarantees the row clears the SLEEP strip.
  const actY = y0 + totalH + 14;
  out.push({ x: cx - 152, y: actY, w: 96, h: 40, label: '🏁 RACE',    tab: 'race',    enabled: true });
  out.push({ x: cx - 48,  y: actY, w: 96, h: 40, label: '👕 OUTFIT',  tab: 'outfit',  enabled: true });
  out.push({ x: cx + 56,  y: actY, w: 96, h: 40, label: '📖 CATALOG', tab: 'catalog', enabled: true });
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

/** H1149: geometry for the RELAX | SLEEP row. ALWAYS two 8-hour-block
 *  advances (no special "End day" single button) — shared by
 *  drawSleepButtons (paint + the _sleepBtns tap cache) and
 *  layoutFocusButtons (the controller focus cursor) so the focus ring
 *  lands on exactly what a tap hits. Must match drawSleepButtons. */
export function layoutSleepButtons(
  GW: number, GH: number,
): Array<{ x: number; y: number; w: number; h: number; action: 'relax' | 'sleep' }> {
  const sleepY = GH - 130;
  const halfW = (GW - 28) / 2;
  return [
    { x: 12, y: sleepY, w: halfW, h: 32, action: 'relax' },
    { x: 14 + halfW, y: sleepY, w: halfW, h: 32, action: 'sleep' },
  ];
}

/** H1149: the full controller-focus list on the main hub — the grid +
 *  action buttons (layoutMainButtons) PLUS the RELAX/SLEEP row, which the
 *  D-pad cursor previously skipped. Geometry-only (FocusRect); activation
 *  reuses handleHomeOverlayClick at the focused rect's center, which
 *  already routes sleep/relax taps through the _sleepBtns hit-test. */
export function layoutFocusButtons(GW: number, GH: number): FocusRect[] {
  // H1247: the pit hub has no RELAX/SLEEP row, so the pad cursor must not
  // include it — an invisible focus stop is a dead end.
  return atTrackPit()
    ? layoutMainButtons(GW, GH)
    : [...layoutMainButtons(GW, GH), ...layoutSleepButtons(GW, GH)];
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
  // H780: + GT2 grid backdrop overlay so the home tabs share the
  // same blueprint-grid surface as the dealer/garage screens.
  ctx.fillStyle = 'rgba(28, 28, 28, 0.92)';
  ctx.fillRect(0, 0, GW, GH);
  drawGt2Backdrop(ctx, GW, GH);

  // H574: rich header. Main-tab header gets full daily-status
  // summary (portrait, health bar, bills countdown, debt total,
  // rep bars); sub-tab header collapses to a compact one-row money
  // + time-slot indicator so the tab body has more vertical space.
  // 1:1 with monolith L47215-L47283.
  if (tab === 'main') {
    drawRichHeader(ctx, life, clock, GW, GH);
  } else {
    drawCompactHeader(ctx, life, clock, GW, GH);
  }

  if (tab === 'main') {
    drawMainButtons(ctx, GW, GH, life, clock);
    // H214: SLEEP / RELAX buttons. Side-by-side mid-day, single
    // full-width SLEEP when all slots used (the only way to roll
    // the day). Positioned below the main tab grid + above the
    // CLOSE button. Drawn AFTER drawMainButtons so its taps don't
    // get eaten by the grid behind it.
    // H1247: you do not sleep in a pit box. Hidden at a track — and the tap
    // cache drawSleepButtons stamps is cleared, or the last CITY rects would
    // stay live and a tap in that band would still roll the day.
    if (atTrackPit()) {
      (life as { _sleepBtns?: unknown })._sleepBtns = [];
    } else {
      drawSleepButtons(ctx, GW, GH, life);
    }
    // H1112: controller focus ring on the highlighted hub button. Drawn
    // on top of the grid + sleep buttons. Suppressed while the race
    // picker is up (that modal owns focus) and when no pad is driving.
    if (opts.showFocus && !life._racePickerOpen) {
      const btns = layoutFocusButtons(GW, GH);
      const fi = opts.focusIdx ?? 0;
      if (fi >= 0 && fi < btns.length) drawFocusRing(ctx, btns[fi]);
    }
    // H1030: race-picker modal on top of the main tab.
    if (life._racePickerOpen) drawRacePickerModal(ctx, GW, GH, life, clock);
  } else if (tab === 'bills') {
    drawBillsTab(ctx, GW, GH, life, clock);
    // H569: bank loan offer modal sits on top of the bills tab when
    // active. 1:1 with monolith L47571 paint order (drawBankLoanOffer
    // runs after drawHomeBills).
    if (life.bankLoanOffer) {
      drawBankLoanOffer(ctx, life, GW, GH);
    }
  } else if (tab === 'garage') {
    drawGarageTab(ctx, GW, GH, life, opts.carConditions);
    // H564: sell-confirm modal sits on top of the garage tab body
    // when active. Drawn last so the YES/CANCEL buttons paint over
    // any garage row underneath. 1:1 with monolith L47596 paint
    // order (drawSellConfirm runs after drawHomeGarage).
    if (life._sellConfirm) {
      drawSellConfirm(ctx, life, GW, GH);
    }
    // H1296: LIST AD confirmation — same paint order as sell-confirm.
    if (life._listConfirm) {
      drawListConfirm(ctx, life, GW, GH);
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
  } else if (tab === 'outfit') {
    drawOutfitTab(ctx, GW, GH, life);
  } else if (tab === 'eat') {
    drawEatTab(ctx, GW, GH, life);
  } else if (tab === 'mail') {
    drawMailTab(ctx, GW, GH, life, clock);
  } else if (tab === 'newspaper') {
    drawNewspaperTab(ctx, GW, GH, life, clock);
    // H189: pin-picker modal layered ON TOP of the newspaper list
    // when a row is tapped (life.pinPicker set). 1:1 with monolith
    // L47565 paint order. The picker covers the whole canvas at
    // 92% alpha; taps route to handlePinPickerClick (handler wiring
    // lives in handleHomeOverlayClick below).
    if (life.pinPicker) {
      drawPinPicker(ctx, { state: life.pinPicker, GW, GH, life });
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
  ctx.fillStyle = GT2_COLORS.active;
  ctx.font = 'bold 16px monospace';
  ctx.fillText('BILLS & DEBTS', GW / 2, yy);
  yy += 22;
  ctx.fillStyle = GT2_COLORS.text;
  ctx.font = 'bold 13px monospace';
  ctx.fillText(`$${total.toLocaleString()}/mo total`, GW / 2, yy);
  yy += 16;
  if (isAnyBillPastDue(life)) {
    ctx.fillStyle = GT2_COLORS.amberDark;
    ctx.font = 'bold 11px monospace';
    ctx.fillText(`${life.missedPayments} missed payment${(life.missedPayments || 0) === 1 ? '' : 's'}`, GW / 2, yy);
  } else if (total > 0) {
    const days = daysUntilNextBilling(clock.day);
    const color = days <= 1 ? GT2_COLORS.amberDark : days <= 3 ? GT2_COLORS.active : GT2_COLORS.textMute;
    ctx.fillStyle = color;
    ctx.font = '10px monospace';
    ctx.fillText(`Next billing in ${days} day${days === 1 ? '' : 's'}`, GW / 2, yy);
  } else {
    ctx.fillStyle = GT2_COLORS.active;
    ctx.font = '10px monospace';
    ctx.fillText('No debts — free and clear.', GW / 2, yy);
  }
  yy += sectionPad + 12;

  // Housing section. No PAY button — rent/mortgage prepay is a
  // different mechanic; the monolith's bills-due popup handles housing
  // separately.
  const housingCost = monthlyHousing(life);
  yy = drawBillsSection(ctx, GW, yy, 'HOUSING', GT2_COLORS.amber, housingCost, life.mortgageBalance, [
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
  yy = drawBillsSection(ctx, GW, yy, 'CARS', GT2_COLORS.amber, carMonthly, carOwed,
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

  // H1072: INSURANCE section — auto-paid with the monthly bills, so
  // no PAY buttons; aggregate rows only (the tab has no scrolling,
  // per-car rows would overflow a big fleet). Surcharge row appears
  // only once the player has tickets on record.
  const insBase = insuranceFleetPremium(life);
  const insTotal = monthlyInsurance(life);
  const insSurcharge = insTotal - insBase;
  const nCars = life.ownedCars.length;
  const tix = life.ticketsTotal || 0;
  const insRows: BillRow[] = insTotal > 0
    ? [{
        label: `Auto policy (${nCars} car${nCars === 1 ? '' : 's'})`,
        monthly: insBase,
        detail: 'Base + 0.5% of fleet value / mo',
      }]
    : [];
  if (insSurcharge > 0) {
    insRows.push({
      label: 'Ticket surcharge',
      monthly: insSurcharge,
      detail: `${tix} ticket${tix === 1 ? '' : 's'} on record (+15% each)`,
    });
  }
  yy = drawBillsSection(ctx, GW, yy, 'INSURANCE', GT2_COLORS.amber, insTotal, 0, insRows, life.money, null);

  // Bank section.
  const bankMonthly = monthlyBankPayments(life);
  const bankOwed = totalBankLoansOwed(life);
  yy = drawBillsSection(ctx, GW, yy, 'BANK', GT2_COLORS.active, bankMonthly, bankOwed,
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
    ctx.fillStyle = 'rgba(255, 122, 24, 0.20)';
    ctx.fillRect(glX, glY, glW, glH);
    ctx.strokeStyle = GT2_COLORS.active;
    ctx.lineWidth = 1;
    ctx.strokeRect(glX, glY, glW, glH);
    ctx.fillStyle = GT2_COLORS.active;
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('GET BANK LOAN', GW / 2, glY + 18);
    life._billsBankLoanBtnRect = { x: glX, y: glY, w: glW, h: glH };
  } else {
    life._billsBankLoanBtnRect = null;
  }

  ctx.textAlign = 'left';

  // Back button.
  const bx = GW / 2 - 60;
  const by = GH - 80;
  ctx.fillStyle = 'rgba(255, 122, 24, 0.55)';
  ctx.fillRect(bx, by, 120, 32);
  ctx.strokeStyle = GT2_COLORS.amber;
  ctx.lineWidth = 2;
  ctx.strokeRect(bx, by, 120, 32);
  ctx.fillStyle = GT2_COLORS.text;
  ctx.font = 'bold 13px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('← BACK', GW / 2, by + 21);
}

/** H1075: OUTFIT tab — the modular-avatar wardrobe (BL-6 scaffold).
 *  Shows the player's composited avatar large + one panel per
 *  cosmetic slot (AVATAR_SLOTS single-sources the list). Every slot
 *  reads STOCK until layered art ships; the AvatarSpec on
 *  life.avatar is already persisted, so art lands without touching
 *  saves. NPCs (dialogue portraits, rivals) share the same
 *  compositor, so wardrobe art benefits them for free. */
function drawOutfitTab(
  ctx: CanvasRenderingContext2D,
  GW: number,
  GH: number,
  life: LifeState,
): void {
  ctx.textAlign = 'center';
  ctx.fillStyle = GT2_COLORS.active;
  ctx.font = 'bold 14px monospace';
  ctx.fillText('OUTFIT', GW / 2, 34);
  ctx.fillStyle = GT2_COLORS.textMute;
  ctx.font = '9px monospace';
  ctx.fillText((life.playerName || 'DRIVER').toUpperCase() + ' — street look', GW / 2, 48);

  // The avatar, large, on a charcoal pedestal panel.
  const av = 96;
  const ax = GW / 2 - 170;
  const ay = 70;
  ctx.fillStyle = GT2_COLORS.panel;
  ctx.fillRect(ax - 12, ay - 10, av + 24, av + 44);
  ctx.strokeStyle = '#3a3a3a';
  ctx.lineWidth = 1;
  ctx.strokeRect(ax - 11.5, ay - 9.5, av + 23, av + 43);
  drawAvatar(ctx, {
    gender: life.gender === 'F' ? 'F' : 'M',
    fitness: life.fitness ?? 50,
    skinTone: life.skinTone ?? 1,
    avatar: life.avatar,
  }, ax, ay, av);
  const build = (life.fitness ?? 50) >= 80 ? 'MUSCULAR'
    : (life.fitness ?? 50) < 20 ? 'HEAVYSET' : 'LEAN';
  ctx.fillStyle = GT2_COLORS.amber;
  ctx.font = 'bold 9px monospace';
  ctx.fillText(build + ' BUILD', ax + av / 2, ay + av + 16);
  ctx.fillStyle = GT2_COLORS.textDim;
  ctx.font = '8px monospace';
  ctx.fillText('build follows FITNESS (gym)', ax + av / 2, ay + av + 27);

  // Slot panels — 2×2 grid right of the avatar.
  const sx = GW / 2 - 30;
  const sw = Math.min(150, (GW - sx - 20) / 2 - 8);
  const sh = 58;
  AVATAR_SLOTS.forEach((slot, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = sx + col * (sw + 10);
    const y = 70 + row * (sh + 10);
    ctx.fillStyle = GT2_COLORS.panel;
    ctx.fillRect(x, y, sw, sh);
    ctx.strokeStyle = '#3a3a3a';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, sw - 1, sh - 1);
    ctx.textAlign = 'left';
    ctx.fillStyle = GT2_COLORS.amber;
    ctx.font = 'bold 9px monospace';
    ctx.fillText(slot.label, x + 8, y + 14);
    const id = life.avatar?.[slot.key] ?? null;
    ctx.fillStyle = GT2_COLORS.text;
    ctx.font = 'bold 11px monospace';
    ctx.fillText(id ? id.toUpperCase() : 'STOCK', x + 8, y + 32);
    ctx.fillStyle = GT2_COLORS.textDim;
    ctx.font = '8px monospace';
    ctx.fillText('pixel-art sets coming soon', x + 8, y + 46);
    ctx.textAlign = 'center';
  });

  // Back button (generic backRectForTab covers the hit-test).
  const bx2 = GW / 2 - 60;
  const by2 = GH - 80;
  ctx.fillStyle = 'rgba(255, 122, 24, 0.55)';
  ctx.fillRect(bx2, by2, 120, 32);
  ctx.strokeStyle = GT2_COLORS.amber;
  ctx.lineWidth = 2;
  ctx.strokeRect(bx2, by2, 120, 32);
  ctx.fillStyle = GT2_COLORS.text;
  ctx.font = 'bold 13px monospace';
  ctx.fillText('← BACK', GW / 2, by2 + 21);
  ctx.textAlign = 'left';
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
  action: 'getIn' | 'specs' | 'repairs' | 'parts' | 'sell' | 'list' | 'tune' | 'inspect' | 'toolbox';
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
  h += 4;                                        // gap before buttons
  h += 26 + 4 + 26 + 4 + 26 + 4 + 26 + 4 + 26;  // 5 rows of 26px buttons w/ 4px gaps (H944 added TOOLBOX)
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

/** H1296: LIST AD confirmation state — putting a car in the paper now
 *  asks first (user report). Same cached-button-Y pattern as
 *  SellConfirmState. */
export interface ListConfirmState {
  carId: string;
  _yesY?: number;
  _cancelY?: number;
}

/** H1296: the LIST AD confirm modal. Shows the asking price the ad
 *  will carry and where the offers will arrive, then LIST IT / CANCEL. */
export function drawListConfirm(
  ctx: CanvasRenderingContext2D,
  life: LifeState,
  GW: number,
  GH: number,
): void {
  const lc = life._listConfirm as ListConfirmState | undefined | null;
  if (!lc) return;
  const car = CAR_CATALOG[lc.carId];
  if (!car) { life._listConfirm = null; return; }
  const value = getCarValue(life, lc.carId, life.ownedCars[0]);
  const askPrice = Math.round(value * 0.9);

  ctx.fillStyle = 'rgba(0,0,0,0.85)';
  ctx.fillRect(0, 0, GW, GH);
  ctx.textAlign = 'center';
  const popW = GW - 40;
  const popX = 20;
  let yy = Math.floor(GH * 0.24);

  ctx.fillStyle = GT2_COLORS.amber;
  ctx.font = 'bold 14px monospace';
  ctx.fillText('📰 LIST IN NEWSPAPER?', GW / 2, yy);
  yy += 20;
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 11px monospace';
  ctx.fillText(car.name, GW / 2, yy);
  yy += 16;
  ctx.fillStyle = '#0f0';
  ctx.font = 'bold 12px monospace';
  ctx.fillText('Asking $' + askPrice.toLocaleString(), GW / 2, yy);
  yy += 14;
  ctx.fillStyle = '#aaa';
  ctx.font = '9px monospace';
  ctx.fillText('(90% of fair value)', GW / 2, yy);
  yy += 14;
  ctx.fillText('Offers arrive in the MAIL — accept or decline there.', GW / 2, yy);
  yy += 16;

  const btnW = popW - 80;
  const btnX = popX + 40;
  lc._yesY = yy + 8;
  ctx.fillStyle = 'rgba(247,166,35,0.18)';
  ctx.fillRect(btnX, lc._yesY, btnW, 28);
  ctx.strokeStyle = GT2_COLORS.amber;
  ctx.strokeRect(btnX, lc._yesY, btnW, 28);
  ctx.fillStyle = GT2_COLORS.amber;
  ctx.font = 'bold 11px monospace';
  ctx.fillText('YES — LIST IT', GW / 2, lc._yesY + 18);
  yy += 36;
  lc._cancelY = yy + 4;
  ctx.fillStyle = 'rgba(255,255,255,0.1)';
  ctx.fillRect(btnX, lc._cancelY, btnW, 28);
  ctx.strokeStyle = '#aaa';
  ctx.strokeRect(btnX, lc._cancelY, btnW, 28);
  ctx.fillStyle = '#aaa';
  ctx.font = 'bold 11px monospace';
  ctx.fillText('CANCEL', GW / 2, lc._cancelY + 18);
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
  // H1290: can't hand over a car that's physically at the shop.
  const shopJob = carAtShop(life, carId);
  if (shopJob) {
    showNotif(life, `It's at the shop until Day ${shopJob.readyDay} — can't sell it now.`, 160);
    return;
  }
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
  // H1289: actually cancel the car's in-flight jobs + garage parts — the
  // sell-confirm '⚠ N in-flight jobs will be cancelled' warning promised
  // this but nothing filtered the queue, so queued upgrades resolved
  // against sold cars (and delivered kits would pile up for them).
  life.pendingParts = (life.pendingParts ?? []).filter((p) => p.carId !== carId);
  life.ownedParts = (life.ownedParts ?? []).filter((p) => p.carId !== carId);
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

/** H1296: why this car can't be listed right now, or null when it can.
 *  Shared by the LIST AD tap (blocks before opening the confirm) and
 *  listCarInNewspaper itself (defense in depth). */
export function canListCarInNewspaper(life: LifeState, carId: string): string | null {
  if (life.ownedCars.length <= 1) return "Can't sell your only car!";
  const ads = (life.carAds as Array<{ carId?: string }> | undefined) ?? [];
  if (ads.find((a) => a?.carId === carId)) return 'Already listed!';
  // H1290: don't list a car buyers can't come see.
  const shopJob = carAtShop(life, carId);
  if (shopJob) return `It's at the shop until Day ${shopJob.readyDay} — list it when it's back.`;
  return null;
}

/** Create a newspaper ad for the given car. Shape matches the
 *  monolith's `{carId, askPrice, daysListed, offers}` at L43741.
 *  The daily generator (generateCarAdOffers) fills the ad's offers
 *  on weekday rollovers, mirrored into the MAIL tab where the player
 *  accepts or declines them (H1296). */
export function listCarInNewspaper(life: LifeState, carId: string): void {
  const block = canListCarInNewspaper(life, carId);
  if (block) {
    showNotif(life, block, 140);
    return;
  }
  const ads = (life.carAds as Array<{ carId?: string }> | undefined) ?? [];
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
function drawGarageTab(
  ctx: CanvasRenderingContext2D,
  GW: number,
  GH: number,
  life: LifeState,
  carConds?: Record<string, import('@/save/carCondition').CarConditionData>,
): void {
  // H162: SPECS sub-view dispatch. When the player tapped SPECS on a
  // garage row, _garageView flips to 'specs' and _garageSpecsCarId
  // holds the car to inspect; the full tab area takes over with the
  // fleet-normalized gauge view. Back button there flips back to
  // 'list' to return here. List view stays the default.
  const rawView = life._garageView;
  const garageView: 'specs' | 'parts' | 'repairs' | 'tune' | 'toolbox' | 'list' =
    rawView === 'specs' || rawView === 'parts' || rawView === 'repairs' || rawView === 'tune' || rawView === 'toolbox' ? rawView : 'list';
  if (garageView === 'tune') {
    const cid = ((life as { _garageTuneCarId?: string })._garageTuneCarId) ?? life.ownedCars[0];
    const tcar = cid ? CAR_CATALOG[cid] : undefined;
    if (tcar) {
      drawGarageTuneView(ctx, GW, GH, life, tcar);
      return;
    }
    life._garageView = 'list';
  }
  if (garageView === 'specs') {
    const cid = (life._garageSpecsCarId as string | undefined) ?? life.ownedCars[0];
    const car = cid ? CAR_CATALOG[cid] : undefined;
    if (car) {
      drawGarageSpecsView(ctx, GW, GH, life, car, carConds);
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
  if (garageView === 'toolbox') {
    drawGarageToolboxView(ctx, GW, GH, life);
    return;
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
      ctx.fillText(`$${loan.monthlyPayment} / mo · ${loan.monthsRemaining}mo left`, spriteX + spriteW + 12, yy + 47);
    } else if (car.price > 0) {
      ctx.fillStyle = GT2_COLORS.amberDark;
      ctx.font = '9px monospace';
      ctx.fillText('OWNED OUTRIGHT', spriteX + spriteW + 12, yy + 47);
    }

    // Price (right-aligned).
    ctx.textAlign = 'right';
    ctx.fillStyle = GT2_COLORS.text;
    ctx.font = 'bold 11px monospace';
    ctx.fillText(`$${car.price.toLocaleString()}`, rowX + rowW - 12, yy + 18);
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
      // H1295: space before the unit — '282.8kkm' read as a unit typo.
      const _odoStr = _dist >= 1000
        ? `${(_dist / 1000).toFixed(1)}k ${_suffix}`
        : `${Math.round(_dist)} ${_suffix}`;
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
    ctx.fillText('Total owed: $' + tot.toLocaleString(), px + pw / 2, curY + 8);
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
  // H737: All buttons take the regular amber face per the button-
  // state policy (dark = selected/focused, NOT random emphasis,
  // NOT disabled). The pre-H737 code dimmed disabled buttons to
  // amberDim and brightened "primary" actions (RESUME-when-active,
  // REPAIRS-when-faulted) to active-orange — both were wrong.
  // Disabled state communicates via textDim label only. The
  // `primary` param + `color` param are kept on the signature for
  // call-site stability but no longer drive the paint.
  const drawBtn = (
    bx: number, by: number, bw: number, bh: number,
    label: string, sublabel: string, _color: string,
    action: GarageExpandedBtnRect['action'], enabled: boolean,
    _primary = false,
  ): void => {
    ctx.fillStyle = GT2_COLORS.amber;
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

  // Row 1 — GET IN / RESUME (left) + SPECS (right).
  // H1290: a car on the shop's flatbed isn't in the garage to get into —
  // label flips to AT SHOP (still tappable; the tap explains the ETA).
  const atShopJob = carAtShop(life, car.id);
  drawBtn(
    leftX, curY, halfW, btnH,
    atShopJob ? '🚚 AT SHOP' : isActive ? '🚗 RESUME' : '🚗 GET IN',
    atShopJob ? `back Day ${atShopJob.readyDay}` : isActive ? 'Already active' : 'Switch & exit',
    atShopJob ? '#f80' : '#0ff', 'getIn', true,
  );
  drawBtn(rightX, curY, halfW, btnH, '📊 SPECS', 'View stats', '#0ff', 'specs', true);
  curY += btnH + 4;

  // Row 2 — REPAIRS (left) + PARTS (right).
  const repairsLabel = faultCount > 0
    ? ('🔧 REPAIRS (' + faultCount + '!)')
    : '🔧 REPAIRS';
  drawBtn(
    leftX, curY, halfW, btnH,
    repairsLabel, 'Fix issues',
    '#0ff', 'repairs', true,
  );
  drawBtn(rightX, curY, halfW, btnH, '📦 PARTS', 'Buy & install', '#0ff', 'parts', true);
  curY += btnH + 4;

  // Row 3 — UPGRADE (full width). H877: GT2 Stage-tile tuning screen.
  drawBtn(leftX, curY, halfW * 2 + 4, btnH, '⚙ UPGRADE', 'Power & weight tuning', '#0ff', 'tune', true);
  curY += btnH + 4;

  // Row 4 — INSPECT (left) + LIST AD (right). H1299: the visual X-ray
  // inspection (docs/INSPECT_SPEC.md) replaces the H948 paid scan — you
  // look for problems yourself, tool/skill-gated. The paid tier returns
  // at the MECHANIC in slice H-D as a fallible hired-skill roll. Passive
  // mile-reveal stays the free background tier.
  drawBtn(
    leftX, curY, halfW, btnH, '🔍 INSPECT',
    'X-ray check · time slot',
    '#0ff', 'inspect', true,
  );
  const listEnabled = !isOnly && !isLeased && !hasAd;
  const listPrice = Math.round(getCarValue(life, car.id, activeId) * 0.9);
  const listSub = isOnly
    ? 'only car'
    : isLeased ? 'leased' : hasAd ? 'already listed' : '$' + listPrice.toLocaleString();
  drawBtn(rightX, curY, halfW, btnH, '📰 LIST AD', listSub, '#fa0', 'list', listEnabled);
  curY += btnH + 4;

  // Row 5 — TOOLBOX (full width). H944: owned tools / consumables / tires.
  drawBtn(leftX, curY, halfW * 2 + 4, btnH, '🧰 TOOLBOX', 'Tools & supplies', '#0ff', 'toolbox', true);

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
/** H1298 (INSPECT H-A): session state for the visual inspection flow —
 *  transient underscore field on LIFE, design in docs/INSPECT_SPEC.md.
 *  Slice H-A = the user's ENGINE example end-to-end; other components +
 *  daily latches + tools land in H-B/H-C. */
interface InspectState {
  carId: string;
  view: 'overview' | XrayComponentId | 'results';
  /** Flavor-text log for the current focus (last few lines render). */
  lines: string[];
  /** Fault NAMES revealed this session — the results summary. */
  results: string[];
  /** Per-sub session latch — no re-roll by re-tapping. */
  rolled: Record<string, boolean>;
}

interface InspectRect { x: number; y: number; w: number; h: number }
interface InspectRects {
  comps: Array<InspectRect & { comp: XrayComponentId }>;
  band?: InspectRect;
  done?: InspectRect;
  close?: InspectRect;
  backComp?: InspectRect;
  subs: Array<InspectRect & { key: string }>;
}

/** H1299 (INSPECT H-B): per-component focus meta — display label, zoom
 *  factor for the focus view, and the access flavor line printed on entry. */
const INSPECT_COMPONENTS: Record<XrayComponentId, {
  label: string; zoom: number; access: string;
  /** H1300: line used instead when the Two-Post Lift is owned. */
  accessLift?: string;
}> = {
  engine:       { label: 'ENGINE', zoom: 3, access: 'Hard to get a good view underneath without raising the car.',
    accessLift: 'Up on the lift — clear view of the whole bottom end.' },
  transmission: { label: 'TRANSMISSION', zoom: 3, access: 'Most of the box is only reachable from underneath.',
    accessLift: 'On the lift the whole case is at eye level.' },
  driveline:    { label: 'DRIVELINE', zoom: 3, access: 'You peer under the car along the driveline.',
    accessLift: 'The full driveline hangs in front of you on the lift.' },
  cooling:      { label: 'COOLING', zoom: 3, access: 'The core sits right behind the nose — easy to see.' },
  steering:     { label: 'STEERING', zoom: 3, access: 'You turn the wheel lock to lock and watch the linkages.',
    accessLift: 'Wheels hanging free on the lift — you can rock every joint.' },
  suspension:   { label: 'SUSPENSION', zoom: 2.6, access: 'You slide under on the jack — a cramped view without a lift.',
    accessLift: 'On the lift, every arm and bushing is right there.' },
  wheels:       { label: 'WHEELS & BRAKES', zoom: 2.4, access: 'You crouch at each corner and check the rubber.',
    accessLift: 'Wheels dangle at chest height — easy look at everything.' },
  body:         { label: 'BODY', zoom: 1.4, access: 'You walk a slow lap around the car.',
    accessLift: 'You walk a lap, then run the lift up and check underneath.' },
};

// H1304: LIFT_VISIBLE_TD_IDS, InspectSub and the INSPECT_SUBS map moved to
// src/sim/inspectComponents.ts — the SIM side needs the same map to decide
// whether a component has earned its X-ray color. One authority, no drift.

// H1301: the per-car per-day latch moved to inspectOwnCar.ts
// (inspectDailyLatchStore) so the garage flow and the shop inspections
// share one store — imported above under the old local name.

/** Append a flavor line, keeping the visible log short. */
function inspectLine(ist: InspectState, line: string): void {
  ist.lines.push(line);
  while (ist.lines.length > 4) ist.lines.shift();
}

/** H1298: the INSPECT body — takes over the SPECS view below the header
 *  while an inspection session is live. Three views: overview (full X-ray,
 *  tap the highlighted component), engine focus (zoomed X-ray + flavor log
 *  + sub-component buttons), results (the exit summary). Rects re-stashed
 *  every frame on life._inspectRects. */
function drawGarageInspectView(
  ctx: CanvasRenderingContext2D,
  GW: number,
  GH: number,
  life: LifeState,
  car: CatalogCar,
  cond: XrayCondition,
  dmg: BodyDamage | undefined,
  ist: InspectState,
): void {
  const topY = 120;
  const rects: InspectRects = { comps: [], subs: [] };
  (life as { _inspectRects?: InspectRects })._inspectRects = rects;
  ctx.textAlign = 'center';

  if (ist.view === 'results') {
    ctx.fillStyle = GT2_COLORS.amber;
    ctx.font = 'bold 14px monospace';
    ctx.fillText('INSPECTION RESULTS', GW / 2, topY + 70);
    let yy = topY + 96;
    if (ist.results.length === 0) {
      ctx.fillStyle = GT2_COLORS.textMute;
      ctx.font = '10px monospace';
      ctx.fillText('No new issues found today.', GW / 2, yy);
      yy += 16;
    } else {
      ctx.font = 'bold 10px monospace';
      for (const name of ist.results) {
        ctx.fillStyle = GT2_COLORS.active;
        ctx.fillText('• ' + name, GW / 2, yy);
        yy += 14;
      }
      ctx.fillStyle = GT2_COLORS.textMute;
      ctx.font = '8px monospace';
      ctx.fillText('Now listed in REPAIRS.', GW / 2, yy + 4);
      yy += 18;
    }
    const cw = 140;
    rects.close = { x: GW / 2 - cw / 2, y: yy + 12, w: cw, h: 28 };
    ctx.fillStyle = GT2_COLORS.amber;
    fillRoundRectHome(ctx, rects.close.x, rects.close.y, cw, 28, 5);
    ctx.fillStyle = GT2_COLORS.bgDeep;
    ctx.font = 'bold 11px monospace';
    ctx.fillText('CLOSE', GW / 2, rects.close.y + 18);
    ctx.textAlign = 'left';
    return;
  }

  if (ist.view === 'overview') {
    ctx.fillStyle = GT2_COLORS.textMute;
    ctx.font = '9px monospace';
    ctx.fillText('INSPECTION — tap a component', GW / 2, topY + 54);
    const bandTop = topY + 62;
    const bandBot = GH - 150;
    const bx = 12;
    const bw = GW - 24;
    const bh = Math.max(80, bandBot - bandTop);
    drawCarSpritePreview(ctx, bx, bandTop, bw, bh, car, cond, dmg);
    rects.band = { x: bx, y: bandTop, w: bw, h: bh };
    // H1299: every component's car-local boxes through the SAME transform
    // the preview used — hit rects can't drift from the ink. Sorted
    // smallest-first so thin parts (bars, rods) win overlaps against the
    // big blocks they cross.
    const t = carPreviewTransform(bx, bandTop, bw, bh, car);
    const labeled = new Set<XrayComponentId>();
    for (const b of componentBoxesFor(car)) {
      const r = {
        x: t.cx + (b.x - b.hw) * t.scale,
        y: t.cy + (b.y - b.hh) * t.scale,
        w: b.hw * 2 * t.scale,
        h: b.hh * 2 * t.scale,
        comp: b.comp,
      };
      rects.comps.push(r);
      ctx.strokeStyle = 'rgba(0,255,255,0.7)';
      ctx.lineWidth = 1;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      if (!labeled.has(b.comp)) {
        labeled.add(b.comp);
        ctx.fillStyle = 'rgba(0,255,255,0.9)';
        ctx.font = 'bold 7px monospace';
        ctx.fillText(INSPECT_COMPONENTS[b.comp].label, r.x + r.w / 2, r.y - 3);
      }
    }
    rects.comps.sort((a, b2) => a.w * a.h - b2.w * b2.h);
    ctx.fillStyle = GT2_COLORS.textDim;
    ctx.font = '8px monospace';
    ctx.fillText('Tap anywhere else on the car for BODY.', GW / 2, bandBot + 14);
    const dw = 140;
    rects.done = { x: GW / 2 - dw / 2, y: GH - 124, w: dw, h: 26 };
    ctx.fillStyle = GT2_COLORS.amber;
    fillRoundRectHome(ctx, rects.done.x, rects.done.y, dw, 26, 5);
    ctx.fillStyle = GT2_COLORS.bgDeep;
    ctx.font = 'bold 10px monospace';
    ctx.fillText('FINISH INSPECTION', GW / 2, rects.done.y + 17);
    ctx.textAlign = 'left';
    return;
  }

  // A component focus view — the user's ENGINE example, generalized (H1299).
  const compId = ist.view as XrayComponentId;
  const meta = INSPECT_COMPONENTS[compId] ?? INSPECT_COMPONENTS.body;
  const subsDef = INSPECT_SUBS[compId] ?? [];
  ctx.fillStyle = 'rgba(0,255,255,0.9)';
  ctx.font = 'bold 10px monospace';
  ctx.fillText(meta.label + ' — inspecting', GW / 2, topY + 54);
  const bandTop = topY + 62;
  const bandBot = GH - 108 - (subsDef.length + 1) * 26 - ist.lines.length * 11;
  const bh = Math.max(70, bandBot - bandTop);
  const focusBox = componentBoxesFor(car).find((b) => b.comp === compId);
  const focus = compId === 'body' || !focusBox ? { x: 0, y: 0 } : { x: focusBox.x, y: focusBox.y };
  drawCarSpriteFocus(ctx, 12, bandTop, GW - 24, bh, car, cond, dmg, focus, meta.zoom);
  ctx.strokeStyle = '#3a3a3a';
  ctx.lineWidth = 1;
  ctx.strokeRect(12.5, bandTop + 0.5, GW - 25, bh - 1);
  // Flavor log.
  let ly = bandTop + bh + 12;
  ctx.font = '9px monospace';
  for (const line of ist.lines) {
    ctx.fillStyle = GT2_COLORS.textMute;
    ctx.fillText(line, GW / 2, ly);
    ly += 11;
  }
  // Sub-component buttons (seller-menu pattern: one list, drawn + hit-tested
  // from the same rects).
  let by = ly + 6;
  for (const sub of subsDef) {
    const r: InspectRect & { key: string } = { x: 40, y: by, w: GW - 80, h: 22, key: sub.key };
    rects.subs.push(r);
    const done = !!ist.rolled[sub.key];
    ctx.fillStyle = done ? 'rgba(255,255,255,0.05)' : 'rgba(247,166,35,0.14)';
    fillRoundRectHome(ctx, r.x, r.y, r.w, r.h, 4);
    ctx.strokeStyle = done ? '#444' : GT2_COLORS.amberDark;
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
    ctx.fillStyle = done ? GT2_COLORS.textDim : GT2_COLORS.amber;
    ctx.font = 'bold 9px monospace';
    ctx.fillText((done ? '✓ ' : '') + sub.label + (sub.underside ? ' (UNDERSIDE)' : ''), GW / 2, r.y + 15);
    by += 26;
  }
  rects.backComp = { x: 40, y: by, w: GW - 80, h: 22 };
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  fillRoundRectHome(ctx, rects.backComp.x, rects.backComp.y, rects.backComp.w, 22, 4);
  ctx.fillStyle = GT2_COLORS.textMute;
  ctx.font = 'bold 9px monospace';
  ctx.fillText('← BACK TO CAR', GW / 2, rects.backComp.y + 15);
  ctx.textAlign = 'left';
}

function drawGarageSpecsView(
  ctx: CanvasRenderingContext2D,
  GW: number,
  GH: number,
  life: LifeState,
  car: CatalogCar,
  carConds?: Record<string, import('@/save/carCondition').CarConditionData>,
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

  // H880: drivetrain layout glyph (FF/FR/MR/RR/4WD) in the header corner.
  drawDrivetrainGlyph(ctx, 16, topY - 12, 40, 46, car.drv);
  // H881: top-down car sprite in the opposite header corner.
  drawCarSpritePreview(ctx, GW - 132, topY - 14, 116, 50, car);

  // H1284: X-RAY inspection toggle (user: "this should be available when
  // inspecting the car (especially in a garage)"). The chip sits on the
  // header preview box; ON swaps the spec cell grid below for one big
  // condition-tinted X-ray of this car — the same internals the in-world
  // X-ray draws, using THIS car's stored condition (live LIFE stats for
  // the active car, its carConditions record when garaged).
  const xrayOn = (life as { _garageSpecsXray?: boolean })._garageSpecsXray === true;
  {
    const xw = 64;
    const xh = 15;
    const xx = GW - 132 + (116 - xw) / 2;
    const xy = topY + 38;
    ctx.fillStyle = xrayOn ? 'rgba(0,255,255,0.16)' : 'rgba(13,13,13,0.85)';
    ctx.fillRect(xx, xy, xw, xh);
    ctx.strokeStyle = xrayOn ? 'rgba(0,255,255,0.8)' : '#3a3a3a';
    ctx.lineWidth = 1;
    ctx.strokeRect(xx + 0.5, xy + 0.5, xw - 1, xh - 1);
    ctx.fillStyle = xrayOn ? 'rgba(150,255,255,1)' : GT2_COLORS.textMute;
    ctx.font = 'bold 8px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(xrayOn ? 'X-RAY ON' : 'X-RAY', xx + xw / 2, xy + 11);
    // Padded hit rect (H1266/H1281 lesson: chip-sized canvas targets need
    // slack, and the pad A-press activates through this same rect).
    (life as { _garageSpecsXrayRect?: { x: number; y: number; w: number; h: number } })
      ._garageSpecsXrayRect = { x: xx - 10, y: xy - 8, w: xw + 20, h: xh + 16 };
  }

  // H1298: INSPECT chip below the X-RAY chip — starts the visual
  // inspection flow (docs/INSPECT_SPEC.md, slice H-A: ENGINE only).
  // Active car only for now; costs a time slot (user-approved).
  {
    const iw = 64;
    const ih = 15;
    const ix = GW - 132 + (116 - iw) / 2;
    const iy = topY + 58;
    const activeCar = car.id === life.ownedCars[0];
    const on = !!(life as { _inspectState?: InspectState })._inspectState;
    ctx.fillStyle = on ? 'rgba(247,166,35,0.20)' : 'rgba(13,13,13,0.85)';
    ctx.fillRect(ix, iy, iw, ih);
    ctx.strokeStyle = on ? GT2_COLORS.amber : activeCar ? GT2_COLORS.amberDark : '#3a3a3a';
    ctx.lineWidth = 1;
    ctx.strokeRect(ix + 0.5, iy + 0.5, iw - 1, ih - 1);
    ctx.fillStyle = on ? GT2_COLORS.amber : activeCar ? GT2_COLORS.amber : GT2_COLORS.textDim;
    ctx.font = 'bold 8px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('INSPECT', ix + iw / 2, iy + 11);
    (life as { _garageSpecsInspectRect?: { x: number; y: number; w: number; h: number } })
      ._garageSpecsInspectRect = { x: ix - 10, y: iy - 8, w: iw + 20, h: ih + 16 };
  }

  // H1298: while an inspection session is live for THIS car, the flow
  // takes over the body (active car only, so live LIFE stats are right).
  {
    const ist = (life as { _inspectState?: InspectState })._inspectState;
    if (ist && ist.carId === car.id) {
      const cond = buildXrayCondition(life.engine, life.tires, life.carHP, life.faults as unknown[]);
      // H1302/H1304: gray-until-ACCURATELY-inspected — one shared helper so
      // this view and the plain SPECS X-ray below can't tell different
      // stories. Faults hint in prose, never in paint (user rule).
      cond.gray = buildInspectGray(life, car.id, life._hiddenFaults, inspectToolsFor(life));
      const dmg = life.bodyDamage as BodyDamage | undefined;
      drawGarageInspectView(ctx, GW, GH, life, car, cond, dmg, ist);
      drawSpecsBackButton(ctx, GW, GH, life);
      return;
    }
  }

  if (xrayOn) {
    // Condition source: the ACTIVE car's stats live on LIFE; a garaged
    // car's ride its carConditions record. life.faults / record.faults
    // hold only DIAGNOSED faults (DIAGNOSE pushes into them), so the
    // hidden-fault economy survives this screen untouched.
    const activeId = life.ownedCars[0];
    let cond: XrayCondition;
    let dmg: BodyDamage | undefined;
    let hidden: unknown[] | undefined;
    if (car.id === activeId) {
      cond = buildXrayCondition(life.engine, life.tires, life.carHP, life.faults as unknown[]);
      dmg = life.bodyDamage as BodyDamage | undefined;
      hidden = life._hiddenFaults as unknown[] | undefined;
    } else {
      const rec = carConds?.[car.id];
      cond = buildXrayCondition(
        rec?.engine ?? 100, rec?.tires ?? 100, rec?.carHP ?? 100,
        (rec?.faults ?? []) as unknown[],
      );
      dmg = rec?.bodyDamage as BodyDamage | undefined;
      hidden = rec?.hiddenFaults;
    }
    // H1304 (user bug): this branch never applied the gray override, so
    // closing an INSPECT session dumped the player straight from the honest
    // gray X-ray into a fully-colored one — "I inspected one component ...
    // the game displayed all worn parts after leaving Inspection."
    cond.gray = buildInspectGray(life, car.id, hidden, inspectToolsFor(life));
    const bandTop = topY + 60;
    const bandBot = GH - 118;
    drawCarSpritePreview(ctx, 12, bandTop, GW - 24, Math.max(80, bandBot - bandTop), car, cond, dmg);
    ctx.fillStyle = GT2_COLORS.textMute;
    ctx.font = '8px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('CONDITION: GREEN GOOD · ORANGE WORN · RED DAMAGED', GW / 2, bandBot + 14);
    // H1304: DIAGNOSE was retired in H1299 — INSPECT is the reveal now.
    ctx.fillText('GRAY = NOT YET INSPECTED — RUN AN INSPECTION', GW / 2, bandBot + 26);
    drawSpecsBackButton(ctx, GW, GH, life);
    return;
  }

  // H875: show the car as it actually performs at its current upgrade stages,
  // so the PERFORMANCE stats reflect a built car. Fleet percentile still
  // compares against the (stock) world fleet, so an upgraded car correctly
  // ranks higher than its showroom self. (H878: tuning moved to the dedicated
  // UPGRADE screen — SPECS is a read-only spec sheet again.)
  const eff = getEffectiveCar(car, getCarUpgrades(life, car.id));

  // Per-stat values for this car. H483: SCALE_MS imported from
  // canonical physicsUnits module. Unit display: km/h for RHD, mph
  // for LHD (matches H80 effective-unit logic).
  const _dispMul = car.rhd ? 3.6 : 2.237;
  const _topDisp = (eff.topSpeed / SCALE_MS) * _dispMul;
  const _unit = car.rhd ? 'km/h' : 'mph';
  const accel = (eff.hp / Math.max(1, eff.kg)) * 1000;
  const carVals = {
    topSpeed: eff.topSpeed,
    hp: eff.hp,
    accel,
    braking: eff.brakePower,
  };

  // H870: GT2 boxed spec rows — matches the Skyline GTS25 reference
  // (label chip + value box pairs) instead of the old percentile bars.
  // Performance stats keep a subtle fleet-percentile underline inside
  // the value box so the at-a-glance comparison survives the redesign.
  const fracOf = (key: 'topSpeed' | 'hp' | 'accel' | 'braking'): number => {
    const rg = range[key];
    let f = (carVals[key] - rg.min) / (rg.max - rg.min);
    if (!isFinite(f)) f = 0;
    return Math.max(0, Math.min(1, f));
  };

  const M = 12;
  const GAP = 4;
  const ROW_H = 22;
  const ROW_GAP = 4;
  const colW = (GW - M * 2 - GAP) / 2;
  const leftX = M;
  const rightX = M + colW + GAP;
  const fullW = GW - M * 2;

  // One boxed label/value cell. `frac` (0..1), when given, draws a thin
  // amber fleet-percentile strip along the bottom of the value box.
  const cell = (
    x: number, y: number, w: number,
    label: string, value: string,
    frac?: number, valColor?: string,
  ): void => {
    const labelW = Math.floor(w * 0.46);
    ctx.fillStyle = GT2_COLORS.panel;
    ctx.fillRect(x, y, labelW, ROW_H);
    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(x + labelW, y, w - labelW, ROW_H);
    if (frac !== undefined) {
      ctx.fillStyle = GT2_COLORS.amberDim;
      ctx.fillRect(x + labelW, y + ROW_H - 3, (w - labelW) * frac, 3);
    }
    ctx.strokeStyle = GT2_COLORS.bg;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, ROW_H - 1);
    ctx.fillStyle = GT2_COLORS.textMute;
    ctx.font = 'bold 8px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(label.toUpperCase(), x + 5, y + 14);
    ctx.fillStyle = valColor ?? GT2_COLORS.text;
    ctx.font = 'bold 9px monospace';
    ctx.fillText(value, x + labelW + 5, y + 14);
  };

  const sectionHead = (label: string, y: number): void => {
    ctx.fillStyle = GT2_COLORS.amber;
    ctx.font = 'bold 9px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(label, M, y);
  };

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

  let yy = topY + 48;
  sectionHead('PERFORMANCE', yy);
  yy += 8;
  cell(leftX, yy, colW, 'Top Speed', `${Math.round(_topDisp)} ${_unit}`, fracOf('topSpeed'));
  cell(rightX, yy, colW, 'Power', `${Math.round(eff.hp)} hp`, fracOf('hp'));
  yy += ROW_H + ROW_GAP;
  cell(leftX, yy, colW, 'Accel', `${Math.round(fracOf('accel') * 100)} / 100`, fracOf('accel'));
  cell(rightX, yy, colW, 'Braking', `${Math.round(fracOf('braking') * 100)} / 100`, fracOf('braking'));
  yy += ROW_H + ROW_GAP;

  yy += 8;
  sectionHead('DETAILS', yy);
  yy += 8;
  cell(leftX, yy, fullW, 'Drivetrain', drvLong[car.drv] || car.drv);
  yy += ROW_H + ROW_GAP;
  cell(leftX, yy, fullW, 'Engine', eng || '—');
  yy += ROW_H + ROW_GAP;

  const pairs: ReadonlyArray<readonly [string, string]> = [
    ['Gears',        String(car.gears)],
    ['Transmission', car.defaultManual ? 'MANUAL' : 'AUTO'],
    ['Steering',     car.rhd ? 'RHD' : 'LHD'],
    ['Aspiration',   gt4?.asp ?? 'NA'],
    ['Mass',         `${eff.kg} kg`],
    ['Redline',      `${car.redline.toLocaleString()} rpm`],
    ['Wheelbase',    dimStr(gt4?.wb)],
    ['Length',       dimStr(gt4?.lng)],
    ['Width',        dimStr(gt4?.wid)],
    ['Year',         String(car.modelYear)],
    ['Tires F',      gt4?.tsF ?? '—'],
    ['Tires R',      gt4?.tsR ?? '—'],
  ];
  for (let i = 0; i < pairs.length; i += 2) {
    cell(leftX, yy, colW, pairs[i][0], pairs[i][1]);
    const nx = pairs[i + 1];
    if (nx) cell(rightX, yy, colW, nx[0], nx[1]);
    yy += ROW_H + ROW_GAP;
  }
  ctx.textAlign = 'left';
  drawSpecsBackButton(ctx, GW, GH, life);
}

/** H734: Back button as regular GT2 amber pill (no darker active styling —
 *  per user policy, dark = selected/focused, not random emphasis). H1284:
 *  extracted so both the spec-sheet and X-ray inspection layouts share it. */
function drawSpecsBackButton(
  ctx: CanvasRenderingContext2D,
  GW: number,
  GH: number,
  life: LifeState,
): void {
  const bx = GW / 2 - 60;
  const by = GH - 80;
  ctx.fillStyle = GT2_COLORS.amber;
  fillRoundRectHome(ctx, bx, by, 120, 32, 5);
  ctx.fillStyle = GT2_COLORS.bgDeep;
  ctx.font = 'bold 13px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('← BACK', GW / 2, by + 21);
  life._garageSpecsBackRect = { x: bx, y: by, w: 120, h: 32 };
  ctx.textAlign = 'left';
}

/** H877: GT2-voice flavor for each upgrade stage (generic across all cars).
 *  Drafted to the GT2 parts-catalog tone; titles + one-line blurbs. */
const UPGRADE_FLAVOR: Record<UpgradeKind, ReadonlyArray<{ title: string; blurb: string }>> = {
  power: [
    { title: 'Stage 1 Turbo Kit', blurb: 'Bolt-on turbocharger with sports intake and exhaust — output up across the range, minimal lag.' },
    { title: 'Big Turbo + Intercooler', blurb: 'High-capacity turbo and front-mount intercooler trade a little low-end for a strong top-end rush.' },
    { title: 'Forged Internals', blurb: 'Forged pistons and strengthened rods let the engine safely hold higher boost and revs.' },
    { title: 'Full-Spec Fuel System', blurb: 'High-flow injectors, uprated pump and a sports computer give full-spec fueling under heavy boost.' },
  ],
  weight: [
    { title: 'Interior Strip + Battery', blurb: 'Removes carpet, trim and rear seats and fits a light battery — sheds dead mass, stays streetable.' },
    { title: 'Light Wheels + Seats', blurb: 'Forged alloy wheels cut unsprung mass; bucket sports seats trim the cabin and quicken turn-in.' },
    { title: 'Carbon Panels + Glass', blurb: 'Aluminium bonnet, carbon panels and thinned glazing strip serious mass from the body.' },
    { title: 'Full Lightweight Body', blurb: 'Complete lightweight shell and stripped cabin reach the lowest streetable mass.' },
  ],
  brakes: [
    { title: 'Pads + Fluid', blurb: 'Performance brake pads and high-temp fluid for stronger, more fade-resistant stops.' },
    { title: 'Slotted Rotors', blurb: 'Slotted, vented rotors shed heat and gas for consistent bite under repeated braking.' },
    { title: 'Big Brake Kit', blurb: 'Larger discs and multi-piston calipers add clamping force and thermal capacity.' },
    { title: 'Race Calipers', blurb: 'Full race calipers and braided lines deliver maximum, track-ready stopping power.' },
  ],
  suspension: [
    { title: 'Lowering Springs', blurb: 'Stiffer, lower springs cut body roll and sharpen turn-in for a planted feel.' },
    { title: 'Sports Dampers', blurb: 'Matched performance dampers control the springs for crisper, more composed handling.' },
    { title: 'Coilovers', blurb: 'Adjustable coilovers drop the centre of gravity and tighten the chassis response.' },
    { title: 'Race Coilovers', blurb: 'Full race coilovers and stiffened bushings give the sharpest, track-ready turn-in.' },
  ],
  tires: [
    { title: 'Sport Tires', blurb: 'Stickier street-sport rubber raises grip for stronger cornering, braking and traction.' },
    { title: 'Sport+ Compound', blurb: 'A softer high-performance compound widens the grip envelope on warm roads.' },
    { title: 'Semi-Slicks', blurb: 'R-compound semi-slicks bite hard for serious cornering speed, road-legal but quick to wear.' },
    { title: 'Track Compound', blurb: 'Full track rubber delivers maximum mechanical grip for the sharpest lap times.' },
  ],
};

/** Word-wrap helper for the tune tiles/strip. Uses the CURRENT ctx font, so
 *  set the font before calling. Ellipsizes the final line when it overflows. */
function wrapTuneText(
  ctx: CanvasRenderingContext2D, text: string,
  x: number, y: number, maxW: number, lineH: number, maxLines = 2,
): void {
  const words = text.split(' ');
  let line = '';
  let row = 0;
  for (let i = 0; i < words.length; i++) {
    const test = line ? line + ' ' + words[i] : words[i];
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, x, y + row * lineH);
      row++;
      if (row >= maxLines - 1) {
        let rest = words.slice(i).join(' ');
        while (ctx.measureText(rest).width > maxW && rest.length > 1) rest = rest.slice(0, -2) + '…';
        ctx.fillText(rest, x, y + row * lineH);
        return;
      }
      line = words[i];
    } else {
      line = test;
    }
  }
  ctx.fillText(line, x, y + row * lineH);
}

/** A small amber pill button for the tune strip (label + sublabel). */
function drawTuneBtn(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  label: string, sub: string, enabled: boolean,
): void {
  ctx.fillStyle = enabled ? 'rgba(247,166,35,0.16)' : 'rgba(80,80,80,0.2)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = enabled ? GT2_COLORS.amber : '#555';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.textAlign = 'center';
  ctx.fillStyle = enabled ? GT2_COLORS.amber : '#666';
  ctx.font = 'bold 8px monospace';
  ctx.fillText(label, x + w / 2, y + 9);
  if (sub) {
    ctx.fillStyle = enabled ? GT2_COLORS.textMute : '#555';
    ctx.font = '7px monospace';
    ctx.fillText(sub, x + w / 2, y + 17);
  }
}

type TuneTileHit = { kind: UpgradeKind; venue: 'diy' | 'shop'; toStage: number; x: number; y: number; w: number; h: number };

/** H1266: vertical slack added to each category chip's HIT rect (not its drawn
 *  rect). The chips are only 30px tall in a heavily-scaled canvas, so a few
 *  logical pixels of overshoot is a dozen real ones. */
const CHIP_HIT_PAD_Y = 8;

/** H1266: a category chip's padded hit rect plus the smaller rect actually
 *  drawn (v*), so pad focus can navigate and ring the visible chip. */
interface TuneCatHit {
  kind: UpgradeKind;
  x: number; y: number; w: number; h: number;
  vx: number; vy: number; vw: number; vh: number;
}

/** H1266: every pad-focusable target on the UPGRADE screen, in a stable order —
 *  category chips, then the DIY/SHOP buy buttons for the selected category (if
 *  any are purchasable), then BACK.
 *
 *  Built from the SAME rects the click router dispatches on, which the draw
 *  pass already stashes on `life`. That is deliberate: the pad activates a
 *  target by tapping its centre through handleHomeOverlayClick, so a focus list
 *  derived from anywhere else could drift out of sync with what a tap does.
 *  Returns [] until the screen has painted once. */
export function tuneFocusRects(life: LifeState): Array<{ x: number; y: number; w: number; h: number }> {
  const l = life as {
    _garageTuneCatHits?: TuneCatHit[];
    _garageTuneTileHits?: TuneTileHit[];
    _garageTuneBackRect?: { x: number; y: number; w: number; h: number };
  };
  const out: Array<{ x: number; y: number; w: number; h: number }> = [];
  for (const c of l._garageTuneCatHits ?? []) out.push({ x: c.vx, y: c.vy, w: c.vw, h: c.vh });
  for (const t of l._garageTuneTileHits ?? []) out.push({ x: t.x, y: t.y, w: t.w, h: t.h });
  if (l._garageTuneBackRect) out.push(l._garageTuneBackRect);
  return out;
}

/** H877: dedicated GT2-style UPGRADE screen — per-axis Stage 1-4 tiles with a
 *  detail/action strip for the next purchasable stage (flavor, before→after,
 *  DIY/SHOP buy). Reuses the H876 economy (getUpgradeStagePlan / orderUpgrade).
 *  Reached via the garage car panel's UPGRADE button (garageView='tune'). */
function drawGarageTuneView(
  ctx: CanvasRenderingContext2D,
  GW: number, GH: number,
  life: LifeState,
  car: CatalogCar,
): void {
  const topY = 120;
  const up = getCarUpgrades(life, car.id);
  const headroom = getUpgradeHeadroom(car);
  const eff = getEffectiveCar(car, up);

  ctx.textAlign = 'center';
  ctx.fillStyle = GT2_COLORS.text;
  ctx.font = 'italic bold 16px monospace';
  ctx.fillText('UPGRADE', GW / 2, topY);
  ctx.font = 'bold 11px monospace';
  const nm = car.name.length > 32 ? car.name.slice(0, 31) + '…' : car.name;
  ctx.fillText(nm, GW / 2, topY + 16);
  ctx.fillStyle = GT2_COLORS.textMute;
  ctx.font = '9px monospace';
  ctx.fillText(`$${life.money.toLocaleString()} · SKILL ${life.mechSkill ?? 0}/100`, GW / 2, topY + 30);

  // H880: drivetrain layout glyph in the header corner.
  drawDrivetrainGlyph(ctx, 16, topY - 12, 40, 46, car.drv);
  // H881: top-down car sprite in the opposite header corner.
  drawCarSpritePreview(ctx, GW - 132, topY - 14, 116, 50, car);

  const M = 12;
  const fullW = GW - M * 2;
  const tileHits: TuneTileHit[] = [];

  const drawAxis = (
    y0: number, kind: UpgradeKind,
    curStage: number, curVal: number, maxVal: number, unit: string,
  ): number => {
    let y = y0;
    // Summary line.
    ctx.textAlign = 'left';
    ctx.fillStyle = GT2_COLORS.amber;
    ctx.font = 'bold 10px monospace';
    ctx.fillText(kind.toUpperCase(), M, y);
    ctx.textAlign = 'right';
    ctx.fillStyle = GT2_COLORS.text;
    ctx.fillText(`${Math.round(curVal)}${unit}  ·  Stage ${curStage}/4  ·  max ${Math.round(maxVal)}${unit}`, M + fullW, y);
    y += 8;

    // Stage tiles.
    const gap = 6;
    const tileW = (fullW - gap * 3) / 4;
    const tileH = 40;
    for (let s = 1; s <= 4; s++) {
      const tx = M + (s - 1) * (tileW + gap);
      const owned = curStage >= s;
      const isNext = s === curStage + 1;
      ctx.fillStyle = owned ? 'rgba(247,166,35,0.18)' : isNext ? GT2_COLORS.bgDeep : '#101010';
      ctx.fillRect(tx, y, tileW, tileH);
      ctx.strokeStyle = owned || isNext ? GT2_COLORS.amber : '#333';
      ctx.lineWidth = isNext ? 1.5 : 1;
      ctx.strokeRect(tx + 0.5, y + 0.5, tileW - 1, tileH - 1);
      ctx.textAlign = 'left';
      ctx.fillStyle = owned ? GT2_COLORS.amber : isNext ? GT2_COLORS.text : GT2_COLORS.textDim;
      ctx.font = 'bold 9px monospace';
      ctx.fillText(`STAGE ${s}`, tx + 5, y + 12);
      if (owned) {
        ctx.textAlign = 'right';
        ctx.fillStyle = GT2_COLORS.active;
        ctx.fillText('✓', tx + tileW - 5, y + 12);
      }
      ctx.textAlign = 'left';
      ctx.fillStyle = owned || isNext ? GT2_COLORS.textMute : GT2_COLORS.textDim;
      ctx.font = '7px monospace';
      wrapTuneText(ctx, UPGRADE_FLAVOR[kind][s - 1].title, tx + 5, y + 24, tileW - 8, 8, 2);
    }
    y += tileH + 6;

    // Detail / action strip for the next stage (or status).
    const stripH = 56;
    ctx.fillStyle = GT2_COLORS.bgDeep;
    ctx.fillRect(M, y, fullW, stripH);
    ctx.strokeStyle = '#3a3a3a';
    ctx.lineWidth = 1;
    ctx.strokeRect(M + 0.5, y + 0.5, fullW - 1, stripH - 1);
    const pending = hasPendingUpgrade(life, car.id, kind);
    if (pending) {
      // H1289: three in-flight flavors — parts in the mail, wrenching in
      // your own garage, or the car's build at the shop.
      ctx.textAlign = 'center';
      ctx.fillStyle = GT2_COLORS.active;
      ctx.font = 'bold 11px monospace';
      const msg = pending.isDelivery
        ? `PARTS ORDERED · arrive Day ${pending.readyDay}`
        : pending.venue === 'diy'
          ? `INSTALLING IN GARAGE · ready Day ${pending.readyDay}`
          : `IN SHOP · ready Day ${pending.readyDay}`;
      ctx.fillText(msg, GW / 2, y + stripH / 2 + 4);
    } else if (curStage >= 4) {
      ctx.textAlign = 'center';
      ctx.fillStyle = GT2_COLORS.amber;
      ctx.font = 'bold 11px monospace';
      ctx.fillText('FULLY BUILT', GW / 2, y + stripH / 2 + 4);
    } else {
      const plan = getUpgradeStagePlan(car, kind, curStage + 1, life);
      if (plan) {
        const fl = UPGRADE_FLAVOR[kind][curStage];
        ctx.textAlign = 'left';
        ctx.fillStyle = GT2_COLORS.text;
        ctx.font = 'bold 9px monospace';
        ctx.fillText(`STAGE ${plan.toStage}: ${fl.title}`, M + 8, y + 13);
        ctx.fillStyle = GT2_COLORS.textMute;
        ctx.font = '7px monospace';
        wrapTuneText(ctx, fl.blurb, M + 8, y + 24, fullW * 0.6, 8, 3);
        ctx.textAlign = 'right';
        ctx.fillStyle = GT2_COLORS.active;
        ctx.font = 'bold 11px monospace';
        ctx.fillText(`${Math.round(plan.fromVal)} → ${Math.round(plan.toVal)} ${plan.unit}`, M + fullW - 8, y + 14);
        const bw = Math.min(120, (fullW * 0.4 - 6) / 2);
        const btnY = y + 28;
        const btnH = 20;
        const bx2 = M + fullW - 8 - bw;
        const bx1 = bx2 - 6 - bw;
        // H1289: DIY is two steps — buy the PARTS (no skill gate), then
        // INSTALL once the kit is in the garage (free, skill-gated). SHOP
        // greys out while a kit waits so the parts money is never stranded.
        const havePart = findOwnedUpgradePartIdx(life, car.id, kind, plan.toStage) >= 0;
        if (havePart) {
          drawTuneBtn(ctx, bx1, btnY, bw, btnH, 'INSTALL', `${plan.days}d · skill ${plan.skillReq}`, plan.canDIY);
          drawTuneBtn(ctx, bx2, btnY, bw, btnH, 'SHOP', 'you have the parts', false);
        } else {
          drawTuneBtn(ctx, bx1, btnY, bw, btnH, `PARTS $${plan.diyPrice.toLocaleString()}`, `ships ${UPGRADE_PART_SHIP_DAYS}d`, life.money >= plan.diyPrice);
          drawTuneBtn(ctx, bx2, btnY, bw, btnH, `SHOP $${plan.shopPrice.toLocaleString()}`, `${plan.days}d`, life.money >= plan.shopPrice);
        }
        tileHits.push({ kind, venue: 'diy', toStage: plan.toStage, x: bx1, y: btnY, w: bw, h: btnH });
        tileHits.push({ kind, venue: 'shop', toStage: plan.toStage, x: bx2, y: btnY, w: bw, h: btnH });
      }
    }
    return y + stripH + 12;
  };

  // Per-category display values (current effective + max headroom + unit).
  const catView = (kind: UpgradeKind): { stage: number; cur: number; max: number; unit: string } => {
    if (kind === 'power') return { stage: up.power, cur: eff.hp, max: headroom.builtHp, unit: 'hp' };
    if (kind === 'weight') return { stage: up.weight, cur: eff.kg, max: headroom.minKg, unit: 'kg' };
    if (kind === 'brakes') return { stage: up.brakes, cur: Math.round((brakeStageMult(up.brakes) - 1) * 100), max: BRAKE_MAX_PCT, unit: '%' };
    if (kind === 'suspension') return { stage: up.suspension, cur: Math.round((suspTurnBonus(up.suspension) - 1) * 100), max: SUSP_MAX_PCT, unit: '%' };
    return { stage: up.tires, cur: Math.round((gripStageBonus(up.tires) - 1) * 100), max: GRIP_MAX_PCT, unit: '%' };
  };

  // H879: category selector chips — one per upgrade category, each showing its
  // stage as 4 dots. Tap to focus that category; its detail renders below.
  const valid = UPGRADE_CATEGORIES.some((c) => c.kind === (life as { _tuneCategory?: UpgradeKind })._tuneCategory);
  const selKind: UpgradeKind = valid ? (life as { _tuneCategory?: UpgradeKind })._tuneCategory! : 'power';
  const chipY = topY + 40;
  const chipH = 30;
  const chipGap = 6;
  const chipW = (fullW - chipGap * (UPGRADE_CATEGORIES.length - 1)) / UPGRADE_CATEGORIES.length;
  const catHits: TuneCatHit[] = [];
  UPGRADE_CATEGORIES.forEach((c, i) => {
    const cx = M + i * (chipW + chipGap);
    const sel = c.kind === selKind;
    const stage = catView(c.kind).stage;
    ctx.fillStyle = sel ? 'rgba(247,166,35,0.22)' : GT2_COLORS.bgDeep;
    ctx.fillRect(cx, chipY, chipW, chipH);
    ctx.strokeStyle = sel ? GT2_COLORS.amber : '#3a3a3a';
    ctx.lineWidth = sel ? 1.5 : 1;
    ctx.strokeRect(cx + 0.5, chipY + 0.5, chipW - 1, chipH - 1);
    ctx.textAlign = 'center';
    ctx.fillStyle = sel ? GT2_COLORS.amber : GT2_COLORS.textMute;
    ctx.font = 'bold 9px monospace';
    ctx.fillText(c.label, cx + chipW / 2, chipY + 12);
    for (let s = 1; s <= 4; s++) {
      const dx = cx + chipW / 2 - 12 + (s - 1) * 8;
      ctx.beginPath();
      ctx.arc(dx, chipY + 21, 2.4, 0, Math.PI * 2);
      ctx.fillStyle = stage >= s ? GT2_COLORS.amber : '#444';
      ctx.fill();
    }
    // H1266: the HIT rect is deliberately bigger than the drawn chip.
    //
    // These were hit-tested on their exact 113x30 rects, so the 6px gaps
    // between chips and the 12px page margin were dead space that swallowed
    // taps. Every chip except POWER has a neighbour on both sides, so a near
    // miss there just selects the adjacent tab and you SEE it move; a near
    // miss to POWER's left lands in the page margin and does nothing at all —
    // the user's "regularly can't select Power tab ... seems to randomly be
    // unable to select". The row is scaled ~3.3x on screen, so 12 logical px
    // of margin is ~40 real pixels of nothing.
    //
    // Each chip now claims to the midpoint of its gaps, the outer two run to
    // the screen edges, and the band is padded vertically. The row is a
    // continuous target with no holes; only the drawn rect stays at 113x30.
    const isFirst = i === 0;
    const isLast = i === UPGRADE_CATEGORIES.length - 1;
    const halfGap = chipGap / 2;
    const hx = isFirst ? 0 : cx - halfGap;
    const hw = (isLast ? GW : cx + chipW + halfGap) - hx;
    catHits.push({
      kind: c.kind,
      x: hx,
      y: chipY - CHIP_HIT_PAD_Y,
      w: hw,
      h: chipH + CHIP_HIT_PAD_Y * 2,
      // H1266: the DRAWN rect, kept alongside the padded hit rect — pad focus
      // navigates and rings the chip you can see, not its generous hitbox.
      vx: cx, vy: chipY, vw: chipW, vh: chipH,
    });
  });
  (life as { _garageTuneCatHits?: typeof catHits })._garageTuneCatHits = catHits;

  // Selected category's detail (tiles + buy strip).
  const cv = catView(selKind);
  drawAxis(chipY + chipH + 12, selKind, cv.stage, cv.cur, cv.max, cv.unit);
  (life as { _garageTuneTileHits?: TuneTileHit[] })._garageTuneTileHits = tileHits;

  const bx = GW / 2 - 60;
  const by = GH - 80;
  ctx.fillStyle = GT2_COLORS.amber;
  fillRoundRectHome(ctx, bx, by, 120, 32, 5);
  ctx.fillStyle = GT2_COLORS.bgDeep;
  ctx.font = 'bold 13px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('← BACK', GW / 2, by + 21);
  (life as { _garageTuneBackRect?: { x: number; y: number; w: number; h: number } })._garageTuneBackRect = { x: bx, y: by, w: 120, h: 32 };

  // H1266: controller focus ring. Drawn last so it sits over every widget, and
  // only while a pad is actually driving — mouse/touch players never see it.
  const fl = life as { _garageTuneFocusIdx?: number; _garageTuneShowFocus?: boolean };
  if (fl._garageTuneShowFocus) {
    const rects = tuneFocusRects(life);
    const fr = rects[fl._garageTuneFocusIdx ?? 0];
    if (fr) {
      ctx.strokeStyle = GT2_COLORS.active;
      ctx.lineWidth = 2;
      ctx.strokeRect(fr.x - 2.5, fr.y - 2.5, fr.w + 5, fr.h + 5);
    }
  }
  ctx.textAlign = 'left';
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
/** H782 — geometry of one category tab in the parts view's top strip.
 *  Cached on life._garagePartsTabRects so the click router can
 *  dispatch by tap → category. */
interface GaragePartsTabRect {
  x: number;
  y: number;
  w: number;
  h: number;
  cat: PartsCategory;
}

/** H782 — height of the category tab strip (icon block + label block).
 *  Tuned to match the visual weight of the GT2 lineup grid tiles
 *  without crowding the parts list below. */
const PARTS_TAB_STRIP_H = 52;

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
  ctx.fillText('Cash: $' + life.money.toLocaleString() + ' · Skill: ' + Math.round(life.mechSkill ?? 0), GW / 2, topY + 26);

  // H782: GT2-style category tab strip. Eight tabs across, each
  // showing the canonical glyph from the lineup grid + label. The
  // active tab takes the amber background; the rest sit as charcoal
  // tiles so the row reads as the source of truth for filtering
  // (not as decoration). Tap-to-switch is wired in the click router.
  const stripTop = topY + 40;
  const stripPadX = 6;
  const tabGap = 2;
  const tabsAvailW = GW - stripPadX * 2;
  const tabCount = PARTS_CATEGORIES.length;
  const tabW = Math.floor((tabsAvailW - tabGap * (tabCount - 1)) / tabCount);
  const activeCat: PartsCategory =
    (PARTS_CATEGORIES as readonly string[]).includes(life._garagePartsCategory ?? '')
      ? (life._garagePartsCategory as PartsCategory)
      : 'ENGINE';
  // Persist any default we picked on first open so the click router
  // and the next paint agree on which tab is live.
  life._garagePartsCategory = activeCat;
  const tabRects: GaragePartsTabRect[] = [];
  for (let i = 0; i < tabCount; i++) {
    const cat = PARTS_CATEGORIES[i];
    const tx = stripPadX + i * (tabW + tabGap);
    const ty = stripTop;
    const isActive = cat === activeCat;
    ctx.fillStyle = isActive ? GT2_COLORS.amber : GT2_COLORS.panel;
    fillRoundRectHome(ctx, tx, ty, tabW, PARTS_TAB_STRIP_H, 4);
    ctx.strokeStyle = isActive ? GT2_COLORS.amberDark : '#3a3a3a';
    ctx.lineWidth = 1;
    ctx.strokeRect(tx + 0.5, ty + 0.5, tabW - 1, PARTS_TAB_STRIP_H - 1);
    // Glyph centered in the top ~60% of the tile (matching the lineup
    // grid's geometry). Active glyphs paint over the amber face in
    // bgDeep — same recipe as the lineup tile — so they read as the
    // selection target rather than as a separate hover state.
    const gcx = tx + tabW / 2;
    const gcy = ty + PARTS_TAB_STRIP_H * 0.42;
    const prevFill = ctx.fillStyle;
    const prevStroke = ctx.strokeStyle;
    drawCategoryGlyph(ctx, gcx, gcy, Math.min(tabW, PARTS_TAB_STRIP_H) * 0.55, cat);
    ctx.fillStyle = prevFill;
    ctx.strokeStyle = prevStroke;
    // Label — short, monospace, sits under the glyph.
    ctx.fillStyle = isActive ? GT2_COLORS.bgDeep : GT2_COLORS.text;
    ctx.font = 'bold 7px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(cat, gcx, ty + PARTS_TAB_STRIP_H - 5);
    tabRects.push({ x: tx, y: ty, w: tabW, h: PARTS_TAB_STRIP_H, cat });
  }
  life._garagePartsTabRects = tabRects as unknown[];

  const listTop = stripTop + PARTS_TAB_STRIP_H + 8;
  const listBot = GH - 100; // reserve room for BACK button
  const visibleH = listBot - listTop;

  // Filter parts catalog by mod eligibility (drops WELD DIFF when
  // already welded, SUPERCHARGER when already supercharged, etc.),
  // then narrow to the active tab so the user only sees rows that
  // belong to MUFFLER / BRAKES / etc.
  const eligibleAll = filterAvailableParts(life, car);
  const eligible = eligibleAll.filter(
    (p) => (PART_NAME_TO_CATEGORY[p.name] ?? 'OTHERS') === activeCat,
  );

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
    ctx.textAlign = 'center';
    const msg = eligibleAll.length === 0
      ? 'No parts available for this car.'
      : 'No ' + activeCat + ' parts for this car.';
    ctx.fillText(msg, GW / 2, yy + 24);
    ctx.textAlign = 'left';
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
    ctx.fillText('$' + price.toLocaleString(), btnX + btnW / 2, btnY + 24);

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
/** H944: garage TOOLBOX view — owned tools / consumables / tires, grouped by
 *  category. Display-only v1; buying/using tools lands in later slices. */
function drawGarageToolboxView(
  ctx: CanvasRenderingContext2D,
  GW: number,
  GH: number,
  life: LifeState,
): void {
  const topY = 120;
  ctx.textAlign = 'center';
  ctx.fillStyle = GT2_COLORS.text;
  ctx.font = 'italic bold 16px monospace';
  ctx.fillText('TOOLBOX', GW / 2, topY);
  ctx.fillStyle = GT2_COLORS.textMute;
  ctx.font = '9px monospace';
  ctx.fillText('Tools, supplies & tires you own', GW / 2, topY + 14);

  const groups = groupToolbox(life);
  const x0 = 16;
  let yy = topY + 40;
  if (groups.length === 0) {
    ctx.fillStyle = GT2_COLORS.textMute;
    ctx.font = '10px monospace';
    ctx.fillText('Empty — buy tools to stock your garage.', GW / 2, yy + 20);
  }
  ctx.textAlign = 'left';
  for (const g of groups) {
    ctx.fillStyle = GT2_COLORS.amber;
    ctx.font = 'bold 10px monospace';
    ctx.fillText(g.label, x0, yy);
    yy += 5;
    ctx.strokeStyle = GT2_COLORS.amberDark;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, yy + 0.5);
    ctx.lineTo(GW - 16, yy + 0.5);
    ctx.stroke();
    yy += 14;
    for (const it of g.items) {
      ctx.fillStyle = GT2_COLORS.text;
      ctx.font = '10px monospace';
      const label = it.spec ? it.name + ' (' + it.spec + ')' : it.name;
      ctx.fillText(label, x0 + 6, yy);
      if (it.qty > 1 || it.category === 'consumable' || it.category === 'tire') {
        ctx.fillStyle = GT2_COLORS.textMute;
        ctx.textAlign = 'right';
        ctx.fillText('×' + it.qty, GW - 18, yy);
        ctx.textAlign = 'left';
      }
      yy += 16;
    }
    yy += 8;
  }

  // BACK button — GT2 amber outline.
  ctx.textAlign = 'center';
  const bx = (GW - 120) / 2;
  const by = GH - 60;
  ctx.strokeStyle = GT2_COLORS.amber;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(bx, by, 120, 32);
  ctx.fillStyle = GT2_COLORS.amber;
  ctx.font = 'bold 12px monospace';
  ctx.fillText('← BACK', GW / 2, by + 21);
  (life as { _garageToolboxBackRect?: { x: number; y: number; w: number; h: number } })._garageToolboxBackRect = { x: bx, y: by, w: 120, h: 32 };
  ctx.textAlign = 'left';
}

function drawGarageRepairsView(
  ctx: CanvasRenderingContext2D,
  GW: number,
  GH: number,
  life: LifeState,
  car: CatalogCar,
): void {
  const topY = 120;
  ctx.textAlign = 'center';
  ctx.fillStyle = GT2_COLORS.active;
  ctx.font = 'bold 14px monospace';
  ctx.fillText('REPAIRS', GW / 2, topY);
  // Car name + condition summary.
  ctx.fillStyle = GT2_COLORS.textMute;
  ctx.font = '9px monospace';
  const nm = car.name.length > 32 ? car.name.slice(0, 31) + '…' : car.name;
  ctx.fillText(
    nm + ' · Eng ' + Math.round(life.engine) + '% Tire ' + Math.round(life.tires) + '% Body ' + Math.round(life.carHP) + '%',
    GW / 2, topY + 14,
  );
  // Per-category mechanical skills (H938) — six sub-skills on five 20-pt
  // tier bands, a 2-row × 3-col grid of labelled mini-bars. Replaces the
  // single "Mechanical Skill" bar; you build each category by working in it.
  const cs = ensureCatSkill(life);
  ctx.textAlign = 'left';
  const gx0 = 30;
  const gridW = GW - 60;
  const cellW = gridW / 3;
  const rowTop = topY + 24;
  const catRowH = 13;
  for (let i = 0; i < MECH_CATEGORIES.length; i++) {
    const cat = MECH_CATEGORIES[i];
    const meta = CATEGORY_META[cat];
    const v = Math.round(cs[cat] ?? 0);
    const col = i % 3;
    const row = (i / 3) | 0;
    const cx = gx0 + col * cellW;
    const cy = rowTop + row * catRowH;
    ctx.font = 'bold 8px monospace';
    ctx.fillStyle = meta.color;
    ctx.fillText(meta.abbr, cx, cy + 6);
    ctx.fillStyle = GT2_COLORS.textMute;
    ctx.fillText(String(v), cx + 24, cy + 6);
    const barX = cx + 38;
    const barW = cellW - 46;
    ctx.fillStyle = GT2_COLORS.bgDeep;
    ctx.fillRect(barX, cy + 1, barW, 5);
    ctx.fillStyle = meta.color;
    ctx.fillRect(barX, cy + 1, barW * (v / 100), 5);
  }
  ctx.textAlign = 'center';

  const listTop = topY + 52;
  const listBot = GH - 100;
  const visibleH = listBot - listTop;
  const faults = (life.faults ?? []) as Fault[];

  // Scroll layout — taller rows (parts-style) carry difficulty + time-blocks.
  const rowH = 52;
  const rowGap = 6;
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
    ctx.fillStyle = GT2_COLORS.active;
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('No diagnosed issues', GW / 2, yy + 16);
    ctx.fillStyle = GT2_COLORS.textMute;
    ctx.font = '9px monospace';
    ctx.fillText('Faults surface here when wear, impact, or breakdown', GW / 2, yy + 34);
    ctx.fillText('diagnoses them. Use PARTS for proactive upkeep.', GW / 2, yy + 46);
  }
  for (let i = 0; i < faults.length; i++) {
    const f = faults[i];
    const venues = getFaultVenueOptions(f, car, life);
    // Difficulty tier from the DIY skill requirement (incl. the car's
    // skill-boost penalty) — color-graded green(easy) → red(expert).
    const diff = venues.diy.skillReq;
    const tier = diff < 25 ? { l: 'EASY', c: '#7fe5a8' }
               : diff < 50 ? { l: 'MODERATE', c: GT2_COLORS.amber }
               : diff < 75 ? { l: 'HARD', c: GT2_COLORS.active }
               :             { l: 'EXPERT', c: '#c85a3a' };
    // Cheapest venue the player can use right now (DIY when skill clears).
    const primary = venues.diy.canDo ? venues.diy : venues.mechanic;
    const queued = life.pendingParts.find((p) => p.faultId === f.id);

    ctx.fillStyle = GT2_COLORS.panel;
    ctx.fillRect(12, yy, GW - 24, rowH);
    ctx.strokeStyle = '#3a3a3a';
    ctx.lineWidth = 1;
    ctx.strokeRect(12, yy, GW - 24, rowH);

    // Difficulty badge.
    ctx.textAlign = 'left';
    ctx.fillStyle = tier.c;
    ctx.font = 'bold 8px monospace';
    ctx.fillText(tier.l, 20, yy + 13);

    // Fault name.
    ctx.fillStyle = GT2_COLORS.text;
    ctx.font = 'bold 11px monospace';
    ctx.fillText(f.name, 84, yy + 13);

    // Stat-restore line. H1065: ?? guards — hydrateFaults repairs
    // stripped saves at load, but a fault minted mid-session must
    // never render "+undefined% undefined".
    ctx.fillStyle = GT2_COLORS.textMute;
    ctx.font = '9px monospace';
    const statRaw = f.stat ?? 'engine';
    const statLbl = statRaw === 'hp' ? 'body' : statRaw;
    ctx.fillText('Restores +' + (f.add ?? 15) + '% ' + statLbl, 20, yy + 29);

    // Time-blocks line: estimated completion per venue (days).
    ctx.fillStyle = GT2_COLORS.textDim;
    ctx.font = '8px monospace';
    ctx.fillText(
      'Time — DIY ~' + Math.max(8, venues.diy.time * 8) + 'h · Mechanic ' + venues.mechanic.time + 'd · Dealer same-day',
      20, yy + 42,
    );

    // Right side: FIX pill, or IN-SHOP status when already queued.
    const btnW = 96;
    const btnH = 30;
    const btnX = GW - 12 - btnW - 8;
    const btnY = yy + (rowH - btnH) / 2;
    ctx.textAlign = 'center';
    if (queued) {
      ctx.fillStyle = 'rgba(247,166,35,0.10)';
      fillRoundRectHome(ctx, btnX, btnY, btnW, btnH, 4);
      ctx.strokeStyle = GT2_COLORS.amberDark;
      ctx.lineWidth = 1;
      ctx.strokeRect(btnX + 0.5, btnY + 0.5, btnW - 1, btnH - 1);
      if (queued.venue === 'diy' && typeof queued.totalHours === 'number') {
        // H942: DIY WORK METER — hours of work done, 8h per time block. You're
        // doing the job in your own garage, so it shows progress, not "in shop".
        const tot = Math.max(1, queued.totalHours);
        const hdone = Math.min(tot, queued.hoursDone ?? 0);
        const prog = Math.max(0, Math.min(1, hdone / tot));
        ctx.fillStyle = GT2_COLORS.amber;
        ctx.font = 'bold 9px monospace';
        ctx.fillText('🔧 GARAGE', btnX + btnW / 2, btnY + 9);
        const bx = btnX + 8;
        const bw = btnW - 16;
        const by = btnY + 13;
        ctx.fillStyle = GT2_COLORS.bgDeep;
        ctx.fillRect(bx, by, bw, 5);
        ctx.fillStyle = GT2_COLORS.active;
        ctx.fillRect(bx, by, bw * prog, 5);
        ctx.fillStyle = GT2_COLORS.textMute;
        ctx.font = '8px monospace';
        ctx.fillText(hdone + 'h / ' + tot + 'h', btnX + btnW / 2, btnY + 26);
      } else {
        ctx.fillStyle = GT2_COLORS.amberDark;
        ctx.font = 'bold 10px monospace';
        ctx.fillText('IN SHOP', btnX + btnW / 2, btnY + 13);
        ctx.font = '9px monospace';
        ctx.fillText('ready Day ' + queued.readyDay, btnX + btnW / 2, btnY + 24);
      }
    } else {
      ctx.fillStyle = GT2_COLORS.amber;
      fillRoundRectHome(ctx, btnX, btnY, btnW, btnH, 4);
      ctx.fillStyle = GT2_COLORS.bgDeep;
      ctx.font = 'bold 11px monospace';
      ctx.fillText('FIX', btnX + btnW / 2, btnY + 13);
      ctx.font = 'bold 9px monospace';
      ctx.fillText('from $' + primary.price.toLocaleString(), btnX + btnW / 2, btnY + 25);
    }

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

  // BACK button — GT2 amber-outline secondary.
  const bx = GW / 2 - 60;
  const by = GH - 80;
  ctx.fillStyle = 'rgba(247,166,35,0.10)';
  ctx.fillRect(bx, by, 120, 32);
  ctx.strokeStyle = GT2_COLORS.amber;
  ctx.lineWidth = 2;
  ctx.strokeRect(bx, by, 120, 32);
  ctx.fillStyle = GT2_COLORS.amber;
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
  // H1082: a selected day zooms into the per-slot detail panel.
  if (life._calSelectedDay != null) {
    drawCalendarDayDetail(ctx, GW, GH, clock, life, life._calSelectedDay);
    return;
  }
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
  ctx.fillStyle = GT2_COLORS.active;
  ctx.font = 'bold 16px monospace';
  ctx.fillText(`${monthName.toUpperCase()} ${yearNum}`, GW / 2, yy);
  // H566: ◀ ▶ nav arrows on either side of the title row. Cached
  // rects stashed on life for handleHomeOverlayClick.
  life._calNavRects = drawNavArrows(ctx, GW, yy);
  yy += 22;
  ctx.fillStyle = GT2_COLORS.textMute;
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
  ctx.fillStyle = GT2_COLORS.textMute;
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
  const cellRects: NonNullable<LifeState['_calCellRects']> = [];
  for (let d = 1; d <= DAYS_PER_MONTH; d++) {
    const cx = gridX + col * cellW;
    const cy = yy + row * cellH;
    const absDay = firstDayGlobal + (d - 1);
    const isToday = isCurrentMonth && d === dayOfMonth;
    const isBillDay = d === 1;
    // Background.
    if (isToday) {
      ctx.fillStyle = 'rgba(255, 122, 24, 0.18)';
    } else if (isBillDay) {
      ctx.fillStyle = 'rgba(163, 110, 21, 0.10)';
    } else {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
    }
    ctx.fillRect(cx + 1, cy, cellW - 2, cellH - 1);
    if (isToday) {
      ctx.strokeStyle = GT2_COLORS.amber;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(cx + 1, cy, cellW - 2, cellH - 1);
    }
    // Date number.
    ctx.fillStyle = isToday ? GT2_COLORS.amber : col === 0 ? GT2_COLORS.amberDark : GT2_COLORS.text;
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(String(d), cx + cellW / 2, cy + 12);
    // H566 badges (solid = logged history) + H1082 scheduled badges
    // (ghosted = upcoming work / pay / bills) for today & future days.
    const scheduled = absDay >= clock.day ? getScheduledEventsForDay(life, absDay) : undefined;
    drawCellBadges(ctx, life, viewMonthOfYear, d, cx, cy, cellW, cellH, scheduled);
    // H1082: record the cell so a tap opens its day-detail.
    cellRects.push({ x: cx + 1, y: cy, w: cellW - 2, h: cellH - 1, absDay });

    col++;
    if (col > 6) {
      col = 0;
      row++;
    }
  }
  life._calCellRects = cellRects;

  // H566: legend below the grid — letter / color swatch row + slot
  // hint. Bills-next-due line stays below as supplemental info.
  const gridRows = Math.ceil((DAYS_PER_MONTH + firstCol) / 7);
  const legY = yy + gridRows * cellH + 14;
  drawCalendarLegend(ctx, GW, legY);
  ctx.fillStyle = GT2_COLORS.textMute;
  ctx.font = '9px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(`Bills next due in ${daysUntilNextBilling(clock.day)} day(s)`, GW / 2, legY + 30);
  // H1082: ghosted badges are upcoming; tapping a day zooms in.
  ctx.fillStyle = GT2_COLORS.textDim;
  ctx.font = '8px monospace';
  ctx.fillText('faded = upcoming · tap a day for its schedule', GW / 2, legY + 42);

  ctx.textAlign = 'left';

  // Back button.
  const bx = GW / 2 - 60;
  const by = GH - 80;
  ctx.fillStyle = 'rgba(255, 122, 24, 0.55)';
  ctx.fillRect(bx, by, 120, 32);
  ctx.strokeStyle = GT2_COLORS.amber;
  ctx.lineWidth = 2;
  ctx.strokeRect(bx, by, 120, 32);
  ctx.fillStyle = GT2_COLORS.text;
  ctx.font = 'bold 13px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('← BACK', GW / 2, by + 21);
}

/** H1082: per-day zoom — the parts of the selected day (morning /
 *  afternoon / night) with what happened (logged) or is planned
 *  (scheduled), plus today's slot free/used state. Reached by tapping a
 *  grid cell; its BACK returns to the month grid (clears
 *  life._calSelectedDay). */
function drawCalendarDayDetail(
  ctx: CanvasRenderingContext2D,
  GW: number,
  GH: number,
  clock: Clock,
  life: LifeState,
  absDay: number,
): void {
  const plan: DayPlan = getDayPlan(life, absDay, clock.day);

  // Header — full date + relation to today.
  ctx.textAlign = 'center';
  ctx.fillStyle = GT2_COLORS.active;
  ctx.font = 'bold 16px monospace';
  ctx.fillText(getDateString(absDay), GW / 2, 116);
  const delta = absDay - clock.day;
  const rel = plan.isToday ? 'TODAY'
    : delta === 1 ? 'tomorrow'
    : delta === -1 ? 'yesterday'
    : delta > 0 ? `in ${delta} days`
    : `${-delta} days ago`;
  ctx.fillStyle = plan.isToday ? GT2_COLORS.amber : GT2_COLORS.textMute;
  ctx.font = '11px monospace';
  ctx.fillText(`Day ${absDay} • ${rel}`, GW / 2, 134);

  // Slot rows. Each shows the slot's events (logged solid / scheduled
  // faded); today also flags free / used / current.
  const slots: Array<{ key: 'morning' | 'afternoon' | 'night'; icon: string; name: string; col: string }> = [
    { key: 'morning',   icon: '🌅', name: 'MORNING',   col: BADGE_SLOT_COLOR.morning },
    { key: 'afternoon', icon: '☀️', name: 'AFTERNOON', col: BADGE_SLOT_COLOR.afternoon },
    { key: 'night',     icon: '🌙', name: 'NIGHT',     col: BADGE_SLOT_COLOR.night },
  ];
  const rowX = 24;
  const rowW = GW - 48;
  const rowH = 46;
  let ry = 150;
  const both = [...plan.logged, ...plan.scheduled.map((e) => ({ ...e, _sched: true as const }))];
  for (const s of slots) {
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.fillRect(rowX, ry, rowW, rowH - 6);
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 1;
    ctx.strokeRect(rowX + 0.5, ry + 0.5, rowW - 1, rowH - 7);
    // Slot label.
    ctx.textAlign = 'left';
    ctx.fillStyle = s.col;
    ctx.font = 'bold 11px monospace';
    ctx.fillText(`${s.icon} ${s.name}`, rowX + 8, ry + 16);
    // Today: free / used / current tag on the right.
    if (plan.slotUsage) {
      const used = plan.slotUsage[s.key];
      const isCurrent = life.timeSlot === s.key;
      ctx.textAlign = 'right';
      ctx.fillStyle = isCurrent ? GT2_COLORS.active : used ? GT2_COLORS.textDim : '#7fe5a8';
      ctx.font = 'bold 9px monospace';
      ctx.fillText(isCurrent ? '● NOW' : used ? 'used' : 'free', rowX + rowW - 8, ry + 16);
    }
    // Events for this slot.
    const evs = both.filter((e) => e.slot === s.key);
    ctx.textAlign = 'left';
    ctx.font = '9px monospace';
    if (evs.length === 0) {
      ctx.fillStyle = GT2_COLORS.textDim;
      ctx.fillText('—', rowX + 12, ry + 32);
    } else {
      let ex = rowX + 12;
      for (const e of evs.slice(0, 3)) {
        const sched = '_sched' in e;
        ctx.globalAlpha = sched ? 0.55 : 1;
        // Type chip.
        ctx.fillStyle = BADGE_TYPE_BG[e.type] ?? '#333';
        ctx.fillRect(ex, ry + 24, 9, 9);
        ctx.fillStyle = s.col;
        ctx.font = 'bold 8px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(e.type, ex + 4.5, ry + 31);
        // Label.
        ctx.textAlign = 'left';
        ctx.fillStyle = GT2_COLORS.text;
        ctx.font = '9px monospace';
        const label = truncateLabel(ctx, e.label || e.type, rowW - (ex - rowX) - 20);
        ctx.fillText(label, ex + 13, ry + 32);
        ctx.globalAlpha = 1;
        ex += 14 + ctx.measureText(label).width + 8;
      }
    }
    ry += rowH;
  }

  // Anytime (slot-less) events — bills / work / pay carry no slot.
  const anytime = both.filter((e) => !e.slot);
  ctx.textAlign = 'left';
  ctx.fillStyle = GT2_COLORS.textMute;
  ctx.font = 'bold 9px monospace';
  ctx.fillText('ANYTIME', rowX, ry + 12);
  ctx.font = '10px monospace';
  if (anytime.length === 0) {
    ctx.fillStyle = GT2_COLORS.textDim;
    ctx.fillText('nothing scheduled', rowX + 66, ry + 12);
  } else {
    let ax = rowX + 66;
    for (const e of anytime.slice(0, 4)) {
      const sched = '_sched' in e;
      ctx.globalAlpha = sched ? 0.55 : 1;
      ctx.fillStyle = BADGE_TYPE_BG[e.type] ?? '#333';
      ctx.fillRect(ax, ry + 4, 10, 10);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 8px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(e.type, ax + 5, ry + 12);
      ctx.textAlign = 'left';
      ctx.fillStyle = GT2_COLORS.text;
      ctx.font = '10px monospace';
      const label = truncateLabel(ctx, e.label || e.type, rowW - (ax - rowX) - 24);
      ctx.fillText(label, ax + 14, ry + 13);
      ctx.globalAlpha = 1;
      ax += 14 + ctx.measureText(label).width + 12;
    }
  }

  // Back button → grid.
  const bx = GW / 2 - 60;
  const by = GH - 80;
  ctx.fillStyle = 'rgba(255, 122, 24, 0.55)';
  ctx.fillRect(bx, by, 120, 32);
  ctx.strokeStyle = GT2_COLORS.amber;
  ctx.lineWidth = 2;
  ctx.strokeRect(bx, by, 120, 32);
  ctx.fillStyle = GT2_COLORS.text;
  ctx.font = 'bold 13px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('← CALENDAR', GW / 2, by + 21);
  life._calDetailBackRect = { x: bx, y: by, w: 120, h: 32 };
}

/** Ellipsize a label to fit maxW px (monospace, measured). */
function truncateLabel(ctx: CanvasRenderingContext2D, s: string, maxW: number): string {
  if (maxW <= 6) return '';
  if (ctx.measureText(s).width <= maxW) return s;
  let t = s;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
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
/** H810: hit-rect cache the eat tab writes at draw time and the tap
 *  dispatcher reads. Replaces the pre-H810 mirrored-constant geometry
 *  (EAT_ROWS_TOP etc.), which had already drifted: the tab's content
 *  overflowed the canvas and the whole GYM section painted (and
 *  hit-tested) BELOW the visible area — unreachable. Rects are in HUD
 *  canvas coordinates. */
interface EatTabRects {
  eat: Array<{ x: number; y: number; w: number; h: number }>;
  shop: Array<{ x: number; y: number; w: number; h: number }>;
  gym: Array<{ x: number; y: number; w: number; h: number; level: 1 | 2 | 3; canGym: boolean }>;
}

/** H810: GT2-standard HEALTH & FITNESS tab. Full visual rewrite of the
 *  H34/H38/H213 terminal-style layout (neon green/cyan, emoji icons,
 *  single overflowing column) into the locked GT2 amber-on-charcoal
 *  language (gt2Chrome GT2_COLORS — day/night aware):
 *    - compact side-by-side stat bars,
 *    - two-column body (EAT + GROCERIES left, GYM right) so everything
 *      fits inside the 427-px HUD canvas with room for the BACK row,
 *    - panel rows with 1-px borders, amber accents, right-aligned
 *      values — no emoji, no per-row rainbow colors.
 *  Gameplay logic (eatFood / buyGroceries / evaluateGymWorkout) is
 *  untouched; only presentation + hit-rect plumbing changed. */
function drawEatTab(ctx: CanvasRenderingContext2D, GW: number, GH: number, life: LifeState): void {
  const C = GT2_COLORS;
  const rects: EatTabRects = { eat: [], shop: [], gym: [] };
  const L = 16;
  const R = GW - 16;

  // Section header — amber title over a thin rule (GT2 dealer style).
  ctx.textAlign = 'left';
  ctx.fillStyle = C.amber;
  ctx.font = 'bold 11px monospace';
  ctx.fillText('HEALTH & FITNESS', L, 112);
  ctx.fillStyle = C.amberDark;
  ctx.fillRect(L, 117, R - L, 1);

  // Stat bars — side by side, value inside.
  drawGt2StatBar(ctx, L, 126, (GW / 2 - 6) - L, 'HEALTH', life.health);
  drawGt2StatBar(ctx, GW / 2 + 6, 126, R - (GW / 2 + 6), 'FITNESS', life.fitness);

  // Hunger status line.
  ctx.font = '8px monospace';
  ctx.textAlign = 'left';
  if (life.daysSinceEat >= 2) {
    ctx.fillStyle = C.active;
    ctx.fillText(`STARVING — ${life.daysSinceEat} DAYS WITHOUT FOOD`, L, 152);
  } else if (life.daysSinceEat >= 1) {
    ctx.fillStyle = C.amber;
    ctx.fillText('HUNGRY — eat to avoid health loss', L, 152);
  } else if (life.ateToday) {
    ctx.fillStyle = C.textMute;
    ctx.fillText('Fed today', L, 152);
  } else {
    ctx.fillStyle = C.textMute;
    ctx.fillText('Feeling okay', L, 152);
  }

  // Two-column body.
  const colGap = 12;
  const colW = (R - L - colGap) / 2;
  const colL = L;
  const colR = L + colW + colGap;
  const sectionHeader = (x: number, y: number, title: string, note: string): number => {
    ctx.textAlign = 'left';
    ctx.fillStyle = C.amber;
    ctx.font = 'bold 9px monospace';
    ctx.fillText(title, x, y + 8);
    ctx.fillStyle = C.textDim;
    ctx.font = '7px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(note, x + colW, y + 8);
    ctx.fillStyle = C.amberDim;
    ctx.fillRect(x, y + 12, colW, 1);
    return y + 17;
  };
  // Shared row painter: panel + border + title/value + optional
  // sub-line (sub === '' → single-line row, title vertically centered).
  const row = (
    x: number, y: number, h: number, enabled: boolean,
    title: string, value: string, sub: string,
  ): void => {
    ctx.fillStyle = enabled ? C.panel : C.bgDeep;
    ctx.fillRect(x, y, colW, h);
    ctx.strokeStyle = enabled ? C.amberDark : C.textDim;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, colW - 1, h - 1);
    const titleY = sub ? y + 11 : y + h / 2 + 3;
    ctx.textAlign = 'left';
    ctx.fillStyle = enabled ? C.text : C.textDim;
    ctx.font = 'bold 9px monospace';
    ctx.fillText(title, x + 6, titleY);
    ctx.textAlign = 'right';
    ctx.fillStyle = enabled ? C.amber : C.textDim;
    ctx.fillText(value, x + colW - 6, titleY);
    if (sub) {
      ctx.textAlign = 'left';
      ctx.fillStyle = enabled ? C.textMute : C.textDim;
      ctx.font = '7px monospace';
      ctx.fillText(sub, x + 6, y + h - 6);
    }
  };

  // LEFT column — EAT rows then GROCERIES.
  let yL = sectionHeader(colL, 160, 'EAT', 'instant · no slot');
  const eatH = 26;
  for (const ft of FOOD_TIERS) {
    const qty = life.foodStock[ft.key] || 0;
    const canEat = qty > 0 && !life.ateToday;
    const sub = life.ateToday
      ? 'Already ate today'
      : qty > 0 ? `Health ${ft.hEffect}` : 'None in stock';
    row(colL, yL, eatH, canEat, ft.label, '×' + qty, sub);
    rects.eat.push({ x: colL, y: yL, w: colW, h: eatH });
    yL += eatH + 3;
  }
  // Single-line shop rows so the column clears the shared BACK pill
  // at GH-80 (PC HUD canvas is only 427 px tall).
  yL = sectionHeader(colL, yL + 5, 'GROCERIES', 'stock up');
  const shopH = 16;
  for (const opt of GROCERY_OPTIONS) {
    const canBuy = life.money >= opt.cost;
    row(
      colL, yL, shopH, canBuy,
      opt.store, `+${opt.qty} · $${opt.cost}`, '',
    );
    rects.shop.push({ x: colL, y: yL, w: colW, h: shopH });
    yL += shopH + 3;
  }

  // RIGHT column — GYM. 1:1 logic port of monolith L48879-48908; only
  // presentation changed (H810).
  let yR = sectionHeader(colR, 160, 'GYM', 'uses a time slot');
  const slotAvail = (life.slotsActiveToday ?? 0) < 3;
  const gymOpts = [
    { level: 1 as const, label: 'Light Workout',  cost: 0,  desc: 'FIT +2 · HP +1' },
    { level: 2 as const, label: 'Medium Workout', cost: 10, desc: 'FIT +4 · HP +2' },
    { level: 3 as const, label: 'Heavy Workout',  cost: 20, desc: 'FIT +6 · HP +3' },
  ];
  const gymH = 26;
  for (const go of gymOpts) {
    const canGym = life.money >= go.cost
      && slotAvail
      && !life.gymVisitedToday
      && (go.level < 3 || life.health >= 15);
    let desc = go.desc;
    if (go.level >= 3 && life.health < 15) desc = 'Too unhealthy!';
    else if (go.level >= 2 && life.daysSinceEat >= 2) desc += ' · hungry penalty';
    row(colR, yR, gymH, canGym, go.label, go.cost === 0 ? 'FREE' : '$' + go.cost, desc);
    rects.gym.push({ x: colR, y: yR, w: colW, h: gymH, level: go.level, canGym });
    yR += gymH + 3;
  }
  ctx.font = '7px monospace';
  ctx.textAlign = 'left';
  if (life.gymVisitedToday) {
    ctx.fillStyle = C.textMute;
    ctx.fillText('Already worked out today', colR, yR + 8);
  } else if (!slotAvail) {
    ctx.fillStyle = C.active;
    ctx.fillText('No time slots left today', colR, yR + 8);
  }

  (life as { _eatTabRects?: EatTabRects })._eatTabRects = rects;
  ctx.textAlign = 'left';
  drawBottomBack(ctx, GW, GH);
}

/** H810: GT2-style stat bar — charcoal track, amber fill (signal
 *  orange below 35%), label inside-left, value inside-right. */
function drawGt2StatBar(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number,
  label: string, pct: number,
): void {
  const C = GT2_COLORS;
  const v = Math.max(0, Math.min(100, pct || 0));
  const h = 13;
  ctx.fillStyle = C.bgDeep;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = v < 35 ? C.active : C.amber;
  ctx.fillRect(x, y, Math.round((w * v) / 100), h);
  ctx.strokeStyle = C.amberDark;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.font = 'bold 8px monospace';
  ctx.textAlign = 'left';
  // Dark text on the filled zone, light on the empty zone — label sits
  // at the left edge (almost always on fill), value at the right edge
  // (almost always on track).
  ctx.fillStyle = C.bgDeep;
  ctx.fillText(label, x + 4, y + 10);
  ctx.textAlign = 'right';
  ctx.fillStyle = C.text;
  ctx.fillText(Math.round(v) + '%', x + w - 4, y + 10);
}

/** Returns the eat-row index at (tx, ty), or -1 if none. H810: reads
 *  the draw-time rect cache instead of mirrored layout constants. */
function hitEatRow(opts: HomeOverlayOpts, tx: number, ty: number): number {
  const rects = (opts.life as { _eatTabRects?: EatTabRects })._eatTabRects;
  if (!rects) return -1;
  for (let i = 0; i < rects.eat.length; i++) {
    const r = rects.eat[i];
    if (tx >= r.x && tx <= r.x + r.w && ty >= r.y && ty <= r.y + r.h) return i;
  }
  return -1;
}

/** H38 — returns the grocery-shop-row index at (tx, ty), or -1. */
function hitShopRow(opts: HomeOverlayOpts, tx: number, ty: number): number {
  const rects = (opts.life as { _eatTabRects?: EatTabRects })._eatTabRects;
  if (!rects) return -1;
  for (let i = 0; i < rects.shop.length; i++) {
    const r = rects.shop[i];
    if (tx >= r.x && tx <= r.x + r.w && ty >= r.y && ty <= r.y + r.h) return i;
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

/** H1296: cached hit rect for a mail offer's ACCEPT/DECLINE button.
 *  carId+amount+day is the join key back to the ad's offer
 *  (findAdOfferForMail). Re-stashed every mail-tab draw. */
interface MailOfferRect {
  x: number; y: number; w: number; h: number;
  kind: 'accept' | 'decline';
  carId: string;
  amount: number;
  day: number;
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
  ctx.fillStyle = GT2_COLORS.active;
  ctx.font = 'bold 16px monospace';
  ctx.fillText('MAILBOX', GW / 2, yy);
  yy += 22;

  const mail = (life.mail || []) as MailItem[];
  // H568: viewing the mailbox marks every message read so the main-tab
  // MAIL badge clears. Matches monolith L47804 — kill the badge once
  // the player has SEEN the inbox, regardless of which row they tap.
  for (const m of mail) m.read = true;
  const offers = mail.filter((m) => m.type === 'carOffer');
  const packages = life.pendingParts || [];

  // H1296: rect cache for the offer buttons — re-stashed every draw so
  // an accepted/declined offer's buttons can't be hit stale.
  const offerRects: MailOfferRect[] = [];
  (life as { _mailOfferRects?: MailOfferRect[] })._mailOfferRects = offerRects;

  if (offers.length === 0 && packages.length === 0) {
    ctx.fillStyle = GT2_COLORS.textMute;
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
    ctx.fillStyle = GT2_COLORS.amber;
    ctx.font = 'bold 12px monospace';
    ctx.fillText('BUYER OFFERS', GW / 2, yy + 12);
    yy += 22;
    for (const m of offers) {
      // H1296: row with ACCEPT / DECLINE (user ask: offers come as mail
      // the player answers). Text left, buttons right.
      ctx.fillStyle = 'rgba(255,122,24,0.08)';
      ctx.fillRect(28, yy, GW - 56, 44);
      ctx.strokeStyle = GT2_COLORS.amber;
      ctx.lineWidth = 1;
      ctx.strokeRect(28, yy, GW - 56, 44);
      ctx.textAlign = 'left';
      ctx.fillStyle = GT2_COLORS.amber;
      ctx.font = 'bold 9px monospace';
      const nm = (m.carName || '—');
      ctx.fillText(nm.length > 22 ? nm.slice(0, 21) + '…' : nm, 36, yy + 14);
      ctx.fillStyle = GT2_COLORS.text;
      ctx.font = 'bold 11px monospace';
      const ago = Math.max(0, clock.day - (m.day || clock.day));
      ctx.fillText(`$${(m.amount || 0).toLocaleString()}`, 36, yy + 29);
      ctx.fillStyle = GT2_COLORS.textMute;
      ctx.font = '8px monospace';
      ctx.fillText(ago === 0 ? 'today' : `${ago}d ago`, 36, yy + 39);
      const key = { carId: m.carId ?? '', amount: m.amount ?? 0, day: m.day ?? 0 };
      const acc = { x: GW - 28 - 156, y: yy + 10, w: 74, h: 24 };
      const dec = { x: GW - 28 - 78, y: yy + 10, w: 70, h: 24 };
      ctx.fillStyle = 'rgba(30,120,40,0.25)';
      ctx.fillRect(acc.x, acc.y, acc.w, acc.h);
      ctx.strokeStyle = '#5c5';
      ctx.strokeRect(acc.x + 0.5, acc.y + 0.5, acc.w - 1, acc.h - 1);
      ctx.fillStyle = '#8f8';
      ctx.font = 'bold 9px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('ACCEPT', acc.x + acc.w / 2, acc.y + 15);
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(dec.x, dec.y, dec.w, dec.h);
      ctx.strokeStyle = '#888';
      ctx.strokeRect(dec.x + 0.5, dec.y + 0.5, dec.w - 1, dec.h - 1);
      ctx.fillStyle = '#aaa';
      ctx.fillText('DECLINE', dec.x + dec.w / 2, dec.y + 15);
      offerRects.push({ ...acc, kind: 'accept', ...key });
      offerRects.push({ ...dec, kind: 'decline', ...key });
      ctx.textAlign = 'center';
      yy += 48;
    }
  }

  if (packages.length > 0) {
    yy += 6;
    ctx.fillStyle = GT2_COLORS.amber;
    ctx.font = 'bold 12px monospace';
    ctx.fillText('PACKAGES', GW / 2, yy + 12);
    yy += 22;
    // Placeholder rows — parts shape isn't typed in interim port.
    for (const p of packages as Array<{ name?: string }>) {
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(28, yy, GW - 56, 30);
      ctx.strokeStyle = GT2_COLORS.amber;
      ctx.strokeRect(28, yy, GW - 56, 30);
      ctx.fillStyle = GT2_COLORS.text;
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

// ---- H868: full-bleed "physical newspaper" paper bake ----------------
/** Cream classified-paper texture baked ONCE to a module-scoped offscreen
 *  canvas (fibre grain + aged edge) and blitted each frame — NEVER
 *  regenerated per frame (perf: cost is GPU fill-call count, see
 *  project_perf_cost_model). Rebuilds only on a resize. */
let _newsPaper: HTMLCanvasElement | null = null;
let _newsPaperW = 0;
let _newsPaperH = 0;
function getNewspaperPaper(GW: number, GH: number): HTMLCanvasElement {
  if (_newsPaper && _newsPaperW === GW && _newsPaperH === GH) return _newsPaper;
  const cv = document.createElement('canvas');
  cv.width = GW;
  cv.height = GH;
  const c = cv.getContext('2d');
  _newsPaper = cv; _newsPaperW = GW; _newsPaperH = GH;
  if (!c) return cv;
  c.fillStyle = '#e8e1cf';                       // newsprint cream
  c.fillRect(0, 0, GW, GH);
  const dots = Math.min(6000, Math.floor((GW * GH) / 700));
  for (let i = 0; i < dots; i++) {                // fibre specks
    c.fillStyle = Math.random() < 0.5 ? 'rgba(60,50,30,0.05)' : 'rgba(255,255,255,0.06)';
    c.fillRect(Math.random() * GW, Math.random() * GH, 1, 1);
  }
  const g = c.createRadialGradient(GW / 2, GH / 2, Math.min(GW, GH) * 0.32, GW / 2, GH / 2, Math.max(GW, GH) * 0.62);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(120,100,60,0.16)');     // aged edge
  c.fillStyle = g;
  c.fillRect(0, 0, GW, GH);
  return cv;
}

/** Newspaper ink palette — deliberately NOT GT2 amber; this screen is a
 *  physical paper sheet for immersion. */
const NEWS_INK = '#23201a';
const NEWS_INK_BODY = '#3c362b';
const NEWS_INK_MUTE = '#7c7464';
const NEWS_RULE = 'rgba(35,32,26,0.55)';
const NEWS_RULE_HAIR = 'rgba(35,32,26,0.26)';
const NEWS_SERIF = "Georgia, 'Times New Roman', serif";

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
function drawNewspaperTab(ctx: CanvasRenderingContext2D, GW: number, GH: number, life: LifeState, clock: Clock): void {
  // Full-bleed cream paper sheet (covers the GT2 home chrome for immersion).
  ctx.drawImage(getNewspaperPaper(GW, GH), 0, 0);

  // Masthead.
  ctx.textAlign = 'center';
  ctx.fillStyle = NEWS_INK;
  ctx.font = `bold ${Math.round(GW * 0.066)}px ${NEWS_SERIF}`;
  ctx.fillText('The Charlotte Observer', GW / 2, 64);
  // Double masthead rule.
  ctx.strokeStyle = NEWS_RULE;
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(24, 78); ctx.lineTo(GW - 24, 78); ctx.stroke();
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(24, 83); ctx.lineTo(GW - 24, 83); ctx.stroke();
  // Dateline row: date (left) · CLASSIFIEDS (center) · price (right).
  ctx.fillStyle = NEWS_INK_MUTE;
  ctx.font = `italic 10px ${NEWS_SERIF}`;
  ctx.textAlign = 'left';
  ctx.fillText(getDateString(clock.day), 26, 98);
  ctx.textAlign = 'right';
  ctx.fillText('Late Edition · 25¢', GW - 26, 98);
  ctx.textAlign = 'center';
  ctx.fillStyle = NEWS_INK;
  ctx.font = `bold 12px ${NEWS_SERIF}`;
  ctx.fillText('C L A S S I F I E D S', GW / 2, 98);
  ctx.strokeStyle = NEWS_RULE_HAIR;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(24, 106); ctx.lineTo(GW - 24, 106); ctx.stroke();

  // Section tabs — ink, underline-active (geometry unchanged for hit-tests).
  const tabs: { label: string; key: 'cars' | 'homes' }[] = [
    { label: 'AUTOMOBILES', key: 'cars' },
    { label: 'REAL ESTATE', key: 'homes' },
  ];
  const tabsTotalW = tabs.length * NEWS_TAB_W + (tabs.length - 1) * NEWS_TAB_GAP;
  const tabX0 = GW / 2 - tabsTotalW / 2;
  for (let i = 0; i < tabs.length; i++) {
    const t = tabs[i];
    const x = tabX0 + i * (NEWS_TAB_W + NEWS_TAB_GAP);
    const active = life.newspaperSection === t.key;
    ctx.fillStyle = active ? NEWS_INK : NEWS_INK_MUTE;
    ctx.font = `bold ${active ? 12 : 11}px ${NEWS_SERIF}`;
    ctx.textAlign = 'center';
    ctx.fillText(t.label, x + NEWS_TAB_W / 2, NEWS_TAB_Y + 18);
    if (active) {
      ctx.strokeStyle = NEWS_INK;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x + 10, NEWS_TAB_Y + 24);
      ctx.lineTo(x + NEWS_TAB_W - 10, NEWS_TAB_Y + 24);
      ctx.stroke();
    }
  }
  let yy = NEWS_ROW_TOP;

  // Filter and render.
  const all = life.newspaper || [];
  const filtered: NewspaperListing[] = life.newspaperSection === 'homes'
    ? all.filter((l): l is HouseListing => l.type === 'house')
    : all.filter((l): l is CarListing => l.type === 'car');

  if (filtered.length === 0) {
    ctx.fillStyle = NEWS_INK_BODY;
    ctx.font = `italic 13px ${NEWS_SERIF}`;
    ctx.textAlign = 'center';
    ctx.fillText('No listings in today’s paper.', GW / 2, yy + 24);
    ctx.fillStyle = NEWS_INK_MUTE;
    ctx.font = `11px ${NEWS_SERIF}`;
    ctx.fillText('A fresh edition prints each morning.', GW / 2, yy + 44);
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
    ctx.fillStyle = NEWS_INK_MUTE;
    ctx.font = `italic 9px ${NEWS_SERIF}`;
    ctx.textAlign = 'center';
    ctx.fillText(`continued — ${filtered.length - maxRows} more listings inside`, GW / 2, yy + 8);
    yy += 14;
  }

  // Footer hint.
  ctx.fillStyle = NEWS_INK_MUTE;
  ctx.font = `italic 9px ${NEWS_SERIF}`;
  ctx.textAlign = 'center';
  ctx.fillText('Circle a listing to track it · Fresh paper daily', GW / 2, yy + 14);

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
  // Classified ad on cream: hairline divider, ink type, no neon box.
  ctx.strokeStyle = NEWS_RULE_HAIR;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(rowX, yy); ctx.lineTo(rowX + rowW, yy); ctx.stroke();

  ctx.textAlign = 'left';
  const tx = rowX + 2;
  if (listing.isPinned) {
    ctx.fillStyle = NEWS_INK;
    ctx.font = `bold 12px ${NEWS_SERIF}`;
    ctx.fillText('★', rowX, yy + 16);
  }
  ctx.fillStyle = NEWS_INK;
  ctx.font = `bold 12px ${NEWS_SERIF}`;
  const name = listing.name.length > 38 ? listing.name.slice(0, 37) + '…' : listing.name;
  ctx.fillText(name, tx + (listing.isPinned ? 14 : 0), yy + 16);

  ctx.fillStyle = NEWS_INK_BODY;
  ctx.font = `10px ${NEWS_SERIF}`;
  const condTxt = listing.isNew ? 'NEW' : `${listing.cond}% cond`;
  const mileTxt = listing.isNew ? '' : ` · ${listing.mileage.toLocaleString()} mi`;
  ctx.fillText(`${condTxt}${mileTxt} · ${listing.hp} hp`, tx, yy + 30);

  ctx.fillStyle = NEWS_INK_MUTE;
  ctx.font = `italic 9px ${NEWS_SERIF}`;
  const note = listing.problem ? listing.problem : listing.isNew ? 'Dealer-fresh, clean title' : 'Private seller';
  ctx.fillText(note, tx, yy + 43);

  ctx.textAlign = 'right';
  ctx.fillStyle = NEWS_INK;
  ctx.font = `bold 14px ${NEWS_SERIF}`;
  ctx.fillText(`$${listing.price.toLocaleString()}`, rowX + rowW - 4, yy + 18);
  ctx.fillStyle = NEWS_INK_MUTE;
  ctx.font = `italic 9px ${NEWS_SERIF}`;
  ctx.fillText(affordable ? 'within reach' : 'out of reach', rowX + rowW - 4, yy + 32);
  ctx.textAlign = 'left';
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
  ctx.strokeStyle = NEWS_RULE_HAIR;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(rowX, yy); ctx.lineTo(rowX + rowW, yy); ctx.stroke();

  ctx.textAlign = 'left';
  const tx = rowX + 2;
  if (listing.isPinned) {
    ctx.fillStyle = NEWS_INK;
    ctx.font = `bold 12px ${NEWS_SERIF}`;
    ctx.fillText('★', rowX, yy + 16);
  }
  ctx.fillStyle = NEWS_INK;
  ctx.font = `bold 12px ${NEWS_SERIF}`;
  ctx.fillText(listing.name, tx + (listing.isPinned ? 14 : 0), yy + 16);

  ctx.fillStyle = NEWS_INK_BODY;
  ctx.font = `10px ${NEWS_SERIF}`;
  ctx.fillText(listing.address, tx, yy + 30);

  ctx.fillStyle = NEWS_INK_MUTE;
  ctx.font = `italic 9px ${NEWS_SERIF}`;
  const tag = listing.isRental
    ? `For rent · ${listing.slots} room${listing.slots === 1 ? '' : 's'}`
    : `For sale · ${listing.slots} room${listing.slots === 1 ? '' : 's'}`;
  ctx.fillText(tag, tx, yy + 43);

  ctx.textAlign = 'right';
  ctx.fillStyle = NEWS_INK;
  ctx.font = `bold 14px ${NEWS_SERIF}`;
  ctx.fillText(
    listing.isRental ? `$${listing.price.toLocaleString()}/mo` : `$${listing.price.toLocaleString()}`,
    rowX + rowW - 4, yy + 18,
  );
  ctx.fillStyle = NEWS_INK_MUTE;
  ctx.font = `italic 9px ${NEWS_SERIF}`;
  ctx.fillText(
    listing.isRental ? (affordable ? 'within reach' : 'out of reach') : `~$${listing.monthlyEst.toLocaleString()}/mo mortgage`,
    rowX + rowW - 4, yy + 32,
  );
  ctx.textAlign = 'left';
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
  // H810: GT2 amber pill — matches the H733/H734 per-tab BACK buttons
  // (this shared helper was the last cyan-terminal holdout). Geometry
  // unchanged (GH-80, 120×32) — the shared hit test keys off it.
  const bx = GW / 2 - 60;
  const by = GH - 80;
  ctx.fillStyle = GT2_COLORS.amber;
  fillRoundRectHome(ctx, bx, by, 120, 32, 5);
  ctx.fillStyle = GT2_COLORS.bgDeep;
  ctx.font = 'bold 13px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('← BACK', GW / 2, by + 21);
  ctx.textAlign = 'left';
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
  // H1149: RELAX | SLEEP are ALWAYS shown as two 8-hour-block advances.
  // Was: a single full-width "SLEEP / End day" pill once all three slots
  // were used. Per the user's model a slot is just an 8-hour block — sleep
  // always advances one, and from the NIGHT slot that block wraps to the
  // next day's morning (doSleep/doRelax roll the day). Framed as a normal
  // advance ("To Morning"), never a special day-ender. The fixed two-button
  // geometry also lets the controller focus cursor land on them
  // (layoutSleepButtons feeds both this paint and layoutFocusButtons).
  const rects = layoutSleepButtons(GW, GH);
  const nextNames: Record<'morning' | 'afternoon' | 'night', string> = {
    morning: 'Morning', afternoon: 'Afternoon', night: 'Night',
  };
  // Wrap: from the night slot nextUnusedSlot() is null → the next block is
  // tomorrow morning.
  const next = nextUnusedSlot(life) ?? 'morning';
  const nextLabel = nextNames[next];
  const [relax, sleep] = rects;

  // LEFT — RELAX (half rest). H737: both pills take the regular amber face
  // — the label says what each does; dark face is reserved for focus.
  ctx.fillStyle = GT2_COLORS.amber;
  fillRoundRectHome(ctx, relax.x, relax.y, relax.w, relax.h, 5);
  ctx.fillStyle = GT2_COLORS.bgDeep;
  ctx.font = 'bold 12px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('🛋 RELAX', relax.x + relax.w / 2, relax.y + 14);
  ctx.font = '8px monospace';
  ctx.fillText('To ' + nextLabel + ' (half rest)', relax.x + relax.w / 2, relax.y + 26);

  // RIGHT — SLEEP (full rest).
  ctx.fillStyle = GT2_COLORS.amber;
  fillRoundRectHome(ctx, sleep.x, sleep.y, sleep.w, sleep.h, 5);
  ctx.fillStyle = GT2_COLORS.bgDeep;
  ctx.font = 'bold 12px monospace';
  ctx.fillText('😴 SLEEP', sleep.x + sleep.w / 2, sleep.y + 14);
  ctx.font = '8px monospace';
  ctx.fillText('To ' + nextLabel + ' (full rest)', sleep.x + sleep.w / 2, sleep.y + 26);

  ctx.textAlign = 'left';
  (life as { _sleepBtns?: typeof rects })._sleepBtns = rects;
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
  GH: number,
): void {
  // Safe-top inset (5 % vh) — pushes the portrait + title + status
  // strip clear of the upper camera-punch band on devices like the
  // Samsung S24+ where the front camera lives in the top-center of
  // the display. dy is added to every y-coordinate in this header so
  // the internal layout stays intact.
  const safeTop = Math.max(GH * 0.05, 4);
  const dy = safeTop - 4;

  // Portrait swatch top-left.
  const portraitSize = 28;
  drawCharacterBase(ctx, life.gender, life.fitness, life.skinTone, 4, 4 + dy, portraitSize);
  ctx.strokeStyle = GT2_COLORS.amber;
  ctx.lineWidth = 1;
  ctx.strokeRect(4, 4 + dy, portraitSize, portraitSize);

  // Title — italic display "HOME" instead of the emoji + label, to
  // match GT2's poster header treatment (H732).
  ctx.textAlign = 'center';
  ctx.fillStyle = GT2_COLORS.text;
  ctx.font = 'italic bold 18px monospace';
  // H1247: the same screen serves a pit box; name it for where you are.
  ctx.fillText(atTrackPit() ? 'PIT GARAGE' : 'HOME', GW / 2 + 14, 22 + dy);

  // Name + age + date.
  ctx.fillStyle = GT2_COLORS.textMute;
  ctx.font = '11px monospace';
  ctx.fillText(
    (life.playerAlias || 'NO NAME') + ' (' + life.age + ') — ' + getDateString(clock.day),
    GW / 2, 36 + dy,
  );

  // Cash — Cr coin convention (matches the GT2 modals landed H726-H731).
  ctx.fillStyle = GT2_COLORS.amber;
  ctx.font = 'bold 12px monospace';
  ctx.fillText('$' + life.money.toLocaleString(), GW / 2, 50 + dy);

  // Compact health bar at top-right.
  const hStatus = getHealthStatus(life.health);
  const hbW = 60, hbH = 6;
  const hbX = GW - hbW - 8;
  const hbY = 44 + dy;
  ctx.fillStyle = '#333';
  ctx.fillRect(hbX, hbY, hbW, hbH);
  ctx.fillStyle = hStatus.color;
  ctx.fillRect(hbX, hbY, Math.round(hbW * (life.health / 100)), hbH);
  ctx.fillStyle = hStatus.color;
  ctx.font = '7px monospace';
  ctx.textAlign = 'right';
  ctx.fillText(hStatus.icon + Math.round(life.health) + '%', hbX - 2, hbY + 5);
  ctx.textAlign = 'center';

  // Housing + bills summary line. H1247: rent, car payments and total debt are
  // home-screen concerns — a pit box shows the driver and their cash, nothing
  // else, so the header stops here at a track.
  if (atTrackPit()) { ctx.textAlign = 'left'; return; }
  const housingCost = monthlyHousing(life);
  const carPay = monthlyCarPayments(life);
  const totalBills = housingCost + carPay;
  const daysUntilBill = daysUntilNextBilling(clock.day);
  ctx.fillStyle = GT2_COLORS.textMute;
  ctx.font = '9px monospace';
  const housingName = HOUSING_TIERS[life.housingType as HousingTierKey]?.name ?? life.housingType;
  const billLine = carPay > 0
    ? 'Bills: $' + totalBills.toLocaleString() + ' / mo · ' + daysUntilBill + 'd left'
    : housingName + ' · $' + housingCost.toLocaleString() + ' / mo · ' + daysUntilBill + 'd';
  ctx.fillText(billLine, GW / 2, 62 + dy);

  // Cars-breakdown sub-line. Only shows when there are car loans.
  let totalDebtY = 72 + dy;
  if (carPay > 0) {
    ctx.fillStyle = GT2_COLORS.textDim;
    ctx.font = '8px monospace';
    ctx.fillText('rent $' + housingCost + ' + cars $' + carPay, GW / 2, 71 + dy);
    totalDebtY = 80 + dy;
  }

  // Total debt line (mortgage + car loans + bank loans).
  const totalDebt = (life.mortgageBalance ?? 0)
    + totalCarLoansOwed(life)
    + totalBankLoansOwed(life);
  if (totalDebt > 0) {
    ctx.fillStyle = '#ff7a7a';
    ctx.font = '8px monospace';
    ctx.fillText('Total debt: $' + totalDebt.toLocaleString(), GW / 2, totalDebtY);
  }

  // Reputation bars — WORK on left, STREET on right. Only WORK
  // shows when the player has a job (no rep math otherwise).
  // Bar colors stay semantic (red→yellow→green) so the player can
  // read tier at a glance even on a charcoal backplate.
  const repY = 84 + dy;
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
  GH: number,
): void {
  // Safe-top inset so the money line + slot indicator don't sit under
  // a top-center camera punch. Sub-tabs (GARAGE / BILLS / NEWSPAPER /
  // EAT / CALENDAR / MAIL) all use this header.
  const safeTop = Math.max(GH * 0.05, 4);
  const dy = safeTop - 4;
  ctx.textAlign = 'center';
  ctx.fillStyle = GT2_COLORS.amber;
  ctx.font = 'bold 11px monospace';
  ctx.fillText('$' + life.money.toLocaleString(), GW / 2, 14 + dy);
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
    GW / 2, 26 + dy,
  );
}

function drawMainButtons(ctx: CanvasRenderingContext2D, GW: number, GH: number, life: LifeState, clock: Clock): void {
  const buttons = layoutMainButtons(GW, GH);
  ctx.font = 'bold 14px monospace';
  ctx.textAlign = 'center';
  for (const b of buttons) {
    // H737: All tiles take the regular amber face per the button-
    // state policy (dark = selected/focused, NOT random emphasis,
    // NOT disabled). Close was previously active-orange; disabled
    // tabs were previously amberDim — both wrong. Disabled state
    // is now communicated via textDim label.
    ctx.fillStyle = GT2_COLORS.amber;
    fillRoundRectHome(ctx, b.x, b.y, b.w, b.h, 6);
    ctx.fillStyle = b.enabled ? GT2_COLORS.bgDeep : GT2_COLORS.textDim;
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
    if (b.enabled && b.tab !== 'close' && b.tab !== 'main'
        && b.tab !== 'race' && b.tab !== 'catalog') {
      const badge = computeTabBadge(b.tab, life, clock);
      if (badge) drawTabBadge(ctx, b.x + b.w, b.y, badge);
    }
  }
  ctx.fillStyle = GT2_COLORS.textDim;
  ctx.font = '11px monospace';
  ctx.fillText('Press H or tap EXIT to close', GW / 2, GH - 18);
  ctx.font = 'bold 14px monospace';
}

// H1030/H1086: race-picker modal (opened by the RACE button). Self-contained
// like the sell-confirm / bank-loan modals — drawn on top, eats all taps. The
// venue list is now DYNAMIC (listMaps().inRacePicker) so new circuits appear
// automatically: the test tracks (drag/oval/meet) plus the real circuits
// (Monza/Spa/Watkins/Laguna). Laid out as a 2-column grid.
interface PickRect { x: number; y: number; w: number; h: number }
interface PickCell extends PickRect { map: MapDef }
const RP_COLS = 2;

/** A venue that awards rep/money against a random rival burns the one-race-per-
 *  day cap (the drag strip + oval). Solo lap circuits, touge sprints, and the
 *  meet-challenge (autoStage:false) are free — no rival, no cap. */
function raceIsDailyCapped(m: MapDef): boolean {
  return !!m.race && !m.race.solo && m.race.kind !== 'sprint' && m.race.autoStage !== false;
}

/** H1247: at a track, RACE picks WHAT TO DO here, not where to go. */
export const TRACK_MODES: ReadonlyArray<{ mode: TrackMode; label: string; sub: string }> = [
  { mode: 'testlap', label: '🏁 TEST LAP', sub: 'Open track · learn it · no timer pressure' },
  { mode: 'qualify', label: '⏱ QUALIFY', sub: 'One flying lap · sets your grid slot' },
  { mode: 'race',    label: '🚦 START RACE', sub: 'Full grid · standing start' },
];

interface ModeCell extends PickRect { mode: TrackMode; label: string; sub: string }

function trackModeLayout(GW: number, GH: number): { box: PickRect; cells: ModeCell[]; cancel: PickRect } {
  const w = 340;
  const padTop = 52, btnH = 46, gap = 10, cancelH = 32, padBot = 16, subGap = 12;
  const gridH = TRACK_MODES.length * btnH + (TRACK_MODES.length - 1) * gap;
  const h = padTop + gridH + subGap + cancelH + padBot;
  const x = GW / 2 - w / 2, y = GH / 2 - h / 2;
  const inner = w - 40, gx = x + 20, gy = y + padTop;
  return {
    box: { x, y, w, h },
    cells: TRACK_MODES.map((m, i) => ({
      ...m, x: gx, y: gy + i * (btnH + gap), w: inner, h: btnH,
    })),
    cancel: { x: gx, y: y + h - padBot - cancelH, w: inner, h: cancelH },
  };
}

function racePickerLayout(GW: number, GH: number): { box: PickRect; cells: PickCell[]; cancel: PickRect } {
  const entries = listMaps().filter((m) => m.inRacePicker);
  const rows = Math.max(1, Math.ceil(entries.length / RP_COLS));
  const w = 384;
  const padTop = 52, btnH = 44, gap = 10, cancelH = 32, padBot = 16, subGap = 12;
  const gridH = rows * btnH + (rows - 1) * gap;
  const h = padTop + gridH + subGap + cancelH + padBot;
  const x = GW / 2 - w / 2, y = GH / 2 - h / 2;
  const inner = w - 40, colGap = 12;
  const bw = (inner - (RP_COLS - 1) * colGap) / RP_COLS;
  const gx = x + 20, gy = y + padTop;
  const cells: PickCell[] = entries.map((m, i) => {
    const c = i % RP_COLS, r = Math.floor(i / RP_COLS);
    return { map: m, x: gx + c * (bw + colGap), y: gy + r * (btnH + gap), w: bw, h: btnH };
  });
  return {
    box: { x, y, w, h },
    cells,
    cancel: { x: gx, y: y + h - padBot - cancelH, w: inner, h: cancelH },
  };
}

function drawRacePickerModal(ctx: CanvasRenderingContext2D, GW: number, GH: number, life: LifeState, clock: Clock): void {
  if (atTrackPit()) { drawTrackModeModal(ctx, GW, GH, life); return; }
  const L = racePickerLayout(GW, GH);
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 0, GW, GH);
  ctx.fillStyle = GT2_COLORS.bgDeep;
  fillRoundRectHome(ctx, L.box.x, L.box.y, L.box.w, L.box.h, 8);
  ctx.strokeStyle = GT2_COLORS.amber;
  ctx.lineWidth = 2;
  ctx.strokeRect(L.box.x, L.box.y, L.box.w, L.box.h);
  ctx.textAlign = 'center';
  ctx.fillStyle = GT2_COLORS.amber;
  ctx.font = 'bold 15px monospace';
  ctx.fillText('🏁 RACE / PRACTICE', GW / 2, L.box.y + 26);
  const racedToday = life.lastRaceDay === clock.day;
  ctx.fillStyle = '#9ac';
  ctx.font = '10px monospace';
  ctx.fillText('Circuits = free solo lap times · drag/oval = vs rival, once/day', GW / 2, L.box.y + 42);
  for (const cell of L.cells) {
    const disabled = raceIsDailyCapped(cell.map) && racedToday;
    ctx.fillStyle = disabled ? '#333' : GT2_COLORS.amber;
    fillRoundRectHome(ctx, cell.x, cell.y, cell.w, cell.h, 6);
    ctx.fillStyle = disabled ? '#888' : GT2_COLORS.bgDeep;
    ctx.font = 'bold 12px monospace';
    ctx.fillText(cell.map.menuLabel ?? cell.map.name, cell.x + cell.w / 2, cell.y + 19);
    ctx.font = '9px monospace';
    ctx.fillText(disabled ? 'raced today' : (cell.map.menuSub ?? ''), cell.x + cell.w / 2, cell.y + 33);
  }
  ctx.fillStyle = '#333';
  fillRoundRectHome(ctx, L.cancel.x, L.cancel.y, L.cancel.w, L.cancel.h, 5);
  ctx.fillStyle = '#ccc';
  ctx.font = 'bold 12px monospace';
  ctx.fillText('CANCEL', GW / 2, L.cancel.y + L.cancel.h / 2 + 4);
}

function drawTrackModeModal(ctx: CanvasRenderingContext2D, GW: number, GH: number, life: LifeState): void {
  const L = trackModeLayout(GW, GH);
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 0, GW, GH);
  ctx.fillStyle = GT2_COLORS.bgDeep;
  fillRoundRectHome(ctx, L.box.x, L.box.y, L.box.w, L.box.h, 8);
  ctx.strokeStyle = GT2_COLORS.amber;
  ctx.lineWidth = 2;
  ctx.strokeRect(L.box.x, L.box.y, L.box.w, L.box.h);
  ctx.textAlign = 'center';
  ctx.fillStyle = GT2_COLORS.amber;
  ctx.font = 'bold 15px monospace';
  ctx.fillText('🏁 GO TO TRACK', GW / 2, L.box.y + 26);
  ctx.fillStyle = '#9ac';
  ctx.font = '10px monospace';
  ctx.fillText('Pick a session, then drive out and stop on the start line', GW / 2, L.box.y + 42);
  for (const cell of L.cells) {
    const sel = life._trackMode === cell.mode;
    ctx.fillStyle = sel ? '#ffd98a' : GT2_COLORS.amber;
    fillRoundRectHome(ctx, cell.x, cell.y, cell.w, cell.h, 6);
    ctx.fillStyle = GT2_COLORS.bgDeep;
    ctx.font = 'bold 13px monospace';
    ctx.fillText(cell.label, cell.x + cell.w / 2, cell.y + 20);
    ctx.font = '9px monospace';
    ctx.fillText(cell.sub, cell.x + cell.w / 2, cell.y + 34);
  }
  ctx.fillStyle = '#333';
  fillRoundRectHome(ctx, L.cancel.x, L.cancel.y, L.cancel.w, L.cancel.h, 5);
  ctx.fillStyle = '#ccc';
  ctx.font = 'bold 12px monospace';
  ctx.fillText('CANCEL', GW / 2, L.cancel.y + L.cancel.h / 2 + 4);
}

function handleRacePickerClick(tx: number, ty: number, opts: HomeOverlayOpts, deps: HomeOverlayDeps): void {
  // H1247: at a track this modal picks a SESSION, and choosing one closes the
  // whole overlay — you're getting in the car and driving out to the line.
  if (atTrackPit()) {
    const M = trackModeLayout(opts.GW, opts.GH);
    const hit = (b: PickRect): boolean => tx >= b.x && tx <= b.x + b.w && ty >= b.y && ty <= b.y + b.h;
    if (hit(M.cancel)) { opts.life._racePickerOpen = false; return; }
    for (const cell of M.cells) {
      if (!hit(cell)) continue;
      opts.life._trackMode = cell.mode;
      opts.life._racePickerOpen = false;
      deps.close();
      return;
    }
    return;
  }
  const L = racePickerLayout(opts.GW, opts.GH);
  const within = (b: PickRect): boolean => tx >= b.x && tx <= b.x + b.w && ty >= b.y && ty <= b.y + b.h;
  if (within(L.cancel)) { opts.life._racePickerOpen = false; return; }
  const racedToday = opts.life.lastRaceDay === opts.clock.day;
  for (const cell of L.cells) {
    if (!within(cell)) continue;
    if (raceIsDailyCapped(cell.map) && racedToday) return; // eat the tap, stay open
    opts.life._racePickerOpen = false;
    deps.startRace?.(cell.map.id);
    return;
  }
  // Otherwise the modal eats the tap (stays open).
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

  // H1030: race-picker modal eats every tap while open (before the tab-body
  // handlers below), so a stray tap can't close the home tab under it.
  if (opts.life._racePickerOpen) {
    handleRacePickerClick(tx, ty, opts, deps);
    return true;
  }

  if (opts.tab !== 'main') {
    // H1082: calendar day-detail sub-view — its BACK returns to the
    // month grid (clears _calSelectedDay), NOT the main tab. Intercepted
    // before the generic tab-back below so the detail's own BACK (same
    // screen position) doesn't close the whole calendar. Swallows every
    // other tap while the detail is open.
    if (opts.tab === 'calendar' && opts.life._calSelectedDay != null) {
      const db = opts.life._calDetailBackRect;
      if (db && tx >= db.x && tx <= db.x + db.w && ty >= db.y && ty <= db.y + db.h) {
        opts.life._calSelectedDay = null;
      }
      return true;
    }
    // H162: garage SPECS sub-view has its OWN back button that returns
    // to the list, not the main tab picker. Intercept before the
    // generic tab back-button below so the specs-back tap doesn't fall
    // through and close the whole garage. SPECS back rect stashed on
    // life by drawGarageSpecsView each frame.
    if (opts.tab === 'garage' && opts.life._garageView === 'specs') {
      // H878: SPECS is a read-only spec sheet (tuning moved to the UPGRADE
      // screen). Interactive: the BACK button + the H1284 X-RAY toggle;
      // other taps are eaten so a stray tap doesn't close the panel.
      const inR = (r?: { x: number; y: number; w: number; h: number }): boolean =>
        !!r && tx >= r.x && tx <= r.x + r.w && ty >= r.y && ty <= r.y + r.h;

      // H1298: live INSPECT session is modal over SPECS. Screen BACK routes
      // to the results summary first ("[player leaves inspection menus] →
      // Inspection Results" — the user's flow), CLOSE ends the session.
      const ist = (opts.life as { _inspectState?: InspectState })._inspectState;
      if (ist) {
        const ir = (opts.life as { _inspectRects?: InspectRects })._inspectRects;
        const sBackI = opts.life._garageSpecsBackRect as
          { x: number; y: number; w: number; h: number } | undefined;
        if (ist.view !== 'results' && inR(sBackI)) { ist.view = 'results'; return true; }
        // H1299: entering any component focus prints its access line; the
        // session's FIRST focus also runs the floor check (spec §4) — the
        // "no leaks are seen on the garage floor" line.
        // H1300: inspection tool ownership shapes access + odds.
        const _toolbox = ensureToolbox(opts.life);
        const _hasTool = (id: string): boolean => _toolbox.some((t) => t.id === id && (t.qty ?? 1) > 0);
        const hasLift = _hasTool('two_post_lift');
        const hasScope = _hasTool('borescope');
        const hasImpact = _hasTool('impact_wrench');
        const enterComp = (comp: XrayComponentId): void => {
          ist.view = comp;
          // H1304: opening a panel is NOT inspecting it. The condition color
          // is earned per SUB-CHECK below (markSubChecked), so backing
          // straight out of a component leaves it honestly gray.
          const meta2 = INSPECT_COMPONENTS[comp];
          ist.lines = [hasLift && meta2.accessLift ? meta2.accessLift : meta2.access];
          if (!ist.rolled['_floor']) {
            ist.rolled['_floor'] = true;
            const leaks = inspectFaultIds(opts.life, ['oil_leak', 'oil_pan_gasket'], () => 0.25);
            if (leaks.length > 0) {
              inspectLine(ist, "There's a fresh oil spot on the garage floor — something is leaking.");
              ist.results.push(...leaks);
            } else {
              inspectLine(ist, 'No leaks are seen on the garage floor.');
            }
          }
        };
        if (ist.view === 'overview') {
          for (const cr of ir?.comps ?? []) {
            if (inR(cr)) { enterComp(cr.comp); return true; }
          }
          if (inR(ir?.done)) { ist.view = 'results'; return true; }
          // Anywhere else on the car = BODY (the outline is the component).
          if (inR(ir?.band)) { enterComp('body'); return true; }
          return true;
        }
        if (ist.view !== 'results') {
          // A component focus view.
          if (inR(ir?.backComp)) { ist.view = 'overview'; return true; }
          const subsDef = INSPECT_SUBS[ist.view as XrayComponentId] ?? [];
          for (const s of ir?.subs ?? []) {
            if (!inR(s)) continue;
            const sub = subsDef.find((e) => e.key === s.key);
            if (!sub) return true;
            // liftOnly (frame rails): without the Two-Post Lift it's a
            // repeatable info line, no roll, no latch. With the lift the
            // sub inspects like any other (H1300).
            if (sub.liftOnly && !hasLift) { inspectLine(ist, 'You need the car on a proper lift to check that.'); return true; }
            // H1299: session latch + per-car per-sub DAILY latch — a failed
            // look stays failed until tomorrow (spec §5, user-approved).
            const daily = inspectDailyLatch(opts.life, opts.clock.day, ist.carId);
            if (ist.rolled[sub.key] || daily[sub.key]) {
              inspectLine(ist, 'You already checked that today.');
              return true;
            }
            ist.rolled[sub.key] = true;
            daily[sub.key] = true;
            // H1304: THIS is what earns the component its X-ray color —
            // a check that actually happened, recorded persistently so it
            // survives midnight and the save.
            markSubChecked(opts.life, ist.carId, ist.view as XrayComponentId, sub.key);
            if (sub.ids.length === 0) { inspectLine(ist, sub.clean); return true; }
            // The roll (spec §4): base detectChance + the fault's OWN
            // category skill; underside subs pay the jack penalty OR get
            // the lift bonus; borescope helps engine internals; wheel-off
            // subs need the impact wrench (or lift) for a real look.
            // H1300: the lift also unlocks the underside-VISUAL subset of
            // test-drive-only faults (LIFT_VISIBLE_TD_IDS).
            const allowTD: string[] = [];
            if ((hasLift && (sub.underside || sub.liftOnly))
                || ((hasImpact || hasLift) && sub.wheelOff)) {
              for (const id of sub.ids) if (LIFT_VISIBLE_TD_IDS.includes(id)) allowTD.push(id);
            }
            // H1304: snapshot BEFORE the roll so a miss can be told from a
            // genuinely clean part — the prose must not say "pan is dry"
            // while the X-ray honestly refuses to color it.
            const couldFind = (opts.life._hiddenFaults ?? []).some((h) => {
              const hid = (h as { id?: string }).id;
              const td = (h as { testDriveOnly?: boolean }).testDriveOnly === true;
              return !!hid && sub.ids.includes(hid) && (!td || allowTD.includes(hid));
            });
            const names = inspectFaultIds(opts.life, sub.ids, (f) => {
              const skill = getCatSkill(opts.life, categoryForFault({ id: f.id }));
              let p = (f.detectChance ?? 0.5) + skill * 0.003;
              if (sub.underside) p += hasLift ? 0.15 : -0.10;
              if (sub.scope && hasScope) p += 0.15;
              if (sub.wheelOff && !(hasImpact || hasLift)) p = Math.min(p, 0.15);
              return Math.max(0.05, Math.min(0.95, p));
            }, allowTD);
            if (names.length > 0) {
              inspectLine(ist, sub.found);
              ist.results.push(...names);
            } else if (hasHiddenTestDriveFault(opts.life, sub.ids.filter((id) => !allowTD.includes(id)))) {
              inspectLine(ist, "Can't tell while it's parked — worth a test drive.");
            } else if (couldFind) {
              // The roll missed something it could have caught. Don't hand
              // the player a clean bill of health the X-ray won't back up.
              inspectLine(ist, "Nothing obvious — but you're not satisfied with that look.");
            } else {
              inspectLine(ist, sub.clean);
            }
            return true;
          }
          return true;
        }
        // view === 'results'
        if (inR(ir?.close)) {
          (opts.life as { _inspectState?: InspectState })._inspectState = undefined;
          return true;
        }
        return true;
      }

      const sBack = opts.life._garageSpecsBackRect as {
        x: number; y: number; w: number; h: number;
      } | undefined;
      if (sBack && tx >= sBack.x && tx <= sBack.x + sBack.w && ty >= sBack.y && ty <= sBack.y + sBack.h) {
        opts.life._garageView = 'list';
        return true;
      }
      const xr = (opts.life as { _garageSpecsXrayRect?: { x: number; y: number; w: number; h: number } })
        ._garageSpecsXrayRect;
      if (xr && tx >= xr.x && tx <= xr.x + xr.w && ty >= xr.y && ty <= xr.y + xr.h) {
        const l = opts.life as { _garageSpecsXray?: boolean };
        l._garageSpecsXray = l._garageSpecsXray !== true;
        return true;
      }
      // H1298: INSPECT chip — starts a session (active car only in H-A;
      // costs a time slot, the gym pattern, user-approved).
      const inspR = (opts.life as { _garageSpecsInspectRect?: { x: number; y: number; w: number; h: number } })
        ._garageSpecsInspectRect;
      if (inR(inspR)) {
        const carId = opts.life._garageSpecsCarId as string | undefined;
        if (!carId || carId !== opts.life.ownedCars[0]) {
          showNotif(opts.life, 'INSPECT works on the ACTIVE car — GET IN first', 160);
          return true;
        }
        // H1302: using a time slot ADVANCES time (user rule) — no cap, no
        // refusal; a night inspection simply runs into the next morning.
        const usedSlot = opts.life.timeSlot;
        const slotRes = consumeActivitySlot(opts.life, opts.clock);
        (opts.life as { _inspectState?: InspectState })._inspectState = {
          carId, view: 'overview', lines: [], results: [], rolled: {},
        };
        (opts.life as { _garageSpecsXray?: boolean })._garageSpecsXray = true;
        showNotif(opts.life, slotRes.kind === 'rolled'
          ? '🔍 Inspection runs overnight — Day ' + opts.clock.day
          : '🔍 Inspecting — the ' + usedSlot + ' goes by', 180);
        return true;
      }
      return true;
    }
    // H877: UPGRADE (tune) sub-view — BACK to list; DIY/SHOP buy buttons
    // route through the upgrade economy. Modal-eats other taps.
    if (opts.tab === 'garage' && opts.life._garageView === 'tune') {
      type Rect = { x: number; y: number; w: number; h: number };
      const within = (r?: Rect): boolean => !!r && tx >= r.x && tx <= r.x + r.w && ty >= r.y && ty <= r.y + r.h;
      const tBack = (opts.life as { _garageTuneBackRect?: Rect })._garageTuneBackRect;
      if (within(tBack)) { opts.life._garageView = 'list'; return true; }
      // H879: category chip tap → focus that category.
      const catHits = (opts.life as { _garageTuneCatHits?: Array<{ kind: UpgradeKind } & Rect> })._garageTuneCatHits;
      if (catHits) {
        for (const ch of catHits) {
          if (within(ch)) { (opts.life as { _tuneCategory?: UpgradeKind })._tuneCategory = ch.kind; return true; }
        }
      }
      const carId = ((opts.life as { _garageTuneCarId?: string })._garageTuneCarId) ?? opts.life.ownedCars[0];
      const hits = (opts.life as { _garageTuneTileHits?: TuneTileHit[] })._garageTuneTileHits;
      const car = carId ? CAR_CATALOG[carId] : undefined;
      if (car && hits) {
        for (const ht of hits) {
          if (within(ht)) {
            const plan = getUpgradeStagePlan(car, ht.kind, ht.toStage, opts.life);
            if (!plan) return true;
            const label = ht.kind.charAt(0).toUpperCase() + ht.kind.slice(1);
            // H1289: the DIY slot is PARTS (order the kit) until the kit is
            // in the garage, then INSTALL (consume it, free, skill-gated).
            const havePart = findOwnedUpgradePartIdx(opts.life, car.id, ht.kind, plan.toStage) >= 0;
            const res = ht.venue === 'shop'
              ? orderUpgrade(opts.life, opts.clock, car, plan, true)
              : havePart
                ? orderUpgrade(opts.life, opts.clock, car, plan, false)
                : orderUpgradeParts(opts.life, opts.clock, car, plan);
            if (res.ok && ht.venue === 'shop') showNotif(opts.life, `🚚 Flatbed picked up the ${car.name} — back Day ${res.readyDay} (-$${(res.price ?? 0).toLocaleString()})`);
            else if (res.ok && havePart) showNotif(opts.life, `Installing ${label} Stage ${ht.toStage} — ready Day ${res.readyDay}`);
            else if (res.ok) showNotif(opts.life, `${label} Stage ${ht.toStage} parts ordered — arrive Day ${res.readyDay} (-$${(res.price ?? 0).toLocaleString()})`);
            else if (res.reason === 'money') showNotif(opts.life, "Can't afford this");
            else if (res.reason === 'skill') showNotif(opts.life, `Need skill ${plan.skillReq} to install — use SHOP`);
            else if (res.reason === 'pending') showNotif(opts.life, 'Already in progress');
            else if (res.reason === 'parts') showNotif(opts.life, 'Order the parts first');
            else if (res.reason === 'havePart') showNotif(opts.life, 'You already have the parts — INSTALL them');
            return true;
          }
        }
      }
      return true;
    }
    // H570: repair popup eats every tap while up. Sits FIRST so a
    // tap doesn't fall through to the REPAIRS row beneath. Routes
    // venue + cancel through handleRepairPopupTap.
    if (opts.tab === 'garage' && opts.life.repairPopup) {
      handleRepairPopupTap(tx, ty, opts.life, opts.clock);
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
            // H866: already queued at a shop — can't re-order; surface its ETA.
            const queued = opts.life.pendingParts.find((p) => p.faultId === fault.id);
            if (queued) {
              showNotif(opts.life, fault.name + ' — in the shop, ready Day ' + queued.readyDay, 180);
            } else {
              opts.life.repairPopup = { fault, faultIdx: r.faultIdx };
            }
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
    if (opts.tab === 'garage' && opts.life._garageView === 'toolbox') {
      // H944: toolbox is a display-only view — BACK returns to the list;
      // every other tap is swallowed so it doesn't reach the list behind.
      const tbBack = (opts.life as { _garageToolboxBackRect?: { x: number; y: number; w: number; h: number } })._garageToolboxBackRect;
      if (tbBack && tx >= tbBack.x && tx <= tbBack.x + tbBack.w && ty >= tbBack.y && ty <= tbBack.y + tbBack.h) {
        opts.life._garageView = 'list';
      }
      return true;
    }
    if (opts.tab === 'garage' && opts.life._garageView === 'parts') {
      const pBack = opts.life._garagePartsBackRect as {
        x: number; y: number; w: number; h: number;
      } | undefined;
      if (pBack && tx >= pBack.x && tx <= pBack.x + pBack.w && ty >= pBack.y && ty <= pBack.y + pBack.h) {
        opts.life._garageView = 'list';
        return true;
      }
      // H782: category tab strip. Tap a tab → switch the active
      // category + reset list scroll so the new list starts at the
      // top. Sits before the ORDER-button loop so a tap on the strip
      // doesn't reach into the part rows below.
      const tabRects = (opts.life._garagePartsTabRects as GaragePartsTabRect[] | undefined) ?? [];
      for (const t of tabRects) {
        if (tx >= t.x && tx <= t.x + t.w && ty >= t.y && ty <= t.y + t.h) {
          opts.life._garagePartsCategory = t.cat;
          opts.life._garagePartsScrollY = 0;
          return true;
        }
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
          // H865: route through the lead-time queue. Instant venues (in-stock
          // DIY / flag-mods) apply now; timed venues queue and resolve on
          // day-rollover (sleep to advance). DIY skill bump is inside orderPart.
          const ord = orderPart(opts.life, opts.clock, part, primary, primary === venues.diy);
          showNotif(
            opts.life,
            ord.queued
              ? part.name + ' ordered — ready Day ' + ord.readyDay + ' (-$' + primary.price.toLocaleString() + ')'
              : part.name + ' installed (-$' + primary.price.toLocaleString() + ')',
            ord.queued ? 200 : 180,
          );
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
    // H1296: MAIL tab — buyer-offer ACCEPT / DECLINE (rects cached by
    // drawMailTab; carId+amount+day joins back to the ad's offer).
    if (opts.tab === 'mail') {
      const rects = (opts.life as { _mailOfferRects?: MailOfferRect[] })._mailOfferRects ?? [];
      for (const r of rects) {
        if (tx >= r.x && tx <= r.x + r.w && ty >= r.y && ty <= r.y + r.h) {
          const loc = findAdOfferForMail(opts.life, r.carId, r.amount, r.day);
          if (!loc) {
            // Stale row — ad cancelled or car already sold. Drop it.
            if (opts.life.mail) {
              const mi = (opts.life.mail as MailItem[]).findIndex((m) =>
                m.type === 'carOffer' && m.carId === r.carId
                && m.amount === r.amount && m.day === r.day);
              if (mi >= 0) (opts.life.mail as MailItem[]).splice(mi, 1);
            }
            showNotif(opts.life, 'That offer has expired.', 130);
            return true;
          }
          if (r.kind === 'accept') acceptCarOffer(opts.life, loc.adIdx, loc.offerIdx);
          else declineCarOffer(opts.life, loc.adIdx, loc.offerIdx);
          return true;
        }
      }
    }
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

      // H1296: list-confirm modal — same hard-stop pattern as sell.
      const lc = opts.life._listConfirm as ListConfirmState | null | undefined;
      if (lc) {
        const popW = opts.GW - 40;
        const popX = 20;
        const btnW = popW - 80;
        const btnX = popX + 40;
        if (lc._yesY && ty >= lc._yesY && ty <= lc._yesY + 28
            && tx >= btnX && tx <= btnX + btnW) {
          const id = lc.carId;
          opts.life._listConfirm = null;
          listCarInNewspaper(opts.life, id);
          return true;
        }
        if (lc._cancelY && ty >= lc._cancelY && ty <= lc._cancelY + 28
            && tx >= btnX && tx <= btnX + btnW) {
          opts.life._listConfirm = null;
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
          if (b.action === 'toolbox') {
            opts.life._garageView = 'toolbox';
            return true;
          }
          if (b.action === 'tune') {
            opts.life._garageView = 'tune';
            (opts.life as { _garageTuneCarId?: string })._garageTuneCarId = b.carId;
            return true;
          }
          if (b.action === 'sell') {
            opts.life._sellConfirm = { carId: b.carId };
            return true;
          }
          if (b.action === 'list') {
            // H1296: confirm before the car goes in the paper. Blockers
            // toast immediately instead of opening a doomed confirm.
            const block = canListCarInNewspaper(opts.life, b.carId);
            if (block) showNotif(opts.life, block, 140);
            else opts.life._listConfirm = { carId: b.carId };
            return true;
          }
          if (b.action === 'inspect') {
            // H1299: the button now opens the visual INSPECT flow (same
            // guards as the SPECS chip — active car only, costs a time
            // slot). The H948 paid scan is retired here; its successor is
            // the H-D mechanic PRO DIAGNOSTIC (hired-skill roll).
            if (b.carId !== opts.life.ownedCars[0]) {
              showNotif(opts.life, 'INSPECT works on the ACTIVE car — GET IN first', 160);
              return true;
            }
            // H1302: using a time slot ADVANCES time (user rule) — no cap,
            // no refusal; a night inspection runs into the next morning.
            const usedSlot = opts.life.timeSlot;
            const slotRes = consumeActivitySlot(opts.life, opts.clock);
            opts.life._garageView = 'specs';
            opts.life._garageSpecsCarId = b.carId;
            (opts.life as { _inspectState?: InspectState })._inspectState = {
              carId: b.carId, view: 'overview', lines: [], results: [], rolled: {},
            };
            (opts.life as { _garageSpecsXray?: boolean })._garageSpecsXray = true;
            showNotif(opts.life, slotRes.kind === 'rolled'
              ? '🔍 Inspection runs overnight — Day ' + opts.clock.day
              : '🔍 Inspecting — the ' + usedSlot + ' goes by', 180);
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
      // H1082: tap a day cell to zoom into its per-slot detail.
      for (const r of opts.life._calCellRects ?? []) {
        if (tx >= r.x && tx <= r.x + r.w && ty >= r.y && ty <= r.y + r.h) {
          opts.life._calSelectedDay = r.absDay;
          return true;
        }
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
      // H213: gym workout taps. H810: drawEatTab caches full rects on
      // life._eatTabRects.gym; we hit-test against them and dispatch to
      // evaluateGymWorkout + apply the deltas. canGym was computed
      // at paint time so the disabled state is consistent (taps on
      // greyed-out rows fall through silently).
      const gymBtns = (opts.life as { _eatTabRects?: EatTabRects })._eatTabRects?.gym;
      if (gymBtns) {
        for (const btn of gymBtns) {
          if (!btn.canGym) continue;
          if (tx >= btn.x && tx <= btn.x + btn.w && ty >= btn.y && ty <= btn.y + btn.h) {
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
    // H1030: RACE opens the picker modal (handled at the top next tap).
    if (b.tab === 'race') {
      opts.life._racePickerOpen = true;
      return true;
    }
    // H1076: CATALOG opens the mail-order parts overlay (dep closes
    // the home overlay first). No-op until the gameLoop dep is wired.
    if (b.tab === 'catalog') {
      deps.openCatalog?.();
      return true;
    }
    if (!b.enabled) return true; // swallow but no-op
    // H1082: entering the calendar always starts on the month grid, not
    // a stale day-detail from a previous visit.
    if (b.tab === 'calendar') opts.life._calSelectedDay = null;
    deps.setTab(b.tab as HomeTab);
    return true;
  }
  return true; // overlay swallows all taps even on the dim backdrop
}
