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
 *   - localDeals bonus listing — needs the connections subsystem
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
