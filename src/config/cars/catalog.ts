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

import { GT4_DB, GT4_SPECS, type GT4Spec } from './gt4Database';
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
  /** Engine redline RPM. H81/H103: 1:1 port of monolith L7330/L7341.
   *  Cars with valid spec.tc (≥3 points) use spec.redl||7000; cars
   *  without (most bikes, some edge cases) fall back to the tiered
   *  formula: bike (Harley ? 5500 : 13500); car (hp>300 ? 6200 :
   *  hp>200 ? 7000 : 7600). */
  redline: number;
  /** Engine idle RPM. H81/H103: 1:1 port of monolith L7332/L7343.
   *  GT4 path: max(500, tcStartRpm - 300) — idle sits 300 RPM below
   *  the first torque-curve sample. Fallback: bike (Harley ? 800 :
   *  1200); car (hp>300 ? 700 : 800). */
  idleRPM: number;
  /** H105 torque-curve RPM points, decoded + sorted ascending. Empty
   *  array when the car has no GT4_SPECS entry (interp falls back to
   *  a constant 0.75 multiplier matching monolith getTorqueAtRPM
   *  L6801's no-curve return). Paired index-by-index with tcNorm. */
  tcRPMs: readonly number[];
  /** H105 normalized torque values at each tcRPMs point, scaled so
   *  the curve's peak = 1.0. 1:1 port of monolith L7327-7329:
   *    const rawVals = pairs.map(p => p[1]);
   *    const peak    = Math.max(...rawVals);
   *    tcNorm        = rawVals.map(v => v / peak);
   *  Empty array when the car has no GT4_SPECS entry. */
  tcNorm: readonly number[];
  /** Catalog top speed in game units (wpx/sec; 1 wpx = 0.2056m, SCALE_MS
   *  = 4.864). H82/H102: 1:1 port of monolith L7296-7311. H102 wired
   *  real per-car GT4_SPECS.wDrag into the drag-spread; cars missing
   *  a GT4_SPECS entry still fall back to the original dragCoeff=35
   *  default. Drives the gauge cluster's speedometer dial max;
   *  arcadeUpdate's MAX_SPEED still caps actual player.pSpeed
   *  independently.
   *
   *  Formula: topKmh = bike ? (100 + hp*1.2)
   *                         : min(hp>500 ? 340 : 300,
   *                               (110 + hp*0.48) * dragFactor)
   *           dragFactor = 1 - (wDrag-23)/54 * 0.25    // 23→1.0, 50→0.75
   *           topSpeed = topKmh / 3.6 * SCALE_MS
   *
   *  Per-car physTopSpeedCap (LIFE.gameplaySettings) is NOT applied here
   *  — the monolith rebuilds CARS when that knob changes; we'd need an
   *  equivalent rebuild trigger to port that path. */
  topSpeed: number;
  /** Number of forward gears (1-based count). Surfaces GT4_DB[9] verbatim;
   *  falls back to 5 when the row's gears entry is missing (same `gears||5`
   *  default the monolith uses at L7312). */
  gears: number;
  /** Per-gear upper-bound speeds in game units. gearSpeeds[0] = 0 (reverse
   *  / pre-1st sentinel), gearSpeeds[g] = topSpeed × GEAR_PATTERNS[gears][g-1].
   *  Length is gears+1. H83: 1:1 port of monolith L7312-7315 — the
   *  bracket lookup at L26388-26391 walks this array to pick pGear from
   *  absolute speed, which is how the canvas cluster knows which gear to
   *  display under automatic transmission. */
  gearSpeeds: number[];
  /** H108 engine-brake deceleration in wpx/s². 1:1 port of monolith
   *  L7365-7366: `engineBrk = (spec?.eBrk ?? round(80 + kg*0.05)) / 90
   *  * SCALE_MS`. Engine compression braking when the throttle is
   *  released — speed-independent constant per car. */
  engineBrake: number;
  /** H108 rolling tire friction in wpx/s². 1:1 port of monolith
   *  L7401/L7483: `rollingResist = isBike ? 0.5 : (0.6 + kg*0.0002 +
   *  (tireHtAvg - 600) * 0.0003); rollingFriction = rollingResist *
   *  SCALE_MS * 0.3`. The 0.3 factor (v8.98 retune) matches real-world
   *  tire rolling resistance. Speed-independent constant. */
  rollingFriction: number;
  /** H108 aero drag coefficient in wpx⁻¹. 1:1 port of monolith
   *  L7374-7376: `widthDragMult = (spec?.wid ?? 1500) / 1500; aeroFact
   *  = isBike ? 0.00025 : max(0.00006, dragCoeff/100000 * widthDragMult)`.
   *  Multiplied by pSpeed² in the coast branch — quadratic with speed
   *  matching real aero drag (~1.2 m/s² at 100 km/h, ~3 m/s² at 160
   *  km/h per the monolith comment). */
  aeroFactor: number;
}

