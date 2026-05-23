/**
 * Daily silent connection / reputation milestones — fires once
 * per day rollover and flips the four "connection" boolean flags
 * once their threshold counters hit the magic numbers. Increments
 * neighborhoodDays each day so the local-deals milestone can
 * eventually fire from pure tenure.
 *
 * H519: 1:1 port of monolith updateConnections at L8963-L8982.
 * Pure mutator on LifeState; no return value (each milestone
 * surfaces silently — monolith comments explicitly note "no
 * notification — player notices prices dropped" for the mechanic
 * tier; same convention for the others).
 *
 * THE FOUR MILESTONES (each fires once, then sticks):
 *   1. mechanicDiscount   ← mechanicVisits >= 10
 *      Lower repair prices at the mechanic. Player notices when
 *      bills come in cheaper than expected.
 *
 *   2. dispatcherTrust    ← workRep >= 70 && workDaysPresent >= 30
 *      Better jobs + first-call priority. Tier-bumps
 *      [[checkMonthlyRaise]] chance (+5%) so reputation
 *      compounds.
 *
 *   3. sceneRegular       ← streetRacesTotal >= 15 && streetRep >= 25
 *      "Vouches for next tier" — narrative payoff; opens future
 *      gating once the deep-cred subsystems port.
 *
 *   4. localDeals         ← neighborhoodDays >= 60
 *      Tips on car deals in the newspaper. The newspaper
 *      generator (H35) already has the placeholder hook for
 *      this but doesn't actually surface "deal" badges yet;
 *      that lands with the connections subsystem port.
 *
 * The increment of neighborhoodDays is unconditional — the
 * milestone fires once it crosses the 60-day mark even if the
 * player switches neighborhoods later (monolith doesn't reset).
 */

import type { LifeState } from '@/state/life';

/** Mechanic-visit threshold for the discount milestone. */
export const CONNECTION_MECHANIC_VISITS_NEEDED = 10;

/** Work-rep + days-present thresholds for dispatcher trust.
 *  Both required — high rep alone isn't enough; the
 *  workDaysPresent gate filters out lucky-streak short careers. */
export const CONNECTION_DISPATCHER_REP_NEEDED = 70;
export const CONNECTION_DISPATCHER_DAYS_NEEDED = 30;

/** Race count + rep thresholds for the scene-regular milestone.
 *  Both required — many races at low rep doesn't qualify (the
 *  scene wants consistent presence with at least minimal wins);
 *  high rep with few races doesn't either (one-and-done shouldn't
 *  unlock the regular status). */
export const CONNECTION_SCENE_RACES_NEEDED = 15;
export const CONNECTION_SCENE_REP_NEEDED = 25;

/** Days lived in neighborhood for the local-deals milestone. 60
 *  days ≈ 2 in-game months of regular driving. Pure tenure —
 *  no other gates beyond just being present. */
export const CONNECTION_LOCAL_DEALS_DAYS_NEEDED = 60;

/** Daily silent connection milestone tick. Caller (gameLoop day-
 *  rollover) invokes once per day. Side-effects only — mutates
 *  life flags + neighborhoodDays.
 *
 *  Ported 1:1 from monolith L8963-L8982. */
export function updateConnections(life: LifeState): void {
  if (!life.mechanicDiscount && life.mechanicVisits >= CONNECTION_MECHANIC_VISITS_NEEDED) {
    life.mechanicDiscount = true;
  }
  if (
    !life.dispatcherTrust
    && life.workRep >= CONNECTION_DISPATCHER_REP_NEEDED
    && life.workDaysPresent >= CONNECTION_DISPATCHER_DAYS_NEEDED
  ) {
    life.dispatcherTrust = true;
  }
  if (
    !life.sceneRegular
    && life.streetRacesTotal >= CONNECTION_SCENE_RACES_NEEDED
    && life.streetRep >= CONNECTION_SCENE_REP_NEEDED
  ) {
    life.sceneRegular = true;
  }
  life.neighborhoodDays++;
  if (!life.localDeals && life.neighborhoodDays >= CONNECTION_LOCAL_DEALS_DAYS_NEEDED) {
    life.localDeals = true;
  }
}
