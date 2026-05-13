import { CAR_MSRP } from './msrp';
import { getBrandTier, type BrandTier } from './brandTiers';
import { CLASS_CURVES, curveLookup } from './classCurves';

/**
 * Era multiplier: what fraction of base MSRP applies for a given model year.
 * 1990s → full price; 1980s → slight discount; pre-1980 → classic branch.
 */
export function eraMult(year: number | null): number {
  if (!year || year >= 1995) return 1.0;
  if (year >= 1990) return 0.95;
  if (year >= 1985) return 0.85;
  if (year >= 1980) return 0.75;
  return 1.0;
}

/**
 * Classic collector valuation for pre-1980 cars. Returns 1999 USD collector-market
 * values (what you'd pay a classic-car dealer), not original MSRPs.
 */
export function classicPrice(name: string, hp: number, year: number, brandTier: BrandTier): number {
  let base: number;
  if (year >= 1970 && year < 1980) {
    base = hp < 150 ? 8000 : hp < 250 ? 18000 : hp < 350 ? 35000 : 65000;
  } else if (year >= 1960 && year < 1970) {
    base = hp < 120 ? 10000 : hp < 200 ? 22000 : hp < 300 ? 48000 : 95000;
  } else {
    base = hp < 80 ? 12000 : hp < 150 ? 35000 : 75000;
  }
  if (brandTier.cls === 'premium') base *= 1.8;
  if (brandTier.cls === 'exotic') base *= 3.5;
  if (/Race Car|GTR|Le Mans|Group ?C|LM|GT1/i.test(name)) base *= 2.5;
  return Math.round(base / 100) * 100;
}

/**
 * Main entry point used by GT4_DB load loop. Three-tier lookup:
 *   1. CAR_MSRP table (hand-priced).
 *   2. Classic collector valuation for <1980 cars.
 *   3. Brand-class + era tier formula as fallback.
 */
export function calcGT4Price(name: string, hp: number, kg: number): number {
  if (CAR_MSRP[name] !== undefined) return CAR_MSRP[name];

  let year: number | null = null;
  const mm = name.match(/`(\d{2})/);
  if (mm) {
    const yy = parseInt(mm[1], 10);
    year = yy <= 10 ? 2000 + yy : 1900 + yy;
  }
  if (!year) {
    const m2 = name.match(/\b(19\d{2}|20\d{2})\b/);
    if (m2) year = parseInt(m2[1], 10);
  }

  const isRace = /Race Car|Le Mans|Group ?C|GT1 Class/i.test(name);
  const brandTier = getBrandTier(name);

  if (year && year < 1980 && !isRace) {
    return classicPrice(name, hp, year, brandTier);
  }

  if (isRace) {
    const base = curveLookup(CLASS_CURVES.race, hp);
    const mult = brandTier.cls === 'exotic' ? 1.8 : brandTier.cls === 'premium' ? 1.3 : 1.0;
    return Math.round((base * mult) / 100) * 100;
  }

  const curve = CLASS_CURVES[brandTier.cls] || CLASS_CURVES.mid;
  const base = curveLookup(curve, hp);
  const pwr = hp / Math.max(kg, 1);
  const pwrBump = pwr > 0.20 ? 1.0 + Math.min(0.25, (pwr - 0.20) * 0.8) : 1.0;
  const price = base * brandTier.mult * pwrBump * eraMult(year);
  return Math.round(price / 100) * 100;
}
