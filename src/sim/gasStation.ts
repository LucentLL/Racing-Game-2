/**
 * Gas station sim helpers — refuel, buy jerry can, mechanic services,
 * respray. Backs the drawGasStationMenu modal in
 * src/ui/modals/gasStation.ts.
 *
 * 1:1 port of monolith L43498-L43657 with one modular adaptation:
 * CatalogCar doesn't carry tankGal / fuelDoor / mpg yet, so refuel
 * defaults to a 12-gallon tank and uses fuel% direct (gallonsNeeded
 * × $/gal × tankGal/100 model). Once CatalogCar grows the fuel
 * fields, refuel() can read them off the active car.
 *
 * H571 SCOPE: simplified ordering — refuel / mechanic / respray apply
 * effects immediately; no pendingParts queue, no per-fuel-grade fuel-
 * quality engine impact yet. Per-octane preferences (high-octane car
 * running 87 underperforms) are deferred to a follow-up.
 */

import type { LifeState } from '@/state/life';
import type { CatalogCar } from '@/config/cars/catalog';
import type { FuelGrade } from '@/config/world/fuelGrades';
import type { Fault } from '@/sim/faults';
import { getCarCostMult } from '@/sim/partsShop';

/** Per-car tank default. CatalogCar doesn't carry tankGal yet —
 *  override here lands when the field ports. */
export const DEFAULT_TANK_GAL = 12;

/** Per-car mpg default. */
export const DEFAULT_MPG = 25;

/** Jerry-can purchase price. Mirrors monolith L35848. */
export const JERRY_CAN_PRICE = 10;

/** Per-respray price flat. Mirrors monolith L35888 "$100 respray" hint. */
export const RESPRAY_PRICE = 100;

/** Mechanic services available at the gas station. 1:1 port of
 *  monolith MECHANIC_SERVICES at L43625-L43634. Each service
 *  bumps the matching LIFE stat (clamped to 100) for the listed
 *  $price (pre car-cost-multiplier scaling). 'all' applies to
 *  engine + tires + carHP + paint together. */
export interface MechanicService {
  name: string;
  stat: 'engine' | 'tires' | 'carHP' | 'paint' | 'all';
  add: number;
  price: number;
  desc: string;
}
export const MECHANIC_SERVICES: readonly MechanicService[] = [
  { name: 'Oil Change',     stat: 'engine', add: 15, price:  50, desc: '+15% engine' },
  { name: 'Engine Tune-Up', stat: 'engine', add: 35, price: 200, desc: '+35% engine' },
  { name: 'Tire Rotation',  stat: 'tires',  add: 20, price:  40, desc: '+20% tires'  },
  { name: 'New Tires',      stat: 'tires',  add: 60, price: 300, desc: '+60% tires'  },
  { name: 'Body Patch',     stat: 'carHP',  add: 20, price:  80, desc: '+20% body'   },
  { name: 'Full Body Work', stat: 'carHP',  add: 50, price: 350, desc: '+50% body'   },
  { name: 'Paint Touch-Up', stat: 'paint',  add: 30, price:  60, desc: '+30% paint'  },
  { name: 'Full Service',   stat: 'all',    add: 30, price: 500, desc: '+30% all systems' },
];

/** Heuristic diesel-name check. Modular's CatalogCar doesn't carry a
 *  diesel flag yet; defensively look for 'diesel' or 'tdi' (popular
 *  badge) in the name. Trucks default to gas in the modular catalog
 *  even though several would be diesel in real life — fine for now,
 *  ports up when the catalog grows the field. */
export function isCarDiesel(car: CatalogCar | undefined): boolean {
  if (!car) return false;
  const n = car.name.toLowerCase();
  return n.includes('diesel') || n.includes('tdi');
}

/** Per-car tank capacity. Falls back to DEFAULT_TANK_GAL until the
 *  catalog grows the field. */
export function getTankGal(_car: CatalogCar | undefined): number {
  return DEFAULT_TANK_GAL;
}

/** Per-car fuel-economy estimate. Falls back to DEFAULT_MPG until the
 *  catalog grows the field. */
