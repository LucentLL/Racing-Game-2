/**
 * H39 — pay one monthly payment NOW on a single loan, from the BILLS
 * tab's per-row PAY button. Mirrors the per-loan paydown logic in
 * fireMonthlyBills (src/sim/monthlyBills.ts L57-70): full payment goes
 * against balance, monthsRemaining drops by 1, paid-off loans splice
 * out of life.carLoans / life.bankLoans.
 *
 * Pure (mutates LifeState). Returns true on success, false if the
 * player can't afford the payment or the index is bogus.
 *
 * INTENTIONALLY simpler than the monolith's extra-payment cascade
 * (L46655-46695, where extra dollars roll into the highest-APR loan
 * across both lists at once). H39 is a per-row action — one tap, one
 * loan, one month forward. The principal-portion-vs-interest split
 * also stays loose (full payment against balance) to match the monthly
 * tick. Real amortization lands when the schedule.ts port arrives.
 */

import type { LifeState } from '@/state/life';

/** Identifies which list of loans the index refers to. */
export type LoanList = 'car' | 'bank';

/** Apply a single monthly payment to the loan at (list, idx). Returns
 *  true if the payment went through. */
export function payLoanNow(life: LifeState, list: LoanList, idx: number): boolean {
  const arr = list === 'car' ? life.carLoans : life.bankLoans;
  const loan = arr[idx];
  if (!loan) return false;
  const cost = list === 'car'
    ? (loan as { monthlyPayment: number }).monthlyPayment
    : (loan as { monthlyPayment: number }).monthlyPayment;
  if (!cost || life.money < cost) return false;
  life.money -= cost;
  if (list === 'car') {
    const cl = arr[idx] as { balance: number; monthsRemaining: number };
    cl.balance = Math.max(0, cl.balance - cost);
    cl.monthsRemaining = Math.max(0, cl.monthsRemaining - 1);
    if (cl.monthsRemaining <= 0 || cl.balance <= 0) {
      life.carLoans.splice(idx, 1);
    }
  } else {
    const bl = arr[idx] as { amount: number; monthsRemaining: number };
    bl.amount = Math.max(0, bl.amount - cost);
    bl.monthsRemaining = Math.max(0, bl.monthsRemaining - 1);
    if (bl.monthsRemaining <= 0 || bl.amount <= 0) {
      life.bankLoans.splice(idx, 1);
    }
  }
  return true;
}
