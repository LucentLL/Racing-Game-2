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
import { GT4_SPECS } from '@/config/cars/gt4Database';

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
