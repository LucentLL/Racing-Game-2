/**
 * Apply CharacterCommit + StartingConditions + job pick to a fresh
 * LifeState. Ported from monolith L44516-44530 plus the LIFE field
 * writes scattered through handleNameEntryClick (L44801-44824) and
 * handleJobSelectClick (L44958-44985).
 */

import type { LifeState } from '@/state/life';
import type { CharacterCommit, StartingConditions } from '@/state/gameState';
import type { JobName } from '@/config/jobs';
import { JOB_BASE_PAY } from '@/config/jobs';
import { HOUSING_TIERS } from '@/config/housing';

/** Writes character + housing + money + skill + fitness to LIFE. Caller
 *  passes an already-rolled StartingConditions (post-job-band-reroll)
 *  so the money field reflects the final start-flow value. */
export function applyStartingConditions(life: LifeState, character: CharacterCommit, conditions: StartingConditions): void {
  life.playerName = character.playerName;
  life.playerAlias = character.playerAlias;
  life.age = character.age;
  life.gender = character.gender;
  life.skinTone = conditions.skinTone;
  life.portrait = 0; // legacy field, kept at 0 for save back-compat

  life.housingType = conditions.housingType;
  const tier = HOUSING_TIERS[conditions.housingType as keyof typeof HOUSING_TIERS];
  if (tier) {
    life.monthlyHousingCost = tier.rent || tier.mortgage;
    life.mortgageBalance = tier.price || 0;
    life.mortgageMonthsRemaining = tier.price > 0 ? 360 : 0;
    life.garageSlots = tier.slots;
  }

  life.money = conditions.money;
  life.mechSkill = conditions.mechSkill;
  life.fitness = conditions.fitness;

  if (character.testMode) {
    life._testMode = true;
  }
}

/** Sets the job-related fields on LIFE. Called at the job-select
 *  commit BEFORE the in-game money reroll fires. */
export function applyStartingJob(life: LifeState, job: JobName): void {
  life.playerJob = job;
  life.basePay = JOB_BASE_PAY[job] || 50;
  life.payMultiplier = 1.0;
  life.workRep = 25; // new hire
  life.workDaysTotal = 0;
  life.workDaysPresent = 0;
  life.consecutiveAbsences = 0;
  life._fired = false;
}
