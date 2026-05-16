/**
 * Car catalog — derived at module init by iterating GT4_DB and pricing
 * each entry via calcGT4Price. Surfaces the (id, name, price,
 * modelYear, transType, drv) tuples the start-flow car picker and
 * future garage / shop screens need without porting the monolith's
 * runtime-mutating rebuildCarSpecs.
 *
 * IDs are slugified from the GT4 name via `lower + non-alphanum→_`,
 * matching the monolith's convention (so 'Honda CIVIC SiR-II (EG) `93'
 * → 'honda_civic_sir_ii__eg___93' and old saves migrate cleanly).
 *
 * INTENTIONALLY simpler than the monolith's CARS map (which carries
 * GT4_SPECS suspension / torque-curve / aero data alongside the basic
 * fields). Subsequent ports grow CatalogCar with those fields when the
 * physics body port needs them.
 */

import { GT4_DB } from './gt4Database';
import { calcGT4Price } from './pricing';

export interface CatalogCar {
  id: string;
  name: string;
  /** USD MSRP (or classic collector value for pre-1980). */
  price: number;
  hp: number;
  /** Curb weight in kg. */
  kg: number;
  /** 'FF' | 'FR' | 'MR' | 'RR' | '4WD'. */
  drv: string;
  /** 4-digit model year extracted from the name (1995 fallback). */
  modelYear: number;
  /** Manual transmission by default — derived from the GT4 gears count
   *  (a 6-speed sports car is almost always manual; a 4-speed compact
   *  is usually auto). Imperfect but consistent. */
  defaultManual: boolean;
  /** Right-hand drive flag. */
  rhd: boolean;
  /** Body color hex (from GT4_DB). */
  color: string;
  /** Motorcycle flag from GT4_DB (1=bike, 0=car). H81 surfaces this so
   *  downstream consumers can branch bike-specific tunings without
   *  guessing from the name. */
  isBike: boolean;
  /** Engine redline RPM. H81: 1:1 port of monolith fallback at L7341:
   *  bike (Harley ? 5500 : 13500); car (hp>300 ? 6200 : hp>200 ? 7000 : 7600).
   *  Cars with full GT4 torque-curve data use spec.redl; that path
   *  ports later when the torque-curve scaffold lands. */
  redline: number;
  /** Engine idle RPM. H81: 1:1 port of monolith fallback at L7343:
   *  bike (Harley ? 800 : 1200); car (hp>300 ? 700 : 800). */
  idleRPM: number;
  /** Catalog top speed in game units (wpx/sec; 1 wpx = 0.2056m, SCALE_MS
   *  = 4.864). H82: 1:1 port of monolith L7296-7311 with the no-spec
   *  fallback (dragCoeff=35, dragFactor≈0.9444). Drives the gauge
   *  cluster's speedometer dial max; arcadeUpdate's MAX_SPEED still
   *  caps actual player.pSpeed independently.
   *
   *  Formula: topKmh = bike ? (100 + hp*1.2)
   *                         : min(hp>500 ? 340 : 300,
   *                               (110 + hp*0.48) * dragFactor)
   *           topSpeed = topKmh / 3.6 * SCALE_MS
   *
   *  Per-car physTopSpeedCap (LIFE.gameplaySettings) is NOT applied here
   *  — the monolith rebuilds CARS when that knob changes; we'd need an
   *  equivalent rebuild trigger to port that path. */
  topSpeed: number;
}

/** SCALE_MS = 1 / 0.2056 — the monolith's m/s ↔ game-units factor,
 *  defined inline here so catalog can compute topSpeed without taking
 *  a dependency on gameLoop. Same value used at monolith L5802. */
const SCALE_MS = 4.864;

/** Slugify name → id. Matches the monolith convention exactly so saves
 *  with monolith-shape IDs continue to resolve. */
export function slugifyCarName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '_');
}

/** Extract model year from the name string. The monolith's
 *  getCarModelYear is duplicated here to avoid a cross-package cycle.
 *  Falls back to 1995 if no year token is found. */
function modelYearFromName(name: string): number {
  const mm = name.match(/`(\d{2})/);
  if (mm) {
    const yy = parseInt(mm[1], 10);
    return yy <= 30 ? 2000 + yy : 1900 + yy;
  }
  const m2 = name.match(/\b(19\d{2}|20\d{2})\b/);
  if (m2) return parseInt(m2[1], 10);
  return 1995;
}

/** Build the catalog map at module init. */
/** H81: compute redline + idleRPM from monolith L7338-7345 fallback
 *  (the GT4 torque-curve path takes precedence when spec.tc is available
 *  but that lookup is a separate scaffold). Pure function for clarity
 *  and testability. */
function computeRpmParams(
  name: string,
  hp: number,
  isBike: boolean,
): { redline: number; idleRPM: number } {
  const isHarley = isBike && name.includes('Harley');
  const redline = isBike
    ? (isHarley ? 5500 : 13500)
    : (hp > 300 ? 6200 : hp > 200 ? 7000 : 7600);
  const idleRPM = isBike
    ? (isHarley ? 800 : 1200)
    : (hp > 300 ? 700 : 800);
  return { redline, idleRPM };
}

/** H82: compute catalog top speed (game units) from monolith L7296-7311
 *  no-spec fallback. GT4_SPECS.wDrag isn't ported into the modular
 *  catalog yet, so dragCoeff defaults to 35 (the same `spec?spec.wDrag:35`
 *  fallback the monolith uses for cars without GT4 detail). LM bikes
 *  hit the 340 km/h cap; standard cars cap at 300 km/h. */
function computeTopSpeed(hp: number, isBike: boolean): number {
  const dragCoeff = 35;
  const dragFactor = 1.0 - ((dragCoeff - 23) / 54) * 0.25;
  const isLM = hp > 500;
  const physCap = 300;
  const lmCap = Math.max(physCap + 40, 340);
  const topKmh = isBike
    ? (100 + hp * 1.2)
    : Math.min(isLM ? lmCap : physCap, (110 + hp * 0.48) * dragFactor);
  const topMs = topKmh / 3.6;
  return topMs * SCALE_MS;
}

function buildCatalog(): { byId: Record<string, CatalogCar>; ids: string[] } {
  const byId: Record<string, CatalogCar> = {};
  const ids: string[] = [];
  for (const row of GT4_DB) {
    // GT4_DB tuple layout (matches monolith comment at L5895):
    //   [name, hp, kg, drv, _price, color, rhd, isBike, fuelDoor, gears]
    const [name, hp, kg, drv, , color, rhd, isBikeFlag, , gears] = row;
    const id = slugifyCarName(name);
    if (byId[id]) continue; // dedupe (some GT4 names collide post-slug)
    const isBike = isBikeFlag === 1;
    const { redline, idleRPM } = computeRpmParams(name, hp, isBike);
    const topSpeed = computeTopSpeed(hp, isBike);
    byId[id] = {
      id,
      name,
      price: calcGT4Price(name, hp, kg),
      hp,
      kg,
      drv,
      modelYear: modelYearFromName(name),
      defaultManual: gears >= 5,
      rhd: rhd === 1,
      color,
      isBike,
      redline,
      idleRPM,
      topSpeed,
    };
    ids.push(id);
  }
  return { byId, ids };
}

const { byId, ids } = buildCatalog();

/** Lookup map keyed by slug ID. */
export const CAR_CATALOG: Record<string, CatalogCar> = byId;
/** All catalog IDs (insertion order matches GT4_DB row order). */
export const ALL_CAR_IDS: readonly string[] = ids;
