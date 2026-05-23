/**
 * Used-car lot listing generator — samples 8 catalog cars and rolls
 * a sale-ready row per pick: new vs used, condition rating, age-
 * realistic mileage, and the cond-scaled price.
 *
 * Surfaces in the pause-menu GARAGE-tab "USED CAR LOT" sub-screen
 * (monolith L34707+). Each call returns a fresh array — the
 * monolith stashes it in a `carLot` module-level global; the
 * modular pattern stores it on LifeState (or wherever the GARAGE
 * tab port lands) so the lot stays stable between refreshes.
 *
 * H540: 1:1 port of monolith generateCarLot at L9106-L9119.
 * Distinct from [[generateNewspaperListings]] — the newspaper
 * surface uses a 0.25 new-probability, 5 listings, cond derived
 * from mileage, and carries a `problem` disclosure + a breakChance.
 * The lot surface uses 0.15 new-probability, 8 listings, a flat
 * 40-89 cond roll, and no problem/breakChance — listings on the
 * physical lot are pre-screened by the dealer.
 *
 * Both surfaces share [[generateRealisticOdo]] for the mileage
 * draw (H539) and the `0.3 + cond/200` cond-scaled price formula
 * — same monolith convention.
 */

import { CAR_CATALOG, ALL_CAR_IDS } from '@/config/cars/catalog';
import { generateRealisticOdo } from '@/sim/realisticOdo';

/** Probability that any one lot pick lands as a brand-new car
 *  (cond 100, mileage 0). Lower than the newspaper's 0.25 because
 *  the physical lot historically skews to dealer trade-ins.
 *  Matches monolith L9112 `Math.random() < 0.15`. */
export const NEW_CAR_PROBABILITY = 0.15;

/** Floor of the random condition roll for used picks. Matches
 *  monolith L9113 `40 + floor(random*50)` → cond ∈ [40, 89]. */
export const USED_COND_MIN = 40;

/** Width of the random condition roll for used picks. */
export const USED_COND_SPREAD = 50;

/** Number of rows the lot generates per call. Matches monolith
 *  L9110 `i < 8 && i < shuffled.length`. */
export const LOT_SIZE = 8;

/** Cond-scaled price multiplier — base + cond_pct/200. A mint car
 *  (cond=100) lists at base × 0.8; a fixer-upper (cond=40) lists
 *  at base × 0.5. Shared with the newspaper price formula
 *  (matches monolith L9115 / L45319). */
export const PRICE_BASE_MULT = 0.3;
/** Cond-scaling divisor for the price multiplier — cond pct
 *  divided by this yields the per-cond price bump. 200 → cond=100
 *  adds 0.5 to the base. */
export const PRICE_COND_DIVISOR = 200;

/** A single lot row. Shape matches the monolith's push at L9116. */
export interface CarLotListing {
  /** Slugified catalog id. */
  id: string;
  /** Display name (from CAR_CATALOG[id].name). */
  name: string;
  /** Asking price (USD), already rounded. */
  price: number;
  /** 0..100 visual condition rating. */
  cond: number;
  /** Odometer reading (miles). 0 for `isNew` rows. */
  mileage: number;
  /** True for dealer-new picks; cond=100, mileage=0, price=MSRP. */
  isNew: boolean;
}

/** Generate a fresh used-car lot. Pure — no LIFE mutation, no
 *  carLot global to write through. Caller stashes the returned
 *  array wherever it needs to live (GARAGE-tab state, save
 *  schema, etc.).
 *
 *  The shuffle is `Math.random()-0.5` matching the monolith — not
 *  uniform across all 8! permutations, but cheap and indistinguishable
 *  for an 8-row pick. The slice is `<8 && <shuffled.length` so
 *  catalogs with fewer than 8 cars (test fixtures) still render
 *  cleanly.
 *
 *  Ported 1:1 from monolith generateCarLot at L9106-L9119.
 *
 *  @param day  Current in-game day, passed through to
 *              generateRealisticOdo so listing mileage advances with
 *              the game-year clock. Defaults to 0 — same starting
 *              behavior the monolith has on cold boot before LIFE.day
 *              increments. */
export function generateCarLot(day: number = 0): CarLotListing[] {
  const lot: CarLotListing[] = [];
  const shuffled = [...ALL_CAR_IDS].sort(() => Math.random() - 0.5);
  const n = Math.min(LOT_SIZE, shuffled.length);
  for (let i = 0; i < n; i++) {
    const id = shuffled[i];
    const c = CAR_CATALOG[id];
    if (!c) continue;
    const isNew = Math.random() < NEW_CAR_PROBABILITY;
    const cond = isNew
      ? 100
      : (USED_COND_MIN + Math.floor(Math.random() * USED_COND_SPREAD));
    const mileage = isNew ? 0 : generateRealisticOdo(c.modelYear, day);
    const price = isNew
      ? c.price
      : Math.round(c.price * (PRICE_BASE_MULT + cond / PRICE_COND_DIVISOR));
    lot.push({ id, name: c.name, price, cond, mileage, isNew });
  }
  return lot;
}
