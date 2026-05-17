import type { LifeState } from '@/state/life';
import {
  CAR_LOAN_RATE_NEW,
  CAR_LOAN_RATE_USED,
  LEASE_MONEY_FACTOR,
  LEASE_RESIDUAL,
  BANK_LOAN_RATES,
  BANK_LOAN_TERMS,
  HOUSE_LOAN_APR,
  HOUSE_LOAN_MONTHS,
} from '@/config/housing';
import { getCreditTier } from './credit';

export function calcLoanPayment(principal: number, apr: number, months: number): number {
  const r = apr / 12;
  if (r === 0) return principal / months;
  return (principal * (r * Math.pow(1 + r, months))) / (Math.pow(1 + r, months) - 1);
}

export function calcLeasePayment(msrp: number): number {
  const residual = Math.round(msrp * LEASE_RESIDUAL);
  const depreciation = (msrp - residual) / 36;
  const financeCharge = (msrp + residual) * LEASE_MONEY_FACTOR;
  return Math.round(depreciation + financeCharge);
}

export interface PaycheckBreakdown {
  weeklyNet: number;
  weeklyTax: number;
  annualFed: number;
  annualNC: number;
  annualFICA: number;
  effectiveRate: number;
}

/**
 * 1999 paycheck-tax model (single filer, NC).
 * Federal: 15/28/31/36/39.6% brackets
 * NC: 6/7/7.75% brackets
 * FICA: 6.2% SS (capped at $72,600 1999 wage base) + 1.45% Medicare
 */
export function calcPaycheckTax(weeklyGross: number): PaycheckBreakdown {
  if (weeklyGross <= 0) {
    return { weeklyNet: 0, weeklyTax: 0, annualFed: 0, annualNC: 0, annualFICA: 0, effectiveRate: 0 };
  }
  const annualGross = weeklyGross * 52;

  const fedBrackets: ReadonlyArray<readonly [number, number, number]> = [
    [0, 25750, 0.15],
    [25750, 62450, 0.28],
    [62450, 130250, 0.31],
    [130250, 283150, 0.36],
    [283150, Infinity, 0.396],
  ];
  let fedTax = 0;
  for (const [lo, hi, rate] of fedBrackets) {
    if (annualGross <= lo) break;
    fedTax += (Math.min(annualGross, hi) - lo) * rate;
  }

  const ncBrackets: ReadonlyArray<readonly [number, number, number]> = [
    [0, 12750, 0.06],
    [12750, 60000, 0.07],
    [60000, Infinity, 0.0775],
  ];
  let ncTax = 0;
  for (const [lo, hi, rate] of ncBrackets) {
    if (annualGross <= lo) break;
    ncTax += (Math.min(annualGross, hi) - lo) * rate;
  }

  const ssTax = Math.min(annualGross, 72600) * 0.062;
  const medTax = annualGross * 0.0145;
  const fica = ssTax + medTax;
  const totalAnnualTax = fedTax + ncTax + fica;
  const weeklyTax = totalAnnualTax / 52;
  return {
    weeklyNet: Math.round(weeklyGross - weeklyTax),
    weeklyTax: Math.round(weeklyTax),
    annualFed: Math.round(fedTax),
    annualNC: Math.round(ncTax),
    annualFICA: Math.round(fica),
    effectiveRate: totalAnnualTax / annualGross,
  };
}

export interface FinanceOption {
  type: 'cash' | 'loan' | 'lease';
  label: string;
  monthly: number;
  down: number;
  total: number;
  term: number;
  rate?: number;
  desc: string;
}

