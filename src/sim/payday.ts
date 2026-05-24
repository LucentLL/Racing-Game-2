/**
 * Payday system — daily salary accumulator + Friday payout.
 *
 * Two functions, both consumed by the day-rollover sequence:
 *
 *   [[accumulateSalary]] — runs once per in-game day (gated by
 *     life.dailyPaid). When the player worked any slot today and
 *     holds a salaried job (not FOOD DELIVERY, which is per-tip),
 *     adds today's adjusted gross to life.pendingSalary, bumps
 *     work-day counters, updates workRep based on getWorkPerformance.
 *     Workers leaving early get a 60% pay haircut. Sleep-deprived
 *     workers may LOSE rep on top of the perf-bucket pay multiplier.
 *
 *   [[runFridayPayout]] — runs on every day-rollover; no-op except
 *     on Fridays when life.pendingSalary > 0. Computes federal +
 *     NC + FICA via the shared [[calcPaycheckTax]] withholder,
 *     deposits the net into life.money, accumulates the gross /
 *     tax into life.ytdGross / life.ytdTax for the year-end W-2
 *     screen (port pending), and resets pendingSalary to 0.
 *
 * H544: 1:1 port of monolith salary accumulator at L46938-L46967
 * and Friday-payout block at L46973-L46986. Both blocks lived
 * inside the monolith's doSleep day-rollover branch and ran
 * back-to-back; the modular port keeps the accumulator inside
 * doSleep (where slotsUsed is still readable, before its reset)
 * but moves runFridayPayout to gameLoop's day-rollover sequence
 * so it fires consistently regardless of whether the day rolls
 * via doSleep or via real-time tickClock advance. Both are
 * idempotent within a day so the order doesn't matter.
 *
 * PERFORMANCE BUCKETS (matches monolith L46943 / L46955-L46966):
 *   perf >= 0.8  → fresh worker:    perfMult 1.00,  repGain  +3
 *   perf >= 0.5  → tired worker:    perfMult 0.90,  repGain  +1
 *   perf <  0.5  → exhausted:       perfMult 0.75,  repGain  0
 *                                                   + 40-70% chance to LOSE 2 or 3 rep
 *
 * The +1 "rookie boost" rep gain when workRep < 30 fires on every
 * tier — even an exhausted rookie gets some early reputation.
 *
 * LEAVE-EARLY PENALTY (matches monolith L46947-L46949): when the
 * office day-flow modal's "LEAVE EARLY" branch sets
 * life.officeLeaveEarly = true, the accumulated salary is reduced
 * to 60%. The flag is cleared per-day in the rollover latch reset.
 */

import type { LifeState } from '@/state/life';
import { JOB_SALARY, type JobName } from '@/config/jobs';
import { getWorkPerformance } from '@/sim/workPerformance';
import { calcPaycheckTax, type PaycheckBreakdown } from '@/sim/finance';
import { dayOfWeekIndex } from '@/config/calendar';
import { gameYearFor } from '@/sim/realisticOdo';
import { logCalEvent } from '@/sim/calendarLog';

/** Performance threshold for the "fresh worker" bucket — full
 *  pay (1.00×) + +3 rep gain. Matches monolith L46943. */
export const PERF_FRESH_THRESHOLD = 0.8;

/** Performance threshold for the "tired worker" bucket — 90%
 *  pay + +1 rep gain. Below this: exhausted bucket. */
export const PERF_TIRED_THRESHOLD = 0.5;

/** Pay multiplier for the exhausted bucket. */
export const EXHAUSTED_PAY_MULT = 0.75;

/** Pay multiplier for the tired bucket. */
export const TIRED_PAY_MULT = 0.9;

/** Salary haircut applied when officeLeaveEarly is true.
 *  Matches monolith L46948 `adjustedSalary = round(adj * 0.6)`. */
export const LEAVE_EARLY_PAY_MULT = 0.6;

