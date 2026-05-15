/**
 * Housing tab — current housing summary + scrollable tier picker.
 *
 * Header shows: current tier name, monthly cost (rent vs mortgage),
 * garage slots, mortgage payoff state (X yr Y mo left, or "OWNED FREE
 * & CLEAR"), and credit score (v8.99.49 — needed before applying for a
 * mortgage). Below the divider, a scrollable list of every tier; tap to
 * change.
 *
 * Move semantics on tap (handleHousingClick):
 *   - If tier.price > 0 → 10% down required (gated on cash).
 *     Sets mortgageBalance = price - down, mortgageMonthsRemaining = 360
 *     (30-year). Notifies down-payment amount.
 *   - If tier.price === 0 → rental. First month free; bills start next
 *     1st. Clears mortgageBalance.
 *   - Either path: sets housingType, monthlyHousingCost, garageSlots,
 *     missedPayments=0; warns if owned cars exceed new garage slots.
 *
 * Move-effective-date copy "moves on 1st" sets the player expectation —
 * the actual transition happens on the bills-due rollover.
 *
 * Ported from monolith L49022-49099 (draw) + L49469-49509 (handler).
 *
 * SCAFFOLD status: type contract + entry points stubbed with TODO line
 * refs.
 */

/** One housing tier row (from HOUSING_TIERS map). */
export interface HousingTier {
  name: string;
  /** Mutually exclusive with mortgage — non-zero for rentals. */
  rent: number;
  /** Mutually exclusive with rent — non-zero for owned tiers. */
  mortgage: number;
  /** 0 for rentals; purchase price for owned tiers. */
  price: number;
  /** Garage slot count this tier provides. */
  slots: number;
}

/** Per-frame inputs for the housing draw pass. */
export interface HousingOpts {
  /** All tiers in display order — Object.entries(HOUSING_TIERS). */
  tiers: Array<[string, HousingTier]>;
  /** Active tier key. */
  currentType: string;
  /** Player money (drives can-afford coloring). */
  money: number;
  /** Mortgage state for the header. */
  mortgageBalance: number;
  mortgageMonthsRemaining: number;
  /** Active garage slot count. */
  garageSlots: number;
  /** Credit score + tier (v8.99.49). */
  creditScore: number;
  creditTier: { tier: string; color: string };
  /** Scroll offset (LIFE._scrollY — shared per-tab). */
  scrollY: number;
  /** Canvas internal width / height. */
  GW: number;
  GH: number;
  BACK_ZONE: number;
}

/** Side effects of a successful tier change. */
export interface HousingDeps {
  /** Commits the tier switch — caller mutates LIFE.housingType,
   *  mortgageBalance, garageSlots, etc. */
  commitMove(tierKey: string, downPayment: number): void;
  showNotif(msg: string): void;
}

/** Draws the header summary + divider + scrollable tier list + scroll
 *  bar. Emits LIFE._housingListY so the click handler tracks the
 *  list-top y after layout. TODO(D30-followup): port from L49022-49099. */
export function drawHomeHousing(
  _ctx: CanvasRenderingContext2D,
  _opts: HousingOpts,
): void {
  // TODO: L49022-49099. row height = 40.
}

/** Routes a tap to the right tier row. Skips on _tapMoved (drag, not
 *  tap). 10% down enforcement gates owned-tier moves; rentals just
 *  switch. TODO(D30-followup): port from L49469-49509. */
export function handleHousingClick(
  _tx: number,
  _ty: number,
  _opts: HousingOpts,
  _deps: HousingDeps,
  _tapMoved: boolean,
): void {
  // TODO: L49469-49509.
}