export function getMpg(_car: CatalogCar | undefined): number {
  return DEFAULT_MPG;
}

/** Per-car fuel door side ('L' / 'R' / 'C'). Falls back to 'C' so
 *  the proximity check accepts pumps on either side. */
export function getFuelDoor(_car: CatalogCar | undefined): 'L' | 'R' | 'C' {
  return 'C';
}

/** Fuel up. Deducts (gallonsNeeded × $/gal), sets fuel to 100, stores
 *  octane. FUEL TANKER job perks bring the bill to $0 (matches
 *  monolith L35832 jobName perk). Returns the dollars-spent for
 *  notif text. */
export function refuel(
  life: LifeState,
  car: CatalogCar | undefined,
  grade: FuelGrade,
): { spent: number; gallons: number } {
  const tank = getTankGal(car);
  const gallonsNeeded = tank * (1 - life.fuel / 100);
  if (gallonsNeeded < 0.1) return { spent: 0, gallons: 0 };
  const isFreePerk = life.playerJob === 'FUEL TANKER';
  const spent = isFreePerk ? 0 : Math.round(gallonsNeeded * grade.price * 100) / 100;
  if (life.money < spent) return { spent: 0, gallons: 0 };
  life.money -= spent;
  life.fuel = 100;
  life.fuelOctane = grade.octane;
  return { spent, gallons: gallonsNeeded };
}

/** Buy one jerry can. Deducts $10, increments life.jerryCans. */
export function buyJerryCan(life: LifeState): boolean {
  if (life.money < JERRY_CAN_PRICE) return false;
  life.money -= JERRY_CAN_PRICE;
  life.jerryCans = (life.jerryCans ?? 0) + 1;
  return true;
}

/** Buy a mechanic service. Applies cost (× carCostMult, × 0.9 with
 *  mechanicDiscount), bumps the matching stat, clears related faults,
 *  lifts broken state if engine + tires recovered. Mirrors monolith
 *  buyMechanic at L43635-L43657 1:1.
 *
 *  Returns the actual dollars deducted on success, 0 on insufficient
 *  funds. */
export function buyMechanicService(
  life: LifeState,
  car: CatalogCar | undefined,
  idx: number,
): number {
  const s = MECHANIC_SERVICES[idx];
  if (!s) return 0;
  const base = Math.round(s.price * getCarCostMult(car));
  const adjPrice = life.mechanicDiscount ? Math.round(base * 0.9) : base;
  if (life.money < adjPrice) return 0;
  life.money -= adjPrice;
  life.mechanicVisits = (life.mechanicVisits ?? 0) + 1;

  if (s.stat === 'all') {
    life.engine = Math.min(100, life.engine + s.add);
    life.tires  = Math.min(100, life.tires + s.add);
    life.carHP  = Math.min(100, life.carHP + s.add);
    life.paint  = Math.min(100, life.paint + s.add);
  } else if (s.stat === 'engine') {
    life.engine = Math.min(100, life.engine + s.add);
  } else if (s.stat === 'tires') {
    life.tires = Math.min(100, life.tires + s.add);
  } else if (s.stat === 'carHP') {
    life.carHP = Math.min(100, life.carHP + s.add);
  } else if (s.stat === 'paint') {
    life.paint = Math.min(100, life.paint + s.add);
  }

  // Clear faults that line up with the repaired stat. 'all' wipes
  // engine + tires + hp together; the individual stat keys each
  // clear their own lane only.
  let faults = (life.faults ?? []) as Fault[];
  if (s.stat === 'all' || s.stat === 'engine') {
    faults = faults.filter((f) => f.stat !== 'engine');
  }
  if (s.stat === 'all' || s.stat === 'tires') {
    faults = faults.filter((f) => f.stat !== 'tires');
  }
  if (s.stat === 'all' || s.stat === 'carHP') {
    faults = faults.filter((f) => f.stat !== 'hp');
  }
  life.faults = faults;
  // Lift broken state if the player is back on their feet.
  if (life.broken && life.engine > 10 && life.tires > 5) {
    life.broken = false;
    life.breakdownType = '';
    life.breakdownTimer = 0;
  }
  return adjPrice;
}
