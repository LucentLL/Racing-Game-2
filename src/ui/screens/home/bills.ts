/**
 * Bills tab — three-section collapsible debt summary + bank loan offer.
 *
 * v8.99.102 introduced the BILLS tab (replaces old HOUSING tab role).
 * v8.99.109 reworked into three collapsible sections with one-line
 * summaries and TOTAL OWED on the right; tap to expand individual
 * loans. State lives in LIFE.billsExpanded ('housing' | 'vehicles' |
 * 'bank' | null); default collapsed.
 *
 * Past-due treatment (v8.99.110): pulsing red banner under the subtitle
 * + per-section red border / background tint when isHousingPastDue() /
 * isAnyBillPastDue() return true. PAST DUE marker replaces the gray
 * count subline.
 *
 * Bank loan offer overlay is a separate modal-style draw on top of the
 * bills tab — amount + term picker grid + APR / approval evaluation
 * (v8.99.110 word-wraps long denial reasons so they don't clip).
 *
 * Both functions emit hit-rect arrays (LIFE._billsSectionRects,
 * LIFE._billsBankGetLoanRect, LIFE._billsHomeExtraBtns,
 * LIFE._billsCarsExtraBtns, LIFE._billsPayHomeRect, LIFE._billsPayCarsRect)
 * which are read by handleHomeScreenClick's bills-prompt intercept (see
 * ./index.ts L50567-50617 — that path runs BEFORE per-tab dispatch).
 *
 * Ported from monolith L49108-49340 (drawHomeBills) + L49341-49468
 * (drawBankLoanOffer).
 *
 * SCAFFOLD status: type contract + entry points stubbed with TODO line
 * refs.
 */

/** Section keys for the collapsible cascade. */
export type BillsSection = 'housing' | 'vehicles' | 'bank' | null;

/** Per-frame inputs for the bills tab. */
export interface BillsOpts {
  /** Active expanded section (LIFE.billsExpanded). */
  expanded: BillsSection;
  /** Monthly totals — drive the subtitle + each section header. */
  housingCost: number;
  carPayments: number;
  bankPayments: number;
  /** Total-owed numbers (mortgage payoff, sum of car loan remainders, bank). */
  housingOwed: number;
  carsOwed: number;
  bankOwed: number;
  /** Days until the next 1st-of-month bills run. */
  daysUntilBill: number;
  /** Past-due flags (v8.99.110). */
  housingPastDue: boolean;
  anyPastDue: boolean;
  /** Active housing tier (for HOUSING section detail rendering). */
  housingTier: { name: string; rent: number; mortgage: number };
  /** Per-loan detail for expanded VEHICLES section. */
  carLoans: Array<{ carId: string; monthly: number; remaining: number }>;
  /** Canvas internal width / height. */
  GW: number;
  GH: number;
  BACK_ZONE: number;
}

/** Per-frame inputs for the bank loan offer overlay. */
export interface BankLoanOfferOpts {
  /** Selected amount + term (LIFE.bankLoanOffer). */
  amount: number;
  term: number;
  /** Player credit score + tier badge. */
  creditScore: number;
  creditTier: { tier: string; color: string };
  /** Allowed terms (_BANK_LOAN_TERMS). */
  allowedTerms: number[];
  /** Evaluation result for current selection (apr, approved, monthly,
   *  reason). */
  evaluation: {
    apr: number;
    approved: boolean;
    monthly: number;
    reason?: string;
  };
  /** Canvas internal width / height. */
  GW: number;
  GH: number;
}

/** Draws the bills tab — header + 3 collapsible sections.
 *  TODO(D30-followup): port from L49108-49340. */
export function drawHomeBills(
  _ctx: CanvasRenderingContext2D,
  _opts: BillsOpts,
): void {
  // TODO: L49108-49340. drawSectionHeader is a local helper that emits
  // chevron + title + count subline (or PAST DUE marker) + right-aligned
  // total owed / monthly. Each section header pushes into
  // LIFE._billsSectionRects.
}

/** Draws the bank loan offer modal overlay — amount/term picker grids,
 *  APR + approval status, monthly + total + interest preview, or
 *  word-wrapped denial reason. TODO(D30-followup): port from L49341-49468. */
export function drawBankLoanOffer(
  _ctx: CanvasRenderingContext2D,
  _opts: BankLoanOfferOpts,
): void {
  // TODO: L49341-49468.
}
