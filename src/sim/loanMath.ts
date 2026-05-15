/**
 * Loan + lease payment math. Pure functions, no LIFE / state coupling.
 * Ported from monolith L45480-45491.
 */

import { LEASE_RESIDUAL, LEASE_MONEY_FACTOR } from '@/config/housing';

/** Standard amortized loan payment. Returns monthly $ amount given
 *  principal, annual APR (0..1), and term in months. */
export function calcLoanPayment(principal: number, apr: number, months: number): number {
  const r = apr / 12;
  if (r === 0) return principal / months;
  return principal * (r * Math.pow(1 + r, months)) / (Math.pow(1 + r, months) - 1);
}

/** 36-month lease payment. Residual = 45% of MSRP (LEASE_RESIDUAL).
 *  Monthly = depreciation / 36 + (MSRP + residual) * money factor.
 *  Returns rounded $ integer. */
export function calcLeasePayment(msrp: number): number {
  const residual = Math.round(msrp * LEASE_RESIDUAL);
  const depreciation = (msrp - residual) / 36;
  const financeCharge = (msrp + residual) * LEASE_MONEY_FACTOR;
  return Math.round(depreciation + financeCharge);
}
