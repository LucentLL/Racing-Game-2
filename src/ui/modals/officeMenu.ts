/**
 * OFFICE JOB day-flow modal — three-phase decision tree the player
 * walks when they arrive at the office.
 *
 * Phases:
 *   - 'arrive':    ☕ COFFEE / 💼 START WORK / ✕ CANCEL
 *   - 'lunch':     🍴 LUNCH / ⏭ SKIP LUNCH
 *   - 'afternoon': 💼 CONTINUE WORK (full day) / 🚗 LEAVE EARLY (60% pay)
 *
 * COFFEE buys +2 slot of coffeeBuff (fades 1 per slot advance) for $3.
 * LUNCH buys +2 health + sets ateToday for $12. CONTINUE WORK marks
 * a full office day (both slots used, full salary deferred to payday).
 * LEAVE EARLY marks only the morning slot used and caps salary at 60%.
 *
 * Ported from monolith L47074-47212. Dependencies that haven't
 * ported elsewhere yet:
 *   - LIFE.dayPhase / LIFE.jobCooldown — skipped (un-ported state)
 *   - markSlotDone — replaced with inline slot marking (matches the
 *     office-specific branch the monolith comment describes)
 *
 * H550 wired logCalEvent at completeOfficeDay — 'W' OFFICE JOB
 * (full shift) / 'W' OFFICE (left early) matches monolith L47211.
 */

import type { LifeState } from '@/state/life';
import { logCalEvent } from '@/sim/calendarLog';
import { GT2_COLORS, drawGt2Backdrop } from '@/ui/gt2Chrome';

export type OfficePhase = 'arrive' | 'lunch' | 'afternoon';

export interface OfficeMenuState {
  phase: OfficePhase;
  coffeeTaken: boolean;
  lunchTaken: boolean;
}

/** Per-frame inputs for the office overlay. */
export interface OfficeMenuOpts {
  state: OfficeMenuState;
  life: LifeState;
  GW: number;
  GH: number;
}

/** Button-action discriminator. */
export type OfficeAction = 'coffee' | 'work' | 'cancel' | 'lunch' | 'skip' | 'continue' | 'leaveEarly';

interface OfficeBtnRect {
  x: number; y: number; w: number; h: number;
  key: OfficeAction;
  enabled: boolean;
}

let _btnRects: OfficeBtnRect[] = [];

