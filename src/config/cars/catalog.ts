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
import { classifyCarOrigin, type CatalogCarOrigin } from './origin';
import { SCALE_MS } from '@/physics/physicsUnits';
import { WPX_PER_MM } from '@/config/world/tiles';

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
  /** H150: body footprint in game units (1 game-unit ≈ 0.222 m). Derived
   *  from GT4_SPECS.lng × spec.wid (mm) divided by ~222.2 to land on
   *  the monolith's 4.5 gu/m convention (TRAFFIC_BODY_SIZES at
   *  drawTopCar.ts L59+ uses the same ratio — sedan = 5017×1854 mm =
   *  22.6×8.34 gu). Cars without a GT4_SPECS entry fall back to
   *  [22, 8] car / [14, 5] bike — the H146 V2_PLAYER_SIZE placeholder
   *  ratio that everything sized at before this port. drawPlayerCarV2
   *  reads this; drawTopCar's TRAFFIC_BODY_SIZES table handles traffic
   *  per-bodyType separately. */
  size: readonly [number, number];
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
  /** H857: raw GT4 engine-type string (e.g. 'V8 (OHV)', 'L6 (DOHC)',
   *  'V12 (DOHC)', 'Rotor2 (Rotary)') from GT4_SPECS.eType. '' when the
   *  car has no GT4 entry. Drives data-accurate engine AUDIO voicing
   *  (proceduralEngine.classifyEngine) instead of guessing from the name. */
  eType: string;
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
  /** H109 brake-pedal deceleration in wpx/s². 1:1 port of monolith
   *  L7481: `brakePower = (isBike ? 6+pwr*4 : 8+pwr*5) * SCALE_MS`
   *  where pwr = hp/kg. Real-world braking maxes around 1g (~9.8
   *  m/s² ≈ 47 wpx/s² at SCALE_MS=4.864); the formula keeps cars in
   *  that range with high power-to-weight sports cars (pwr~0.3)
   *  reaching ~48 wpx/s² and economy cars (pwr~0.1) around 41. Much
   *  less than the H6 BRAKE_DECEL=240 (~5g — fantasy braking). */
  brakePower: number;
  /** H534: brand-region tag derived from the car name via
   *  [[classifyCarOrigin]]. One of seven values
   *  (jpn/usa/ita/fra/ger/gbr/eur). Drives the pause-menu STATUS
   *  origin flag, the wear-fault FAULT_POOLS pool selection, and
   *  the seller-visit USED_FAULTS pool. The four sub-European tags
   *  (ita/fra/ger/gbr) fall through to FAULT_POOLS.jpn at lookup
   *  time — that monolith quirk is preserved by the
   *  `origin in FAULT_POOLS` check in [[diagnoseFault]]. */
  origin: CatalogCarOrigin;
  /** H882: optional turn-rate multiplier from a SUSPENSION upgrade. Set only
   *  on the effective car (getEffectiveCar); absent/1.0 on stock catalog
   *  entries. computeCarTurnRate multiplies its result by this. */
  suspTurnBonus?: number;
  /** H883: optional grip (mu) multiplier from a TIRES upgrade. Set only on the
   *  effective car; the Phase 0B adapter folds it into gripMult. */
  gripBonus?: number;
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

// H483: SCALE_MS imported from the canonical physicsUnits module.
// (Was duplicated inline here; the value is the same — single source
// of truth now lives in physics/physicsUnits.ts.)

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

/** H109: compute the brake-pedal deceleration for one car. 1:1 port
 *  of monolith L7481: `brakePower = (isBike ? 6+pwr*4 : 8+pwr*5) *
 *  SCALE_MS` where pwr = hp/kg. Higher power-to-weight = better
 *  brakes (real-world correlation — sports cars have bigger calipers
 *  and stickier tires). */
