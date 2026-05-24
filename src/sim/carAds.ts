/**
 * Car-ad lifecycle helpers: daily offer generator, accept-offer
 * handler, cancel-ad handler. The garage tab's ACTIVE ADS section
 * renders against the same shape this module mutates.
 *
 * 1:1 port of monolith L43745-L43819:
 *   generateCarAdOffers — daily weekday roll, pushes Offer entries
 *     onto each ad + mirrors them into LIFE.mail as carOffer items.
 *   acceptCarOffer — sells the car for the offer amount, handles
 *     loan payoff (with upside-down guard), splices the ad +
 *     ownedCars + matching carLoans entries, prunes mail offers.
 *   cancelCarAd — removes the ad outright (no penalty).
 *
 * H576: simplified — lease detection skipped since CarLoan doesn't
 * carry a 'lease' discriminator in modular yet; if/when leases port,
 * add a guard in acceptCarOffer that rejects with a "Can't sell a
 * leased car!" notif. cancelPendingForCar is also deferred (no
 * pendingParts queue yet); related in-flight work for a sold car
 * persists until the queue ports.
 */

import type { LifeState } from '@/state/life';
import { CAR_CATALOG } from '@/config/cars/catalog';
import { getCarValue } from '@/sim/race';
import { showNotif } from '@/ui/notif';

/** A single offer on an ad — amount + day it arrived. */
export interface CarOffer {
  amount: number;
  day: number;
}

/** A single car listing on the newspaper-classifieds surface. The
 *  garage tab's ACTIVE ADS section renders these. Mirrors monolith
 *  ad shape at L43741: `{carId, askPrice, daysListed, offers}`.
 *
 *  _renderY + _offerY are render-cache fields the draw pass
 *  populates so the click router can hit-test without re-running
 *  layout — same convention modular uses elsewhere (PARTS view,
 *  bills tab, etc.). */
export interface CarAd {
  carId: string;
  askPrice: number;
  daysListed: number;
  offers: CarOffer[];
  _renderY?: number;
  _offerY?: number;
}

/** Mail entry mirrored from a carOffer. */
export interface CarOfferMail {
  type: 'carOffer';
  carId: string;
  carName: string;
  amount: number;
  day: number;
  read: boolean;
}

/** Daily ad tick — fires on day rollover. Walks every active ad,
 *  bumps its daysListed, and rolls a fresh offer on weekdays.
 *
 *  Weekend gate: SAT (dow=1) + SUN (dow=2) are quiet — first offer
 *  on a Friday listing lands Monday. Matches monolith L43750-L43755.
 *
 *  Offer chance: 0.45 + 0.10 × daysListed, capped at 0.85 — older
 *  ads attract more attention but plateau. Lowball range: 50-95% of
 *  fairValue (heavily skewed low — buyers haggle).
 *
 *  Each offer additionally mirrors into life.mail as a carOffer
 *  notification so the H568 mail badge ticks up. */
export function generateCarAdOffers(life: LifeState): void {
  const ads = (life.carAds as CarAd[] | undefined) ?? [];
  if (ads.length === 0) return;
  const day = life.day;
  const dow = ((day - 1) % 7 + 7) % 7; // 0=FRI 1=SAT 2=SUN 3=MON 4=TUE 5=WED 6=THU
  const isWeekend = dow === 1 || dow === 2;
  if (!life.mail) life.mail = [];
  const activeId = life.ownedCars[0];

  for (const ad of ads) {
    ad.daysListed = (ad.daysListed ?? 0) + 1;
    if (isWeekend) continue;
    const offerChance = Math.min(0.85, 0.45 + ad.daysListed * 0.10);
    if (Math.random() >= offerChance) continue;
    const c = CAR_CATALOG[ad.carId];
    if (!c) continue;
    const fairValue = getCarValue(life, ad.carId, activeId);
    const lowball = 0.5 + Math.random() * 0.45;
    const amount = Math.round(fairValue * lowball);
    ad.offers.push({ amount, day });
    // Mirror into mailbox.
    (life.mail as CarOfferMail[]).push({
      type: 'carOffer',
      carId: ad.carId,
      carName: c.name,
      amount,
      day,
      read: false,
    });
    showNotif(life, '📬 Mail — offer on ' + c.name + ': $' + amount.toLocaleString(), 180);
  }
}

