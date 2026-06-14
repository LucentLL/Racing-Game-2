/**
 * Upgrade headroom model — H874.
 *
 * The catalog's car.hp / car.kg are FACTORY STOCK values (proven 13/13
 * against real specs; see memory project_upgrade_headroom). This module
 * supplies the OTHER end of the tuning ladder — the realistic fully-built
 * "Stage 4" street ceiling — so upgrades can interpolate stock → built.
 *
 * Strategy (user-chosen 2026-06-14): a bucket MULTIPLIER keyed on
 * aspiration + displacement covers all ~380 cars, with absolute-HP
 * OVERRIDES for the famous strong-block tuner platforms whose ceilings
 * are well-known and roughly engine-limited (a 13B-REW tops ~500 crank
 * whether it started at 255 or 280; a 2JZ ~700; an RB26 ~560). Calibrated
 * to the 13-car research sample — icons land exact, the long tail ±~10%.
 *
 * Power tiers are FRONT-LOADED (Stage 1 = the turbo/SC = the biggest jump,
 * matching real forced-induction tuning + GT2's Protégé 109→164 Stage 1);
 * weight tiers are linear. Pure module — nothing wires it yet.
 */

import type { CatalogCar } from '@/config/cars/catalog';
import { makeEffectiveCar } from '@/config/cars/catalog';
import { GT4_SPECS } from '@/config/cars/gt4Database';
import type { LifeState } from '@/state/life';

export interface UpgradeHeadroom {
  /** Factory stock crank HP (= car.hp). */
  stockHp: number;
  /** Realistic fully-built streetable crank HP ceiling. */
  builtHp: number;
  /** Factory stock weight, kg (= car.kg). */
  stockKg: number;
  /** Realistic minimum weight after streetable reduction, kg. */
  minKg: number;
}

/** Absolute built-HP ceilings for famous platforms whose street limit is
 *  roughly engine-bound (not a clean multiple of stock). First match wins,
 *  so list more-specific tests before broader ones. */
interface Override {
  test: (name: string, year: number) => boolean;
  builtHp: number;
}
const PLATFORM_OVERRIDES: readonly Override[] = [
  // 2JZ-GTE — A80 twin-turbo Supra is the headline ceiling; A70 (7M/older
  // 2JZ) is far less.
  { test: (n, y) => n.includes('Supra') && y >= 1993, builtHp: 700 },
  { test: (n, y) => n.includes('Supra') && y < 1993, builtHp: 450 },
  // RB26DETT — NISMO R-tune already runs bigger turbos, so a higher ceiling
  // than the base 280 PS GT-R. Test the tuned variant first.
  { test: (n) => n.includes('Skyline') && n.includes('R-tune'), builtHp: 640 },
  { test: (n) => n.includes('Skyline') && n.includes('GT-R'), builtHp: 560 },
  // 13B-REW (FD) vs 13B-T (FC).
  { test: (n) => n.includes('RX-7') && n.includes('(FD'), builtHp: 500 },
  { test: (n) => n.includes('RX-7') && n.includes('(FC'), builtHp: 380 },
  // 4G63 / EJ20 — the rally strong-blocks.
  { test: (n) => n.includes('Lancer Evolution'), builtHp: 470 },
  { test: (n) => n.includes('Impreza') && /WRX|ST[iI]|Rally|22B/.test(n), builtHp: 450 },
  // High-rev Honda NA + SR20DET drift platforms.
  { test: (n) => n.includes('S2000'), builtHp: 430 },
  { test: (n) => /Silvia|180SX|200SX|240SX/.test(n), builtHp: 400 },
  // NA exotics — supercharger / NA build ceilings.
  { test: (n) => n.includes('NSX'), builtHp: 410 },
  { test: (n) => n.includes('Corvette') && n.includes('ZR-1'), builtHp: 500 },
  // Light turbo-able NA roadster — tiny base, ~doubles on a stock-block turbo.
  { test: (n) => /MX-5|Miata/.test(n), builtHp: 290 },
];

function parseDispCc(spec: { disp?: string } | undefined): number {
  if (!spec?.disp) return 0;
  const m = /(\d+)\s*cc/i.exec(spec.disp);
  return m ? parseInt(m[1], 10) : 0;
}

