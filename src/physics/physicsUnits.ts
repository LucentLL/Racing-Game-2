/**
 * Canonical physics unit-conversion constants.
 *
 * The monolith uses world-pixels-per-second (wpx/s) as its internal
 * speed unit. Many gameplay / HUD / spec systems need to convert
 * to/from real-world units (m/s, mph, km/h). This module
 * establishes the single source of truth so the conversion
 * factors aren't redefined inline across multiple files.
 *
 * H805 UNIFIED WORLD SCALE: the monolith carried TWO scales — speed
 * and odometer used a real-Charlotte map calibration (1 wpx =
 * 0.2056 m → SCALE_MS = 4.864), while road GEOMETRY is built at
 * 12-ft lanes = 1.275 tiles (1 wpx = 0.1594 m). So "100 mph" only
 * covered ~78 mph of road-scale distance, and cars (sized near the
 * map scale) drew ~28% small against the lanes. Per user direction,
 * everything now anchors to the ROAD scale (config/world/tiles.ts
 * WPX_PER_M ≈ 6.2746): car dimensions, speed, odometer, and lane
 * geometry are one consistent unit system — a car doing 100 mph
 * covers exactly 100 mph of world distance.
 *
 * Monolith source: `const SCALE_MS = 4.864` was redefined inline
 * across update() L24770, audio L18xxx, HUD L33xxx, etc.
 */

import { WPX_PER_M } from '@/config/world/tiles';

/** World-pixels per second per meter per second. 1 m/s × SCALE_MS
 *  = velocity in the game's internal wpx/s speed units.
 *
 *  H805: = WPX_PER_M (≈ 6.2746; 1 wpx ≈ 0.1594 m), replacing the
 *  monolith's separate 4.864 speed calibration — see module header.
 *  Identity with chassisFrame.ts METERS_PER_GAME_UNIT:
 *  SCALE_MS = 1 / METERS_PER_GAME_UNIT. */
export const SCALE_MS = WPX_PER_M;

/** Standard m/s to mph multiplier. mph = m/s × 2.237. */
export const MPH_PER_MS = 2.237;

/** Standard m/s to km/h multiplier. km/h = m/s × 3.6. */
export const KMH_PER_MS = 3.6;

/** Convert world-pixels-per-second to miles-per-hour. Used by
 *  HUD speedometer, speed-limit checks, fuel-economy displays.
 *
 *  FORMULA: mph = (wpx/s ÷ SCALE_MS) × 2.237
 *
 *  Composition: divide by SCALE_MS to get m/s, then multiply by
 *  MPH_PER_MS to get mph. */
export function wpxsToMph(wpxs: number): number {
  return (wpxs / SCALE_MS) * MPH_PER_MS;
}

/** Convert world-pixels-per-second to kilometers-per-hour. Used
 *  by non-US-unit HUD displays (Euro/JDM-spec cars).
 *
 *  FORMULA: km/h = (wpx/s ÷ SCALE_MS) × 3.6 */
export function wpxsToKmh(wpxs: number): number {
  return (wpxs / SCALE_MS) * KMH_PER_MS;
}

/** Convert miles-per-hour to world-pixels-per-second. Used when
 *  catalog / spec data is in mph and the integrator wants wpx/s.
 *
 *  FORMULA: wpx/s = (mph ÷ 2.237) × SCALE_MS */
export function mphToWpxs(mph: number): number {
  return (mph / MPH_PER_MS) * SCALE_MS;
}

/** Miles per game unit. H805: derived from the unified road scale —
 *  1 wpx = (1/WPX_PER_M) m ≈ 0.1594 m, 1 mi = 1609.344 m, so
 *  mi/wpx ≈ 0.00009903 (was the monolith's 0.0001278 at the old
 *  map calibration). Use this to convert a raw odometer reading
 *  (carOdometers[id], in game units) to displayable miles.
 *  NOTE: existing saves' odometer readings re-interpret ~22% lower
 *  in displayed miles — accepted cost of scale unification. */
export const MILES_PER_GAME_UNIT = 1 / WPX_PER_M / 1609.344;

/** Kilometers per game unit. H805: derived — km/wpx = (1/WPX_PER_M)
 *  / 1000 ≈ 0.0001594 (was 0.0002056). Used by RHD / Euro spec cars
 *  whose HUD shows km instead of mi. */
export const KM_PER_GAME_UNIT = 1 / WPX_PER_M / 1000;

/** Convert a raw odometer reading (game units) to miles.
 *  Inverse: divide miles by MILES_PER_GAME_UNIT. */
export function gameUnitsToMiles(units: number): number {
  return units * MILES_PER_GAME_UNIT;
}

/** Convert a raw odometer reading (game units) to kilometers.
 *  Inverse: divide km by KM_PER_GAME_UNIT. */
export function gameUnitsToKm(units: number): number {
  return units * KM_PER_GAME_UNIT;
}

/** Convert a listing's mileage (miles) to raw game units —
 *  used at purchase time to seed carOdometers[id] from the
 *  seller listing. Matches monolith L45905 (`mileage / 0.0001278`). */
export function milesToGameUnits(miles: number): number {
  return miles / MILES_PER_GAME_UNIT;
}
