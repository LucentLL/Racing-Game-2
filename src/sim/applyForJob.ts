/**
 * Apply for a job listing — 55% hire chance, full fresh-hire state
 * init on success, removes the listing from _jobListings on
 * rejection so the player can't spam-retry the same opening.
 *
 * H522: 1:1 port of monolith applyForJob at L8919-L8942. Replaces
 * the gameLoop callback's previous "always hire" stub. The
 * v8.99.30 age-restriction removal (monolith comment at L8946)
 * means getJobAgeAccess always returns true, collapsing the
 * monolith's 0.55/0.25 split into a flat 0.55 — we encode that
 * directly here without porting the now-vestigial getJobAgeAccess
 * helper.
 *
 * The HIRED path resets the full work-rep / pay state to fresh-
 * hire defaults — workRep=25 (not zero — new hires start with
 * baseline trust), workDaysTotal/.workDaysPresent zeroed,
 * consecutiveAbsences zeroed, basePay seeded from JOB_BASE_PAY,
 * payMultiplier reset to 1.0, _fired latch cleared, jobDoneToday
 * cleared so the player can start working immediately.
 *
 * The REJECTED path drops the failed opening from _jobListings so
 * the player has to wait for tomorrow's roll (or pick a different
 * opening this morning). Matches monolith L8939-L8941.
 */

import type { LifeState } from '@/state/life';
import { JOB_BASE_PAY, type JobName } from '@/config/jobs';

/** Hire chance for any application. The v8.99.30 monolith
 *  refactor collapsed the previous 0.55/0.25 split (age-bracket
 *  in / out of) into a flat 0.55 — getJobAgeAccess always returns
 *  true. Stored as a named constant so future tuning hops (or a
 *  re-introduction of the age system) have one knob to turn.
 *
 *  Matches monolith `hireChance = ageAccess ? 0.55 : 0.25` at
 *  L8922 — collapsed via the L8946 always-true return. */
export const APPLY_FOR_JOB_HIRE_CHANCE = 0.55;

/** Starting work-rep for a fresh hire. Not zero (which would
 *  trigger the firing threshold immediately on first absence)
 *  and not 100 (which would trip the dispatcher-trust milestone
 *  on day one). 25 is in the "new hire — needs to prove
 *  themselves" zone the rep ladder is calibrated around.
 *
 *  Matches monolith `LIFE.workRep = 25` at L8926. */
export const NEW_HIRE_WORK_REP = 25;

/** Fallback per-job base pay when JOB_BASE_PAY doesn't have an
 *  entry for the requested job name. Matches monolith
 *  `JOB_BASE_PAY[jobName] || 50` defaulting at L8929. */
export const NEW_HIRE_BASE_PAY_FALLBACK = 50;

/** Result of [[applyForJob]]. Discriminated so the caller can
 *  surface the right notif. */
export type ApplyForJobResult =
  | { kind: 'hired'; jobName: string }
  | { kind: 'rejected'; jobName: string };

/** Roll the hire chance + apply state updates. Pure mutator on
 *  LifeState; caller surfaces the discriminated notif.
 *
 *  HIRE-SUCCESS MUTATIONS (1:1 with monolith L8924-L8932):
 *    - playerJob = jobName
 *    - workRep = 25                       (new-hire baseline)
 *    - workDaysTotal = workDaysPresent = consecutiveAbsences = 0
 *    - basePay = JOB_BASE_PAY[jobName]    (fallback 50)
 *    - payMultiplier = 1.0
 *    - _fired = false                     (clears prior-firing latch)
 *    - jobDoneToday = false               (can work today)
 *    - _jobListings = []                  (close out the listings UI)
 *
 *  HIRE-REJECT MUTATIONS (1:1 with monolith L8939-L8941):
 *    - _jobListings filters out the rejected jobName (can't spam-
 *      retry the same opening; player must wait for tomorrow OR
 *      try a different listing this morning).
 *
 *  Caller responsibilities:
 *    - generateDailyJob refresh on hire (monolith L8932 calls it
 *      inline; modular tree's lazy-fill at next JOBS-tab entry
 *      handles this — the gameLoop fillJobsTab dep callback in
 *      drawPlaying calls generateDailyJob when life._availJobs is
 *      empty + the JOBS tab opens).
 *    - showNotif with the right message based on result.kind. */
export function applyForJob(life: LifeState, jobName: string): ApplyForJobResult {
  if (Math.random() < APPLY_FOR_JOB_HIRE_CHANCE) {
    life.playerJob = jobName;
    life.workRep = NEW_HIRE_WORK_REP;
    life.workDaysTotal = 0;
    life.workDaysPresent = 0;
    life.consecutiveAbsences = 0;
    life.basePay = JOB_BASE_PAY[jobName as JobName] ?? NEW_HIRE_BASE_PAY_FALLBACK;
    life.payMultiplier = 1.0;
    life._fired = false;
    life.jobDoneToday = false;
    life._jobListings = [];
    return { kind: 'hired', jobName };
  }

  // Rejection — drop this opening from the listings so the player
  // can't immediately re-tap. Filter is a no-op when _jobListings
  // is undefined; defensive against pre-fill state.
  if (life._jobListings) {
    life._jobListings = life._jobListings.filter((j) => j.name !== jobName);
  }
  return { kind: 'rejected', jobName };
}
