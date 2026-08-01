/**
 * Real generateStartingCarChoices — the four-card lineup shown on the
 * carSelect screen. Ported from monolith L44251-44515.
 *
 * H1287: the lineup is BACKSTORY, not a day-1 purchase. The player
 * already had whichever car they pick before the game starts, so every
 * lane is always selectable — no cash gate, no down-payment gate, no
 * credit lock. Down payments / due-at-signing were paid pre-game
 * (they set the carried loan balance but never touch starting cash).
 * What the choice actually decides is the ongoing burden:
 *
 *   1. BEATER          — paid off, old + high-mileage, no monthly bill
 *   2. USED RELIABLE   — 48mo loan carried over, moderate age + miles
 *   3. NEW — LOAN      — 60mo loan carried over, ≤2yr old
 *   4. LEASE           — 36mo lease carried over, ≤2yr old
 *
 * Each lane runs the same algorithm:
 *   a. Price every eligible candidate from CAR_CATALOG.
 *   b. Filter to the lane's income-keyed target band.
 *   c. Fall back to the cheapest candidate if the band is empty.
 *   d. Pick from the upper half (aspirational-but-reachable).
 *   e. Build a CarChoice with pre-resolved carName + transType so the
 *      render layer never reaches into CAR_CATALOG.
 *
 * Credit still matters — it sets the APR baked into the carried loan's
 * monthly payment — it just never locks a lane anymore.
 */

import type { CarChoice, CarSelectHeader } from '@/ui/screens/carSelect';
import type { JobName } from '@/config/jobs';
import { JOB_SALARY } from '@/config/jobs';
import { CAR_LOAN_RATE_NEW, CAR_LOAN_RATE_USED } from '@/config/housing';
import { CAR_CATALOG, ALL_CAR_IDS, isCarAccessible, type CatalogCar } from '@/config/cars/catalog';
import { calcUsedPrice } from './usedPrice';
import { calcStartingCredit, getCreditTier, type CreditTier } from './credit';
import { calcLoanPayment, calcLeasePayment } from './loanMath';

const r = Math.random;

const EXCLUDED_IDS = new Set([
  'ambulance', 'tow_truck', 'police_cruiser', 'semi_truck', 'box_truck',
]);

const FALLBACK_BEATER_ID = 'honda_civic_sir_ii__eg___93';

/** Convert a CatalogCar to the bits the carSelect CarChoice needs. */
function carDisplay(car: CatalogCar): { carId: string; carName: string; transType: 'AUTO' | 'MANUAL' } {
  return {
    carId: car.id,
    carName: car.name,
    transType: car.defaultManual ? 'MANUAL' : 'AUTO',
  };
}

/** Pick from the upper half (most-expensive first half) of a sorted
 *  pool — gives the player something aspirational, not always the
 *  cheapest. */
function pickFromUpperHalf<T>(pool: T[], priceOf: (x: T) => number): T {
  const sorted = [...pool].sort((a, b) => priceOf(b) - priceOf(a));
  const halfN = Math.max(1, Math.floor(sorted.length * 0.5));
  return sorted[Math.floor(r() * halfN)];
}

interface PricedCar {
  id: string;
  car: CatalogCar;
  /** Used price (depreciated MSRP) — computed once, reused for sort. */
  up: number;
}

function priceUsed(cond: number, mileage: number, gameYear: number, minAge: number, maxAge: number): PricedCar[] {
  const out: PricedCar[] = [];
  for (const id of ALL_CAR_IDS) {
    if (EXCLUDED_IDS.has(id)) continue;
    if (!isCarAccessible(id)) continue; // H1113: no sub-100 HP starter cars
    const car = CAR_CATALOG[id];
    const carAge = gameYear - car.modelYear;
    if (carAge < minAge || carAge > maxAge) continue;
    out.push({ id, car, up: calcUsedPrice(car.price, car.modelYear, gameYear, cond, mileage) });
  }
  return out;
}

function buildBeater(gameYear: number): CarChoice {
  const cond = 15 + Math.floor(r() * 25);
  const mileage = 100_000 + Math.floor(r() * 120_000);
  const TARGET_LO = 400;
  const TARGET_HI = 3000;

  // BEATER = anything 3+ years old.
  const priced = priceUsed(cond, mileage, gameYear, 3, 100);

  const pool = priced.filter((x) => x.up >= TARGET_LO && x.up <= TARGET_HI);

  let picked: PricedCar | null = null;
  if (pool.length > 0) {
    picked = pickFromUpperHalf(pool, (x) => x.up);
  } else if (priced.length > 0) {
    priced.sort((a, b) => a.up - b.up);
    picked = priced[0];
  }

  let carId: string;
  let car: CatalogCar;
  let price: number;
  if (picked) {
    carId = picked.id;
    car = picked.car;
    price = picked.up;
  } else {
    carId = FALLBACK_BEATER_ID;
    car = CAR_CATALOG[carId] || ({ id: carId, name: 'Fallback Beater', price: 1500, hp: 100, kg: 1200, drv: 'FF', modelYear: 1993, defaultManual: true, rhd: false, color: '#888' } as CatalogCar);
    price = Math.max(400, Math.min(3000, calcUsedPrice(car.price, car.modelYear, gameYear, cond, mileage)));
  }

  return {
    kind: 'BEATER',
    ...carDisplay(car),
    price,
    cond,
    mileage,
    tagline: 'Paid off. High miles, tired.',
    canAfford: true,
    locked: false,
    financeType: 'cash',
    down: 0,
    monthly: 0,
    term: 0,
  };
}

