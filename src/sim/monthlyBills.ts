/**
 * Monthly bill tick. Fires when the day clock crosses a 30-day month
 * boundary (day 31, 61, 91, ...). Drains LIFE.money by
 * monthlyHousingCost + sum of carLoan monthly payments, decrements
 * each loan's balance + monthsRemaining, removes paid-off loans.
 *
 * Negative-money case: tracks missedPayments instead of clamping.
 * Real eviction / repo logic ports later — for H22 the player just
 * sees a negative number and a missedPayments counter ticking up.
 *
 * INTENTIONALLY simpler than the monolith's triggerMonthlyBills
 * pipeline (L46408+, with the full bills-due popup, partial-pay
 * choices, late-fee math, credit-score impact). Real port lands when
 * the home-screen / bills modal body ports.
 */

import type { LifeState } from '@/state/life';
import { logCalEvent } from '@/sim/calendarLog';
import { adjustCredit } from '@/sim/credit';

/** Days per month. The monolith uses 30 for simplicity (no leap years,
 *  no 31-day months). Real calendar arithmetic isn't needed until the
 *  day-of-week / monthly-rent-on-specific-date features port. */
export const DAYS_PER_MONTH = 30;

export interface MonthlyBillReceipt {
  /** New month number (after the rollover). */
  month: number;
  /** Rent / mortgage paid. */
  housing: number;
  /** Total of all car-loan monthly payments. */
  loanTotal: number;
  /** Number of loans that paid off this cycle. */
  paidOffCount: number;
  /** Number of missed payments newly accrued (negative-money case). */
  newMissed: number;
}

/** Returns true if `newDay` crossed a month boundary from `prevDay`.
 *  Caller compares prev → new across the tickClock call. Pre-day-1
 *  (prevDay===0) is treated as no crossing — first frame won't fire. */
export function isMonthBoundary(prevDay: number, newDay: number): boolean {
  if (prevDay === newDay) return false;
  const prevMonth = Math.floor((prevDay - 1) / DAYS_PER_MONTH);
  const newMonth = Math.floor((newDay - 1) / DAYS_PER_MONTH);
  return newMonth > prevMonth;
}

/** Fires all monthly bills against the supplied LifeState. Mutates the
 *  state in place. Returns a receipt the caller can surface in the HUD
 *  / notifications. */
export function fireMonthlyBills(life: LifeState, newDay: number): MonthlyBillReceipt {
  const month = Math.floor((newDay - 1) / DAYS_PER_MONTH) + 1;
  const housing = life.monthlyHousingCost || 0;

  let loanTotal = 0;
  let paidOffCount = 0;
  const remainingLoans = [];
  for (const loan of life.carLoans) {
    const mo = loan.monthlyPayment || 0;
    loanTotal += mo;
    // Loose principal decrement — uses full payment as balance
    // reduction rather than splitting principal vs interest. Refines
    // when the proper amortization port lands.
    loan.balance = Math.max(0, loan.balance - mo);
    loan.monthsRemaining = Math.max(0, loan.monthsRemaining - 1);
    if (loan.monthsRemaining <= 0 || loan.balance <= 0) {
      paidOffCount++;
      // H558: paid-off-loan credit bonus. Matches monolith L46638
      // `adjustCredit(15, 'car loan paid off')`. Fires per loan
      // closing this cycle so a player with two loans both finishing
      // gets +30. Early-payoff bonus (+20 at monolith L46686) is
      // a separate path that the player-controlled extra-payment
      // UI hits — modular's auto-pay doesn't have that path yet.
      adjustCredit(life, 15, 'car loan paid off');
    } else {
      remainingLoans.push(loan);
    }
  }
  life.carLoans = remainingLoans;

  const totalDue = housing + loanTotal;
  const moneyBefore = life.money;
  life.money -= totalDue;

  let newMissed = 0;
  if (life.money < 0 && moneyBefore >= 0) {
    // Crossed from solvent to insolvent this cycle.
    newMissed = 1;
    life.missedPayments = (life.missedPayments || 0) + 1;
  } else if (life.money < 0) {
    // Already insolvent — keep ticking missed payments up so eventual
    // eviction logic has a counter to read.
    newMissed = 1;
    life.missedPayments = (life.missedPayments || 0) + 1;
  }

  // H558: on-time / missed credit events. Combined-bill model in
  // modular's simplified auto-pay (vs monolith's per-sub-bill
  // payHomeBills + payCarBills which adjust credit independently
  // at L46588 / L46594 / L46698 / L46704). Award +2 per sub-bill
  // when the player stayed solvent (~+4 total for a player with
  // both home + cars), penalize -40 per sub-bill on insolvency
  // (~-80 — same magnitude as monolith would dish out when both
  // sub-bills miss together). Sub-bills with $0 due (renter with
  // no rent in arrears, no car loans) don't trigger either.
  const wentInsolvent = newMissed > 0;
  if (housing > 0) {
    if (wentInsolvent) adjustCredit(life, -40, 'missed home payment');
    else adjustCredit(life, 2, 'on-time home');
  }
  if (loanTotal > 0) {
    if (wentInsolvent) adjustCredit(life, -40, 'missed car payment');
    else adjustCredit(life, 2, 'on-time cars');
  }

  // Cache the latest receipt on LIFE for the HUD to surface. Not part
  // of the formal LifeState schema yet (it's transient UI state).
  life._lastBillsMonth = month;
  life._lastBillsTotal = totalDue;
  life._lastBillsAtMs = Date.now();

  // H575: bills receipt snapshot — surfaces to the home overlay's
  // billsReceipt popup so the player sees what just got paid (vs.
  // current silent-drain behavior). billsDuePrompt flips true here;
  // popup dismiss clears it.
  if (totalDue > 0 || paidOffCount > 0 || newMissed > 0) {
    life.billsReceipt = {
      month,
      housing,
      loanTotal,
      paidOffCount,
      missed: newMissed > 0,
    };
    life.billsDuePrompt = true;
  }

  // H549: per-sub-bill calendar entries. Matches monolith's two
  // separate logCalEvent calls — 'B' Home -$X at L46590 (inside
  // payHomeBills) and 'B' Cars -$Y at L46700 (inside payCarBills).
  // Modular's simplified auto-pay collapses the two user-action
  // handlers into this single fireMonthlyBills call, but the log
  // stays split so the future calendar-tab port shows the two
  // sub-bill amounts independently. Skip empty sub-bills (renter
  // with no car loans gets only the Home entry).
  if (housing > 0) {
    logCalEvent(life, newDay, 'B', '', 'Home -$' + housing);
  }
  if (loanTotal > 0) {
    logCalEvent(life, newDay, 'B', '', 'Cars -$' + loanTotal);
  }

  return { month, housing, loanTotal, paidOffCount, newMissed };
}
