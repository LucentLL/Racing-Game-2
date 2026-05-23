/**
 * Street-race reputation decay — fires daily. If the player skips
 * the scene for more than a week, their underground rep starts
 * eroding; high-tier players (TRUSTED / INNER CIRCLE, rep > 50)
 * lose ground twice as fast as the lower tiers.
 *
 * H518: 1:1 port of monolith decayStreetRep at L8952-L8960. Pure
 * mutator on LifeState; no return value (the decay is silent —
 * the monolith intentionally doesn't notify so the player notices
 * by glancing at rep, matching the underground-scene flavor).
 *
 * Pairs with [[getStreetTier]] (H513) and the race-win/loss rep
 * gains in applyRaceResult — those build rep; this hop is what
 * takes it away when the player doesn't show up.
 */

import type { LifeState } from '@/state/life';

/** Days the player can skip racing before decay starts. Matches
 *  monolith `daysSinceRace > 7` at L8956. */
export const STREET_REP_DECAY_GRACE_DAYS = 7;

/** Per-day rep loss at low tier (rep <= 50). Matches monolith
 *  ternary at L8958 — the `:1` branch. */
export const STREET_REP_DECAY_RATE_LOW = 1;

/** Per-day rep loss at high tier (rep > 50). Matches monolith
 *  ternary at L8958 — the `?2` branch. Higher tiers decay faster
 *  because reputation at that level is built on consistent
 *  visibility — a TRUSTED racer who vanishes for two weeks is
 *  forgotten faster than an OPEN-tier newcomer who's still
 *  invisible. */
export const STREET_REP_DECAY_RATE_HIGH = 2;

/** Rep threshold above which the high decay rate applies. Matches
 *  monolith `LIFE.streetRep > 50` at L8958. */
export const STREET_REP_DECAY_HIGH_TIER_THRESHOLD = 50;

/** Apply the daily street-rep decay. No-op when rep is already
 *  zero, or when the last race was within the grace window
 *  (7 days). Pure mutator; the caller (gameLoop day-rollover
 *  hook) ignores the return.
 *
 *  Ported 1:1 from monolith L8952-L8960. */
export function decayStreetRep(life: LifeState): void {
  if (life.streetRep <= 0) return;
  const daysSinceRace = life.day - (life.lastRaceDay || 0);
  if (daysSinceRace <= STREET_REP_DECAY_GRACE_DAYS) return;
  const decayRate = life.streetRep > STREET_REP_DECAY_HIGH_TIER_THRESHOLD
    ? STREET_REP_DECAY_RATE_HIGH
    : STREET_REP_DECAY_RATE_LOW;
  life.streetRep = Math.max(0, life.streetRep - decayRate);
}