function buildUsedReliable(gameYear: number, credit: CreditTier, targetMo: number): CarChoice {
  const cond = 55 + Math.floor(r() * 20);
  const mileage = 30_000 + Math.floor(r() * 60_000);
  const targetLo = Math.round(Math.max(4000, targetMo * 35));
  const targetHi = Math.round(Math.max(10_000, targetMo * 80));

  const priced = priceUsed(cond, mileage, gameYear, 2, 7);

  const pool = priced.filter((x) => x.up >= targetLo && x.up <= targetHi);

  let picked: PricedCar | null = null;
  if (pool.length > 0) {
    picked = pickFromUpperHalf(pool, (x) => x.up);
  } else if (priced.length > 0) {
    priced.sort((a, b) => a.up - b.up);
    picked = priced[0];
  }

  const car = picked ? picked.car : CAR_CATALOG[FALLBACK_BEATER_ID];
  const price = picked ? picked.up : calcUsedPrice(car.price, car.modelYear, gameYear, cond, mileage);
  const down = Math.round(price * 0.15);
  const fin = price - down;
  const apr = CAR_LOAN_RATE_USED + credit.aprAdj;
  const monthly = Math.round(calcLoanPayment(fin, apr, 48));
  return {
    kind: 'USED RELIABLE',
    ...carDisplay(car),
    price,
    cond,
    mileage,
    tagline: 'Sensible. 48mo loan carries over.',
    canAfford: true,
    locked: false,
    financeType: 'loan',
    down,
    monthly,
    term: 48,
  };
}

function newish(gameYear: number): CatalogCar[] {
  const out: CatalogCar[] = [];
  for (const id of ALL_CAR_IDS) {
    if (EXCLUDED_IDS.has(id)) continue;
    if (!isCarAccessible(id)) continue; // H1113: no sub-100 HP starter cars
    const car = CAR_CATALOG[id];
    if (gameYear - car.modelYear > 2) continue;
    out.push(car);
  }
  return out;
}

function buildNewLoan(gameYear: number, credit: CreditTier, targetMo: number): CarChoice {
  const lo = Math.round(Math.max(8000, targetMo * 60));
  const hi = Math.round(Math.max(18_000, targetMo * 150));
  const candidates = newish(gameYear);

  let pool = candidates.filter((c) => c.price >= lo && c.price <= hi);
  if (pool.length === 0) pool = candidates;

  let car: CatalogCar;
  if (pool.length > 0) {
    car = pickFromUpperHalf(pool, (c) => c.price);
  } else {
    car = CAR_CATALOG[FALLBACK_BEATER_ID];
  }

  const price = car.price;
  const down = Math.round(price * 0.10);
  const fin = price - down;
  const apr = CAR_LOAN_RATE_NEW + credit.aprAdj;
  const monthly = Math.round(calcLoanPayment(fin, apr, 60));
  return {
    kind: 'NEW — LOAN',
    ...carDisplay(car),
    price,
    cond: 100,
    mileage: 0,
    tagline: 'Brand new. 60mo loan carries over.',
    canAfford: true,
    locked: false,
    financeType: 'loan',
    down,
    monthly,
    term: 60,
  };
}

function buildLease(gameYear: number, targetMo: number): CarChoice {
  const lo = Math.round(Math.max(15_000, targetMo * 120));
  const hi = Math.round(Math.max(35_000, targetMo * 300));

  const candidates = newish(gameYear);

  let pool = candidates.filter((c) => c.price >= lo && c.price <= hi);
  if (pool.length === 0) pool = candidates;

  let car: CatalogCar;
  if (pool.length > 0) {
    car = pickFromUpperHalf(pool, (c) => c.price);
  } else {
    car = CAR_CATALOG[FALLBACK_BEATER_ID];
  }

  const price = car.price;
  const monthly = calcLeasePayment(price);
  const down = Math.round(monthly * 3);
  return {
    kind: 'LEASE',
    ...carDisplay(car),
    price,
    cond: 100,
    mileage: 0,
    tagline: 'Leased — return after 36mo.',
    canAfford: true,
    locked: false,
    financeType: 'lease',
    down,
    monthly,
    term: 36,
  };
}

export interface StartingCarPayload {
  header: CarSelectHeader;
  choices: CarChoice[];
}

/** The main entry point. Called from the jobSelect→carSelect transition.
 *  Build the four-card lineup based on the player's age + savings +
 *  job. */
export function generateStartingCarChoices(opts: {
  age: number;
  money: number;
  job: JobName;
  playerAlias: string;
  gender: 'M' | 'F';
  fitness: number;
  skinTone: number;
}): StartingCarPayload {
  const { age, money, job } = opts;
  const jobMo = (JOB_SALARY[job] || 0) * 20; // approx monthly (~20 work days)
  const creditScore = calcStartingCredit(age, money, job);
  const credit = getCreditTier(creditScore);
  const targetMo = Math.max(80, Math.round(jobMo * 0.25));
  const gameYear = 1999;

  return {
    header: {
      playerAlias: opts.playerAlias,
      playerJob: job,
      money,
      gender: opts.gender,
      fitness: opts.fitness,
      skinTone: opts.skinTone,
      credit: { tier: credit.tier, color: credit.color },
      creditScore,
      jobMo,
    },
    choices: [
      buildBeater(gameYear),
      buildUsedReliable(gameYear, credit, targetMo),
      buildNewLoan(gameYear, credit, targetMo),
      buildLease(gameYear, targetMo),
    ],
  };
}
