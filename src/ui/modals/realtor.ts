/**
 * Realtor visit overlay — home purchase mirror of seller.ts.
 *
 * Same lifecycle (driving → menu → no test drive — homes don't drive).
 * Header / agent label varies by listing.isRental ('🏠 PROPERTY MANAGER'
 * vs '🏡 REAL ESTATE AGENT').
 *
 * completeHomePurchase has two paths:
 *   - Rentals: pay deposit + first month upfront (price × 2). Sets
 *     housingType, monthlyHousingCost, clears mortgage.
 *   - Owned: deduct down payment, set mortgageBalance to loan amount,
 *     set monthsRemaining to _HOUSE_LOAN_MONTHS (30yr). Sets
 *     housingType, monthlyHousingCost.
 * Either path: removes listing from LIFE.newspaper + carPins (with pin
 * index repair so remaining pins still resolve to their listings).
 *
 * checkRealtorArrival is the per-frame poll that flips phase from
 * 'driving' to 'menu' when player is within 2 tiles + nearly stopped.
 *
 * Ported from monolith L49928 (openRealtorVisit), L49940 (checkRealtorArrival),
 * L49951 (completeHomePurchase), L49990 (drawRealtorOverlay), L50106
 * (handleRealtorTap).
 *
 * SCAFFOLD status: type contract + entry points stubbed with TODO line
 * refs.
 */

/** Pre-approval result for a single mortgage offer. */
export interface RealtorOffer {
  approved: boolean;
  /** Down payment $ (owned only). */
  downAmt: number;
  /** Loan amount $ (owned only). */
  loanAmt: number;
  /** Monthly payment $. */
  monthly: number;
  /** APR (decimal). */
  apr: number;
  /** Denial reason (when !approved). */
  reason?: string;
}

/** Real-estate listing being shown. */
export interface RealtorListing {
  name: string;
  address: string;
  /** Total price ($) for owned, monthly rent for rentals. */
  price: number;
  /** Housing tier this listing maps to (drives LIFE.housingType on
   *  completion). */
  tierKey: string;
  /** Garage slots this property provides. */
  slots: number;
  /** Description copy (e.g., "3BR / 2BA in Plaza Midwood"). */
  desc: string;
  /** True when listing is a rental. */
  isRental: boolean;
  /** World coords for the realtor visit. */
  worldX: number;
  worldY: number;
  /** Day the listing expires (drives pin auto-removal). */
  expiresDay: number;
}

/** LIFE.realtorVisit shape. */
export interface RealtorVisitState {
  listing: RealtorListing;
  /** Pin reference if visit was opened from a pin tap. */
  _fromPin: unknown | null;
  /** World coords of the realtor location. */
  mapX: number;
  mapY: number;
  phase: 'driving' | 'menu';
  /** Down-payment percentage slider (0.0-1.0). */
  downPct: number;
  /** Last evaluated offer (drives the COMMIT button enable). */
  lastOffer: RealtorOffer | null;
}

/** Per-frame inputs for the realtor overlay. */
export interface RealtorOpts {
  state: RealtorVisitState;
  /** Player credit + finance summary. */
  creditScore: number;
  creditTier: { tier: string; color: string };
  /** Annual income for the affordability check. */
  annualIncome: number;
  money: number;
  /** Canvas internal width / height. */
  GW: number;
  GH: number;
}

/** Side effects the realtor buttons invoke. */
export interface RealtorDeps {
  /** Re-evaluate offer when down% changes. */
  evaluateOffer(downPct: number): RealtorOffer;
  /** Commit the deal — runs completeHomePurchase. */
  commit(): void;
  /** Walk away — clears LIFE.realtorVisit. */
  walkAway(): void;
  showNotif(msg: string): void;
}

/** LIFE-shaped slot the entry/arrival paths write into. */
export interface RealtorLife {
  realtorVisit?: RealtorVisitState | null;
}

/** Opens a realtor visit at the listing's worldX/worldY, sets phase
 *  to 'menu' immediately. The home picker runs from the newspaper
 *  tab while the player is at home — no driving step needed (the
 *  driving phase exists on the state for symmetry with sellerVisit
 *  and for future startRealtorVisit-style entries; checkRealtorArrival
 *  handles that case). 1:1 port of monolith L49846-49856. */
export function openRealtorVisit(
  life: RealtorLife,
  listing: RealtorListing,
  pin: unknown | null,
  showNotif: (msg: string) => void,
): void {
  life.realtorVisit = {
    listing,
    _fromPin: pin ?? null,
    mapX: listing.worldX,
    mapY: listing.worldY,
    phase: 'menu',
    downPct: 0.20,
    lastOffer: null,
  };
  showNotif(listing.isRental ? '🏠 Property manager ready' : '🏡 Real estate agent ready');
}

/** Per-frame poll: when phase==='driving' and player is within 2
 *  tiles + nearly stopped (|pSpeed|<3), flip to 'menu'. 1:1 port of
 *  monolith L49858-49866. */
export function checkRealtorArrival(
  rv: RealtorVisitState | null | undefined,
  player: { px: number; py: number; pSpeed: number },
  deps: { tilePx: number; showNotif(msg: string): void },
): void {
  if (!rv || rv.phase !== 'driving') return;
  const dx = player.px - rv.mapX;
  const dy = player.py - rv.mapY;
  const radius2 = deps.tilePx * deps.tilePx * 4;
  if (dx * dx + dy * dy < radius2 && Math.abs(player.pSpeed) < 3) {
    rv.phase = 'menu';
    player.pSpeed = 0;
    deps.showNotif('You arrived at the property!');
  }
}

/** Draws the realtor overlay — header + listing summary + price/stats +
 *  player summary + offer slider + COMMIT/WALK buttons.
 *  TODO(D31-followup): port from L49990-end of realtor draw. */
export function drawRealtorOverlay(
  _ctx: CanvasRenderingContext2D,
  _opts: RealtorOpts,
): void {
  // TODO: L49990+.
}

/** Routes a tap (down-pct slider, COMMIT, WALK).
 *  TODO(D31-followup): port from L50106+. */
export function handleRealtorTap(
  _tx: number,
  _ty: number,
  _opts: RealtorOpts,
  _deps: RealtorDeps,
): boolean {
  // TODO: L50106+.
  return false;
}

/** Finalizes the deal — rentals pay 2× upfront, owneds set mortgage,
 *  both paths remove listing + repair pin indices.
 *  TODO(D31-followup): port from L49951-49988. */
export function completeHomePurchase(): void {
  // TODO: L49951-49988. Pin index repair walks remaining LIFE.carPins
  // and re-resolves pin.index = LIFE.newspaper.indexOf(pin.listing).
}
