/**
 * Pin expiry — day-rollover hook that drops carPins whose
 * expiresDay has passed, surfaces a "SOLD!" notif per dropped
 * pin, clears the linked listing's isPinned flag so it stops
 * surviving fillNewspaper's pinned-protection filter, and cleans
 * up orphan pins whose listing reference is no longer in
 * life.newspaper at all.
 *
 * H545: 1:1 port of monolith expireCarPins at L50464-L50480.
 *
 * MONOLITH-VS-MODULAR DIVERGENCE: the monolith fillNewspaper
 * drops every listing whose expiresDay has passed (no
 * pinned-protection). The modular fillNewspaperListings (H36)
 * adds `row.isPinned || row.expiresDay >= day` so pinned listings
 * survive daily refresh until the player unpins them. That design
 * makes pin expiry the AUTHORITATIVE clear-isPinned event — without
 * the listing.isPinned flip in this module, a pinned listing whose
 * pin has expired would survive fillNewspaperListings indefinitely
 * as a zombie. The monolith doesn't need this because its
 * fillNewspaper drops the listing first; the pin orphan-check at
 * L50478 then sweeps the pin in the same rollover. Modular splits
 * the work across two day-rollovers: H545 here drops the pin +
 * clears isPinned, then the NEXT rollover's fillNewspaperListings
 * drops the now-unpinned-and-expired listing.
 *
 * The monolith L50476 "Remove expired newspaper listings" line is
 * SKIPPED in the modular port because fillNewspaperListings already
 * does that work — duplicating it here would re-filter the same
 * array immediately before fillNewspaperListings re-filters it
 * again. The orphan-pin check at L50478 still fires (some pin's
 * listing may have been dropped by an earlier path like
 * completePurchase / completeRealtorVisit which splice the listing
 * out of life.newspaper without touching pins).
 */

import type { LifeState } from '@/state/life';

/** Day-rollover pin expiry hook. Mutates life.carPins (filtering
 *  dead entries) and listing.isPinned flags. Notify dep receives
 *  one "📌 NAME (LABEL) SOLD!" string per expired pin — caller
 *  pipes to the in-game toast queue.
 *
 *  Ported 1:1 from monolith expireCarPins at L50464-L50480
 *  (modulo the listing-expiry sub-step which fillNewspaperListings
 *  owns in the modular tree — see module docstring). */
export function expireCarPins(
  life: LifeState,
  day: number,
  notify: (msg: string) => void,
): void {
  if (!life.carPins || life.carPins.length === 0) return;

  // Drop pins whose expiresDay has passed. Per-pin SOLD notif +
  // clear the linked listing's isPinned flag so the listing stops
  // surviving fillNewspaper's pinned-protection filter.
  life.carPins = life.carPins.filter((p) => {
    if (p.expiresDay && day > p.expiresDay) {
      // Look up listing name for the notif. pin.listing is unknown
      // on the schema (decoupled from newspaper module); read its
      // .name field via a narrow cast.
      const listingName = (p.listing as { name?: string } | undefined)?.name ?? 'Listing';
      notify('📌 ' + listingName + ' (' + p.label + ') SOLD!');
      // Clear isPinned on the matching newspaper row so the next
      // fillNewspaperListings drops it via the standard expiry path.
      const src = life.newspaper?.find((l) => l === p.listing);
      if (src) src.isPinned = false;
      return false;
    }
    return true;
  });

  // Orphan-pin sweep: pins whose listing reference is no longer in
  // life.newspaper (the listing was dropped by some non-expiry path
  // like a completed purchase / realtor commit before the pin's
  // own expiresDay landed). Matches monolith L50478.
  if (life.newspaper) {
    const liveListings = new Set(life.newspaper);
    life.carPins = life.carPins.filter((p) => liveListings.has(p.listing as typeof life.newspaper[number]));
  }
}
