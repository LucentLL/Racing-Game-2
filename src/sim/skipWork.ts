/**
 * Skip work — player taps SKIP WORK on the pause-menu JOBS tab when
 * they have a playerJob but no active assignment yet today. Burns
 * the day, applies a reputation penalty, and fires the player if
 * absences pile up or rep drops to zero.
 *
 * 1:1 port of monolith L8854-8878 (skipWork). The monolith also
 * routes a "no-show" path at L46903 (player drove off without
 * tapping SKIP) — that reuses the same rep/fire ladder and lives
 * with the daily-roll-over hook; not in scope here.
 *
 * Pure mutator: caller decides how to surface the outcome (notif
 * + close pause menu). Discriminated return mirrors sleepSlot's
 * pattern.
 */

import type { LifeState } from '@/state/life';
import { generateJobListings } from '@/sim/jobsRoller';

export type SkipWorkResult =
  | { kind: 'absence'; workRep: number; absences: number }
  | { kind: 'fired' };

export function skipWork(life: LifeState): SkipWorkResult {
  life.jobDoneToday = true;
  life.workDaysTotal++;
  life.consecutiveAbsences++;

  let repLoss = 5;
  if (life.consecutiveAbsences === 2) repLoss = 15;
  else if (life.consecutiveAbsences >= 3) repLoss = 30;

  // Good attendance cushions the hit (1 absence in 100 days is minor).
  const attendanceRate =
    life.workDaysTotal > 0 ? life.workDaysPresent / life.workDaysTotal : 0;
  if (attendanceRate > 0.9) repLoss = Math.max(3, Math.round(repLoss * 0.6));

  life.workRep = Math.max(0, life.workRep - repLoss);

  // New employees (rep < 20) get fired faster — 2 absences vs 3.
  const fireThreshold = life.workRep < 20 ? 2 : 3;
  if (life.consecutiveAbsences >= fireThreshold || life.workRep <= 0) {
    life.playerJob = '';
    life.workRep = 0;
    life.workDaysTotal = 0;
    life.workDaysPresent = 0;
    life.consecutiveAbsences = 0;
    life.payMultiplier = 1.0;
    life.basePay = 0;
    life._fired = true;
    life._jobListings = generateJobListings();
    return { kind: 'fired' };
  }

  return {
    kind: 'absence',
    workRep: life.workRep,
    absences: life.consecutiveAbsences,
  };
}
