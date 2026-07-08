/**
 * Bills summary helpers. Pure functions over LifeState — no mutation,
 * no UI coupling. The home-screen BILLS tab consumes these for
 * display; the monthly tick (src/sim/monthlyBills) doesn't need them
 * (it iterates the same data directly to mutate it).
 *
 * Ported from the monolith's getMonthlyHousingCost / getTotalCarPayments /
 * getTotalBankPayments / getMortgageTotalOwed / getTotalBankOwed
 * (scattered around L48700-49025).
 */

import type { LifeState } from '@/state/life';
import { DAYS_PER_MONTH } from './monthlyBills';
import { monthlyInsurance } from './insurance';

/** Monthly housing cost (rent or mortgage). Already stored on LIFE
 *  but wrapped here so callers don't have to know which field. */
export function monthlyHousing(life: LifeState): number {
  return life.monthlyHousingCost || 0;
}

/** Sum of all carLoan monthly payments. */
export function monthlyCarPayments(life: LifeState): number {
  return life.carLoans.reduce((s, l) => s + (l.monthlyPayment || 0), 0);
}

/** Sum of all bankLoan monthly payments. */
export function monthlyBankPayments(life: LifeState): number {
  return life.bankLoans.reduce((s, l) => s + (l.monthlyPayment || 0), 0);
}

/** Total monthly bill burden. H1072: includes car insurance. */
export function monthlyTotalDue(life: LifeState): number {
  return monthlyHousing(life) + monthlyCarPayments(life)
    + monthlyBankPayments(life) + monthlyInsurance(life);
}

/** Total amount owed on car loans (balance, not just one month). */
export function totalCarLoansOwed(life: LifeState): number {
  return life.carLoans.reduce((s, l) => s + (l.balance || 0), 0);
}

/** Total amount owed on bank loans. */
export function totalBankLoansOwed(life: LifeState): number {
  return life.bankLoans.reduce((s, l) => s + (l.amount || 0), 0);
}

/** Days remaining in the current month — drives the "Next billing in
 *  N days" countdown. Returns 1..30 inclusive. */
export function daysUntilNextBilling(day: number): number {
  const dayOfMonth = ((day - 1) % DAYS_PER_MONTH) + 1;
  return DAYS_PER_MONTH - dayOfMonth + 1;
}

/** True when the player has missed at least one bill. */
export function isAnyBillPastDue(life: LifeState): boolean {
  return (life.missedPayments || 0) > 0;
}
