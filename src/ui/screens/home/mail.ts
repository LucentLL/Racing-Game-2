/**
 * Mail tab — buyer offers (newspaper ads) + parts packages.
 *
 * v8.99.33 split into two sections:
 *   - OFFERS  — incoming bids on cars the player listed. Sorted newest
 *               first. Color-coded: amber (still-listed) vs grey
 *               (listing closed).
 *   - PACKAGES — pending parts orders placed via DIY delivery. Each
 *                tags its target car name and shows ETA / DELIVERED.
 *
 * Side effect on draw: marks all OFFERS as read (kills the unread badge
 * on the tab icon). The mailbox-viewed event is implicit — opening the
 * tab IS reading the mail.
 *
 * Empty state: a brief explainer ("Offers arrive Mon-Fri when you list
 * a car / Parts you order via DIY delivery land here too").
 *
 * Ported from monolith L47878-47985.
 *
 * SCAFFOLD status: type contract + entry points stubbed with TODO line
 * refs.
 */

/** Car ID — bare string key into CARS map. */
type CarId = string;

/** Single offer-mail letter. */
export interface OfferMail {
  type: 'carOffer';
  carId: CarId;
  carName: string;
  amount: number;
  /** Game day the offer arrived. */
  day: number;
  /** True after first view. Caller flips on draw to clear the unread badge. */
  read: boolean;
}

/** Single pending-parts entry. */
export interface PendingPart {
  carId: CarId;
  name: string;
  /** Game day the part arrives (may be today). */
  readyDay: number;
  /** Hour-of-day the part arrives, if same-day. */
  readyHour?: number;
}

/** Per-frame inputs for the mail tab. */
export interface MailOpts {
  /** All mail letters. The tab body filters to type==='carOffer'. */
  mail: Array<OfferMail | { type: string }>;
  /** Pending parts orders. */
  pendingParts: PendingPart[];
  /** Active newspaper ads — drives "still listed" coloring on offers. */
  carAds: Array<{ carId: CarId }>;
  /** Current game day / hour for ETA computation. */
  day: number;
  hour: number;
  /** Scroll offset (LIFE._scrollY — shared per-tab). */
  scrollY: number;
  /** Canvas internal width / height. */
  GW: number;
  GH_BASE: number;
  BACK_ZONE: number;
}

/** Side effects the draw pass needs (in addition to ctx mutations). */
export interface MailDeps {
  /** Side effect: mark all OFFERS read. Called once per draw to clear
   *  the unread badge on the MAIL tab icon. */
  markAllOffersRead(): void;
  /** Updates the caller-owned scroll bounds (LIFE._scrollMax / _scrollY
   *  clamping). The orchestrator owns the actual state. */
  setScrollBounds(scrollMax: number, scrollY: number): void;
}

/** Draws the mail tab — title + offers section + packages section + empty
 *  state when both are empty. TODO(D29-followup): port from L47878-47985. */
export function drawHomeMail(
  _ctx: CanvasRenderingContext2D,
  _opts: MailOpts,
  _deps: MailDeps,
): void {
  // TODO: L47878-47985. Sections in order: header (📬 MAILBOX), OFFERS,
  // PACKAGES. Empty state copy when both are empty.
}
