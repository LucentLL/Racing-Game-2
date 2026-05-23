/**
 * Street-race reputation tier — derives the player's place in the
 * underground scene from LIFE.streetRep. Tier gates the bet range
 * for the race-spawn flow, the rep-gain rate (higher tiers get less
 * per win — see [[STREET_TIER_REP_GAIN]]), and the HUD callsign
 * + color used by the race-flag overlay.
 *
 * H513: 1:1 port of monolith getStreetTier() at L8847-L8852. Pure
 * function; reads only LIFE.streetRep.
 *
 * Tier idx mapping (lower = newer/lower-stakes):
 *   0 — OPEN          (rep <  25)   green   $100-$500 bets
 *   1 — KNOWN         (rep 25-49)   yellow  $1k-$5k bets
 *   2 — TRUSTED       (rep 50-74)   orange  $10k-$25k bets
 *   3 — INNER CIRCLE  (rep >= 75)   magenta $50k-$100k bets
 */

import type { LifeState } from '@/state/life';

/** Result of [[getStreetTier]] — every field the monolith returns,
 *  typed for downstream consumers (race-spawn flow, HUD overlay,
 *  rep-gain calculation). */
export interface StreetTier {
  /** Display name surfaced in the race-result notif and HUD. */
  name: 'OPEN' | 'KNOWN' | 'TRUSTED' | 'INNER CIRCLE';
  /** Numeric index 0..3 — gates rep-gain rates and tier comparisons
   *  ([[STREET_TIER_WIN_REP_GAIN]] is keyed on this). */
  idx: 0 | 1 | 2 | 3;
  /** Lower bound (USD) of the bet range available at this tier. */
  minBet: number;
  /** Upper bound (USD) of the bet range available at this tier. */
  maxBet: number;
  /** Hex tier color — drives the HUD callsign tint + race-flag
   *  overlay so tiers read visually distinct. */
  color: '#0f0' | '#ff0' | '#f80' | '#f0f';
}

/** Win-rep-gain by tier index. Matches monolith
 *  `tier.idx>=2 ? 2 : (tier.idx===1 ? 4 : 6)` at L8525.
 *
 *  WHY HIGHER TIERS GAIN LESS: the rep-gain rate is inverse to
 *  tier so the curve to INNER CIRCLE flattens out. At OPEN you
 *  build rep fast (+6 per win); at INNER CIRCLE the wins barely
 *  move the meter (+2). This mirrors the felt experience of
 *  underground-racing scenes — getting recognized is easy, becoming
 *  legendary is slow. Caller (applyRaceResult) consults the table
 *  via the tier idx returned by [[getStreetTier]]. */
export const STREET_TIER_WIN_REP_GAIN: Readonly<Record<0 | 1 | 2 | 3, number>> = {
  0: 6, // OPEN — gain fast
  1: 4, // KNOWN
  2: 2, // TRUSTED
  3: 2, // INNER CIRCLE — slow grind
};

/** Loss rep-gain — flat at all tiers in the monolith. Showed up;
 *  small bump regardless of where you sit on the ladder. Matches
 *  the `+= 1` at the loss-handler equivalents. */
export const STREET_TIER_LOSS_REP_GAIN = 1;

/** Compute the street-race tier from the player's current streetRep.
 *  Pure function; allocates a new StreetTier object each call (cheap;
 *  the realistic call cadence is once per race start + once per HUD
 *  refresh, not per frame).
 *
 *  Ported 1:1 from monolith L8847-L8852. */
export function getStreetTier(life: LifeState): StreetTier {
  const rep = life.streetRep ?? 0;
  if (rep >= 75) return { name: 'INNER CIRCLE', idx: 3, minBet: 50000, maxBet: 100000, color: '#f0f' };
  if (rep >= 50) return { name: 'TRUSTED',      idx: 2, minBet: 10000, maxBet:  25000, color: '#f80' };
  if (rep >= 25) return { name: 'KNOWN',        idx: 1, minBet:  1000, maxBet:   5000, color: '#ff0' };
  return            { name: 'OPEN',         idx: 0, minBet:   100, maxBet:    500, color: '#0f0' };
}
