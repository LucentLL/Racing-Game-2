/**
 * Effective drive-side resolver for a car.
 *
 * H80: 1:1 port of monolith getEffectiveRHD + getEffectiveUnit at
 * L7669-7684. The active car may have a runtime override stored on
 * LIFE (set via STEERING SWAP); other owned cars carry the override
 * on their carConditions entry; unowned cars fall back to the catalog's
 * factory `rhd` field.
 *
 * Unit follows drive-side per monolith convention: RHD → KM/H, LHD →
 * MPH. The display layer reads this for the speedometer + odometer.
 */

import type { LifeState } from '@/state/life';
import type { CatalogCar } from '@/config/cars/catalog';

/** Subset of CarConditionData needed for the override lookup. Kept
 *  loose so callers can pass either the full save record or a partial
 *  runtime mirror. */
export interface RhdOverrideRecord {
  rhdOverride?: boolean;
}

/** Resolve the effective drive-side for a car.
 *  - Active car: LIFE.rhdOverride wins if set (boolean, not null).
 *  - Other owned: carConditions[id].rhdOverride wins if set.
 *  - Unowned: catalog factory rhd.
 *  1:1 with monolith L7669. */
export function getEffectiveRHD(
  carId: string,
  life: LifeState | null,
  activeCarId: string | null,
  catalog: Readonly<Record<string, CatalogCar>>,
  carConditions?: Readonly<Record<string, RhdOverrideRecord>>,
): boolean {
  if (carId === activeCarId && life && typeof life.rhdOverride === 'boolean') {
    return life.rhdOverride;
  }
  const c = carConditions?.[carId];
  if (c && typeof c.rhdOverride === 'boolean') return c.rhdOverride;
  return !!catalog[carId]?.rhd;
}

/** Resolve the effective speed/odo unit for a car. RHD cars use km/h,
 *  LHD cars use mph. 1:1 with monolith L7682. */
export function getEffectiveUnit(
  carId: string,
  life: LifeState | null,
  activeCarId: string | null,
  catalog: Readonly<Record<string, CatalogCar>>,
  carConditions?: Readonly<Record<string, RhdOverrideRecord>>,
): 'kmh' | 'mph' {
  return getEffectiveRHD(carId, life, activeCarId, catalog, carConditions) ? 'kmh' : 'mph';
}