export function getFinanceOptions(price: number, isNew: boolean): FinanceOption[] {
  const opts: FinanceOption[] = [];
  opts.push({
    type: 'cash',
    label: 'PAY CASH',
    monthly: 0,
    down: price,
    total: price,
    term: 0,
    desc: 'Full price: $' + price.toLocaleString(),
  });

  if (isNew) {
    const down10 = Math.round(price * 0.10);
    const fin60 = price - down10;
    const mo60 = Math.round(calcLoanPayment(fin60, CAR_LOAN_RATE_NEW, 60));
    opts.push({
      type: 'loan', label: 'LOAN 60mo', monthly: mo60, down: down10,
      total: down10 + mo60 * 60, term: 60, rate: CAR_LOAN_RATE_NEW,
      desc: '$' + down10.toLocaleString() + ' down + $' + mo60 + '/mo × 60',
    });
    const mo48 = Math.round(calcLoanPayment(fin60, CAR_LOAN_RATE_NEW, 48));
    opts.push({
      type: 'loan', label: 'LOAN 48mo', monthly: mo48, down: down10,
      total: down10 + mo48 * 48, term: 48, rate: CAR_LOAN_RATE_NEW,
      desc: '$' + down10.toLocaleString() + ' down + $' + mo48 + '/mo × 48',
    });
    const leaseMo = calcLeasePayment(price);
    const leaseDue = Math.round(leaseMo * 3);
    opts.push({
      type: 'lease', label: 'LEASE 36mo', monthly: leaseMo, down: leaseDue,
      total: leaseDue + leaseMo * 36, term: 36, rate: 0,
      desc: '$' + leaseDue.toLocaleString() + ' due + $' + leaseMo + '/mo (return at end)',
    });
  } else {
    const down15 = Math.round(price * 0.15);
    const fin48 = price - down15;
    const mo48 = Math.round(calcLoanPayment(fin48, CAR_LOAN_RATE_USED, 48));
    opts.push({
      type: 'loan', label: 'LOAN 48mo', monthly: mo48, down: down15,
      total: down15 + mo48 * 48, term: 48, rate: CAR_LOAN_RATE_USED,
      desc: '$' + down15.toLocaleString() + ' down + $' + mo48 + '/mo × 48',
    });
    const mo36 = Math.round(calcLoanPayment(fin48, CAR_LOAN_RATE_USED, 36));
    opts.push({
      type: 'loan', label: 'LOAN 36mo', monthly: mo36, down: down15,
      total: down15 + mo36 * 36, term: 36, rate: CAR_LOAN_RATE_USED,
      desc: '$' + down15.toLocaleString() + ' down + $' + mo36 + '/mo × 36',
    });
  }
  return opts;
}

export function getTotalCarPayments(life: LifeState): number {
  let total = 0;
  for (const ln of life.carLoans) total += ln.monthlyPayment;
  return total;
}

export function getTotalBankPayments(life: LifeState): number {
  let total = 0;
  for (const ln of life.bankLoans || []) total += ln.monthlyPayment;
  return total;
}

export function getTotalBankOwed(life: LifeState): number {
  let total = 0;
  for (const ln of life.bankLoans || []) total += ln.monthlyPayment * ln.monthsRemaining;
  return total;
}

export function isHousingPastDue(life: LifeState, monthlyHousingCost: number): boolean {
  return (life.missedHomePayments || 0) > 0 && monthlyHousingCost > 0;
}

/** H211: mortgage-offer evaluator. Deterministic approval check
 *  with five reject reasons + one accept. 1:1 port of monolith
 *  L49799-49843 minus the LIFE-global reads — caller threads the
 *  player's money / creditScore / annualIncome + the existing
 *  monthly debt sum so the function stays test-friendly. */
export interface HomeOfferInputs {
  price: number;
  downPct: number;
  money: number;
  creditScore: number;
  annualIncome: number;
  existingMonthlyDebt: number;
}

export interface HomeOfferResult {
  approved: boolean;
  reason: string;
  downAmt: number;
  loanAmt: number;
  monthly: number;
  apr: number;
}

