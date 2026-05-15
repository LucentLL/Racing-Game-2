/**
 * Monthly pay tick. Fires alongside fireMonthlyBills on day-31, day-61,
 * etc. Adds basePay × workDays × payMultiplier to LIFE.money.
 *
 * H23 minimum assumes 100% attendance — workDays = 20 every month.
 * Real work-cycle port will read life.workDaysPresent and apply the
 * v8.99.x raises / bonuses / streetRep multipliers.
 *
 * Order matters: pay fires BEFORE bills so the player has the salary
 * sitting in money when bills draw down. Same boundary trigger
 * (isMonthBoundary) — caller invokes both back-to-back.
 *
 * INTENTIONALLY simpler than the monolith's checkMonthlyRaise +
 * completeWorkDay pipeline. Real port lands with the work-cycle bodies.
 */

import type { LifeState } from '@/state/life';

export interface MonthlyPayReceipt {
  /** New month number (after the rollover). */
  month: number;
  basePay: number;
  multiplier: number;
  workDays: number;
  /** 0..1 attendance ratio. H23 hard-codes 1.0. */
  attendance: number;
  /** Final amount added to LIFE.money. */
  total: number;
}

const ASSUMED_WORK_DAYS_PER_MONTH = 20;

/** Compute + apply monthly pay. Returns the receipt for HUD surfacing. */
export function fireMonthlyPay(life: LifeState, newDay: number): MonthlyPayReceipt {
  const month = Math.floor((newDay - 1) / 30) + 1;
  const basePay = life.basePay || 0;
  const multiplier = life.payMultiplier || 1;
  const workDays = ASSUMED_WORK_DAYS_PER_MONTH;
  const attendance = 1.0;
  const total = Math.round(basePay * workDays * multiplier * attendance);

  // Test mode: $999,999 already represents infinite wealth; don't add
  // pay (would still work but pollutes the receipt with noise).
  if (!life._testMode) {
    life.money += total;
  }

  // Cache for HUD. Same shape as bills slots — caller renders both.
  life._lastPayMonth = month;
  life._lastPayTotal = total;
  life._lastPayAtMs = Date.now();

  return { month, basePay, multiplier, workDays, attendance, total };
}
