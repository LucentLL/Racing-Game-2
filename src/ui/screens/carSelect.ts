/**
 * Starting-car select screen — third (final) step of character creation.
 *
 * Shown after job select (v8.99.40 split the flow). Reads the four pre-
 * computed deal cards from LIFE._carSelect (populated upstream by
 * generateStartingCarChoices in handleJobSelectClick). Layout: header
 * with player + credit summary, then up to 4 cards (BEATER / USED
 * RELIABLE / NEW — LOAN / LEASE), each with kind, car name, price
 * (always total — v8.99.43), cond%, mileage, transmission (v8.99.126.83),
 * and a finance-detail line (down + monthly × term).
 *
 * NOT to be confused with the in-game #carSelect modal (DOM-backed,
 * opened from STATUS tab via openCarSelect) — that one ships in
 * D31 modals/carPicker.ts.
 *
 * Picking a card commits the deal, sets gameState='playing', and runs
 * the game-start wiring: applyCssTilt, dayPhase='home', generate
 * newspaper + daily jobs, open home screen, init audio, fire monthly-
 * bills popup if dayOfMonth===1 (v8.99.42 — Day 1 = Friday = bills due).
 *
 * Ported from monolith L45114-45290.
 *
 * SCAFFOLD status: type contract + entry points stubbed with TODO line
 * refs. CarChoice shape mirrors what generateStartingCarChoices builds.
 */

/** Top of the card list, below the header. */
export const CAR_LIST_TOP = 100;
/** Card height. */
export const CAR_CARD_H = 70;
/** Bottom strip reserved for the scroll-hint chrome. */
export const CAR_BOTTOM_STRIP = 20;

/** Pre-computed deal card shape (one per BEATER / USED / LOAN / LEASE). */
export interface CarChoice {
  /** 'BEATER' | 'USED RELIABLE' | 'NEW — LOAN' | 'LEASE'. */
  kind: string;
  /** Car ID (key into CARS map). May be null for placeholder/locked rows. */
  carId: string | null;
  /** Total price in dollars (always shown top-right per v8.99.43). */
  price: number;
  /** Condition % (factory default — car not yet owned). */
  cond: number;
  /** Mileage in miles. */
  mileage: number;
  /** Sales-floor tagline shown when the deal is takeable. */
  tagline: string;
  /** Replaces tagline when locked / unaffordable. */
  blockReason?: string;
  /** True when player can't afford it. */
  canAfford: boolean;
  /** True when the deal is gated (e.g., credit too low for LEASE). */
  locked: boolean;
  /** 'cash' | 'loan' | 'lease' — drives the bottom-line wording. */
  financeType: 'cash' | 'loan' | 'lease';
  /** Down payment ($, if loan/lease). */
  down?: number;
  /** Monthly payment ($, if loan/lease). */
  monthly?: number;
  /** Term length (months, if loan/lease). */
  term?: number;
}

/** Header inputs (player + credit summary). */
export interface CarSelectHeader {
  playerAlias: string;
  playerJob: string;
  money: number;
  gender: 'M' | 'F';
  fitness: number;
  skinTone: number;
  /** Credit display (color/tier from getCreditTier()). */
  credit: { tier: string; color: string };
  creditScore: number;
  /** Estimated monthly job income (sel.jobMo). */
  jobMo: number;
}

/** Per-frame inputs for the car-select draw pass. */
export interface CarSelectOpts {
  header: CarSelectHeader;
  /** The four (or fewer) deal cards in display order. */
  choices: CarChoice[];
  /** Scroll offset for the list. Caller owns + clamps. */
  scrollY: number;
  /** Canvas internal width / height. */
  GW: number;
  GH: number;
}

/** Caller-supplied callbacks invoked on a successful car selection. */
export interface CarSelectDeps {
  /** Called when the player taps a usable card. The screen has already
   *  filtered out locked / unaffordable rows and showNotif'd the block
   *  reason. The caller commits applyStartingCarChoice + the rest of
   *  game-start wiring. */
  onPick(choice: CarChoice): void;
  /** Notification toast (e.g., "Can't take this deal: <reason>"). */
  showNotif(msg: string): void;
}

/** Draws the header + scrollable card list + scroll hint / scroll bar.
 *  Renders an ERROR fallback if LIFE._carSelect is missing.
 *  TODO(D28-followup): port from L45117-45248. */
export function drawCarSelect(
  _ctx: CanvasRenderingContext2D,
  _opts: CarSelectOpts,
): void {
  // TODO: L45117-45248.
}

/** Routes a tap to the right card. Locked / unaffordable cards toast a
 *  block reason instead of advancing.
 *  TODO(D28-followup): port from L45249-45290. */
export function handleCarSelectClick(
  _tx: number,
  _ty: number,
  _opts: CarSelectOpts,
  _deps: CarSelectDeps,
): void {
  // TODO: L45249-45290.
}
