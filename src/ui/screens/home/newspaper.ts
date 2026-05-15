/**
 * Newspaper tab — Charlotte Observer classifieds.
 *
 * v8.99.102 added a CARS / HOMES section toggle inside the newspaper.
 * Section state lives in LIFE.newspaperSection ('cars' | 'homes';
 * default 'cars'). Rows are filtered at draw time but the click hit-
 * rects use the ORIGINAL array index (origIdx) so pin lookups —
 * LIFE.carPins reference listings by position in LIFE.newspaper —
 * stay valid across section switches.
 *
 * Tapping a listing places a pin on the map and starts a seller visit
 * (cars) or a realtor visit (homes). The pin marker is drawn on the
 * newspaper row when LIFE.carPins contains a matching entry.
 *
 * Affordability coloring:
 *   - cars  → green when LIFE.money >= price (heuristic — actual deal
 *             can be financed, this is just the UI hint)
 *   - homes → green when isRental && money >= 2× monthly rent, OR
 *             owned && money >= 5% down payment
 *
 * Empty-state copy varies by section.
 *
 * Hit rects emitted into LIFE._newsTabRects (section toggle) and
 * LIFE._newsRowRects (per-row, with origIdx).
 *
 * Ported from monolith L50127-50295.
 *
 * SCAFFOLD status: type contract + entry point stubbed with TODO line
 * refs.
 */

/** Section discriminator. */
export type NewspaperSection = 'cars' | 'homes';

/** Single classifieds row. */
export interface NewspaperListing {
  /** 'house' = real estate row; anything else = car. */
  type?: string;
  /** Display name. */
  name: string;
  /** Price ($). */
  price: number;
  /** True for rentals (homes only). */
  isRental?: boolean;
}

/** Pin marker for a listing (LIFE.carPins[]). */
export interface ListingPin {
  /** Index into LIFE.newspaper. */
  index: number;
  label: string;
  color: string;
}

/** Per-frame inputs for the newspaper tab. */
export interface NewspaperOpts {
  /** Active section. */
  section: NewspaperSection;
  /** All listings — filtered at draw time but indexed by original pos. */
  newspaper: NewspaperListing[];
  /** Pinned listings — drives in-row marker rendering. */
  carPins: ListingPin[];
  /** Player money (drives affordability coloring). */
  money: number;
  /** "Mon Jul 14" style date for the subtitle. */
  shortDate: string;
  /** Scroll offset (LIFE._scrollY — shared per-tab). */
  scrollY: number;
  /** Canvas internal width / height. */
  GW: number;
  GH: number;
  BACK_ZONE: number;
}

/** Draws the newspaper tab — header + CARS/HOMES section toggle +
 *  scrollable filtered list + empty state. Per-row pin markers when
 *  carPins matches by origIdx. Emits LIFE._newsTabRects +
 *  LIFE._newsRowRects. TODO(D30-followup): port from L50127-50295. */
export function drawHomeNewspaper(
  _ctx: CanvasRenderingContext2D,
  _opts: NewspaperOpts,
): void {
  // TODO: L50127-50295. Row height 40, listings filtered by section
  // but indexed via origIdx so pins stay stable.
}
