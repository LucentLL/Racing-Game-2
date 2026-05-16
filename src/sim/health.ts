import type { LifeState, FoodStock } from '@/state/life';

export type FoodTier = 'junk' | 'regular' | 'premium';

export function getTotalFood(fs: FoodStock): number {
  return (fs.junk || 0) + (fs.regular || 0) + (fs.premium || 0);
}

/** H193: thresholds + labels + icon now match monolith L45737-45745
 *  1:1. Previous values were a placeholder-grade approximation. */
export function getHealthStatus(health: number): { label: string; color: string; icon: string } {
  if (health >= 85) return { label: 'Excellent', color: '#0f0', icon: '💪' };
  if (health >= 65) return { label: 'Good',      color: '#8f0', icon: '😊' };
  if (health >= 45) return { label: 'Fair',      color: '#ff0', icon: '😐' };
  if (health >= 25) return { label: 'Poor',      color: '#f80', icon: '😟' };
  if (health >= 10) return { label: 'Bad',       color: '#f44', icon: '🤒' };
  return            { label: 'Critical', color: '#f00', icon: '🏥' };
}

/** H193: labels match monolith L45746-45753 1:1. Note monolith's
 *  fitness helper has no `icon` field — the STATUS tab hardcodes 💪
 *  for the fitness row inline. */
export function getFitnessStatus(fitness: number): { label: string; color: string } {
  if (fitness >= 80) return { label: 'Athletic',  color: '#0ff' };
  if (fitness >= 60) return { label: 'Fit',       color: '#0f0' };
  if (fitness >= 40) return { label: 'Active',    color: '#8f0' };
  if (fitness >= 20) return { label: 'Sedentary', color: '#ff0' };
  return            { label: 'Unfit',     color: '#f80' };
}

/**
 * Run the once-per-day health/fitness update. Reads ateToday, daysSinceEat,
 * slotsActiveToday, gymVisitedToday, age, lastMealTier, daysSinceSleep,
 * fitness. Mutates health/fitness/days and resets daily trackers.
 */
export function updateDailyHealth(life: LifeState): void {
  let hDelta = 0;
  const ageFitDecay = 0.3 + Math.max(0, (life.age - 20) * 0.01);
  let fDelta = -ageFitDecay;

  if (!life.ateToday) {
    life.daysSinceEat++;
    if (life.daysSinceEat >= 4) hDelta -= 12;
    else if (life.daysSinceEat >= 3) hDelta -= 8;
    else if (life.daysSinceEat >= 2) hDelta -= 4;
    else hDelta -= 2;
  } else {
    if (life.lastMealTier === 'premium') hDelta += 2;
    else if (life.lastMealTier === 'regular') hDelta += 1;
    else if (life.lastMealTier === 'junk') hDelta -= 1;
  }

  const sleepAgePenalty = 1.0 + Math.max(0, (life.age - 25) * 0.02);
  if ((life.slotsActiveToday || 0) >= 3) {
    life.daysSinceSleep++;
    if (life.daysSinceSleep >= 3) hDelta -= Math.round(12 * sleepAgePenalty);
    else if (life.daysSinceSleep >= 2) hDelta -= Math.round(7 * sleepAgePenalty);
    else hDelta -= Math.round(3 * sleepAgePenalty);
  } else {
    const recoverBonus = life.age <= 25 ? 3 : 2;
    if (life.daysSinceSleep > 0) hDelta += recoverBonus;
    life.daysSinceSleep = 0;
  }

  if (life.gymVisitedToday) fDelta = 0;

  if (life.health < 75 && life.ateToday && life.daysSinceSleep === 0) {
    hDelta += life.age <= 30 ? 3 : 2;
  }

  if (life.fitness >= 60) hDelta += 1;

  life.health = Math.max(0, Math.min(100, life.health + hDelta));
  life.fitness = Math.max(0, Math.min(100, life.fitness + fDelta));

  life.ateToday = false;
  life.lastMealTier = '';
  life.gymVisitedToday = false;
  life.lastWorkoutLevel = 0;
  life.slotsActiveToday = 0;
}

export interface GymWorkoutResult {
  applied: boolean;
  reason?: string;
  cost: number;
  fitGain: number;
  healthDelta: number;
  penalty: number;
}

/**
 * Pure workout calculator — returns the deltas. Caller checks affordance,
 * checks slot availability, then applies the deltas and consumes the slot.
 */
export function evaluateGymWorkout(life: LifeState, level: 1 | 2 | 3): GymWorkoutResult {
  const cost = [0, 0, 10, 20][level];
  if (life.money < cost) {
    return { applied: false, reason: `Need $${cost} for gym`, cost, fitGain: 0, healthDelta: 0, penalty: 0 };
  }
  if (life.gymVisitedToday) {
    return { applied: false, reason: 'Already worked out today', cost, fitGain: 0, healthDelta: 0, penalty: 0 };
  }
  if (level >= 3 && life.health < 15) {
    return { applied: false, reason: 'Too unhealthy for heavy workout', cost, fitGain: 0, healthDelta: 0, penalty: 0 };
  }
  const fitGain = [0, 2, 4, 6][level];
  const healthGain = [0, 1, 2, 3][level];
  let penalty = 0;
  if (life.daysSinceEat >= 2 && level >= 3) penalty = 5;
  else if (life.daysSinceEat >= 2 && level >= 2) penalty = 3;
  else if (life.daysSinceEat >= 1 && level >= 3) penalty = 2;
  return {
    applied: true,
    cost,
    fitGain,
    healthDelta: healthGain - penalty,
    penalty,
  };
}

export const GROCERY_OPTIONS: Record<FoodTier, { cost: number; qty: number; label: string; icon: string }> = {
  junk:    { cost: 8,  qty: 4, label: 'Corner Store',       icon: '🏪' },
  regular: { cost: 25, qty: 5, label: 'Grocery Store',      icon: '🛒' },
  premium: { cost: 45, qty: 4, label: 'Health Food Store',  icon: '🥦' },
};
