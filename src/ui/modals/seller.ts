/**
 * Seller visit overlay — private-seller dealership simulation.
 *
 * Lifecycle phases (LIFE.sellerVisit.phase):
 *   - 'driving'   → no overlay (just a map pin); player drives to the
 *                   seller's location.
 *   - 'menu'      → full-screen menu (PURCHASE / HAGGLE / INSPECT /
 *                   TEST DRIVE / WALK AWAY).
 *   - 'testdrive' → minimal HUD timer at top center; tap to abort.
 *
 * startSellerVisit places the seller on a random road tile (>20 tiles
 * from home — keeps drives interesting), generates pre-existing faults
 * via generateUsedCarFaults (used cars only), and discounts the listing
 * price by faultPriceDiscount(preFaults) into hagglePrice.
 *
 * Inspect / test drive flags:
 *   - sv._inspected unlocks visual fault disclosure (visual count +
 *     "Some issues only show during driving..." hint when test-drive-
 *     only faults remain undetected).
 *   - sv._testDriven adds the test-drive disclosure (count of felt
 *     issues, or "Drove fine" when none surfaced).
 *
 * Haggle flow:
 *   - haggleWithSeller is the side-effect path the HAGGLE button
 *     invokes. Mirrors inspection.ts haggle math but operates on
 *     LIFE.sellerVisit.hagglePrice instead of inspectCar.hagglePrice.
 *
 * Ported from monolith L49513 (startSellerVisit), L49560 (drawSellerOverlay),
 * L49645 (handleSellerClick), L49708 (haggleWithSeller).
 *
 * SCAFFOLD status: type contract + entry points stubbed with TODO line
 * refs.
 */

import type { PreFault } from './inspection';

/** Lifecycle phase. */
export type SellerPhase = 'driving' | 'menu' | 'testdrive';

/** Action keys emitted by button taps. */
export type SellerAction = 'buy' | 'haggle' | 'inspect' | 'testdrive' | 'leave';

/** LIFE.sellerVisit shape. */
export interface SellerVisitState {
  listing: {
    id: string;
    name: string;
    price: number;
    cond: number;
    mileage: number;
    isNew: boolean;
  };
  source: 'newspaper' | 'lot';
  index: number;
  /** World coords of the seller location. */
  mapX: number;
  mapY: number;
  phase: SellerPhase;
  /** Pre-existing faults (mostly hidden until inspect / test drive). */
  preFaults: PreFault[];
  /** Test-drive countdown (seconds). */
  testDriveTimer: number;
  /** Saved player car for restore after test drive. */
  tdSavedCar: unknown | null;
  /** Haggle state. */
  haggled: boolean;
  hagglePrice: number;
  /** Inspect / test-drive done flags. */
  _inspected?: boolean;
  _testDriven?: boolean;
}

/** Per-frame inputs for the seller overlay. */
export interface SellerOpts {
  state: SellerVisitState;
  /** Canvas internal width / height. */
  GW: number;
  GH: number;
}

/** Side effects the seller buttons invoke. */
export interface SellerDeps {
  /** PURCHASE — opens the finance menu at hagglePrice. */
  openPurchase(): void;
  /** HAGGLE — applies fault-tier discount via haggleWithSeller. */
  haggle(): void;
  /** INSPECT — sets _inspected, marks visible faults detected. */
  inspect(): void;
  /** TEST DRIVE — saves tdSavedCar, transitions to 'testdrive' phase. */
  startTestDrive(): void;
  /** End test drive early (tap on top HUD timer). */
  endTestDrive(): void;
  /** WALK AWAY — clears LIFE.sellerVisit. */
  walkAway(): void;
}

/** Places the seller on a random road tile, generates faults, discounts
 *  price, sets phase='driving', closes the home screen, drops a marker
 *  notification. TODO(D31-followup): port from L49513-49547. */
export function startSellerVisit(
  _listing: SellerVisitState['listing'],
  _source: 'newspaper' | 'lot',
  _index: number,
): void {
  // TODO: L49513-49547. >20-tile distance-from-home rule keeps drives
  // non-trivial.
}

/** Draws the test-drive timer HUD (when phase==='testdrive') OR the
 *  full-screen seller menu (when phase==='menu'). 'driving' phase
 *  renders nothing — just the map pin (handled by world layer).
 *  TODO(D31-followup): port from L49560-49643. */
export function drawSellerOverlay(
  _ctx: CanvasRenderingContext2D,
  _opts: SellerOpts,
): void {
  // TODO: L49560-49643. Five buttons in 'menu' phase: PURCHASE / HAGGLE
  // / INSPECT / TEST DRIVE / WALK AWAY.
}

/** Routes a tap to the right button (or aborts test drive when in
 *  'testdrive' phase). Returns true when consumed.
 *  TODO(D31-followup): port from L49645-end of seller click. */
export function handleSellerClick(
  _tx: number,
  _ty: number,
  _opts: SellerOpts,
  _deps: SellerDeps,
): boolean {
  // TODO: L49645+.
  return false;
}

/** Applies the fault-tier discount to LIFE.sellerVisit.hagglePrice and
 *  flips haggled=true. Same per-tier %s as inspection.ts.
 *  TODO(D31-followup): port from L49708. */
export function haggleWithSeller(_state: SellerVisitState): void {
  // TODO: L49708. Mirror inspection.ts haggle math; cap 40%.
}
