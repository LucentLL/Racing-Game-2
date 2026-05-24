/**
 * Parts shop catalog + ordering helpers.
 *
 * 1:1 port of monolith L42428-L42600 — PARTS_SHOP data table,
 * getCarCostMult / getCarSkillBoost / getVenueOptions price math,
 * filterAvailableParts mod-eligibility gates, and applyPart effect
 * application.
 *
 * H567 SCOPE: simplified ordering — applyPart runs immediately on
 * order, no pendingParts queue, no day-rollover delay. The monolith
 * routes delivery parts to ownedParts (inventory), mechanic/dealer
 * orders to pendingParts (multi-day timer), then completePending
 * pops them in lifeSimTick. That whole pipeline lands as a follow-
 * up — for now, ORDER deducts cash and applies the stat bump
 * synchronously so the visible UI works without the sim infrastructure.
 *
 * Transmission / steering swap parts are intentionally OMITTED from
 * this catalog: their applyPart paths mutate manualGear / pedal
 * layout / rhdOverride which need additional plumbing the modular
 * tree hasn't ported. Once the manual/auto + RHD swap sim helpers
 * land, those entries can join.
 */

import type { LifeState } from '@/state/life';
import type { CatalogCar } from '@/config/cars/catalog';

/** A single part-shop entry. Same shape across delivery/diy/mechanic
 *  types so the UI doesn't have to branch per kind. Mirrors monolith
 *  L42430+ row schema. */
export interface ShopPart {
  /** Display name — shown in the row header. */
  name: string;
  /** Stat lane this part bumps. 'all' applies to engine + tires +
   *  body together; 'welded' / 'supercharged' flip the mod flag. */
  stat: 'tires' | 'engine' | 'hp' | 'all' | 'welded' | 'supercharged';
  /** Base cost in dollars before car-cost multiplier / discounts. */
  cost: number;
  /** Stat boost (clamped to <= 100 on apply). For mod flags this is
   *  the legacy "1" value; the apply path ignores the number. */
  add: number;
  /** Days to complete via mechanic. delivery=days-to-ship, diy=0
   *  (instant), mechanic=days-at-shop. */
  days: number;
  /** Routing — drives which venue is the "primary" for the row. */
  type: 'delivery' | 'diy' | 'mechanic';
  /** Difficulty threshold — mechSkill must meet this to DIY a
   *  delivery/mechanic item. Mirrors monolith's `diff` field. */
  diff: number;
}

/** 1:1 with monolith PARTS_SHOP at L42428-L42469. Transmission +
 *  steering swap entries deferred (see module doc). */
export const PARTS_SHOP: readonly ShopPart[] = [
  // DELIVERY — parts shipped to your door
  { name: 'NEW TIRES',         stat: 'tires',   cost:  200, add:  50, days: 1, type: 'delivery',  diff: 30 },
  { name: 'BRAKE PADS',        stat: 'hp',      cost:  120, add:  20, days: 1, type: 'delivery',  diff: 25 },
  { name: 'STRUTS & SPRINGS',  stat: 'hp',      cost:  180, add:  25, days: 2, type: 'delivery',  diff: 35 },
  { name: 'CONTROL ARMS',      stat: 'hp',      cost:  250, add:  30, days: 2, type: 'delivery',  diff: 40 },
  // DIY — work in your garage, instant
  { name: 'OIL CHANGE',        stat: 'engine',  cost:   40, add:  15, days: 0, type: 'diy',       diff:  5 },
  { name: 'BODY PATCH',        stat: 'hp',      cost:  100, add:  20, days: 0, type: 'diy',       diff: 10 },
  { name: 'FLUID FLUSH',       stat: 'all',     cost:   60, add:  10, days: 0, type: 'diy',       diff:  8 },
  // MODS — permanent modifications
  { name: 'WELD DIFF',         stat: 'welded',       cost:  150, add: 1, days: 0, type: 'diy',       diff: 35 },
  { name: 'SUPERCHARGER',      stat: 'supercharged', cost: 3000, add: 1, days: 1, type: 'mechanic',  diff: 85 },
  // MECHANIC — professional work, takes days
  { name: 'USED ENGINE (40-80k mi)', stat: 'engine', cost: 1800, add:  70, days: 2, type: 'mechanic', diff: 55 },
  { name: 'CRATE ENGINE (0 mi)',     stat: 'engine', cost: 4000, add: 100, days: 4, type: 'mechanic', diff: 60 },
  { name: 'ENGINE REBUILD',          stat: 'engine', cost: 5500, add: 100, days: 6, type: 'mechanic', diff: 85 },
  { name: 'TRANSMISSION REBUILD',    stat: 'engine', cost: 2500, add:  30, days: 3, type: 'mechanic', diff: 65 },
  { name: 'FULL SERVICE',            stat: 'all',    cost:  900, add:  40, days: 4, type: 'mechanic', diff: 80 },
];