/** workRep ceiling below which the player gets a +1 rookie bonus
 *  on every performance bucket. */
export const ROOKIE_REP_THRESHOLD = 30;

/** Result of [[runFridayPayout]] — null if not Friday or nothing
 *  was pending; otherwise the breakdown so the caller can surface
 *  the PAYDAY notif with gross / tax / net amounts. */
export interface FridayPayoutResult {
  /** Pre-tax weekly gross — what hit pendingSalary across the week. */
  gross: number;
  /** Total weekly tax withholding (federal + NC + FICA). */
  tax: number;
  /** Net deposited into life.money. */
  net: number;
  /** Full tax breakdown for any caller that wants the federal /
   *  NC / FICA split (W-2 screen, debug). */
  breakdown: PaycheckBreakdown;
}

/** Did any work-slot fire today? Reads slotsUsed which is mutated
 *  by [[doSleep]] / [[doRelax]] when the player commits a slot.
 *  Mirrors monolith's `LIFE.slotsUsed.morning || .afternoon || .night`
 *  test at L46939. */
function workedAnySlot(life: LifeState): boolean {
  return !!(life.slotsUsed.morning || life.slotsUsed.afternoon || life.slotsUsed.night);
}

/** Daily salary accumulator. Pulled into pendingSalary by the
 *  doSleep day-rollover before slotsUsed gets reset. Idempotent
 *  within a day — the dailyPaid latch prevents double-pay if the
 *  player triggers another rollover path before dailyPaid clears.
 *
 *  Ported 1:1 from monolith L46938-L46967 (the "Accumulate salary
 *  if worked today" block inside doSleep). */
export function accumulateSalary(life: LifeState): void {
  if (life.dailyPaid) return;
  if (!life.playerJob) return;
  if (life.playerJob === 'FOOD DELIVERY') return; // per-tip, not per-day
  if (!life.jobDoneToday && !workedAnySlot(life)) return;

  const salary = JOB_SALARY[life.playerJob as JobName] ?? 0;
  if (salary <= 0) return;

  const perf = getWorkPerformance(life);
  const perfMult =
    perf >= PERF_FRESH_THRESHOLD ? 1.0
    : perf >= PERF_TIRED_THRESHOLD ? TIRED_PAY_MULT
    : EXHAUSTED_PAY_MULT;
  let adjusted = Math.round(salary * (life.payMultiplier ?? 1) * perfMult);
  if (life.officeLeaveEarly) {
    adjusted = Math.round(adjusted * LEAVE_EARLY_PAY_MULT);
  }
  life.pendingSalary += adjusted;
  life.dailyPaid = true;

  // Work-day counters — feed the future absence ladder + raise
  // eligibility. consecutiveAbsences resets on any present day.
  life.workDaysTotal += 1;
  life.workDaysPresent += 1;
  life.consecutiveAbsences = 0;

  // Rep tick — perf bucket sets the base, rookie-floor adds +1,
  // exhausted has a chance to LOSE 2/3 rep on top.
  let repChange = perf >= PERF_FRESH_THRESHOLD ? 3
    : perf >= PERF_TIRED_THRESHOLD ? 1
    : 0;
  if (life.workRep < ROOKIE_REP_THRESHOLD) repChange += 1;
  if (perf < PERF_TIRED_THRESHOLD) {
    // Sleep-deprived subpar work — 40-70% chance to drop rep.
    const lossChance = 0.4 + (PERF_TIRED_THRESHOLD - perf) * 0.6;
    if (Math.random() < lossChance) {
      repChange = -(perf < 0.25 ? 3 : 2);
    }
  }
  life.workRep = Math.max(0, Math.min(100, life.workRep + repChange));
}

/** Result of [[runYearRolloverW2]] — null when the supplied day
 *  isn't a year boundary; otherwise the prior-year totals snapshot
 *  the caller surfaces as the W-2 notif right before the YTD reset
 *  zeroes them. */