/** Fallback built-HP multiplier when no platform override applies. Keyed on
 *  aspiration (the dominant predictor) + displacement. */
function bucketMult(asp: string, dispCc: number, isRace: boolean, isBike: boolean): number {
  if (isRace) return 1.18;            // already a built race car
  if (isBike) return 1.5;
  if (asp === 'TURBO') return 1.7;    // factory turbo — upgrade the turbo (Audi S4 ✓)
  if (asp === 'SuperCharger') return 1.45;
  // NA: small-displacement engines turbo well and ~double; big NA V8s /
  // exotics gain far less (NA build + maybe a blower).
  if (dispCc > 0 && dispCc < 2500) return 1.9;
  return 1.4;
}

/** Streetable weight-reduction floor multiplier — lighter cars strip down
 *  proportionally more; heavy AWD/exotics less. Matches the ~8-17% sample. */
function weightCutMult(stockKg: number): number {
  if (stockKg < 1100) return 0.84;
  if (stockKg < 1500) return 0.88;
  return 0.91;
}

/** Compute the stock + built endpoints for a car. builtHp is always ≥ stock;
 *  minKg always ≤ stock. */
export function getUpgradeHeadroom(car: CatalogCar): UpgradeHeadroom {
  const stockHp = car.hp;
  const stockKg = car.kg;
  const spec = GT4_SPECS[car.name];
  const asp = spec?.asp ?? 'NA';
  const dispCc = parseDispCc(spec);
  const isRace = car.name.includes('Race Car');
  const isBike = !!car.isBike;

  const override = PLATFORM_OVERRIDES.find((o) => o.test(car.name, car.modelYear));
  const builtHp = Math.max(
    stockHp,
    Math.round(override ? override.builtHp : stockHp * bucketMult(asp, dispCc, isRace, isBike)),
  );
  const minKg = Math.min(stockKg, Math.round(stockKg * weightCutMult(stockKg)));
  return { stockHp, builtHp, stockKg, minKg };
}

/** Cumulative fraction of the stock→built HP headroom unlocked at each
 *  stage. FRONT-LOADED: Stage 1 (the turbo/SC) is the biggest single jump. */
export const POWER_STAGE_FRAC: readonly number[] = [0, 0.45, 0.70, 0.88, 1.0];
/** Weight reduction is roughly linear across the four stages. */
export const WEIGHT_STAGE_FRAC: readonly number[] = [0, 0.25, 0.5, 0.75, 1.0];

/** Effective HP at a given power-upgrade stage (0..4). */
export function powerAtStage(stockHp: number, builtHp: number, stage: number): number {
  const f = POWER_STAGE_FRAC[Math.max(0, Math.min(4, stage))];
  return Math.round(stockHp + (builtHp - stockHp) * f);
}

/** Effective weight (kg) at a given weight-reduction stage (0..4). */
export function weightAtStage(stockKg: number, minKg: number, stage: number): number {
  const f = WEIGHT_STAGE_FRAC[Math.max(0, Math.min(4, stage))];
  return Math.round(stockKg - (stockKg - minKg) * f);
}

// ---- Per-car upgrade state (H875) ------------------------------------------

/** Upgrade category kinds. H879+: handling categories extend the original
 *  power/weight spec axes. */
export type UpgradeKind = 'power' | 'weight' | 'brakes' | 'suspension';

/** Upgrade stages (0-4) per category for one car. */
export interface CarUpgradeLevels {
  power: number;
  weight: number;
  brakes: number;
  suspension: number;
}

/** The categories the UPGRADE screen surfaces, in display order. */
export const UPGRADE_CATEGORIES: ReadonlyArray<{ kind: UpgradeKind; label: string }> = [
  { kind: 'power', label: 'POWER' },
  { kind: 'weight', label: 'WEIGHT' },
  { kind: 'brakes', label: 'BRAKES' },
  { kind: 'suspension', label: 'SUSPENSION' },
];

function clampStage(v: number | undefined): number {
  if (typeof v !== 'number' || !isFinite(v)) return 0;
  return Math.max(0, Math.min(4, Math.round(v)));
}

