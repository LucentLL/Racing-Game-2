/**
 * Age-weighted starting-conditions roller — picks a player's initial
 * housing tier, savings, mechanical skill, and fitness based on their
 * chosen age. Ported from monolith L44096-44153.
 *
 * Plus the v8.99.42 job-band savings re-roll (rollStartingSavingsForJob,
 * L45003-45022) that fires AT JOB-SELECT TIME to replace the age-only
 * money with a (job, age) cross-tabulation — OFFICE workers come in
 * richer than food-delivery tip-chasers, but a 60yo of any job has
 * more lifetime savings than a 21yo.
 *
 * Both rollers are pure functions over Math.random — no LIFE mutation,
 * no side effects. The caller (gameLoop's name-entry / job-select
 * commits) takes the result and writes it into ctx.startingConditions.
 */

import { HOUSING_TIERS, type HousingTierKey } from '@/config/housing';
import type { StartingConditions } from '@/state/gameState';
import type { JobName } from '@/config/jobs';

const r = Math.random;

/** Age-band-weighted housing tier. Younger players overwhelmingly land
 *  in apartments; older players are more likely to own. Matches the
 *  monolith roll-table verbatim. */
function rollHousing(age: number): HousingTierKey {
  if (age <= 25) {
    const roll = r();
    if (roll < 0.50) return 'apt1br';
    if (roll < 0.80) return 'apt1br';
    if (roll < 0.95) return 'apt2br';
    return 'rentHouse';
  }
  if (age <= 40) {
    const roll = r();
    if (roll < 0.15) return 'apt1br';
    if (roll < 0.50) return 'apt2br';
    if (roll < 0.75) return 'rentHouse';
    if (roll < 0.92) return 'ownStarter';
    return 'ownMid';
  }
  // 41+
  const roll = r();
  if (roll < 0.05) return 'apt1br';
  if (roll < 0.15) return 'apt2br';
  if (roll < 0.35) return 'rentHouse';
  if (roll < 0.60) return 'ownStarter';
  if (roll < 0.85) return 'ownMid';
  return 'ownNice';
}

/** Pre-job-select money roll. Job-select overrides this via
 *  rollStartingSavingsForJob (v8.99.42 split). */
function rollAgeMoney(age: number): number {
  if (age <= 25) return Math.round(100 + r() * 400);          // $100-500
  if (age <= 40) return Math.round(500 + r() * 4500);         // $500-5000
  // Older — wider range, 15% chance to be broke (divorce/debt).
  if (r() < 0.15) return Math.round(50 + r() * 200);          // $50-250
  return Math.round(1000 + r() * 9000);                       // $1000-10000
}

/** Age-weighted mechanical knowledge. Influences future repair-cost
 *  discounts and diagnose accuracy. */
function rollMechSkill(age: number): number {
  if (age <= 25) return 5 + Math.floor(r() * 15);             // 5-20
  if (age <= 40) return 15 + Math.floor(r() * 25);            // 15-40
  return 25 + Math.floor(r() * 35);                           // 25-60
}

/** Age-weighted fitness. 35-65 young, 25-55 middle, 15-40 older —
 *  reflects the body-base preview's Lean/Muscular/Overweight bands. */
function rollFitness(age: number): number {
  if (age <= 25) return 35 + Math.floor(r() * 30);
  if (age <= 40) return 25 + Math.floor(r() * 30);
  return 15 + Math.floor(r() * 25);
}

/** Roll all four at once. Skin tone is pinned to 1 (the only tone
 *  shipped in the body-base sheet). Ported from L44096-44153. */
export function rollStartingConditions(age: number): StartingConditions {
  const housingType = rollHousing(age);
  return {
    money: rollAgeMoney(age),
    housingType,
    housingName: HOUSING_TIERS[housingType].name,
    mechSkill: rollMechSkill(age),
    fitness: rollFitness(age),
    skinTone: 1,
  };
}

/** v8.99.42: job-band-weighted starting savings. Fired AT JOB-PICK to
 *  REPLACE the age-only money rolled at name-entry. Reason: a 60yo
 *  food-delivery driver shouldn't start with more cash than a 25yo
 *  office worker — IRL job is the stronger signal for savings.
 *
 *  Ranges (post-bill — represents what the player has AFTER their
 *  previous month's expenses cleared):
 *    FOOD DELIVERY    $200-$1,200
 *    AUTO PARTS RUN   $400-$2,000
 *    PACKAGE COURIER  $800-$4,000
 *    PARAMEDIC        $1,500-$5,000
 *    TOW TRUCK        $700-$3,000
 *    TRAFFIC COP      $1,200-$4,500
 *    TRUCK DRIVER     $1,200-$4,500
 *    FUEL TANKER      $1,500-$6,000
 *    OFFICE JOB       $2,000-$8,000
 *
 *  Age multiplier: 0.6× at 21, 1.0× at 40, capped at 1.4× at 60+.
 *  Even a 60yo OFFICE worker doesn't have 10× a 21yo's savings —
 *  the curve is intentionally compressed so car-tier decisions stay
 *  interesting at every age.
 *
 *  Ported from monolith L45003-45022. */
const SAVINGS_BANDS: Record<JobName, [number, number]> = {
  'FOOD DELIVERY':   [200, 1200],
  'AUTO PARTS RUN':  [400, 2000],
  'PACKAGE COURIER': [800, 4000],
  PARAMEDIC:         [1500, 5000],
  'TOW TRUCK':       [700, 3000],
  'TRAFFIC COP':     [1200, 4500],
  'TRUCK DRIVER':    [1200, 4500],
  'FUEL TANKER':     [1500, 6000],
  'OFFICE JOB':      [2000, 8000],
};

export function rollStartingSavingsForJob(job: JobName, age: number): number {
  const [lo, hi] = SAVINGS_BANDS[job];
  const raw = lo + r() * (hi - lo);
  const ageMult = Math.max(0.6, Math.min(1.4, 0.6 + (age - 21) * 0.02));
  return Math.round(raw * ageMult);
}