export interface YearRolloverW2Result {
  /** Prior year's cumulative gross. */
  gross: number;
  /** Prior year's cumulative tax. */
  tax: number;
  /** Effective tax rate (tax / gross), rounded to whole percent —
   *  the value the W-2 notif shows in parentheses. */
  effectivePct: number;
}

/** Year-end W-2 rollover. Fires once per in-game year on the first
 *  day of the new year (the day where [[gameYearFor]] advances).
 *  Snapshots life.ytdGross / .ytdTax into the returned result for
 *  the caller's notif, then zeroes both. No-op when either:
 *    - the day isn't a year boundary
 *    - ytdGross is 0 (player worked nothing all year — no W-2 to show)
 *
 *  Year-boundary detection uses `gameYearFor(day) !==
 *  gameYearFor(day - 1)` — pure, no extra LifeState field needed.
 *  This means the year-rollover effect is detected at the exact
 *  day-rollover frame, not the next time the player checks; safe
 *  to call on every day-rollover.
 *
 *  Ported 1:1 from monolith advanceCalendarDay W-2 branch at
 *  L46487-L46498 (the `if(LIFE.month>=12)` year-wrap block —
 *  W-2 notif + YTD reset). */
export function runYearRolloverW2(life: LifeState, day: number): YearRolloverW2Result | null {
  if (gameYearFor(day) === gameYearFor(day - 1)) return null;
  const gross = life.ytdGross;
  const tax = life.ytdTax;
  if (gross <= 0) {
    // Reset YTD even when there's no W-2 to show — keeps the
    // counters from carrying forward through years where the
    // player took a sabbatical mid-year. Matches monolith
    // ordering: zero unconditionally after the notif gate at
    // L46496-L46497.
    life.ytdGross = 0;
    life.ytdTax = 0;
    return null;
  }
  const effectivePct = Math.round((tax / gross) * 100);
  life.ytdGross = 0;
  life.ytdTax = 0;
  return { gross, tax, effectivePct };
}

/** Friday payout — pulls life.pendingSalary out as a net deposit
 *  via the shared paycheck-tax model, accumulates YTD totals, and
 *  zeros pendingSalary. No-op except when the supplied day is a
 *  Friday AND pendingSalary > 0. Returns the breakdown when the
 *  payout fires; null otherwise.
 *
 *  Ported 1:1 from monolith L46973-L46986. */
export function runFridayPayout(life: LifeState, day: number): FridayPayoutResult | null {
  // Friday is dayOfWeekIndex 0 per the monolith convention (day 1
  // starts on Friday — see calendar.ts dayOfWeekIndex docstring).
  if (dayOfWeekIndex(day) !== 0) return null;
  if (life.pendingSalary <= 0) return null;
  const gross = life.pendingSalary;
  const breakdown = calcPaycheckTax(gross);
  const tax = breakdown.weeklyTax;
  const net = breakdown.weeklyNet;
  life.money += net;
  life.ytdGross += gross;
  life.ytdTax += tax;
  life.pendingSalary = 0;
  // H555: also fold this payout's net into the in-flight monthly
  // accumulator. fireMonthlyPay reads + resets _monthPayAccum on
  // month boundary to drive the HUD's "MONTH N: +$X" receipt line.
  // Index-signature access since LifeState's transient flags aren't
  // exhaustively typed.
  (life as { _monthPayAccum?: number })._monthPayAccum =
    ((life as { _monthPayAccum?: number })._monthPayAccum || 0) + net;
  // H548: calendar log entry. Matches monolith L46984
  // `logCalEvent('P','','Payday $'+fridayPayout+' (tax -$'+fridayTax+')')`.
  // Slot is '' — payday is slot-agnostic (fires at day-rollover,
  // not within a play slot).
  logCalEvent(life, day, 'P', '', 'Payday $' + net + ' (tax -$' + tax + ')');
  return { gross, tax, net, breakdown };
}
