/**
 * Upgrade purchase economy — H876.
 *
 * Turns a power/weight STAGE step into a priced, timed, skill-gated job and
 * routes it through the same day-clock queue as repairs (life.pendingParts →
 * tickPendingParts). Each stage:
 *   - costs money scaled by the spec gain (hp added / kg shed) × car class,
 *     with a per-stage premium (later stages cost more per unit — the
 *     front-loaded power curve already gives them less),
 *   - takes build DAYS (resolves on a day-rollover, like a repair),
 *   - needs mechanical SKILL to DIY, or you pay the SHOP premium (no gate).
 *
 * Upgrades are sequential (you buy the next stage) and permanent — there's no
 * "un-build", so the SPECS pips only ever step UP through this path.
 */

import type { LifeState, PendingPart } from '@/state/life';
import type { Clock } from '@/state/clock';
import type { CatalogCar } from '@/config/cars/catalog';
import { getCarCostMult, getCarSkillBoost, getEffCostMult } from '@/sim/partsShop';
import {
  getCarUpgrades, getUpgradeHeadroom, powerAtStage, weightAtStage,
  brakeStageMult, suspTurnBonus, gripStageBonus, type UpgradeKind,
} from '@/config/cars/upgradeHeadroom';
import { diySkillGain } from '@/sim/repairCost';

export type { UpgradeKind };

export interface UpgradeStagePlan {
  kind: UpgradeKind;
  fromStage: number;
  toStage: number;
  /** Current effective value and the value after this stage (hp / kg / % gain). */
  fromVal: number;
  toVal: number;
  /** Positive magnitude of the change (hp gained / kg shed / % braking gained). */
  delta: number;
  unit: 'hp' | 'kg' | '%';
  diyPrice: number;
  shopPrice: number;
  days: number;
  skillReq: number;
  canDIY: boolean;
}

const PER_HP = 55;
// Weight reduction is the CHEAP mod early — stage 1 is pulling the interior +
// a lighter battery (mostly labor + a cheap battery, ~$400), not buying power.
// $45/kg made a Civic interior-strip cost ~$1.5k (more at the shop) which the
// user flagged as absurd for 1999. $12/kg + the steep weight stage premium
// below keeps stage 1 cheap while stage 4 (carbon panels) gets appropriately
// pricey, and it still scales by car value (Honda < Aston) via getCarCostMult.
const PER_KG = 12;
// H940: handling kinds (brakes/suspension/tires) are priced by a FLAT hardware
// base × steep weight-style premium × a base-DAMPED car multiplier — NOT by the
// front-loaded %-performance-gain. The old per-% rates dumped the biggest gain
// into stage 1, so the cheap consumable (pads/springs/tires) was the most
// expensive step, then ×2.4-5 for exotics → the "$6,336 NSX stage-1 brakes" bug.
// Stage 1 = the cheap consumable; the premium ramps to race hardware at stage 4.
// The %-gain functions still drive PERFORMANCE + the displayed fromVal/toVal.
const BASE_BRAKE = 220;   // S1 = pads + fluid
const BASE_SUSP = 200;    // S1 = lowering springs
const BASE_TIRE = 250;    // S1 = sport tire set
const SHOP_MULT = 1.6;
/** Per-category DIY skill requirement by target stage. Handling bolt-ons need
 *  less skill than engine builds; tires are the easiest swap. */
const SKILL_REQ_BASE: Record<UpgradeKind, readonly number[]> = {
  power:      [0, 25, 45, 65, 85],
  weight:     [0, 20, 35, 55, 75],
  brakes:     [0, 15, 30, 50, 70],
  suspension: [0, 20, 38, 58, 78],
  tires:      [0, 10, 22, 40, 60],
};

/** Build the plan for advancing `kind` to `toStage` (must be exactly one past
 *  the current stage). Returns null if toStage is out of range or not the next
 *  step up. */
