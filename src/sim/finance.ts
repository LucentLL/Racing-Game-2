import type { LifeState } from '@/state/life';
import {
  CAR_LOAN_RATE_NEW,
  CAR_LOAN_RATE_USED,
  LEASE_MONEY_FACTOR,
  LEASE_RESIDUAL,
  BANK_LOAN_RATES,
  BANK_LOAN_TERMS,
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
