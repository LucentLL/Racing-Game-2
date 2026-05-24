/**
 * Monthly pay tick. Fires alongside fireMonthlyBills on day-31, day-61,
 * etc.
 *
 * H554: DEPRECATED money-deposit path. H544 ported the canonical
 * salary system (accumulateSalary daily + runFridayPayout weekly
 * with full 1999 tax withholding), which supersedes the
 * `basePay × workDays × payMultiplier` block here. Without skipping
 * the deposit, salaried players would receive BOTH the H544 weekly
 * paychecks AND the monthly basePay × 20 lump from this function —
 * double-pay. The receipt fields (_lastPayMonth / _lastPayTotal /
 * _lastPayAtMs) are still cached so the HUD month-rollover
 * "MONTH N: +$X" line keeps its layout slot, but total is now
 * always 0 (H544's per-month aggregate replacement is a future
 * hop — see HUD pay-line at gameLoop ~L2110).
 *
 * Order matters: pay fires BEFORE bills so the receipt slot
 * stays positioned ahead of the bills line in the HUD render
 * order. Same boundary trigger (isMonthBoundary) — caller invokes
 * both back-to-back.
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

/** Returns the receipt for HUD surfacing. H554: no money deposit —
 *  see module docstring on the H544 supersedence + double-pay fix. */
export function fireMonthlyPay(life: LifeState, newDay: number): MonthlyPayReceipt {
  const month = Math.floor((newDay - 1) / 30) + 1;
  const basePay = life.basePay || 0;
  const multiplier = life.payMultiplier || 1;
  const workDays = ASSUMED_WORK_DAYS_PER_MONTH;
  const attendance = 1.0;
  // H554: total kept as 0 — the deposit moved to H544's
  // accumulateSalary + runFridayPayout pipeline. Receipt fields
  // still cached so the HUD month-rollover line keeps its layout
  // slot (shows +$0 for now; future hop wires a true monthly
  // aggregate of the weekly Friday payouts).
  const total = 0;

  // Cache for HUD. Same shape as bills slots — caller renders both.
  life._lastPayMonth = month;
  life._lastPayTotal = total;
  life._lastPayAtMs = Date.now();

  return { month, basePay, multiplier, workDays, attendance, total };
}