/** Car-class price multiplier — exotics cost more to repair. Mirrors
 *  monolith getCarCostMult at L42481-L42489. sqrt scale on price,
 *  capped at 5x. Race cars (name includes 'Race Car') get a 1.5x
 *  premium on top. */
export function getCarCostMult(car: CatalogCar | undefined): number {
  if (!car) return 1;
  const price = car.price || 15000;
  const isRace = car.name.includes('Race Car');
  let mult = Math.max(0.6, Math.min(5.0, Math.sqrt(price / 15000)));
  if (isRace) mult *= 1.5;
  return mult;
}

/** Per-car skill-requirement bump — exotic cars need more mechSkill.
 *  Mirrors monolith getCarSkillBoost at L42490-L42497. Race cars
 *  jump to +60 unconditionally; ordinary exotics scale linearly. */
export function getCarSkillBoost(car: CatalogCar | undefined): number {
  if (!car) return 0;
  const isRace = car.name.includes('Race Car');
  if (isRace) return 60;
  const price = car.price || 15000;
  return Math.min(25, Math.max(0, Math.floor((price - 15000) / 8000)));
}

/** Per-venue price + skill-gate + time for a single part. Mirrors
 *  monolith getVenueOptions at L42499-L42516. Discount-via-connections
 *  is deferred (LIFE.partDiscount not ported yet) — defaults to 1.0
 *  multiplier; mechanicDiscount is already on LifeState so it threads
 *  through correctly. */
export interface VenueOption {
  price: number;
  time: number;
  canDo: boolean;
  skillReq: number;
  label: string;
}
export interface VenueOptions {
  diy: VenueOption;
  mechanic: VenueOption;
  dealer: VenueOption;
}
export function getVenueOptions(
  part: ShopPart,
  car: CatalogCar | undefined,
  life: LifeState,
): VenueOptions {
  const base = part.cost;
  const costMult = getCarCostMult(car);
  const skillBoost = getCarSkillBoost(car);
  const diff = Math.min(100, part.diff + skillBoost);
  const canDIY = (life.mechSkill ?? 0) >= diff;
  const diyTime = part.type === 'diy' ? 0 : part.type === 'delivery' ? part.days : part.days + 1;
  const mechTime = Math.max(1, part.days);
  const mechDisc = life.mechanicDiscount ? 0.9 : 1.0;
  return {
    diy:      { price: Math.round(base * costMult),              time: diyTime,  canDo: canDIY, skillReq: diff, label: '🔧 GARAGE (DIY)' },
    mechanic: { price: Math.round(base * 2 * costMult * mechDisc), time: mechTime, canDo: true,   skillReq: 0,    label: '🏭 MECHANIC' },
    dealer:   { price: Math.round(base * 8 * costMult),          time: 0,        canDo: true,   skillReq: 0,    label: '🏪 DEALERSHIP' },
  };
}

/** Mod-eligibility filter. 1:1 with monolith getPartsLayout's per-
 *  item filter at L42523-L42559. Returns the subset of PARTS_SHOP
 *  the active car can actually be ordered against. */
export function filterAvailableParts(life: LifeState, car: CatalogCar | undefined): ShopPart[] {
  const out: ShopPart[] = [];
  for (const item of PARTS_SHOP) {
    if (item.stat === 'welded') {
      if (life.welded) continue;
      if (!car || car.isBike) continue;
    }
    if (item.stat === 'supercharged') {
      if (life.supercharged) continue;
      if (!car || car.isBike) continue;
      // Per-car supercharger eligibility (monolith CARS[id].gt4.canSC)
      // hasn't ported to modular CatalogCar yet — allow all non-bike
      // cars for now. The check returns when CatalogCar grows the
      // canSC field.
    }
    out.push(item);
  }
  return out;
}

/** Apply a part's effect to LIFE. Mirrors monolith applyPart at
 *  L42564-L42600 minus the transmission/steering swap branches.
 *  Stat fields are clamped to 100. */
export function applyPart(life: LifeState, part: ShopPart): void {
  if (part.stat === 'welded') {
    life.welded = true;
    return;
  }
  if (part.stat === 'supercharged') {
    life.supercharged = true;
    return;
  }
  if (part.stat === 'tires') {
    life.tires = Math.min(100, life.tires + part.add);
    return;
  }
  if (part.stat === 'engine') {
    life.engine = Math.min(100, life.engine + part.add);
    return;
  }
  if (part.stat === 'hp') {
    life.carHP = Math.min(100, life.carHP + part.add);
    return;
  }
  if (part.stat === 'all') {
    life.engine = Math.min(100, life.engine + part.add);
    life.tires = Math.min(100, life.tires + part.add);
    life.carHP = Math.min(100, life.carHP + part.add);
  }
}
