/**
 * H1072: monthly car insurance — SANCTIONED INVENTION (zero insurance
 * concept existed in the monolith; user request 2026-07-07).
 *
 * Premium model:
 *   monthly = (BASE + Σ ownedCar value × VALUE_RATE) × ticketMult
 *   ticketMult = 1 + min(ticketsTotal, CAP) × TICKET_RATE
 *
 * Scales exactly along the axes the user named: number of cars (each
 * adds a value-scaled premium), how expensive each car is (0.5% of
 * CURRENT value/month — getCarValue already folds condition +
 * mileage, so a beater is cheap to insure and a mint R34 is not),
 * and tickets on the record (+15% each, capped at +150%).
 *
 * Lives in its own module: billsCalc already imports from
 * monthlyBills, so parking the calculator here lets BOTH import it
 * without a cycle. life.ticketsTotal is incremented at the police
 * ticket issuance site in gameLoop; older saves lack the field and
 * every read defaults it to 0.
 */

import type { LifeState } from '@/state/life';
import { getCarValue } from '@/sim/race';

/** Flat policy fee per month once the player owns ≥1 car. */
export const INSURANCE_BASE = 50;
/** Monthly premium as a fraction of each car's CURRENT value. */
export const INSURANCE_VALUE_RATE = 0.005;
/** Premium surcharge per ticket on record. */
export const INSURANCE_TICKET_RATE = 0.15;
/** Tickets beyond this stop raising the premium (already +150%). */
export const INSURANCE_TICKET_CAP = 10;

/** Base fleet premium (before the ticket surcharge). $0 with no cars. */
export function insuranceFleetPremium(life: LifeState): number {
  const owned = life.ownedCars || [];
  if (owned.length === 0) return 0;
  const active = owned[0] ?? null;
  let p = INSURANCE_BASE;
  for (const id of owned) {
    p += Math.round(getCarValue(life, id, active) * INSURANCE_VALUE_RATE);
  }
  return p;
}

/** Driving-record multiplier from lifetime police tickets. */
export function insuranceTicketMult(life: LifeState): number {
  const tickets = Math.min(life.ticketsTotal || 0, INSURANCE_TICKET_CAP);
  return 1 + tickets * INSURANCE_TICKET_RATE;
}

/** The monthly insurance line item. */
export function monthlyInsurance(life: LifeState): number {
  const base = insuranceFleetPremium(life);
  return base > 0 ? Math.round(base * insuranceTicketMult(life)) : 0;
}
