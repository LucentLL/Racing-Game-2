/**
 * Canonical physics unit-conversion constants.
 *
 * The monolith uses world-pixels-per-second (wpx/s) as its internal
 * speed unit. Many gameplay / HUD / spec systems need to convert
 * to/from real-world units (m/s, mph, km/h). This module
 * establishes the single source of truth so the conversion
 * factors aren't redefined inline across multiple files.
 *
 * Tile-scale derivation: TILE = 18 wpx, and the monolith's world
 * scale calibration treats 1 wpx as 0.2056 m (matching the world
 * dimensions to a real-Charlotte reference). At 1 second:
 *   1 m/s × (1 wpx / 0.2056 m) ≈ 4.864 wpx/s
 *
 * So SCALE_MS = 4.864 is the wpx/s ↔ m/s conversion factor. mph
 * adds the standard 2.237 m/s ↔ mph multiplier; km/h adds 3.6.
 *
 * Monolith source: `const SCALE_MS = 4.864` is redefined inline
 * across update() L24770, audio L18xxx, HUD L33xxx, etc.
 */

/** World-pixels per second per meter per second. 1 m/s × SCALE_MS
 *  = velocity in the game's internal wpx/s speed units.
 *
 *  Inverse relationship: 1 wpx ≈ 0.2056 m. SCALE_MS = 1 / 0.2056
 *  ≈ 4.864.
 *
 *  This matches the [[METERS_PER_GAME_UNIT]] constant in
 *  chassisFrame.ts (0.2056) via the identity
 *  SCALE_MS = 1 / METERS_PER_GAME_UNIT. The two are duplicated
 *  for ergonomics — wpx/s callers want the multiplier form;
 *  m/wpx callers want the divisor form. Math is the same.
 *
 *  Matches monolith `SCALE_MS = 4.864` used throughout. */
export const SCALE_MS = 4.864;

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
