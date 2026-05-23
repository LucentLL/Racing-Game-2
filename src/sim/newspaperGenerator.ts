/**
 * H35 newspaper listings generator — port of monolith generateNewspaper
 * L45294-45375 in simplified form. Produces ~5 car classifieds + ~3
 * house classifieds per call. Pure (no LIFE mutation) — caller decides
 * where to stash the array.
 *
 * Deferred from full monolith body:
 *   - Impounded-car buyback rows (LIFE.impoundedCars is `string[]` in
 *     the interim port — the monolith uses `{id,name,price,...}` objects
 *     populated by the cop subsystem, which hasn't ported)
 *   - World-position pins (worldX/worldY) — needs the map-pin subsystem
 *   - H523 wired the localDeals bonus listing — when LIFE.localDeals
 *     is true (set by H519's updateConnections after neighborhoodDays
 *     >= 60), 40% of rolls add a deeper-discounted "tip from a
 *     neighbor" car at the tail of the car listings.
 *   - Deterministic RNG seed — currently uses Math.random() so each
 *     call generates a fresh paper
 *   - Dedupe against already-listed cars from a previous newspaper —
 *     fillNewspaper port still pending
 */

import type { LifeState } from '@/state/life';
import { CAR_CATALOG, ALL_CAR_IDS } from '@/config/cars/catalog';
import { HOUSING_TIERS, type HousingTierKey } from '@/config/housing';

/** A used / new car row in the classifieds. */
export interface CarListing {
  type: 'car';
  /** Slugified catalog id. */
  id: string;
  /** Display name. */
  name: string;
  /** Asking price (USD). */
  price: number;
  /** 0..100 visual condition rating. */
  cond: number;
  /** Odometer reading (miles). */
  mileage: number;
  /** True if dealer-new (zero miles, cond=100). */
  isNew: boolean;
  /** Disclosed problem string (empty if none). */
  problem: string;
  /** 0..0.5 per-day breakdown probability — informational here. */
  breakChance: number;
  /** Horsepower (from catalog). */
  hp: number;
  /** Day this listing rolls off the paper. */
  expiresDay: number;
  /** H36 tap-to-pin flag. Pinned listings survive daily refresh until
   *  the player unpins them. The full LIFE.carPins/PlacedPin port adds
   *  worldX/Y + label/color when the map-pin subsystem lands. */
  isPinned?: boolean;
}

/** A real-estate row in the classifieds. */
export interface HouseListing {
  type: 'house';
  /** HOUSING_TIERS key. */
  tierKey: HousingTierKey;
  /** Tier name ("Mid-Range Home"). */
  name: string;
  /** Generated street address. */
  address: string;
  /** Rent/mo (rentals) OR asking price (owned). */
  price: number;
  /** Effective monthly (= price for rentals; mortgage estimate for owned). */
  monthlyEst: number;
  /** Garage slots. */
  slots: number;
  /** Tier blurb. */
  desc: string;
  /** True for rental tiers (apt / rental house). */
  isRental: boolean;
  /** Day this listing rolls off the paper. */
  expiresDay: number;
  /** H36 tap-to-pin flag. See CarListing.isPinned. */
  isPinned?: boolean;
}

export type NewspaperListing = CarListing | HouseListing;

const JOB_VEHICLE_IDS = new Set([
  'ambulance',
  'tow_truck',
  'police_cruiser',
  'semi_truck',
  'box_truck',
]);

const STREET_NAMES: readonly string[] = [
  'Elm St',
  'Queens Rd',
  'Park Ave',
  'Providence Rd',
  'Sharon Ln',
  'Selwyn Ave',
  'Colony Rd',
  'Morehead St',
  'Tyvola Rd',
  'Eastway Dr',
];

const HOUSE_KEYS: readonly HousingTierKey[] = [
  'apt1br',
  'apt2br',
  'rentHouse',
  'ownStarter',
  'ownMid',
  'ownNice',
];

const CAR_PROBLEMS: readonly string[] = [
  'Engine knock',
  'Leaky radiator',
  'Worn brakes',
  'Bad transmission',
  'Oil leak',
  'Cracked windshield',
];

/** Base in-game year. Day 1 = Jan 1999 (monolith convention). */
const GAME_BASE_YEAR = 1999;

function pickRandom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Simplified port of monolith generateRealisticOdo — 8k-15k miles/yr
 *  scaled by car age. Real monolith mixes in fleet-vs-personal cars and
 *  trickier weighting; this is the average-case reading. */
function generateRealisticOdo(modelYear: number, baseYear = GAME_BASE_YEAR): number {
  const age = Math.max(0, baseYear - modelYear);
  const milesPerYear = 8000 + Math.random() * 7000;
  return Math.round(age * milesPerYear);
}

/** Generate a fresh page of classifieds: ~5 cars (excluding job
 *  vehicles + cars the player already owns) + 3-4 houses. The 'day'
 *  arg is the current in-game day, used to stamp expiresDay so future
 *  fillNewspaper port can age out stale rows. */
