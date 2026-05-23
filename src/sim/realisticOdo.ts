/**
 * Realistic-odometer generator for used-car listings.
 *
 * Produces a believable mileage reading by sampling
 * 10,000-13,999 miles per year of age, then scattering ±30%
 * for individual-car variance (some grandma's garage queen
 * vs some delivery driver's beater of the same year). Always
 * returns at least 100 miles so brand-new dealer listings
 * still show a tiny break-in number rather than zero.
 *
 * Used by:
 *   - Newspaper classifieds (used-car rows)        [wired]
 *   - Race opponent's won-car mileage              (port pending)
 *   - generateCarLot used-car-lot listings         (port pending)
 *   - Imported-car lot listings                    (port pending)
 *   - Bonus localDeals "tip from a neighbor" row   [wired]
 *
 * H539: 1:1 port of monolith generateRealisticOdo at
 * L9084-L9104. Upgrades the prior simplified inline version
 * in [[newspaperGenerator]] (which dropped the variance
 * scatter, the 100-mile floor, and the day-advanced game year)
 * with the full canonical formula.
 *
 * GAME-YEAR ADVANCE: the monolith advances the in-game year as
 * LIFE.day climbs (`1999 + floor(day/365)`), so a 1980 listing
 * sampled on day 1 has age=19, but the same listing sampled on
 * day 730 (two in-game years later) has age=21 and rolls more
 * miles. This makes the used-car market feel like it's aging
 * alongside the player. The simplified prior version pinned the
 * game year at 1999, so listings never aged — fixed here.
 */

/** Base in-game year. Day 1 = Jan 1999 (monolith convention,
 *  L9098 `gameYear = 1999 + floor(day/365)`). */
export const GAME_BASE_YEAR = 1999;

/** Lower bound on miles-per-year sampling. Combined with the
 *  upper bound below this yields a uniform 10k-14k average year
 *  before the per-car variance scatter is applied. Matches
 *  monolith L9101 `10000 + floor(random*4000)`. */
export const MILES_PER_YEAR_MIN = 10000;

/** Width of the miles-per-year uniform sample, so the average is
 *  drawn from [MIN, MIN+SPREAD-1]. The monolith uses 4000 — the
 *  +1 difference between this and a [MIN, MIN+SPREAD] read is
 *  irrelevant for gameplay. */
export const MILES_PER_YEAR_SPREAD = 4000;

/** Per-car variance scatter — once the year-based average is
 *  computed, each listing's actual mileage is sampled uniformly
 *  in [average × (1 - HALF_RANGE), average × (1 + HALF_RANGE)].
 *  At 0.3, a 1980 listing on day 1 with avg 11000 mi/yr lands
 *  somewhere in [70%, 130%] × 209,000 = 146,300-271,700 miles.
 *  Matches monolith L9102 `(0.7 + random * 0.6)` — 0.6 = 2 *
 *  HALF_RANGE = 2 * 0.3. */
export const VARIANCE_HALF_RANGE = 0.3;

/** Minimum returned mileage — even a 1999 brand-new dealer
 *  listing (age=0) shows at least 100 miles since real new cars
 *  have transport / dealer-shuffle mileage. Matches monolith
 *  L9103 `Math.max(100, miles)`. */
export const MIN_LISTING_MILES = 100;

/** Compute the in-game year given the current day. Day 1 = 1999.
 *  Years advance every 365 days. Exported so callers that need
 *  the same year for other displays (catalog "newest model"
 *  label, etc.) don't re-derive it. */
export function gameYearFor(day: number): number {
  return GAME_BASE_YEAR + Math.floor(day / 365);
}

/** Roll a realistic odometer reading for a car of the given
 *  model year, sampled relative to the current in-game day. Two
 *  RNG draws — one for the year-average, one for the per-car
 *  variance scatter. Both go through Math.random (no injection
 *  point yet; the newspaper generator already isn't deterministic
 *  on RNG, so adding seedability would need a broader change).
 *
 *  Ported 1:1 from monolith L9084-L9104. */
export function generateRealisticOdo(modelYear: number, day: number = 0): number {
  const age = Math.max(0, gameYearFor(day) - modelYear);
  const avgPerYear = MILES_PER_YEAR_MIN + Math.floor(Math.random() * MILES_PER_YEAR_SPREAD);
  const varianceFactor = (1 - VARIANCE_HALF_RANGE) + Math.random() * (2 * VARIANCE_HALF_RANGE);
  const miles = Math.round(age * avgPerYear * varianceFactor);
  return Math.max(MIN_LISTING_MILES, miles);
}