export function evaluateHomeOffer(inputs: HomeOfferInputs): HomeOfferResult {
  const { price, downPct, money, creditScore, annualIncome, existingMonthlyDebt } = inputs;
  const downAmt = Math.round(price * downPct);
  const loanAmt = price - downAmt;
  const credit = getCreditTier(creditScore);
  const apr = Math.max(0.04, HOUSE_LOAN_APR + credit.aprAdj);
  const monthly = Math.round(calcLoanPayment(loanAmt, apr, HOUSE_LOAN_MONTHS));
  const monthlyIncome = annualIncome / 12;
  const totalMonthly = monthly + existingMonthlyDebt;
  const dti = monthlyIncome > 0 ? totalMonthly / monthlyIncome : 1.0;

  // Minimum down payment by credit tier. EXCELLENT 5% / GOOD 10% /
  // FAIR 15% / POOR 20% / BAD = denied. 1:1 with monolith L49820-49824.
  let minDown = 0.05;
  if (credit.tier === 'GOOD') minDown = 0.10;
  else if (credit.tier === 'FAIR') minDown = 0.15;
  else if (credit.tier === 'POOR') minDown = 0.20;
  else if (credit.tier === 'BAD') minDown = 1.00;

  if (money < downAmt) {
    return { approved: false, reason: 'Not enough cash for down payment', downAmt, loanAmt, monthly, apr };
  }
  if (credit.tier === 'BAD') {
    return { approved: false, reason: 'Credit score too low (' + creditScore + ')', downAmt, loanAmt, monthly, apr };
  }
  if (downPct < minDown) {
    const pctStr = Math.round(minDown * 100);
    return { approved: false, reason: 'Need at least ' + pctStr + '% down for ' + credit.tier + ' credit', downAmt, loanAmt, monthly, apr };
  }
  if (annualIncome > 0 && loanAmt > annualIncome * 4) {
    return { approved: false, reason: 'Loan exceeds 4× annual income', downAmt, loanAmt, monthly, apr };
  }
  if (dti > 0.35) {
    const dtiPct = Math.round(dti * 100);
    return { approved: false, reason: 'Debt-to-income too high (' + dtiPct + '%, max 35%)', downAmt, loanAmt, monthly, apr };
  }
  return { approved: true, reason: 'Offer accepted!', downAmt, loanAmt, monthly, apr };
}

export function isVehiclesPastDue(life: LifeState): boolean {
  return (life.missedCarPayments || 0) > 0 && life.carLoans.length > 0;
}

export function isBankPastDue(life: LifeState): boolean {
  return (life.missedCarPayments || 0) > 0 && (life.bankLoans || []).length > 0;
}

export function isAnyBillPastDue(life: LifeState, monthlyHousingCost: number): boolean {
  return isHousingPastDue(life, monthlyHousingCost) || isVehiclesPastDue(life) || isBankPastDue(life);
}

export function getBankLoanAPR(life: LifeState): number {
  const credit = getCreditTier(life.creditScore as number || 650);
  return BANK_LOAN_RATES[credit.tier] ?? 0.15;
}

export interface BankLoanEvaluation {
  approved: boolean;
  reason?: string;
  monthly?: number;
  apr?: number;
  termMonths?: number;
}

export function evaluateBankLoan(
  life: LifeState,
  amount: number,
  termMonths: number,
  monthlyIncome: number,
): BankLoanEvaluation {
  if (amount <= 0) return { approved: false, reason: 'Enter an amount' };
  const credit = getCreditTier(life.creditScore as number || 650);
  const apr = getBankLoanAPR(life);
  const monthly = Math.round(calcLoanPayment(amount, apr, termMonths));

  if (credit.tier === 'BAD') {
    return { approved: false, reason: 'Credit tier BAD — no unsecured loans' };
  }

  const existingDebt = getTotalCarPayments(life) + getTotalBankPayments(life);
  const dtiCap = monthlyIncome * 0.35;
  if (existingDebt + monthly > dtiCap) {
    return { approved: false, reason: 'DTI exceeded (35% cap)' };
  }

  return { approved: true, monthly, apr, termMonths };
}

export function originateBankLoan(
  life: LifeState,
  amount: number,
  termMonths: number,
  apr: number,
  monthly: number,
): void {
  life.bankLoans = life.bankLoans || [];
  life.bankLoans.push({
    amount,
    monthsRemaining: termMonths,
    monthlyPayment: monthly,
    apr,
  });
  life.money += amount;
}

export { BANK_LOAN_TERMS };