/** GEAR_PATTERNS: fraction-of-top-speed at the *end* of each gear (i.e.
 *  the shift-up point). 1:1 port of monolith L6773-6778. Indexed by
 *  number of forward gears. Most catalog cars are 4/5/6-speed; truck
 *  rows that GT4_DB encodes as 7-speed land in the 7 row. */
const GEAR_PATTERNS: Record<number, readonly number[]> = {
  4: [0.25, 0.45, 0.70, 1.0],
  5: [0.20, 0.35, 0.53, 0.76, 1.0],
  6: [0.17, 0.28, 0.42, 0.58, 0.78, 1.0],
  7: [0.15, 0.24, 0.35, 0.48, 0.63, 0.80, 1.0],
};

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

/** H103/H105: decode a GT4 torque-curve array into separate RPM /
 *  torque arrays. 1:1 port of monolith decodeTC at L6783-6794 + the
 *  normalization at L7327-7329. Accepts two formats:
 *    Uniform: [startRPM, stepRPM, v1, v2, ...]   (first two are numbers)
 *    Pairs:   [[rpm, torque], [rpm, torque], ...]
 *  Returns { rpms, norms } where norms is scaled so peak = 1.0, or
 *  null when the curve is too short (<3 points) or doesn't match
 *  either shape. */
function decodeTorqueCurve(
  tc: GT4Spec['tc'],
): { rpms: readonly number[]; norms: readonly number[] } | null {
  if (tc.length < 3) return null;
  const pairs: [number, number][] = [];
  const first = tc[0];
  if (typeof first === 'number' && typeof tc[1] === 'number') {
    // Uniform: [startRPM, stepRPM, v1, v2, ...]
    const start = first;
    const step = tc[1] as number;
    for (let i = 2; i < tc.length; i++) {
      const v = tc[i];
      if (typeof v !== 'number') return null;
      pairs.push([start + (i - 2) * step, v]);
    }
  } else if (Array.isArray(first) && typeof first[0] === 'number') {
    // Pairs format.
    for (const p of tc) {
      if (!Array.isArray(p)) return null;
      pairs.push([p[0], p[1]]);
    }
  } else {
    return null;
  }
  if (pairs.length < 2) return null;
  const peak = Math.max(...pairs.map(p => p[1]));
  if (peak <= 0) return null;
  return {
    rpms: pairs.map(p => p[0]),
    norms: pairs.map(p => p[1] / peak),
  };
}

/** Build the catalog map at module init. */
/** H81/H103: compute redline + idleRPM. The monolith's L7320-7344
 *  branches on whether spec.tc decodes to a usable curve:
 *    GT4 path:   carRedline = spec.redl || 7000
 *                carIdleRPM = max(500, tcStartRpm - 300)
 *    Fallback:   bike (Harley ? 5500 : 13500) / car (hp>300 ? 6200 :
 *                hp>200 ? 7000 : 7600) for redline
 *                bike (Harley ? 800 : 1200) / car (hp>300 ? 700 :
 *                800) for idle
 *  H103 wires the GT4 path now that GT4_SPECS is imported (H102).
 *  Cars with full torque-curve data get their real spec'd values;
 *  bikes + edge cases without spec.tc keep H81's tiered formulas. */