/** Read a car's upgrade stages off life.carUpgrades (absent → all stage 0).
 *  Back-compat: old saves have no carUpgrades map / no handling fields. */
export function getCarUpgrades(life: LifeState | null | undefined, carId: string): CarUpgradeLevels {
  const u = life?.carUpgrades?.[carId];
  return {
    power: clampStage(u?.power), weight: clampStage(u?.weight),
    brakes: clampStage(u?.brakes), suspension: clampStage(u?.suspension),
  };
}

/** Set one upgrade category for a car, creating the map/entry as needed. */
export function setCarUpgrade(
  life: LifeState,
  carId: string,
  kind: UpgradeKind,
  stage: number,
): void {
  if (!life.carUpgrades) life.carUpgrades = {};
  const cur = life.carUpgrades[carId] ?? { power: 0, weight: 0, brakes: 0, suspension: 0 };
  life.carUpgrades[carId] = { ...cur, [kind]: clampStage(stage) };
}

/** H879: brakes upgrade — multiplies the car's brake deceleration. A full
 *  build (pads + fluid → slotted rotors → big-brake kit → race calipers)
 *  reaches ~+45% over stock; front-loaded so the first stage (pads/fluid)
 *  gives the biggest single gain. Returns a multiplier on brakePower. */
const BUILT_BRAKE_MULT = 1.45;
export const BRAKE_STAGE_FRAC: readonly number[] = [0, 0.4, 0.65, 0.85, 1.0];
export function brakeStageMult(stage: number): number {
  return 1 + (BUILT_BRAKE_MULT - 1) * BRAKE_STAGE_FRAC[Math.max(0, Math.min(4, stage))];
}
/** Full braking gain at max stage, as a percentage (for UI display). */
export const BRAKE_MAX_PCT = Math.round((BUILT_BRAKE_MULT - 1) * 100);

/** H882: suspension upgrade — sharpens turn-in. A full build (lowering
 *  springs → sports dampers → coilovers → race coilovers + bushings) reaches
 *  ~+25% turn rate; front-loaded. Returns a direct multiplier on the car's
 *  computed turn rate (applied after the stock susp clamp so stages stay
 *  progressive). */
const BUILT_SUSP_MULT = 1.25;
export const SUSP_STAGE_FRAC: readonly number[] = [0, 0.45, 0.7, 0.88, 1.0];
export function suspTurnBonus(stage: number): number {
  return 1 + (BUILT_SUSP_MULT - 1) * SUSP_STAGE_FRAC[Math.max(0, Math.min(4, stage))];
}
/** Full turn-in gain at max stage, as a percentage (for UI display). */
export const SUSP_MAX_PCT = Math.round((BUILT_SUSP_MULT - 1) * 100);

/** Memoized: an unchanged (carId, power, weight) returns the same object so
 *  the per-frame physics path doesn't reallocate. Catalog is static, so the
 *  cache never needs invalidation. */
const _effCache = new Map<string, CatalogCar>();

/** The car as it actually performs at its current upgrade stages — feeds the
 *  physics + the SPECS screen. All-stage-0 returns the base car untouched. */
export function getEffectiveCar(car: CatalogCar, up: CarUpgradeLevels): CatalogCar {
  if (up.power === 0 && up.weight === 0 && up.brakes === 0 && up.suspension === 0) return car;
  const key = `${car.id}:${up.power}:${up.weight}:${up.brakes}:${up.suspension}`;
  const hit = _effCache.get(key);
  if (hit) return hit;
  const h = getUpgradeHeadroom(car);
  const effHp = powerAtStage(h.stockHp, h.builtHp, up.power);
  const effKg = weightAtStage(h.stockKg, h.minKg, up.weight);
  let eff = makeEffectiveCar(car, effHp, effKg);
  // H879: brakes scale the (already power/weight-derived) brake deceleration.
  if (up.brakes > 0) {
    eff = { ...eff, brakePower: eff.brakePower * brakeStageMult(up.brakes) };
  }
  // H882: suspension carries a turn-rate bonus the physics adapter applies.
  if (up.suspension > 0) {
    eff = { ...eff, suspTurnBonus: suspTurnBonus(up.suspension) };
  }
  _effCache.set(key, eff);
  return eff;
}