/** Layout + paint. 1:1 port of monolith L47074-47127. */
export function drawOfficeMenu(ctx: CanvasRenderingContext2D, opts: OfficeMenuOpts): void {
  const { state: m, life, GW, GH } = opts;

  // H780: GT2 charcoal + grid backdrop.
  ctx.fillStyle = GT2_COLORS.bg;
  ctx.fillRect(0, 0, GW, GH);
  drawGt2Backdrop(ctx, GW, GH);

  // H815: GT2 amber-on-charcoal (was cyan/green terminal + emoji).
  const C = GT2_COLORS;
  ctx.textAlign = 'center';
  ctx.fillStyle = C.amber;
  ctx.font = 'bold 14px monospace';
  ctx.fillText('OFFICE', GW / 2, 26);
  const phaseSub: Record<OfficePhase, string> = {
    arrive: 'Good morning',
    lunch: 'Lunch break',
    afternoon: 'Afternoon check-in',
  };
  ctx.fillStyle = C.textMute;
  ctx.font = '9px monospace';
  ctx.fillText(phaseSub[m.phase], GW / 2, 40);

  // Stat strip.
  ctx.fillStyle = C.textMute;
  ctx.font = '8px monospace';
  const coffeeStr = life.coffeeBuff > 0 ? 'coffee · ' + life.coffeeBuff + ' slots' : 'no coffee';
  ctx.fillText(
    '$' + life.money + '  ·  HP ' + Math.round(life.health) + '%  ·  ' + coffeeStr,
    GW / 2, 54,
  );
  ctx.fillStyle = C.amberDim;
  ctx.fillRect(20, 62, GW - 40, 1);

  _btnRects = [];
  const btnW = GW - 40;
  const cx = 20;
  // primary = bright active-orange CTA; else amber outline; disabled =
  // dim panel. Matches the seller/realtor button language.
  const addBtn = (y: number, label: string, sub: string, primary: boolean, key: OfficeAction, enabled: boolean): void => {
    const h = 38;
    if (!enabled) {
      ctx.fillStyle = C.bgDeep;
      ctx.fillRect(cx, y, btnW, h);
      ctx.strokeStyle = C.textDim;
      ctx.lineWidth = 1;
      ctx.strokeRect(cx + 0.5, y + 0.5, btnW - 1, h - 1);
      ctx.fillStyle = C.textDim;
      ctx.font = 'bold 11px monospace';
      ctx.fillText(label, GW / 2, y + 16);
      ctx.fillStyle = C.textDim;
      ctx.font = '8px monospace';
      ctx.fillText(sub, GW / 2, y + 29);
    } else if (primary) {
      ctx.fillStyle = C.active;
      ctx.fillRect(cx, y, btnW, h);
      ctx.fillStyle = C.bgDeep;
      ctx.font = 'bold 11px monospace';
      ctx.fillText(label, GW / 2, y + 16);
      ctx.font = '8px monospace';
      ctx.fillText(sub, GW / 2, y + 29);
    } else {
      ctx.fillStyle = C.panel;
      ctx.fillRect(cx, y, btnW, h);
      ctx.strokeStyle = C.amberDark;
      ctx.lineWidth = 1;
      ctx.strokeRect(cx + 0.5, y + 0.5, btnW - 1, h - 1);
      ctx.fillStyle = C.amber;
      ctx.font = 'bold 11px monospace';
      ctx.fillText(label, GW / 2, y + 16);
      ctx.fillStyle = C.textMute;
      ctx.font = '8px monospace';
      ctx.fillText(sub, GW / 2, y + 29);
    }
    _btnRects.push({ x: cx, y, w: btnW, h, key, enabled });
  };

  if (m.phase === 'arrive') {
    addBtn(72, m.coffeeTaken ? 'COFFEE ✓' : 'COFFEE — $3',
      m.coffeeTaken ? 'Already bought one' : 'Boost energy vs. sleep debt',
      false, 'coffee', !m.coffeeTaken && life.money >= 3);
    addBtn(120, 'START WORK', 'Begin the morning shift', true, 'work', true);
    addBtn(168, 'CANCEL', 'Leave — still morning', false, 'cancel', true);
  } else if (m.phase === 'lunch') {
    const canAfford = life.money >= 12;
    addBtn(72, m.lunchTaken ? 'LUNCH ✓' : 'LUNCH — $12',
      m.lunchTaken
        ? 'Already ate'
        : canAfford ? 'Cafeteria meal (+2 health)' : 'Not enough cash',
      false, 'lunch', !m.lunchTaken && canAfford);
    addBtn(120, 'SKIP LUNCH', 'Straight to afternoon', true, 'skip', true);
  } else if (m.phase === 'afternoon') {
    addBtn(72, 'CONTINUE WORK', 'Full afternoon shift — full pay', true, 'continue', true);
    addBtn(120, 'LEAVE EARLY', '60% pay — afternoon stays free', false, 'leaveEarly', true);
  }

  ctx.textAlign = 'left';
}

/** Tap dispatcher. Returns true unconditionally — modal eats every
 *  tap. 1:1 with monolith L47129-47138. */
export function handleOfficeMenuClick(
  tx: number,
  ty: number,
  opts: OfficeMenuOpts,
  showNotif: (msg: string) => void,
  swapBackToPersonalCar: (life: LifeState) => void,
  day: number,
): boolean {
  for (const b of _btnRects) {
    if (tx < b.x || tx > b.x + b.w || ty < b.y || ty > b.y + b.h) continue;
    if (!b.enabled) return true;
    officeMenuAction(b.key, opts, showNotif, swapBackToPersonalCar, day);
    return true;
  }
  return true;
}