export function getUpgradeStagePlan(
  car: CatalogCar,
  kind: UpgradeKind,
  toStage: number,
  life: LifeState,
): UpgradeStagePlan | null {
  const up = getCarUpgrades(life, car.id);
  const fromStage = up[kind];
  if (toStage < 1 || toStage > 4 || toStage <= fromStage) return null;

  const h = getUpgradeHeadroom(car);
  let fromVal: number;
  let toVal: number;
  let delta: number;
  let unit: 'hp' | 'kg' | '%';
  let basePrice: number;
  if (kind === 'power') {
    fromVal = powerAtStage(h.stockHp, h.builtHp, fromStage);
    toVal = powerAtStage(h.stockHp, h.builtHp, toStage);
    delta = Math.max(0, toVal - fromVal);
    unit = 'hp';
    basePrice = delta * PER_HP;
  } else if (kind === 'weight') {
    fromVal = weightAtStage(h.stockKg, h.minKg, fromStage);
    toVal = weightAtStage(h.stockKg, h.minKg, toStage);
    delta = Math.max(0, fromVal - toVal);
    unit = 'kg';
    basePrice = delta * PER_KG;
  } else if (kind === 'brakes') {
    // value is the % braking gain over stock.
    fromVal = Math.round((brakeStageMult(fromStage) - 1) * 100);
    toVal = Math.round((brakeStageMult(toStage) - 1) * 100);
    delta = Math.max(0, toVal - fromVal);
    unit = '%';
    basePrice = BASE_BRAKE;
  } else if (kind === 'suspension') {
    // value is the % turn-in gain over stock.
    fromVal = Math.round((suspTurnBonus(fromStage) - 1) * 100);
    toVal = Math.round((suspTurnBonus(toStage) - 1) * 100);
    delta = Math.max(0, toVal - fromVal);
    unit = '%';
    basePrice = BASE_SUSP;
  } else {
    // tires — value is the % grip gain over stock.
    fromVal = Math.round((gripStageBonus(fromStage) - 1) * 100);
    toVal = Math.round((gripStageBonus(toStage) - 1) * 100);
    delta = Math.max(0, toVal - fromVal);
    unit = '%';
    basePrice = BASE_TIRE;
  }

  // Handling kinds (brakes/suspension/tires) use the base-DAMPED multiplier (a
  // consumable, not whole-car value) + the steep weight-style premium, so stage
  // 1 is a cheap consumable and stage 4 is race hardware. Power keeps the full
  // sqrt curve + gentle premium (real engine money); weight keeps the full curve
  // + steep premium (H939). Both weight + handling ramp 1.0/stage.
  const isHandling = kind === 'brakes' || kind === 'suspension' || kind === 'tires';
  const mult = isHandling ? getEffCostMult(car, basePrice) : getCarCostMult(car);
  const premiumPerStage = (kind === 'weight' || isHandling) ? 1.0 : 0.25;
  const stagePremium = 1 + (toStage - 1) * premiumPerStage;
  const diyPrice = Math.round(basePrice * mult * stagePremium);
  const shopPrice = Math.round(diyPrice * SHOP_MULT);
  const days = toStage + 1; // Stage 1 = 2d … Stage 4 = 5d
  const skillReq = Math.min(95, SKILL_REQ_BASE[kind][toStage] + getCarSkillBoost(car));
  const canDIY = (life.mechSkill ?? 0) >= skillReq;

  return { kind, fromStage, toStage, fromVal, toVal, delta, unit, diyPrice, shopPrice, days, skillReq, canDIY };
}

/** True if a build for this car+kind is already queued (can't double-order). */
export function hasPendingUpgrade(life: LifeState, carId: string, kind: UpgradeKind): PendingPart | undefined {
  return life.pendingParts?.find((p) => p.upgrade?.kind === kind && p.carId === carId);
}

export interface UpgradeOrderResult {
  ok: boolean;
  reason?: 'money' | 'skill' | 'pending' | 'invalid';
  readyDay?: number;
  price?: number;
}

/** Charge + queue a stage. useShop=false attempts DIY (skill-gated, base price
 *  + a tier-gated skill bump); useShop=true pays the premium with no gate.
 *  The stage applies on completion via tickPendingParts → setCarUpgrade. */
export function orderUpgrade(
  life: LifeState,
  clock: Clock,
  car: CatalogCar,
  plan: UpgradeStagePlan,
  useShop: boolean,
): UpgradeOrderResult {
  if (hasPendingUpgrade(life, car.id, plan.kind)) return { ok: false, reason: 'pending' };
  if (!useShop && !plan.canDIY) return { ok: false, reason: 'skill' };
  const price = useShop ? plan.shopPrice : plan.diyPrice;
  if (life.money < price) return { ok: false, reason: 'money' };

  life.money -= price;
  if (!useShop) {
    const skill = life.mechSkill ?? 0;
    life.mechSkill = Math.min(100, skill + diySkillGain(skill, plan.skillReq));
  }
  const readyDay = clock.day + plan.days;
  const label = plan.kind.charAt(0).toUpperCase() + plan.kind.slice(1);
  const job: PendingPart = {
    id: `upg_${plan.kind}_${plan.toStage}_${car.id}_${clock.day}`,
    name: `${label} Stage ${plan.toStage}`,
    stat: 'engine',
    add: 0,
    readyDay,
    venue: useShop ? 'mechanic' : 'diy',
    isDelivery: false,
    carId: car.id,
    upgrade: { kind: plan.kind, stage: plan.toStage },
  };
  life.pendingParts.push(job);
  return { ok: true, readyDay, price };
}
