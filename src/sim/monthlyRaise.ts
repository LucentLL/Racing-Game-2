/**
 * Monthly raise / promotion check. Fires on the 1st of each month
 * alongside [[fireMonthlyPay]] and [[fireMonthlyBills]] — the work-
 * rep ladder rolls for a chance at a 5-10% pay bump, capped at the
 * per-job JOB_PAY_CAP ceiling.
 *
 * H517: 1:1 port of monolith checkMonthlyRaise at L8899-L8917.
 * Pure mutator on LifeState; returns an optional descriptor so the
 * caller can surface the raise notif ("💰 RAISE! Pay now X%").
 *
 * The raise CHANCE is rep-tiered:
 *   workRep >= 80  →  35% monthly  (high — established + trusted)
 *   workRep >= 60  →  20%          (moderate)
 *   workRep >= 40  →   8%          (decent — keeping the job)
 *   workRep <  40  →   0%          (probationary; raises don't fire)
 *
 * Dispatcher-trust connection adds +5% to whichever tier applies
 * (so a rep-80 player with a dispatcher friend has 40% monthly
 * raise chance vs the bare 35%). Mirrors monolith L8909.
 *
 * Once the roll hits, raise amount is uniform random in [5%, 10%];
 * applied additively to LIFE.payMultiplier and capped at the per-
 * job JOB_PAY_CAP ceiling (monolith v8.99.23 dropped the hardcoded
 * 2.0× cap in favor of the per-job table — high-end annual ranges
 * vary by job class). LIFE.lastRaiseDay records the day so HUD /
 * pause-menu stats can surface "last raise" recency.
 */

import type { LifeState } from '@/state/life';
import { JOB_PAY_CAP, type JobName } from '@/config/jobs';

/** Rep tier for the highest raise chance (35% monthly). Matches
 *  monolith `LIFE.workRep >= 80` at L8903. */
export const MONTHLY_RAISE_REP_TIER_HIGH = 80;
/** Mid-tier rep threshold (20% monthly chance). Matches L8904. */
export const MONTHLY_RAISE_REP_TIER_MID = 60;
/** Low-tier rep threshold (8% monthly chance). Matches L8905. */
export const MONTHLY_RAISE_REP_TIER_LOW = 40;

/** Monthly raise chance at the high rep tier. The 35% rate is
 *  calibrated against the catalog's career-arc tuning — a high-
 *  rep player should hit pay-cap within ~6-12 months of dedicated
 *  shifts. Matches monolith `0.35` at L8903. */
export const MONTHLY_RAISE_CHANCE_HIGH = 0.35;
/** Mid-tier monthly raise chance. Matches monolith `0.20` at L8904. */
export const MONTHLY_RAISE_CHANCE_MID = 0.20;
/** Low-tier monthly raise chance. Matches monolith `0.08` at L8905. */
export const MONTHLY_RAISE_CHANCE_LOW = 0.08;

/** Dispatcher-trust connection bonus added to the rep-tier chance.
 *  Flat +5% regardless of base tier (a player with rep < 40 still
 *  gets 5% with dispatcher trust). Matches monolith
 *  `if(LIFE.dispatcherTrust) raiseChance += 0.05` at L8909. */
export const MONTHLY_RAISE_DISPATCHER_BONUS = 0.05;

/** Minimum raise amount when the roll hits (5%). Matches monolith
 *  `0.05 + Math.random()*0.05` at L8911. */
export const MONTHLY_RAISE_MIN_AMOUNT = 0.05;
/** Range above the minimum — total amount is in [MIN, MIN+RANGE).
 *  5% range produces 5-10% raises. Matches L8911. */
export const MONTHLY_RAISE_AMOUNT_RANGE = 0.05;

/** Fallback per-job pay cap when JOB_PAY_CAP doesn't have an entry
 *  for the active job. Matches monolith's
 *  `JOB_PAY_CAP[LIFE.playerJob]) || 2.0` defaulting at L8914. */
export const MONTHLY_RAISE_FALLBACK_CAP = 2.0;

/** Discriminated result. `null` when no raise fired (no playerJob,
 *  rep too low, or RNG didn't hit). `{ kind: 'raise', ... }` when
 *  the player got a pay bump. */
export type MonthlyRaiseResult =
  | null
  | {
      kind: 'raise';
      /** New payMultiplier value (post-cap). */
      payMultiplier: number;
      /** Pay percentage to surface in notif (round(payMultiplier × 100)). */
      payPercent: number;
      /** Current workRep — surfaced in notif so the player can see
       *  the connection between rep and raise. */
      workRep: number;
    };

/** Roll the monthly raise check. Pure mutator on LifeState.
 *
 *  Returns null when:
 *    - No active playerJob.
 *    - workRep < MONTHLY_RAISE_REP_TIER_LOW (and no dispatcher
 *      trust to bump the chance above 0).
 *    - RNG roll didn't land within the computed chance.
 *
 *  When the roll hits, MUTATES life.payMultiplier (capped) and
 *  life.lastRaiseDay (set to `day`), then returns a raise descriptor.
 *
 *  Ported 1:1 from monolith L8899-L8917. */
export function checkMonthlyRaise(life: LifeState, day: number): MonthlyRaiseResult {
  if (!life.playerJob) return null;

  let raiseChance = 0;
  if (life.workRep >= MONTHLY_RAISE_REP_TIER_HIGH) raiseChance = MONTHLY_RAISE_CHANCE_HIGH;
  else if (life.workRep >= MONTHLY_RAISE_REP_TIER_MID) raiseChance = MONTHLY_RAISE_CHANCE_MID;
  else if (life.workRep >= MONTHLY_RAISE_REP_TIER_LOW) raiseChance = MONTHLY_RAISE_CHANCE_LOW;

  if (life.dispatcherTrust) raiseChance += MONTHLY_RAISE_DISPATCHER_BONUS;

  if (Math.random() >= raiseChance) return null;

  const raiseAmt = MONTHLY_RAISE_MIN_AMOUNT + Math.random() * MONTHLY_RAISE_AMOUNT_RANGE;
  const cap = JOB_PAY_CAP[life.playerJob as JobName] ?? MONTHLY_RAISE_FALLBACK_CAP;
  life.payMultiplier = Math.min(cap, life.payMultiplier + raiseAmt);
  life.lastRaiseDay = day;

  return {
    kind: 'raise',
    payMultiplier: life.payMultiplier,
    payPercent: Math.round(life.payMultiplier * 100),
    workRep: life.workRep,
  };
}