/** Action dispatch — 1:1 port of monolith L47140-47185 + L47190-47212
 *  (completeOfficeDay inlined since it only has two callers). */
function officeMenuAction(
  key: OfficeAction,
  opts: OfficeMenuOpts,
  showNotif: (msg: string) => void,
  swapBackToPersonalCar: (life: LifeState) => void,
  day: number,
): void {
  const { state: m, life } = opts;
  switch (key) {
    case 'coffee':
      if (life.money < 3 || m.coffeeTaken) return;
      life.money -= 3;
      life.coffeeBuff = 2;
      m.coffeeTaken = true;
      showNotif('Coffee! Fades over the next couple slots.');
      break;
    case 'work':
      m.phase = 'lunch';
      showNotif('Morning shift in progress...');
      break;
    case 'cancel':
      life.officeMenu = null;
      showNotif('Left the office — come back before end of morning');
      break;
    case 'lunch':
      if (life.money < 12 || m.lunchTaken) return;
      life.money -= 12;
      life.health = Math.min(100, life.health + 2);
      life.ateToday = true;
      life.lastMealTier = 'regular';
      life.daysSinceEat = 0;
      m.lunchTaken = true;
      m.phase = 'afternoon';
      showNotif('Lunch! +2 health');
      break;
    case 'skip':
      m.phase = 'afternoon';
      break;
    case 'continue':
      completeOfficeDay(life, false, showNotif, swapBackToPersonalCar, day);
      break;
    case 'leaveEarly':
      completeOfficeDay(life, true, showNotif, swapBackToPersonalCar, day);
      break;
  }
}

/** Closes out the office workday. leftEarly: morning-only slot
 *  used + 60% salary cap; full: both slots used + full salary
 *  (salary accrual itself isn't ported here — it lands on the
 *  next monthly-pay cycle).
 *
 *  1:1 with monolith L47190-47212 minus the un-ported jobCooldown
 *  / dayPhase / logCalEvent calls. swapBackToPersonalCar restores
 *  the player's car if ACCEPT JOB swapped them into the OFFICE-JOB
 *  vehicle slot (H206) — for OFFICE JOB the swap is a no-op since
 *  JOB_VEHICLES has no mapping, but the call is symmetric with
 *  the other job-end paths. */
function completeOfficeDay(
  life: LifeState,
  leftEarly: boolean,
  showNotif: (msg: string) => void,
  swapBackToPersonalCar: (life: LifeState) => void,
  day: number,
): void {
  life.officeMenu = null;
  life.officeLeaveEarly = leftEarly;
  life.job = null;
  life.jobDoneToday = true;
  swapBackToPersonalCar(life);

  if (leftEarly) {
    // Office's "leave early" marks ONLY the morning slot (not
    // markSlotDone which would also mark afternoon for the full-
    // day case). Keep timeSlot morning so afternoon stays free.
    life.slotsUsed.morning = true;
    life.slotsActiveToday = (life.slotsActiveToday || 0) + 1;
    showNotif('Left early — afternoon is yours');
  } else {
    // Full shift: office uses both morning + afternoon slots and
    // advances the time-of-day to night.
    life.slotsUsed.morning = true;
    life.slotsUsed.afternoon = true;
    life.slotsActiveToday = (life.slotsActiveToday || 0) + 2;
    life.timeSlot = 'night';
    showNotif('Full shift — drive home');
  }
  // H550: calendar log. 'W' work-event tagged at the 'morning'
  // slot (matches monolith L47211 which logs at 'morning' for
  // both branches — the office shift always BEGINS in morning
  // regardless of whether the player leaves early or stays).
  logCalEvent(life, day, 'W', 'morning', leftEarly ? 'OFFICE (left early)' : 'OFFICE JOB');
}