/** Accept the supplied offer on the supplied ad. Sells the car,
 *  removes it from ownedCars + carLoans, prunes ad + matching
 *  mail entries. Loan handling:
 *    - No loan: full offer amount credits to money.
 *    - With loan: net = offer - loanPayoff. If net < 0 AND player
 *      can't cover the gap from cash, refuse the sale (player must
 *      pay down the loan or accept a higher offer).
 *
 *  Mirrors monolith L43778-L43813 minus the lease branch + the
 *  carConditions / loadCarCondition swap.
 *
 *  Single-car guard: refuses the sale when ownedCars.length<=1 so
 *  the player can't accidentally ad-sell their last car (the lot
 *  flow has the loaner-beater path; ad flow doesn't). */
export function acceptCarOffer(
  life: LifeState,
  adIdx: number,
  offerIdx: number,
): void {
  const ads = (life.carAds as CarAd[] | undefined) ?? [];
  const ad = ads[adIdx];
  if (!ad) return;
  const offer = ad.offers[offerIdx];
  if (!offer) return;
  if (life.ownedCars.length <= 1) {
    showNotif(life, "Can't sell your only car!", 120);
    return;
  }
  const carId = ad.carId;
  if (carId === life.ownedCars[0] && life.job) {
    showNotif(life, 'Finish your job first!', 120);
    return;
  }
  const car = CAR_CATALOG[carId];
  if (!car) return;
  const loan = life.carLoans.find((l) => l.carId === carId);
  if (loan) {
    const payoff = loan.monthlyPayment * loan.monthsRemaining;
    const net = offer.amount - payoff;
    if (net < 0 && life.money < Math.abs(net)) {
      showNotif(life, 'Upside down! Need $' + Math.abs(net).toLocaleString() + ' to cover loan.', 180);
      return;
    }
    life.money += net;
    life.carLoans = life.carLoans.filter((l) => l.carId !== carId);
    showNotif(life, 'SOLD ' + car.name + ' for $' + offer.amount.toLocaleString() + ' (loan payoff: $' + payoff.toLocaleString() + ')', 240);
  } else {
    life.money += offer.amount;
    showNotif(life, 'SOLD ' + car.name + ' for $' + offer.amount.toLocaleString() + '!', 240);
  }
  // Remove the car from ownedCars (next car in the array becomes
  // active automatically — gameLoop reads ownedCars[0] each frame).
  life.ownedCars = life.ownedCars.filter((id) => id !== carId);
  // Splice the ad.
  ads.splice(adIdx, 1);
  life.carAds = ads as unknown[];
  // Prune mail offers for this carId.
  if (life.mail) {
    life.mail = (life.mail as CarOfferMail[])
      .filter((m) => !(m.type === 'carOffer' && m.carId === carId)) as unknown[];
  }
  // Clear the expanded panel if it was pointing at the sold car
  // (otherwise the next paint would render an out-of-bounds row).
  life._garageExpandedIdx = undefined;
}

/** Cancel an active ad. No penalty — just removes the listing.
 *  Mail offers for the cancelled car are kept in the inbox (they
 *  read "listing closed" tail per the H568 mail tab). */
export function cancelCarAd(life: LifeState, adIdx: number): void {
  const ads = (life.carAds as CarAd[] | undefined) ?? [];
  const ad = ads[adIdx];
  if (!ad) return;
  const car = CAR_CATALOG[ad.carId];
  ads.splice(adIdx, 1);
  life.carAds = ads as unknown[];
  showNotif(
    life,
    'Ad for ' + (car?.name ?? ad.carId) + ' cancelled.',
    150,
  );
}
