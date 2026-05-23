/**
 * No-show absence — the daily-rollover penalty for an employed
 * player who didn't work ANY slot today. The "sleep through the
 * day" loophole; v8.99.51 closed it in the monolith and this hop
 * (H515) ports the closure into the modular tree.
 *
 * Before this port, a player with a job could doSleep past every
 * slot and the absence counter never ticked — workRep stayed
 * stuck at 100, never triggering the firing threshold. Now any
 * rollover with zero work AND zero explicit "SKIP WORK" tap
 * counts as an absence and applies the same rep/fire ladder as
 * [[skipWork]].
 *
 * 1:1 port of monolith L46900-L46936 (the L46912-L46915 "skipped
 * work day BEFORE the salary block" check inside doSleep's
 * all-slots-done branch).
 *
 * WEEKEND EXCEPTION: only weekdays (MON-FRI) count toward the
 * absence counter. The monolith encodes the work week via
 * JOB_SALARY's payday-on-Friday convention; weekends are
 * naturally "no work expected." dow math `(LIFE.day - 1) % 7`
 * with 0=FRI 1=SAT 2=SUN 3=MON 4=TUE 5=WED 6=THU.
 *
 * Caller (doSleep's 'rolled' branch) is responsible for:
 *   - Calling BEFORE resetting life.slotsUsed (the eligibility
 *     check reads slotsUsed.morning + .afternoon).
 *   - Surfacing the returned result as the right notif.
 */

import type { LifeState } from '@/state/life';
import { generateJobListings } from '@/sim/jobsRoller';
import { adjustCredit } from '@/sim/credit';

/** Base rep loss for the first absence in a streak. Matches
 *  monolith `repLoss = 5` at L46922. */
const NO_SHOW_REP_LOSS_FIRST = 5;
/** Second-consecutive-absence rep loss. Matches monolith
 *  `if (consecutiveAbsences === 2) repLoss = 15` at L46923. */
const NO_SHOW_REP_LOSS_SECOND = 15;
/** Third+ consecutive absence rep loss. Matches monolith
 *  `else if (consecutiveAbsences >= 3) repLoss = 30` at L46924. */
const NO_SHOW_REP_LOSS_THIRD_PLUS = 30;

/** Fire threshold for OFFICE JOB. Office gets 4 chances (vs 3
 *  elsewhere) because the schedule is fixed and missing one is
 *  more visible — losing the job for 3 strict misses is the
 *  monolith's calibration tradeoff. Matches L46928. */
const NO_SHOW_FIRE_THRESHOLD_OFFICE = 4;
/** Fire threshold for all non-OFFICE jobs. 3 consecutive misses
 *  OR rep <= 0. Matches L46928's else branch. */
const NO_SHOW_FIRE_THRESHOLD_OTHER = 3;

/** Credit-score penalty applied on the firing branch. The job
 *  loss reads as a financial-reliability hit — a 25-point credit
 *  ding matches the monolith's `adjustCredit(-25, 'lost job')`
 *  at L46934. */
const NO_SHOW_FIRE_CREDIT_PENALTY = 25;

/** Result of [[applyNoShowAbsence]]. `null` when no absence fired
 *  (weekend / ineligible / worked today). `'absence'` when the
 *  rep ladder bit but the player kept their job. `'fired'` when
 *  the streak / rep-floor terminated employment. */
export type NoShowAbsenceResult =
  | null
  | { kind: 'absence'; workRep: number; absences: number; jobName: string }
  | { kind: 'fired'; jobName: string };

/** Day-of-week from monolith day index. Returns 0..6 where 0=FRI,
 *  1=SAT, 2=SUN, 3=MON .. 6=THU. Matches monolith inline
 *  `(LIFE.day - 1) % 7` at L46907. */
function dowFromDay(day: number): number {
  return ((day - 1) % 7 + 7) % 7;
}

/** True when the dow is Saturday (1) or Sunday (2). Weekend
 *  absences don't tick the counter. */
function isWeekendDow(dow: number): boolean {
  return dow === 1 || dow === 2;
}

/** Apply the no-show absence rep/fire pipeline if the player had
 *  a job and didn't work today (and it's a weekday). Mutates
 *  life.workDaysTotal / .consecutiveAbsences / .workRep, and on
 *  the firing branch clears playerJob / payMultiplier / basePay /
 *  workRep / workDaysTotal / workDaysPresent / consecutiveAbsences
 *  + dings credit by 25 + regenerates the job listings so the
 *  player can re-apply.
 *
 *  ELIGIBILITY GATES (all required for absence to fire):
 *    - NOT a weekend (dow !== 1 && dow !== 2)
 *    - playerJob is non-empty
 *    - !jobDoneToday (didn't deliver / complete a shift)
 *    - !slotsUsed.morning && !slotsUsed.afternoon (didn't sleep
 *      morning or afternoon either — sleeping a slot counts as
 *      using it)
 *
 *  Returns null when any gate fails. Otherwise returns a
 *  discriminated result for the caller to notif.
 *
 *  Caller MUST invoke BEFORE resetting life.slotsUsed for the
 *  new day — the eligibility check reads the pre-reset values. */
export function applyNoShowAbsence(
  life: LifeState,
  day: number,
): NoShowAbsenceResult {
  if (!life.playerJob) return null;
  if (life.jobDoneToday) return null;
  if (life.slotsUsed.morning || life.slotsUsed.afternoon) return null;
  if (isWeekendDow(dowFromDay(day))) return null;

  const jobName = life.playerJob;
  life.workDaysTotal = (life.workDaysTotal || 0) + 1;
  life.consecutiveAbsences = (life.consecutiveAbsences || 0) + 1;

  let repLoss: number;
  if (life.consecutiveAbsences === 2) repLoss = NO_SHOW_REP_LOSS_SECOND;
  else if (life.consecutiveAbsences >= 3) repLoss = NO_SHOW_REP_LOSS_THIRD_PLUS;
  else repLoss = NO_SHOW_REP_LOSS_FIRST;

  life.workRep = Math.max(0, (life.workRep || 0) - repLoss);

  const fireThreshold = jobName === 'OFFICE JOB'
    ? NO_SHOW_FIRE_THRESHOLD_OFFICE
    : NO_SHOW_FIRE_THRESHOLD_OTHER;

  if (life.consecutiveAbsences >= fireThreshold || life.workRep <= 0) {
    life.playerJob = '';
    life.workRep = 0;
    life.consecutiveAbsences = 0;
    life.payMultiplier = 1.0;
    life.basePay = 0;
    life._fired = true;
    life._jobListings = generateJobListings();
    adjustCredit(life, -NO_SHOW_FIRE_CREDIT_PENALTY, 'lost job');
    return { kind: 'fired', jobName };
  }

  return {
    kind: 'absence',
    workRep: life.workRep,
    absences: life.consecutiveAbsences,
    jobName,
  };
}