export function generateNewspaperListings(
  life: LifeState,
  day: number,
): NewspaperListing[] {
  const out: NewspaperListing[] = [];

  // ---------- Cars ----------
  const ownedSet = new Set(life.ownedCars);
  const pool = ALL_CAR_IDS.filter(
    (id) => !JOB_VEHICLE_IDS.has(id) && !ownedSet.has(id) && CAR_CATALOG[id],
  );
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  for (let i = 0; i < 5 && i < shuffled.length; i++) {
    const id = shuffled[i];
    const c = CAR_CATALOG[id];
    const isNew = Math.random() < 0.25;
    const mileage = isNew ? 0 : generateRealisticOdo(c.modelYear);
    const cond = isNew
      ? 100
      : Math.max(15, Math.round(100 - mileage / 2500 + Math.floor(Math.random() * 20 - 10)));
    const hasProblem = !isNew && Math.random() < 0.3;
    const problem = hasProblem ? pickRandom(CAR_PROBLEMS) : '';
    let price = isNew ? c.price : Math.round(c.price * (0.3 + cond / 200));
    if (hasProblem) price = Math.round(price * 0.55);
    const breakChance = isNew
      ? 0.02
      : Math.min(0.5, mileage / 300000 + (hasProblem ? 0.2 : 0));
    out.push({
      type: 'car',
      id,
      name: c.name,
      price,
      cond,
      mileage,
      isNew,
      problem,
      breakChance,
      hp: c.hp,
      expiresDay: day + 3 + Math.floor(Math.random() * 5),
    });
  }

  // ---------- localDeals bonus listing ----------
  // H523: the H519 connections subsystem flips life.localDeals true
  // after neighborhoodDays >= 60. When that flag is on, 40% of
  // newspaper rolls add an extra "tip from a neighbor" car listing
  // at a substantially deeper discount than the main 5 — the
  // neighborhood-knows-someone-selling-cheap perk.
  //
  // Picks the 6th car from the same shuffled pool (or wraps to
  // shuffled[0] when the pool only had ≤5 entries — defensive for
  // small catalogs / heavily-owned states), random cond in [60, 89]
  // (better than the average used-car discount tier), age-based
  // mileage via generateRealisticOdo, price formula
  // `c.price * (0.2 + cond/250)` (deeper discount than the main
  // `0.3 + cond/200` curve), no disclosed problem (the seller
  // doesn't mention any), low breakChance (0.05), 2-day expiry
  // (vs main 3-7 — these go fast).
  //
  // 1:1 port of monolith L45326-L45339.
  if (life.localDeals && Math.random() < 0.4) {
    const bonusId = shuffled[5] ?? shuffled[0];
    if (bonusId) {
      const bc = CAR_CATALOG[bonusId];
      if (bc) {
        const bCond = 60 + Math.floor(Math.random() * 30);
        const bMile = generateRealisticOdo(bc.modelYear);
        const bPrice = Math.round(bc.price * (0.2 + bCond / 250));
        out.push({
          type: 'car',
          id: bonusId,
          name: bc.name,
          price: bPrice,
          cond: bCond,
          mileage: bMile,
          isNew: false,
          problem: '',
          breakChance: 0.05,
          hp: bc.hp,
          expiresDay: day + 2,
        });
      }
    }
  }

  // ---------- Houses ----------
  const houseCount = 3 + Math.floor(Math.random() * 2); // 3 or 4
  for (let i = 0; i < houseCount; i++) {
    const key = pickRandom(HOUSE_KEYS);
    const t = HOUSING_TIERS[key];
    if (!t) continue;
    const addrNum = 100 + Math.floor(Math.random() * 9900);
    const street = pickRandom(STREET_NAMES);
    const address = `${addrNum} ${street}`;
    const isRental = (t.rent || 0) > 0;
    const jitter = 0.92 + Math.random() * 0.16; // ±8%
    const listingPrice = isRental
      ? Math.round(t.rent * jitter)
      : Math.round(t.price * jitter);
    out.push({
      type: 'house',
      tierKey: key,
      name: t.name,
      address,
      price: listingPrice,
      monthlyEst: isRental ? listingPrice : Math.round(t.mortgage * jitter),
      slots: t.slots,
      desc: t.desc,
      isRental,
      expiresDay: day + 4 + Math.floor(Math.random() * 5),
    });
  }

  return out;
}

/** H36 daily refresh — port of monolith fillNewspaper L45382-45415.
 *  Drops expired car/house rows (unless pinned), then tops up to 5
 *  cars + 3 houses with fresh listings deduped by id (cars) / by
 *  tierKey+address (houses). Mutates life.newspaper in place. Safe to
 *  call on every day rollover; no-op if the paper is already full
 *  and nothing has expired. */
export function fillNewspaperListings(life: LifeState, day: number): void {
  const target = life.newspaper || [];
  // Drop expired non-pinned rows. Pinned listings stay until the
  // player explicitly unpins them.
  const kept = target.filter((l) => l.isPinned || l.expiresDay >= day);
  const carCount = kept.filter((l) => l.type === 'car').length;
  const houseCount = kept.filter((l) => l.type === 'house').length;
  const needCars = Math.max(0, 5 - carCount);
  const needHouses = Math.max(0, 3 - houseCount);
  if (needCars === 0 && needHouses === 0) {
    life.newspaper = kept;
    return;
  }
  const fresh = generateNewspaperListings(life, day);
  const existCarIds = new Set(
    kept.filter((l): l is CarListing => l.type === 'car').map((l) => l.id),
  );
  const existHouseKeys = new Set(
    kept
      .filter((l): l is HouseListing => l.type === 'house')
      .map((l) => `${l.tierKey}|${l.address}`),
  );
  let addedCars = 0;
  let addedHouses = 0;
  for (const f of fresh) {
    if (f.type === 'car') {
      if (addedCars >= needCars) continue;
      if (existCarIds.has(f.id)) continue;
      kept.push(f);
      existCarIds.add(f.id);
      addedCars++;
    } else {
      if (addedHouses >= needHouses) continue;
      const key = `${f.tierKey}|${f.address}`;
      if (existHouseKeys.has(key)) continue;
      kept.push(f);
      existHouseKeys.add(key);
      addedHouses++;
    }
  }
  life.newspaper = kept;
}
