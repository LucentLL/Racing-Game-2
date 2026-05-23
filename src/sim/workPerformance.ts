/**
 * Work-performance modifier — sleep-debt + age scalar that downstream
 * pay calculations multiply into the base pay so a tired / older
 * worker earns less per delivery.
 *
 * H512: 1:1 port of monolith getWorkPerformance() at L8832-L8845. Pure
 * function; reads only LIFE.daysSinceSleep + .coffeeBuff + .age.
 *
 * USAGE: caller compares the returned scalar against the 0.5 threshold
 * in the monolith's pay-modifier formula:
 *   perfMult = getWorkPerformance(life) >= 0.5 ? 1.0 : 0.85
 *   adjPay   = round(job.pay × life.payMultiplier × perfMult)
 *
 * The 0.5 threshold means a single missed-sleep day at any age (which
 * lands around 0.52-0.8 depending on age) keeps the worker at full
 * pay; two missed days (~0.26-0.5) drop to the 0.85× tier; three+
 * (~0.09-0.25) stay at 0.85× (the formula doesn't tier below 0.85
 * for pay, just for the function output itself).
 *
 * CALLER NOTE: getWorkPerformance is ALSO consumed elsewhere in the
 * monolith outside the pay-modifier path — work-performance affects
 * the daily-health-tick severity (sleep-deprived workers take more
 * health damage on shift) and the firing-threshold check. Those
 * downstream consumers can use this same helper when they port; the
 * 0.5-threshold collapse into a binary pay multiplier is specific
 * to the job-arrival delivery path.
 */

import type { LifeState } from '@/state/life';

/** Per-decade-past-20 age decay rate. Each year past 20 subtracts 1 %
 *  from the ageFactor — a 20-year-old worker has ageFactor = 1.0; a
 *  40-year-old has 0.8; a 60-year-old has 0.6. Caps at age 20 so
 *  teens don't get a bonus above 1.0.
 *
 *  Matches monolith `1.0 - Math.max(0, (LIFE.age - 20) * 0.01)`
 *  at L8838. */
const AGE_FACTOR_BASELINE_AGE = 20;
const AGE_FACTOR_DECAY_PER_YEAR = 0.01;

/** Reduce apparent sleep-deprivation by 1 step when coffee buff is
 *  active. Doesn't zero out the underlying daysSinceSleep counter
 *  (the daily-health calc still reads the raw value); just lets the
 *  player fake through a workday after a long night.
 *
 *  v8.98.50 introduced this — see monolith L8836 comment. */
const COFFEE_BUFF_SLEEP_REDUCTION = 1;

/** Performance scalar for 1 day of missed sleep. Young workers
 *  (age 20) land at 0.6 + 1.0 × 0.2 = 0.80; old workers (age 60)
 *  at 0.6 + 0.6 × 0.2 = 0.72... wait, formula is 0.6 + ageFactor × 0.2
 *  where ageFactor < 1 reduces the result. Young ≈ 0.80, old ≈ 0.72.
 *  Both stay above the 0.5 pay threshold — 1 day's sleep debt costs
 *  health but not money.
 *
 *  Matches monolith `0.6 + ageFactor * 0.2` at L8841. */
const PERF_SLEEP_1_BASE = 0.6;
const PERF_SLEEP_1_AGE_WEIGHT = 0.2;

/** Performance scalar for 2 days of missed sleep. Young workers
 *  ≈ 0.50 (right at the pay threshold); old workers drop below
 *  to ≈ 0.41 — 2-day-tired old worker takes the 0.85× pay hit.
 *
 *  Matches monolith `0.35 + ageFactor * 0.15` at L8842. */
const PERF_SLEEP_2_BASE = 0.35;
const PERF_SLEEP_2_AGE_WEIGHT = 0.15;

/** Performance scalar for 3+ days of missed sleep. Young ≈ 0.25;
 *  old ≈ 0.21 — both well below the 0.5 pay threshold, the player
 *  takes the 0.85× pay hit AND the worst daily-health damage.
 *  Doesn't tier further beyond 3 days; the worker is functionally
 *  broken at this point.
 *
 *  Matches monolith `0.15 + ageFactor * 0.1` at L8843. */
const PERF_SLEEP_3PLUS_BASE = 0.15;
const PERF_SLEEP_3PLUS_AGE_WEIGHT = 0.1;

/** Compute the per-shift work-performance scalar from sleep debt +
 *  age. Returns a value in [~0.09, 1.0]; 1.0 is "fully rested,"
 *  values below the 0.5 caller threshold trigger reduced-pay /
 *  reduced-promotion effects in downstream consumers.
 *
 *  FORMULA (1:1 with monolith L8832-L8844):
 *    sleepDep = max(0, LIFE.daysSinceSleep - (coffeeBuff > 0 ? 1 : 0))
 *    ageFactor = max(0, 1 - (LIFE.age - 20) × 0.01)
 *    if sleepDep === 0: return 1.0
 *    if sleepDep === 1: return 0.6 + ageFactor × 0.2
 *    if sleepDep === 2: return 0.35 + ageFactor × 0.15
 *    else (3+ days):    return 0.15 + ageFactor × 0.1
 *
 *  WHY THE COFFEE STEP-DOWN (v8.98.50): one cup of coffee shouldn't
 *  pretend you're fully rested, but it should let a 1-day-tired
 *  worker hit the road feeling functional. The reduction is on the
 *  PERCEIVED sleep-debt only — actual daysSinceSleep continues
 *  accruing for the health system to read. Effectively the player
 *  can buy through one day's worth of sleep penalty by visiting a
 *  cafe before work.
 *
 *  WHY AGE MULTIPLIES (not just adds): older workers recover slower,
 *  so the same sleep-debt category hurts them more proportionally.
 *  The 1 %-per-year decay past 20 is calibrated against real-world
 *  sleep-deprivation research (peak resilience in early 20s,
 *  steady decline through middle age, marked decline past 60).
 *
 *  Pure function; allocates nothing. Safe to call per-frame though
 *  no current caller does — the realistic call pattern is once per
 *  job-arrival delivery (~once per game-day). */
export function getWorkPerformance(life: LifeState): number {
  let sleepDep = life.daysSinceSleep || 0;
  if ((life.coffeeBuff ?? 0) > 0) {
    sleepDep = Math.max(0, sleepDep - COFFEE_BUFF_SLEEP_REDUCTION);
  }
  const ageFactor = 1.0 - Math.max(0, (life.age - AGE_FACTOR_BASELINE_AGE) * AGE_FACTOR_DECAY_PER_YEAR);
  if (sleepDep === 0) return 1.0;
  if (sleepDep === 1) return PERF_SLEEP_1_BASE + ageFactor * PERF_SLEEP_1_AGE_WEIGHT;
  if (sleepDep === 2) return PERF_SLEEP_2_BASE + ageFactor * PERF_SLEEP_2_AGE_WEIGHT;
  return PERF_SLEEP_3PLUS_BASE + ageFactor * PERF_SLEEP_3PLUS_AGE_WEIGHT;
}
