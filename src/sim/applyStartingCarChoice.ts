/**
 * Apply a selected starting-car deal to LIFE. Ported from monolith
 * L44544-44599.
 *
 * Side effects on LifeState:
 *   - money -= choice.down
 *   - ownedCars = [carId]
 *   - engine / tires / carHP set to choice.cond
 *   - paint set to min(100, cond + 15)  (fresh-paint bonus)
 *   - fuel reset to a random 15-40% level (no full tank at start)
 *   - faults cleared, hidden-faults cleared
 *   - isManual seeded from the car's factory defaultManual
 *   - rhdOverride cleared (factory rhd applies)
 *   - if loan/lease: push a carLoan record with carId / monthly /
 *     remaining months / principal / rate / term
 *
 * Test mode overrides apply LAST (v8.99.57 fix):
 *   - re-unlock the full catalog (test mode = all cars owned)
 *   - money back to $999,999
 *   - all car stats maxed
 *   - carLoans cleared (test mode pays cash)
 *   - bankLoans cleared (v8.99.109)
 */

import type { LifeState, CarLoan } from '@/state/life';
import type { CarChoice } from '@/ui/screens/carSelect';
import { CAR_CATALOG, ACCESSIBLE_CAR_IDS } from '@/config/cars/catalog';
import { generateUsedCarFaults, isBeaterCond, surfaceCheapestFault } from '@/sim/usedCarFaults';
import type { PreFault } from '@/ui/modals/inspection';

export function applyStartingCarChoice(life: LifeState, choice: CarChoice, testMode: boolean): void {
  const carId = choice.carId;
  if (!carId) return;
  const car = CAR_CATALOG[carId];

  // Down payment / cash purchase.
  life.money = Math.max(0, life.money - (choice.down || 0));

  // Sole starting car.
  life.ownedCars = [carId];

  // Cosmetic state seeded from the choice.
  life.engine = choice.cond;
  life.tires = choice.cond;
  life.carHP = choice.cond;
  life.paint = Math.min(100, choice.cond + 15);
  life.fuel = 15 + Math.floor(Math.random() * 25);
  life.faults = [];
  life._hiddenFaults = [];

  // BEATER GUARANTEE (user): a rough/cheap STARTER must show at least one
  // ACTIVE fault from day one. Generate the same used-car fault set the
  // buy-flow uses, surface its cheapest issue (the obvious first fix) and
  // leave the rest hidden until mileage reveals them. Nicer starters
  // (cond > BEATER_COND_MAX) start clean, as before. Cleared again under
  // test mode below.
  if (isBeaterCond(choice.cond)) {
    const pre: PreFault[] = generateUsedCarFaults(carId, choice.mileage ?? 0, choice.cond);
    const surfaced = surfaceCheapestFault(pre);
    if (surfaced) {
      life.faults.push({ ...surfaced });
      life._hiddenFaults = pre;
      life._hiddenFaultOdo = 0;
    }
  }

  // Transmission + RHD seeded from factory defaults — see
  // v8.99.126.89 in the monolith for the bug repro this prevents.
  life.isManual = !!(car && car.defaultManual);
  life.rhdOverride = null;

  // Loan or lease record. Matches the carLoan shape pushed by the
  // in-game purchase flow.
  if ((choice.financeType === 'loan' || choice.financeType === 'lease') && choice.monthly && choice.term && car) {
    const loan: CarLoan = {
      carId,
      balance: car.price - (choice.down || 0),
      monthlyPayment: choice.monthly,
      monthsRemaining: choice.term,
      apr: choice.financeType === 'loan' ? 0 : 0, // lease has no APR; loan uses pre-resolved monthly
    };
    life.carLoans.push(loan);
  }

  // Test mode overrides — applied LAST so they aren't clobbered by the
  // base car assignment above. H713: the previous `[...ALL_CAR_IDS]`
  // overwrote ownedCars with the catalog's GT4-row order, so slot 0
  // (= active car) became whichever entry was first alphabetically in
  // GT4_DB. That was "AC Cars 427 S/C `66" regardless of which car the
  // player tapped — user reported "no matter which starter car I
  // select, it becomes AC Cars 427 S/C '66." Mirrors the monolith's
  // L44588-44589 pattern: append ALL_CAR_IDS entries that aren't
  // already in ownedCars, leaving the picked car at slot 0.
  if (testMode) {
    // H1113: test mode grants only ACCESSIBLE cars, so even the "own
    // everything" cheat garage excludes the locked-out sub-100 HP cars.
    // The picked starter (carId) always stays owned at slot 0.
    if (carId) {
      const others = ACCESSIBLE_CAR_IDS.filter((id) => id !== carId);
      life.ownedCars = [carId, ...others];
    } else {
      life.ownedCars = [...ACCESSIBLE_CAR_IDS];
    }
    life.money = 999_999;
    life.fuel = 100;
    life.engine = 100;
    life.tires = 100;
    life.carHP = 100;
    life.paint = 100;
    // H941: do NOT clear faults in test mode — a beater starter keeps the
    // fault H937 surfaced so the repair flow is testable even in test mode.
    // (Stats are maxed above; a single active fault on the starter is fine.)
    life.carLoans = [];
    life.bankLoans = [];
  }
}
