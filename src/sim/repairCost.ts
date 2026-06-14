/**
 * Fault-repair pricing + apply helpers. Mirrors the parts-shop
 * pricing model in [[partsShop]] but operates on Fault entries
 * (life.faults) rather than ShopPart catalog rows.
 *
 * The monolith funnels both fault repairs and proactive parts orders
 * through the same getVenueOptions helper. Modular splits them so
 * each surface (REPAIRS / PARTS) has a typed entry point — a fault
 * lacks the ShopPart `diff` field so we derive it from type+cost.
 *
 * H570: simplified ordering — applyFaultFix runs immediately on
 * order, no pendingParts queue, no day-rollover delay. Same deferred
 * scope as src/sim/partsShop.ts.
 */

import type { LifeState } from '@/state/life';
import type { Fault } from '@/sim/faults';
import type { CatalogCar } from '@/config/cars/catalog';
import { getCarCostMult, getCarSkillBoost, type VenueOptions } from '@/sim/partsShop';

/** Derive the player's DIY difficulty for a fault when the entry
 *  doesn't carry an explicit `diff`. Mirrors monolith
 *  getFaultDifficulty at L42473-L42476: base from repair type
 *  (mech/body) + 3 points per $100 of repair cost, capped at +20.
 *  Modular Fault uses 'mech'/'body' instead of 'mechanic'/etc; the
 *  base map adapts. */
export function getFaultDifficulty(f: Fault): number {
  const baseMap: Record<string, number> = { mech: 55, body: 45 };
  const base = baseMap[f.type] ?? 45;
  return base + Math.min(20, Math.floor(f.cost / 100) * 3);
}

/** Per-venue prices + skill/affordability gating for one fault.
 *  Symmetric with partsShop.getVenueOptions; modular fold so the
 *  repair popup can render either kind of item with the same UI. */
export function getFaultVenueOptions(
  fault: Fault,
  car: CatalogCar | undefined,
  life: LifeState,
): VenueOptions {
  const base = fault.cost;
  const costMult = getCarCostMult(car);
  const skillBoost = getCarSkillBoost(car);
  const rawDiff = getFaultDifficulty(fault);
  const diff = Math.min(100, rawDiff + skillBoost);
  const skill = life.mechSkill ?? 0;
  const canDIY = skill >= diff;
  // H873: DIY time scales with mechanical skill. The base grows with the
  // job's difficulty (sourcing the part + doing the work yourself);
  // skill ABOVE the requirement compresses it — a big margin gets even
  // hard jobs down to an overnight turnaround, while a bare-minimum
  // mechanic spends the better part of a week on a transmission. Mechanic
  // / dealer are unaffected (you're paying for their time, not yours).
  const baseDiyDays = Math.max(1, fault.days + Math.ceil(diff / 25));
  const diyMargin = Math.max(0, skill - diff);
  const diyTime = Math.max(1, Math.round(baseDiyDays / (1 + diyMargin / 6)));
  const mechTime = Math.max(1, fault.days);
  const mechDisc = life.mechanicDiscount ? 0.9 : 1.0;
  return {
    diy:      { price: Math.round(base * costMult),              time: diyTime,  canDo: canDIY, skillReq: diff, label: '🔧 GARAGE (DIY)' },
    mechanic: { price: Math.round(base * 2 * costMult * mechDisc), time: mechTime, canDo: true,   skillReq: 0,    label: '🏭 MECHANIC' },
    dealer:   { price: Math.round(base * 8 * costMult),          time: 0,        canDo: true,   skillReq: 0,    label: '🏪 DEALERSHIP' },
  };
}

/** H873: tier-gated mechanical-skill gain from a DIY job. You improve by
 *  taking on work near or ABOVE your level; jobs well below your skill
 *  barely move the needle (changing your own oil 100× won't teach you a
 *  transmission swap). `diff` is the fault's DIY difficulty (incl. the
 *  per-car boost); `skill` is current mechSkill. Returns whole points.
 *  Gain is awarded on the ATTEMPT, so it applies whether the job
 *  succeeds or (once H874 adds the failure roll) fails. */
export function diySkillGain(skill: number, diff: number): number {
  const challenge = diff - skill;               // >0 above your level, <0 below
  if (challenge >= 0) {
    return 3 + Math.min(5, Math.round(challenge / 8)); // 3..8 at/above level
  }
  return Math.max(0, 2 + Math.round(challenge / 10));  // tapers 2→1→0 below level
}

/** Apply a fault fix: remove the fault from life.faults, bump the
 *  matching stat clamped to 100, tier-gated mechSkill gain on DIY
 *  (mirrors monolith installOwnedPart bump at L48721). */
export function applyFaultFix(
  life: LifeState,
  faultIdx: number,
  fault: Fault,
  isDIY: boolean,
): void {
  if (fault.stat === 'engine') life.engine = Math.min(100, life.engine + fault.add);
  else if (fault.stat === 'tires') life.tires = Math.min(100, life.tires + fault.add);
  else if (fault.stat === 'hp') life.carHP = Math.min(100, life.carHP + fault.add);
  else if (fault.stat === 'paint') life.paint = Math.min(100, life.paint + fault.add);
  // Splice the fault out by index. Defensive: only splice if the
  // entry at that index is the one we expected (defensive against
  // race conditions where the list shifts between popup open + tap).
  const arr = life.faults as Fault[];
  if (arr[faultIdx]?.id === fault.id) {
    arr.splice(faultIdx, 1);
  } else {
    // Fallback: id-based removal.
    const realIdx = arr.findIndex((f) => f.id === fault.id);
    if (realIdx >= 0) arr.splice(realIdx, 1);
  }
  if (isDIY) {
    const skill = life.mechSkill ?? 0;
    life.mechSkill = Math.min(100, skill + diySkillGain(skill, getFaultDifficulty(fault)));
  }
}
