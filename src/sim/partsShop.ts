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

import type { LifeState, PendingPart } from '@/state/life';
import type { CatalogCar } from '@/config/cars/catalog';
import type { Clock } from '@/state/clock';

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
  // H940: cap lowered 5.0 → 3.5 — at 5× even big jobs printed five-figure
  // bills on $300k+ cars. 3.5 keeps exotics meaningfully pricier without the
  // fantasy numbers; NSX (2.42×) is unaffected, only $250k+ cars were at cap.
  let mult = Math.max(0.6, Math.min(3.5, Math.sqrt(price / 15000)));
  if (isRace) mult *= 1.5;
  return mult;
}

/** Car-value multiplier DAMPED by the job's base cost (H940). A cheap
 *  CONSUMABLE (oil, pads, fluid, alignment) barely tracks car value in the
 *  real world — an NSX oil change is not 2.4× a Civic's — while a big LABOR
 *  job (engine/frame) tracks it fully. laborFactor ramps 0.45 at a $150
 *  consumable base → 1.0 at a $600+ major job, so the full sqrt-price curve
 *  only applies where it's realistic. Used by repairs, parts, and the
 *  handling upgrade kinds. */
export function getEffCostMult(car: CatalogCar | undefined, baseCost: number): number {
  const full = getCarCostMult(car);
  const laborFactor = Math.max(0.45, Math.min(1.0, 0.45 + ((baseCost - 150) / 450) * 0.55));
  return 1 + (full - 1) * laborFactor;
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
  // H940: damp the car-value multiplier by base cost (consumables barely
  // track car value), and cut the DEALER markup ×8 → ×3 (a real 1999 dealer
  // is ~2-2.5× an indie, not 8×). $12k per-order ceiling guards outliers.
  const effMult = getEffCostMult(car, base);
  const skillBoost = getCarSkillBoost(car);
  const diff = Math.min(100, part.diff + skillBoost);
  const canDIY = (life.mechSkill ?? 0) >= diff;
  const diyTime = part.type === 'diy' ? 0 : part.type === 'delivery' ? part.days : part.days + 1;
  const mechTime = Math.max(1, part.days);
  const mechDisc = life.mechanicDiscount ? 0.9 : 1.0;
  const cap = (p: number) => Math.min(12000, Math.round(p));
  return {
    diy:      { price: cap(base * effMult),                  time: diyTime,  canDo: canDIY, skillReq: diff, label: '🔧 GARAGE (DIY)' },
    mechanic: { price: cap(base * 2 * effMult * mechDisc),   time: mechTime, canDo: true,   skillReq: 0,    label: '🏭 MECHANIC' },
    dealer:   { price: cap(base * 3 * effMult),              time: 0,        canDo: true,   skillReq: 0,    label: '🏪 DEALERSHIP' },
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

/** H865: order a part at a chosen venue, now respecting the venue's LEAD
 *  TIME. When the venue is instant (in-stock DIY / dealer, time<=0) or the
 *  part is a flag-mod (welded/supercharged, no stat target), it applies
 *  straight to the active car as before. Otherwise it QUEUES a PendingPart
 *  with readyDay = clock.day + venue.time; tickPendingParts applies the stat
 *  bump on the day it's ready (sleep to advance). This is the "can you order
 *  the parts in time?" axis. Caller has already charged + checked cash.
 *
 *  H865 NOTE: queued parts apply to the car on completion (isDelivery:false);
 *  the DIY-delivery→inventory→install-costs-a-slot split lands in the slot
 *  commit. Returns whether it queued + the readyDay for the notif. */
export function orderPart(
  life: LifeState,
  clock: Clock,
  part: ShopPart,
  venue: VenueOption,
  isDIY: boolean,
): { queued: boolean; readyDay: number } {
  // DIY install gives a small skill bump (monolith installOwnedPart L48721).
  if (isDIY) life.mechSkill = Math.min(100, (life.mechSkill ?? 0) + 1);
  const isFlagMod = part.stat === 'welded' || part.stat === 'supercharged';
  if (venue.time <= 0 || isFlagMod) {
    applyPart(life, part);
    return { queued: false, readyDay: clock.day };
  }
  const readyDay = clock.day + venue.time;
  life.pendingParts.push({
    id: `part_${part.name.replace(/\s+/g, '_')}_${clock.day}_${life.pendingParts.length}`,
    name: part.name,
    // After the flag-mod guard, part.stat is a condition stat (engine/tires/
    // hp/all) — all members of RepairStat.
    stat: part.stat as PendingPart['stat'],
    add: part.add,
    readyDay,
    venue: isDIY ? 'diy' : 'mechanic',
    isDelivery: false,
    carId: life.ownedCars[0] ?? '',
  });
  return { queued: true, readyDay };
}
