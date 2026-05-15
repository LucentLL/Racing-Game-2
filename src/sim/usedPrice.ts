/**
 * Used-car depreciation. calcUsedPrice models age + mileage + condition
 * compound discounts off MSRP. Ported from monolith L44192-44214.
 *
 * Curve (compound by year):
 *   year 1: -20% (instant depreciation off-lot)
 *   years 2-5: -12%/year
 *   years 6-10: -8%/year
 *   years 11+: -5%/year
 *
 * Mileage penalty: 10% per 50k miles ABOVE the expected (age * 12,000)
 * threshold. Floors at 40% — even a 300k-mile car retains some scrap
 * value.
 *
 * Condition factor: linear 0.35 (bad) → 1.0 (perfect). Cond percent
 * clamped to [0, 100].
 *
 * Absolute floor: max($300, 5% of MSRP). Below this is scrap/parts
 * territory the game doesn't model.
 */

export function calcUsedPrice(
  msrp: number,
  modelYear: number,
  gameYear: number,
  cond: number,
  mileage: number,
): number {
  const age = Math.max(0, (gameYear || 1999) - (modelYear || 1995));
  let factor = 1.0;
  for (let y = 1; y <= age; y++) {
    if (y === 1) factor *= 0.80;
    else if (y <= 5) factor *= 0.88;
    else if (y <= 10) factor *= 0.92;
    else factor *= 0.95;
  }
  const expMi = age * 12_000;
  const excess = Math.max(0, (mileage || 0) - expMi);
  const milePenalty = Math.max(0.4, 1 - 0.10 * (excess / 50_000));
  factor *= milePenalty;
  const condClamped = Math.max(0, Math.min(100, cond || 50));
  const condFactor = 0.35 + (condClamped / 100) * 0.65;
  factor *= condFactor;
  const raw = Math.round(msrp * factor);
  const floor = Math.max(300, Math.round(msrp * 0.05));
  return Math.max(floor, raw);
}