function computeBrakePower(hp: number, kg: number, isBike: boolean): number {
  const pwr = hp / Math.max(1, kg);
  const decelMs = isBike ? 6 + pwr * 4 : 8 + pwr * 5;
  return decelMs * SCALE_MS;
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

/** H805: game-units / mm ratio — now the ROAD-TRUE world scale
 *  (config/world/tiles.ts WPX_PER_MM, ≈ 1/159.4). The monolith's
 *  ~4.5 gu/m convention (mm / 222.22) sized every car at only 72% of
 *  the road network's scale — a 1.92 m Viper filled 38% of a 12-ft
 *  lane where the real ratio is ~52% (user-reported, drive-observed).
 *  Deliberate deviation from monolith parity, per user direction:
 *  all world dimensions share one scale. */
const GU_PER_MM = WPX_PER_MM;

/** H150: derive per-car [length, width] in game units from GT4_SPECS.
 *  Falls back to generic-sedan mm (4800×1800) for cars without a spec
 *  (rare — most catalog cars have GT4 data) and real motorcycle mm
 *  (2200×800) for bikes, since GT4_SPECS' lng/wid for motorcycles
 *  isn't always populated. (H805: fallbacks restated in mm so they
 *  ride the world-scale constant instead of baking a ratio.) */
function computeCarSize(name: string, isBike: boolean): readonly [number, number] {
  const spec = GT4_SPECS[name];
  if (spec && spec.lng > 0 && spec.wid > 0) {
    return [spec.lng * GU_PER_MM, spec.wid * GU_PER_MM] as const;
  }
  return isBike
    ? ([2200 * GU_PER_MM, 800 * GU_PER_MM] as const)
    : ([4800 * GU_PER_MM, 1800 * GU_PER_MM] as const);
}

/** Real-world top-speed overrides (km/h) for vehicles that are NOT genuine
 *  Gran Turismo 4 entries. GT4 shipped no trucks / vans / ambulances / police
 *  cars and no motorcycles, so [[computeTopSpeed]]'s sports-car formula
 *  (`110 + hp*0.48`, drag-scaled) badly inflates them — the 475 hp Semi Truck
 *  computed to ~280 km/h (174 mph), which then drove a 200 mph speedometer
 *  dial (the dial max is `ceil(topSpeed*1.10)`). When a vehicle is listed
 *  here, computeTopSpeed returns this value verbatim (converted to wpx/s) and
 *  skips the formula; genuine GT4 cars are absent and keep the formula.
 *
 *  Values are unladen / bobtail mechanical top speeds, web-researched against
 *  each row's real-world equivalent (named in the GT4_SPECS comments):
 *    Ambulance / Box Truck — Ford E-450 (6.8L V10 / 7.3L V8), brick aero ~90 mph
 *    Tow Truck             — Ford F-550 7.3L V8, ~100 mph
 *    Semi Truck            — Peterbilt 379 / Cat C15, bobtail ~90 mph
 *    Police Cruiser        — Ford Crown Victoria P71, ~130 mph (limited)
 *    Motorcycles           — per-model real top speed; the power-linear bike
 *                            formula under-rates light high-revving sportbikes
 *
 *  Keyed by the exact GT4_DB name string. The override is name-based, so an
 *  HP-upgraded work vehicle keeps its real top speed — correct, since a
 *  diesel rig's top end is gearing-limited, not power-limited. */
export const NON_GT4_TOP_KMH: Readonly<Record<string, number>> = {
  // Work / special vehicles
  'Ambulance': 145,
  'Tow Truck': 161,
  'Police Cruiser': 209,
  'Semi Truck': 145,
  'Box Truck': 145,
  // Motorcycles (GT4 had no bikes)
  'Kawasaki Ninja 250': 160,
  'Suzuki Katana': 205,
  'Honda CB500': 180,
  'Suzuki Bandit 400': 180,
  'Kawasaki Ninja ZX-6R': 262,
  'Harley-Davidson Fat Boy `96': 180,
  'Harley-Davidson Dyna Wide Glide `96': 180,
  'Harley-Davidson Road Glide `98': 175,
  'Harley-Davidson Road King `97': 175,
};

/** H1161: acceleration multipliers for the same non-GT4 vehicles —
 *  companion table to NON_GT4_TOP_KMH (same exact-name keying, same
 *  rationale: the linear tqPerKg×200×revResponse model breaks down for
 *  them). Work trucks' authored fwI (130-200) and pIR (280-450) peg
 *  combinedRevResponse at its 0.6 floor and the model has no deep-gear
 *  recovery, so an Ambulance measured 30.6s 0-100 km/h vs ~12s real;
 *  Harleys' hp/kg×18 bike branch under-rates low-hp high-torque
 *  cruisers. Values calibrated through the exact live accel chain
 *  against real-world anchors:
 *    Ambulance 30.6s→12.1s · Box 28.4s→15.0s · Tow 18.3s→13.0s ·
 *    Cruiser 10.6s→7.0s · Harleys 8.6-10.1s→6.5-7.1s
 *  Semi Truck is deliberately ABSENT: the linear model already
 *  over-rates its 1650 lb-ft (8.3s bobtail vs ~15-20s real) — the user
 *  asked for improvement, not a nerf; revisit with the trucking-job
 *  feel pass. Sport bikes measure believable already (Ninja 250 6.9s,
 *  ZX-6R 2.6s) — lookup miss = ×1. Applied in gameLoop's
 *  _arcadeAccelTerm AND sim/race.ts oppPowerBase (H828 parity — the
 *  two must never diverge).
 *
 *  H1213: the table now ALSO calibrates GT4 cars the torque-linear
 *  model starves. Real FR propshaft inertia (pIR 250-500) crushes
 *  combinedRevResponse to its 0.6 floor for 92/371 cars — every NA/NB
 *  Miata included — while the H715 ×200 calibration was anchored on
 *  the NSX at rev=1.0, so floored cars run at ~60% of calibrated
 *  force (Miata NA measured a 22.0s quarter-mile vs 17.0-17.5s real).
 *  Values below are quarter-mile-calibrated through the live chain
 *  (tools/physlab accel.mjs + qmile probe):
 *    Miata NA ×1.8 → 17.4s @ 83 mph (real 17.0-17.5)
 *    Miata NA 130hp variants ×1.7 → 17.3s
 *    Miata NB 1.8 ×1.6 → 17.1s (real ~16.5-17)
 *    Honda BEAT ×1.4 → 18.8s (right for a 64 hp kei)
 *    S800 RSC ×1.8 → 17.3s (100 hp, accessible, was floored)
 *  Regression sentinels (must not change): NSX Type R 13.3s,
 *  Ambulance 19.2s (already inside its real 18-20s window). */
export const NON_GT4_ACCEL_MULT: Readonly<Record<string, number>> = {
  'Ambulance': 2.5,
  'Box Truck': 1.9,
  'Tow Truck': 1.4,
  'Police Cruiser': 1.5,
  'Harley-Davidson Fat Boy `96': 1.4,
  'Harley-Davidson Dyna Wide Glide `96': 1.3,
  'Harley-Davidson Road Glide `98': 1.35,
  'Harley-Davidson Road King `97': 1.4,
  // H1213: rev-response-floored low-HP GT4 cars (see doc block).
  'Mazda MX-5 Miata (NA) `89': 1.8,
  'Mazda MX-5 Miata J-Limited (NA, J) `91': 1.8,
  'Mazda MX-5 Miata J-Limited II (NA, J) `93': 1.7,
  'Mazda MX-5 Miata SR-Limited (NA, J) `97': 1.7,
  'Mazda MX-5 Miata S-Special Type I (NA, J) `95': 1.7,
  'Mazda MX-5 Miata VR-Limited (NA, J) `95': 1.7,
  'Mazda MX-5 Miata V-Special Type II (NA, J) `93': 1.7,
  'Mazda MX-5 Miata 1.8 RS (NB, J) `98': 1.6,
  'Honda BEAT `91': 1.4,
  'Honda BEAT Version F `92': 1.4,
  'Honda BEAT Version Z `93': 1.4,
  'Honda S800 RSC Race Car `68': 1.8,
};

/** H82/H102: compute catalog top speed (game units) from monolith L7296-
 *  7311. H102 wires the real per-car GT4_SPECS.wDrag value into the
 *  drag-spread calculation — supercars (wDrag ≈ 23) get a 1.0× drag
 *  multiplier and hit the physCap; boxy bricks (wDrag ≈ 50) get 0.75×
 *  and top out well below cap. Cars without a GT4_SPECS entry fall
 *  back to the same `spec?spec.wDrag:35` default the monolith uses,
 *  preserving the H82 behavior verbatim for legacy / catalog-only
 *  entries. */
function computeTopSpeed(name: string, hp: number, isBike: boolean): number {
  // Non-GT4 vehicles (work vehicles + motorcycles) use a hand-set real-world
  // top speed instead of the sports-car formula, which inflates heavy work
  // vehicles absurdly (a 475 hp semi formula'd to ~280 km/h / 174 mph) and
  // under-rates light sportbikes. See [[NON_GT4_TOP_KMH]].
  const override = NON_GT4_TOP_KMH[name];
  if (override !== undefined) return (override / 3.6) * SCALE_MS;

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

/** H875: build an effective car for an upgraded HP/weight, recomputing the
 *  derived performance fields (top speed, per-gear speeds, brake power, coast
 *  drag) through the same stock→derived formulas the catalog uses. Returns the
 *  base object unchanged when nothing differs, so stage-0 cars never allocate.
 *  The upgrade STAGE→hp/kg math lives in config/cars/upgradeHeadroom.ts; this
 *  only turns final hp/kg numbers into a coherent car. */
export function makeEffectiveCar(base: CatalogCar, effHp: number, effKg: number): CatalogCar {
  if (effHp === base.hp && effKg === base.kg) return base;
  const topSpeed = computeTopSpeed(base.name, effHp, base.isBike);
  const gearSpeeds = computeGearSpeeds(topSpeed, base.gears);
  const brakePower = computeBrakePower(effHp, effKg, base.isBike);
  const drag = computeCoastDrag(base.name, effKg, base.isBike);
  return {
    ...base,
    hp: effHp,
    kg: effKg,
    topSpeed,
    gearSpeeds,
    brakePower,
    engineBrake: drag.engineBrake,
    rollingFriction: drag.rollingFriction,
    aeroFactor: drag.aeroFactor,
  };
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
    const brakePower = computeBrakePower(hp, kg, isBike);
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
      size: computeCarSize(name, isBike),
      redline,
      idleRPM,
      eType: GT4_SPECS[name]?.eType ?? '',
      topSpeed,
      gears: gc,
      gearSpeeds,
      tcRPMs: decoded?.rpms ?? [],
      tcNorm: decoded?.norms ?? [],
      engineBrake: drag.engineBrake,
      rollingFriction: drag.rollingFriction,
      aeroFactor: drag.aeroFactor,
      brakePower,
      origin: classifyCarOrigin(name),
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

/** H1113: power floor for accessibility. Cars under this stock HP are
 *  locked out of every acquisition / encounter surface. */
export const MIN_ACCESSIBLE_HP = 100;

/** H1113: per-car exceptions to the HP floor — sub-100 HP cars the user
 *  explicitly wants kept accessible. Motorcycles are exempt separately
 *  (see isCarAccessible), so this set is only for specific cars.
 *   - honda_civic_1500_3door_cx__79 (85 HP) — the '79 3-door Civic. */
export const ACCESSIBLE_HP_EXCEPTION_IDS: ReadonlySet<string> = new Set([
  'honda_civic_1500_3door_cx__79',
]);

/**
 * H1113: is this car reachable by the player anywhere in the game?
 *
 * Cars under MIN_ACCESSIBLE_HP are hidden from the dealership, newspaper
 * classifieds, race + car-meet opponents, meet parked cars, the starter
 * pick, and the test-mode grant — "completely inaccessible until further
 * notice" per the user. They stay in the catalog (data + physics intact)
 * so the gate is a single flip to reverse. Exempt:
 *   - **motorcycles** (isBike) — a separate vehicle class, kept whole;
 *   - the cars in ACCESSIBLE_HP_EXCEPTION_IDS.
 *
 * Job / utility vehicles (ambulance, tow truck, semi, box truck, police)
 * are all ≥ MIN_ACCESSIBLE_HP, so this floor never touches them — the
 * jobs that depend on them keep working. They also carry their own
 * per-surface exclusion sets (NON_RACE_IDS / MEET_EXCLUDE / JOB_VEHICLE_IDS),
 * which remain in force alongside this gate.
 */
export function isCarAccessible(id: string): boolean {
  const c = CAR_CATALOG[id];
  if (!c) return false;
  if (c.hp >= MIN_ACCESSIBLE_HP) return true;
  if (c.isBike) return true;
  return ACCESSIBLE_HP_EXCEPTION_IDS.has(id);
}

/** H1113: ALL_CAR_IDS minus the locked-out sub-100 HP cars. Drop-in for
 *  the spawn/acquisition pools (dealer, starter, test-mode grant). */
export const ACCESSIBLE_CAR_IDS: readonly string[] = ALL_CAR_IDS.filter(isCarAccessible);
