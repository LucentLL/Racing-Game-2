/**
 * Purchase finance menu — modal for finalizing a car deal.
 *
 * Opens after PURCHASE on inspection / seller. Shows pre-computed
 * finance options (cash / loan / lease) as cards with affordability
 * coloring, current car payments header (so the player sees existing
 * monthly load before committing), and a BACK button.
 *
 * v8.99.122 desktop centering wraps the body — same pattern as the
 * inspection modal. Click handler subtracts _menuCenterOffX from tx.
 *
 * completePurchase finalizes the deal:
 *   - Saves current car's condition before switching (v8.25).
 *   - Deducts down payment.
 *   - Pushes to LIFE.carLoans if not cash.
 *   - Sets odometer from listing mileage (v8.25 — only if car is new
 *     to ownership).
 *   - Adds to LIFE.ownedCars + CAR_IDS.
 *   - Initializes engine/tires/carHP/paint/fuel based on isNew.
 *   - Splits preFaults: detected → LIFE.faults, hidden → LIFE._hiddenFaults
 *     with LIFE._hiddenFaultOdo for "drive N miles to surface" gating.
 *   - Saves new car's condition.
 *   - Removes listing from source array (carLot or LIFE.newspaper, with
 *     pin cleanup for the latter).
 *   - Closes purchase + inspection + sellerVisit modals.
 *
 * Ported from monolith L45971-46220 (completePurchase, drawPurchaseMenu,
 * handlePurchaseMenuClick).
 *
 * SCAFFOLD status: type contract + entry points stubbed with TODO line
 * refs.
 */

import type { PreFault } from './inspection';

/** One finance option row. */
export interface FinanceOption {
  /** 'cash' | 'loan' | 'lease'. */
  type: 'cash' | 'loan' | 'lease';
  label: string;
  desc: string;
  /** Down payment ($). */
  down: number;
  /** Monthly payment ($). 0 for cash. */
  monthly: number;
  /** Term in months (loan/lease). */
  term: number;
  /** Total paid over the term ($). */
  total: number;
  /** APR (decimal — loan/lease only). */
  rate?: number;
}

/** LIFE.purchaseMenu shape. */
export interface PurchaseMenuState {
  carId: string;
  carName: string;
  price: number;
  isNew: boolean;
  source: 'lot' | 'newspaper';
  index: number;
  /** Pre-faults from the source listing — flow through to completePurchase. */
  preFaults?: PreFault[];
  /** True when the deal flowed from a sellerVisit (closes that modal too). */
  sellerVisit?: boolean;
  /** Pre-computed finance options. */
  options: FinanceOption[];
  /** Source listing reference (drives odometer initialization). */
  listing?: { mileage: number };
}

/** Per-frame inputs for the purchase menu draw pass. */
export interface PurchaseOpts {
  state: PurchaseMenuState;
  money: number;
  /** Sum of all current car payments (header banner). */
  existingPayments: number;
  /** HUD canvas width / centering offset (v8.99.122). */
  HUD_W: number;
  menuCenterOffX: number;
  /** Canvas internal width / height. */
  GW: number;
  GH: number;
}

/** Side effects of choosing a finance option. */
export interface PurchaseDeps {
  /** Commits the chosen finance option — invokes completePurchase. */
  commit(option: FinanceOption): void;
  /** Closes the purchase menu without committing (BACK button). */
  cancel(): void;
}

/** Draws the dim backdrop + header + options stack + BACK button.
 *  TODO(D31-followup): port from L46028-46094. Each option row pushes
 *  into pm._optYs; cancel y stored in pm._cancelY. */
export function drawPurchaseMenu(
  _ctx: CanvasRenderingContext2D,
  _opts: PurchaseOpts,
): void {
  // TODO: L46028-46094.
}

/** Routes a tap to a finance option or the BACK button. Subtracts
 *  _menuCenterOffX from tx FIRST. TODO(D31-followup): port from
 *  L46096+. */
export function handlePurchaseMenuClick(
  _tx: number,
  _ty: number,
  _opts: PurchaseOpts,
  _deps: PurchaseDeps,
): boolean {
  // TODO: L46096+.
  return false;
}

/** Finalizes the deal — saves current car condition, deducts down,
 *  pushes loan/lease, sets odometer from mileage, adds to ownedCars,
 *  splits faults into detected vs hidden, removes from source array,
 *  closes overlapping modals. TODO(D31-followup): port from L45971-46025. */
export function completePurchase(
  _carId: string,
  _carName: string,
  _price: number,
  _isNew: boolean,
  _finOpt: FinanceOption,
  _source: 'lot' | 'newspaper',
  _index: number,
  _preFaults: PreFault[] | undefined,
  _sellerVisit: boolean,
): void {
  // TODO: L45971-46025. v8.25 condition save before/after switch +
  // odometer-from-mileage. Hidden faults stored with _hiddenFaultOdo
  // baseline so "drive N miles to surface" gating works.
}