function computeRpmParams(
  name: string,
  hp: number,
  isBike: boolean,
  decoded: { rpms: readonly number[]; norms: readonly number[] } | null,
): { redline: number; idleRPM: number } {
  const spec = GT4_SPECS[name];
  if (spec && decoded) {
    return {
      redline: spec.redl || 7000,
      idleRPM: Math.max(500, decoded.rpms[0] - 300),
    };
  }
  const isHarley = isBike && name.includes('Harley');
  const redline = isBike
    ? (isHarley ? 5500 : 13500)
    : (hp > 300 ? 6200 : hp > 200 ? 7000 : 7600);
  const idleRPM = isBike
    ? (isHarley ? 800 : 1200)
    : (hp > 300 ? 700 : 800);
  return { redline, idleRPM };
}

/** H108: compute the three coast-branch drag forces for one car. 1:1
 *  port of monolith L7365-7366 (engine brake), L7374-7376 (aero), and
 *  L7401/L7483 (rolling friction). All three sum in arcadeUpdate's
 *  coast branch:
 *    drag = engineBrake + rollingFriction + aeroFactor × pSpeed²
 *  Constants stay constant per car; aero scales quadratically with
 *  speed (slow cars barely feel it, fast cars get dominated by it). */
function computeCoastDrag(
  name: string,
  kg: number,
  isBike: boolean,
): { engineBrake: number; rollingFriction: number; aeroFactor: number } {
  const spec = GT4_SPECS[name];
  const eBrkGT4 = spec?.eBrk ?? Math.round(80 + kg * 0.05);
  const engineBrake = (eBrkGT4 / 90) * SCALE_MS;
  const tireHtF = spec?.thF ?? 630;
  const tireHtR = spec?.thR ?? 630;
  const tireHtAvg = (tireHtF + tireHtR) / 2;
  const rollingResist = isBike
    ? 0.5
    : (0.6 + kg * 0.0002 + (tireHtAvg - 600) * 0.0003);
  const rollingFriction = rollingResist * SCALE_MS * 0.3;
  const chassisW = spec?.wid ?? 1500;
  const widthDragMult = chassisW / 1500;
  const dragCoeff = spec?.wDrag ?? 35;
  const aeroFactor = isBike
    ? 0.00025
    : Math.max(0.00006, (dragCoeff / 100000) * widthDragMult);
  return { engineBrake, rollingFriction, aeroFactor };
}

/** H82/H102: compute catalog top speed (game units) from monolith L7296-
 *  7311. H102 wires the real per-car GT4_SPECS.wDrag value into the
 *  drag-spread calculation — supercars (wDrag ≈ 23) get a 1.0× drag
 *  multiplier and hit the physCap; boxy bricks (wDrag ≈ 50) get 0.75×
 *  and top out well below cap. Cars without a GT4_SPECS entry fall
 *  back to the same `spec?spec.wDrag:35` default the monolith uses,
 *  preserving the H82 behavior verbatim for legacy / catalog-only
 *  entries. */
function computeTopSpeed(name: string, hp: number, isBike: boolean): number {
  const spec = GT4_SPECS[name];
  const dragCoeff = spec?.wDrag ?? 35;
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

/** H83: build per-gear upper-bound speeds for a car. Monolith L7312-7315:
 *    const gc = gears || 5;
 *    const pattern = GEAR_PATTERNS[gc] || GEAR_PATTERNS[5];
 *    const gs = [0];
 *    for (let g=0; g<gc; g++) gs.push(topSpeed * pattern[g]);
 *  Returns length gc+1 (index 0 is the reverse / pre-1st sentinel). */
function computeGearSpeeds(topSpeed: number, gears: number): number[] {
  const pattern = GEAR_PATTERNS[gears] ?? GEAR_PATTERNS[5];
  const gs: number[] = [0];
  for (let g = 0; g < gears; g++) gs.push(topSpeed * pattern[g]);
  return gs;
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
    const decoded = GT4_SPECS[name] ? decodeTorqueCurve(GT4_SPECS[name].tc) : null;
    const { redline, idleRPM } = computeRpmParams(name, hp, isBike, decoded);
    const topSpeed = computeTopSpeed(name, hp, isBike);
    const gc = gears || 5;
    const gearSpeeds = computeGearSpeeds(topSpeed, gc);
    const drag = computeCoastDrag(name, kg, isBike);
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
      gears: gc,
      gearSpeeds,
      tcRPMs: decoded?.rpms ?? [],
      tcNorm: decoded?.norms ?? [],
      engineBrake: drag.engineBrake,
      rollingFriction: drag.rollingFriction,
      aeroFactor: drag.aeroFactor,
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
