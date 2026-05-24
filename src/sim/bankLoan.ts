/**
 * Bank loan offer system — unsecured personal loan the player can take
 * out from the bank for emergencies, down payments, or just cash.
 * Approval is deterministic: credit-tier cap × debt-to-income gate.
 *
 * 1:1 port of monolith L45596-L45666:
 *   _BANK_LOAN_TERMS  — term ladder
 *   _BANK_LOAN_RATES  — APR per credit tier
 *   evaluateBankLoan  — gating logic + monthly calc
 *   originateBankLoan — creates the BankLoan + credits cash + -5 score
 *
 * The drawBankLoanOffer modal in src/ui/modals/bankLoanOffer.ts calls
 * evaluateBankLoan() each frame to show live APR/monthly/denial-reason
 * as the player flips amount + term buttons, then routes ACCEPT to
 * originateBankLoan when approved.
 */

import type { LifeState, BankLoan } from '@/state/life';
import { getCreditTier, adjustCredit, approxMonthlyIncome } from '@/sim/credit';
import { calcLoanPayment } from '@/sim/loanMath';
import { monthlyHousing, monthlyCarPayments, monthlyBankPayments } from '@/sim/billsCalc';

/** Term ladder in months — the four discrete options the offer modal
 *  exposes. 1:1 with monolith L45598. */
export const BANK_LOAN_TERMS: readonly number[] = [24, 36, 48, 60];

/** Amount ladder in dollars — the seven discrete options the offer
 *  modal's amount picker exposes. The monolith hard-codes these in
 *  drawBankLoanOffer (L49276). */
export const BANK_LOAN_AMOUNTS: readonly number[] = [500, 1000, 2500, 5000, 10000, 25000, 50000];

/** Per-tier base APR. EXC gets the floor; BAD doesn't get a loan
 *  at all (eval rejects) but the rate is here for completeness.
 *  1:1 with monolith L45596. */
const BANK_LOAN_RATES: Readonly<Record<string, number>> = {
  EXCELLENT: 0.095,
  GOOD:      0.115,
  FAIR:      0.145,
  POOR:      0.185,
  BAD:       0.24,
};

/** Hard credit-tier amount caps. BAD = no loan at all; others scale
 *  up. 1:1 with monolith L45632 tierCap. */
const TIER_CAP: Readonly<Record<string, number>> = {
  EXCELLENT: 50000,
  GOOD:      25000,
  FAIR:      10000,
  POOR:      3500,
  BAD:       0,
};

/** Open the offer modal. Caller is the GET BANK LOAN button on the
 *  BILLS tab; the modal renders + handles its own clicks until the
 *  player accepts or cancels. Defaults to $5k / 48mo per monolith
 *  L50843. */
export function openBankLoanOffer(life: LifeState): void {
  life.bankLoanOffer = { amount: 5000, term: 48 };
}

/** Pre-rolled APR for the player's current credit tier. */
export function getBankLoanAPR(life: LifeState): number {
  const tier = getCreditTier((life.creditScore as number) ?? 650);
  return BANK_LOAN_RATES[tier.tier] ?? 0.15;
}

/** Decision returned by [[evaluateBankLoan]] — drives the modal's
 *  ACCEPT button enable state and the denial-reason text. */
export interface BankLoanDecision {
  approved: boolean;
  /** Either 'Approved' or the specific denial reason. */
  reason: string;
  apr: number;
  /** Monthly payment in dollars (rounded). 0 when amount<=0. */
  monthly: number;
}

/** Evaluate the offer against the player's credit + income. Pure —
 *  safe to call every frame as the modal repaints. Mirrors monolith
 *  L45623-L45647 1:1, with one modular adaptation: existingMonthly
 *  pulls housing/cars/bank from the modular bills helpers instead of
 *  monolith's `getTotalCarPayments + getTotalBankPayments + housing
 *  mortgage|rent`. Net effect is identical — both sum every owed
 *  monthly debt the player carries today. */
export function evaluateBankLoan(
  life: LifeState,
  amount: number,
  termMonths: number,
): BankLoanDecision {
  if (amount <= 0) {
    return { approved: false, reason: 'Enter an amount', apr: 0, monthly: 0 };
  }
  const tier = getCreditTier((life.creditScore as number) ?? 650);
  const apr = getBankLoanAPR(life);
  const monthly = Math.round(calcLoanPayment(amount, apr, termMonths));
  if (tier.tier === 'BAD') {
    return {
      approved: false,
      reason: 'Credit too low (' + (life.creditScore ?? 650) + ')',
      apr, monthly,
    };
  }
  const cap = TIER_CAP[tier.tier] ?? 0;
  if (amount > cap) {
    return {
      approved: false,
      reason: tier.tier + ' credit max is $' + cap.toLocaleString(),
      apr, monthly,
    };
  }
  // Debt-to-income gate (≤35% of gross monthly income, mirrors
  // monolith L45642). Income approximation: 20 working days/mo ×
  // job's daily salary (approxMonthlyIncome). Unemployed → income
  // = 0 → DTI = Infinity → denial.
  const annualIncome = approxMonthlyIncome(life.playerJob || '') * 12;
  const monthlyIncome = annualIncome / 12;
  const existingMonthly = monthlyHousing(life)
                        + monthlyCarPayments(life)
                        + monthlyBankPayments(life);
  const totalMonthly = monthly + existingMonthly;
  const dti = monthlyIncome > 0 ? totalMonthly / monthlyIncome : 1.0;
  if (dti > 0.35) {
    const dtiPct = Math.round(dti * 100);
    return {
      approved: false,
      reason: 'Debt-to-income too high (' + dtiPct + '%, max 35%)',
      apr, monthly,
    };
  }
  return { approved: true, reason: 'Approved', apr, monthly };
}

/** Accept the offer — creates a BankLoan, credits the principal to
 *  life.money, applies a small credit hit (-5) for opening new debt.
 *  Caller is expected to gate on evaluateBankLoan().approved before
 *  calling. Mirrors monolith L45650-L45666 originateBankLoan.
 *
 *  Modular BankLoan shape (life.ts: amount/monthsRemaining/
 *  monthlyPayment/apr) differs from monolith's
 *  principal/monthly/remaining/rate field naming, so this helper
 *  writes the modular names directly. */
export function originateBankLoan(
  life: LifeState,
  amount: number,
  termMonths: number,
  apr: number,
  monthly: number,
): void {
  if (!life.bankLoans) life.bankLoans = [];
  const loan: BankLoan = {
    amount,
    monthsRemaining: termMonths,
    monthlyPayment: monthly,
    apr,
  };
  life.bankLoans.push(loan);
  life.money += amount;
  adjustCredit(life, -5, 'new bank loan opened');
}
