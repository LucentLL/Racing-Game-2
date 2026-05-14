/**
 * Fuel system — burn rate during driving, gas-pump proximity refill,
 * jerry can usage, octane mismatch warning.
 *
 * Ported from monolith L43580-43620 (buyFuel + buyJerryCan + useJerryCan)
 * plus the per-tick fuel-burn calc at L26632.
 *
 * SCAFFOLD status: typed entries; bodies stubbed.
 */

import type { LifeState } from '@/state/life';

export interface FuelDeps {
  /** Player position — for gas-pump proximity check. */
  px: number;
  py: number;
  /** Player speed — affects burn rate at high speed. */
  pSpeed: number;
  /** Fuel multiplier from FaultEffects (oxygen sensor, intake leak, etc.). */
  fuelMult: number;
  /** Octane grade preferred by the car (87, 89, 91, 93). */
  octanePreferred: number;
}

/** Per-frame fuel burn. Reduces LIFE.fuel based on throttle, speed, and
 *  faults. Returns true if the tank just hit empty.
 *  TODO(C23-followup): port from monolith L26632. */
export function tickFuelBurn(
  _life: LifeState,
  _deps: FuelDeps,
  _gasHeld: boolean,
  _dt: number,
): boolean {
  return false;
}

/** Player buys fuel at a pump. Caller passes the grade (0..3 = 87/89/91/93).
 *  Mutates LIFE.fuel + LIFE.money. */
export function buyFuel(
  _life: LifeState,
  _gradeIdx: number,
  _pricePerGallon: number,
): { purchased: boolean; cost: number } {
  // TODO(C23-followup): port from monolith L43584.
  return { purchased: false, cost: 0 };
}

/** Player buys a jerry can — adds inventory item. */
export function buyJerryCan(
  _life: LifeState,
  _price: number,
): boolean {
  // TODO(C23-followup): port from L43608.
  return false;
}

/** Player uses a jerry can to refill on the side of the road. */
export function useJerryCan(_life: LifeState): boolean {
  // TODO(C23-followup): port from L43620.
  return false;
}
