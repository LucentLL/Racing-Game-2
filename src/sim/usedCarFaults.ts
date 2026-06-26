/**
 * Used-car pre-existing fault generator + repair-tier table.
 *
 * Powers the "this beater hides a $600 transmission problem" side of
 * the seller-visit flow:
 *   - generateUsedCarFaults(id, mileage, cond) — rolls 0..5 PreFault
 *     entries appropriate for the listing's condition + odometer.
 *     Called by startSellerVisit / openSellerVisitFromPin / the
 *     used-car-lot openInspection path (port pending).
 *   - faultPriceDiscount(faults) — multiplicative discount from
 *     DETECTED faults only. Drives sv.hagglePrice on init + after
 *     each inspect / test-drive reveal.
 *
 * REPAIR_TIERS controls both visual chrome (color/label in the H185
 * KNOWN ISSUES section) AND the gameplay numbers — detectChance per
 * tier feeds the inspect random reveal and end-of-test-drive reveal;
 * priceMult drives the discount.
 *
 * USED_FAULTS is a per-origin pool. Each origin gets its own
 * stereotyped failure set (jpn = clean wear items, usa = rust +
 * trans, eur = electrical + sport-brake wear). The
 * `costMult = jpn 1.0 / usa 1.1 / eur 1.35` line at the bottom of
 * generateUsedCarFaults applies the per-origin sticker bump to repair
 * costs.
 *
 * TEST_DRIVE_ONLY is the set of fault ids whose `testDriveOnly` flag
 * starts true at generation — these stay hidden through INSPECT and
 * only surface during the H187 test drive.
 *
 * Ported from monolith L43203-43359 (TEST_DRIVE_ONLY set, REPAIR_TIERS
 * map, USED_FAULTS pool, generateUsedCarFaults, faultPriceDiscount).
 *
 * SCOPE NOTE: this is the runtime-table port only. The
 * diagnoseFault path (L43226-43265) — which uses a SEPARATE
 * FAULT_POOLS structure for in-game fault discovery during driving
 * — is NOT ported here. That belongs with the live wear /
 * breakdown system.
 */

import type { PreFault } from '@/ui/modals/inspection';

/** Faults that ONLY a test drive reveals. Mirrors monolith L43203. */
export const TEST_DRIVE_ONLY: ReadonlySet<string> = new Set([
  'trans_hesitation', 'trans_slip', 'alignment', 'o2_sensor', 'cam_sensor',
  'carbon_buildup', 'electrical_sensor', 'strut_bushings', 'strut_wear',
  'control_arm_bush', 'control_arm_rust', 'ball_joint', 'bushing_clunk',
  'air_susp_leak', 'ps_leak', 'rotor_warp', 'sport_brake_wear',
  'intake_manifold', 'battery_drain',
]);

/** Per-tier visual + gameplay parameters. 1:1 with monolith L43268. */
export interface RepairTier {
  label: string;
  color: string;
  /** Default random-detect probability for the inspect / test-drive
   *  random-reveal rolls. Per-fault override via PreFault.detectChance
   *  (set at generation time from the tier value). */
  detect: number;
  /** Multiplier applied to the listing price for each DETECTED fault
   *  in this tier. Stacks multiplicatively across all faults. */
  priceMult: number;
}

export const REPAIR_TIERS: Record<PreFault['tier'] | 'catastrophic', RepairTier> = {
  cheap:        { label: 'CHEAP',        color: '#8f8', detect: 0.30, priceMult: 0.92 },
  moderate:     { label: 'MODERATE',     color: '#ff0', detect: 0.50, priceMult: 0.80 },
  extensive:    { label: 'EXTENSIVE',    color: '#f80', detect: 0.70, priceMult: 0.65 },
  // 'catastrophic' is the monolith's 4th tier; in the modular PreFault
  // shape it stays addressable as 'severe' (mapped at write time).
  catastrophic: { label: 'CATASTROPHIC', color: '#f44', detect: 0.60, priceMult: 0.40 },
  severe:       { label: 'CATASTROPHIC', color: '#f44', detect: 0.60, priceMult: 0.40 },
};

/** A USED_FAULTS pool entry — what the monolith writes into a pool.
 *  This is the *source* row; generateUsedCarFaults transforms it
 *  into a PreFault by adding cost-mult, detected=false, etc. */
interface PoolEntry {
  id: string;
  name: string;
  stat: 'engine' | 'tires' | 'hp';
  tier: 'cheap' | 'moderate' | 'extensive' | 'catastrophic';
  cost: number;
  days: number;
  type: 'diy' | 'delivery' | 'mechanic';
  add: number;
}

type Origin = 'jpn' | 'usa' | 'eur';

/** Per-origin used-car fault pool. 1:1 with monolith L43275-43318. */
const USED_FAULTS: Record<Origin, readonly PoolEntry[]> = {
  jpn: [
    { id: 'spark_plugs',         name: 'Spark Plug Fouling',     stat: 'engine', tier: 'cheap',        cost: 40,  days: 0, type: 'diy',      add: 15 },
    { id: 'alignment',           name: 'Alignment Off',          stat: 'tires',  tier: 'cheap',        cost: 60,  days: 0, type: 'diy',      add: 15 },
    { id: 'oil_leak',            name: 'Fluid Top-Off Needed',   stat: 'engine', tier: 'cheap',        cost: 30,  days: 0, type: 'diy',      add: 10 },
    { id: 'o2_sensor',           name: 'O2 Sensor Aging',        stat: 'engine', tier: 'moderate',     cost: 180, days: 1, type: 'delivery', add: 25 },
    { id: 'sport_brake_wear',    name: 'Brake Pads Worn',        stat: 'tires',  tier: 'moderate',     cost: 140, days: 1, type: 'delivery', add: 25 },
    { id: 'strut_bushings',      name: 'Strut Bushings Soft',    stat: 'tires',  tier: 'moderate',     cost: 200, days: 2, type: 'delivery', add: 30 },
    { id: 'valve_cover_gasket',  name: 'Valve Cover Gasket',     stat: 'engine', tier: 'moderate',     cost: 120, days: 1, type: 'mechanic', add: 20 },
    { id: 'timing_belt',         name: 'Timing Belt Due',        stat: 'engine', tier: 'extensive',    cost: 450, days: 2, type: 'mechanic', add: 45 },
    { id: 'cooling_fail',        name: 'Radiator & Hoses',       stat: 'engine', tier: 'extensive',    cost: 320, days: 2, type: 'mechanic', add: 35 },
    { id: 'ps_leak',             name: 'Power Steering Leak',    stat: 'tires',  tier: 'extensive',    cost: 280, days: 2, type: 'mechanic', add: 30 },
    { id: 'trans_hesitation',    name: 'Trans Solenoid Worn',    stat: 'engine', tier: 'catastrophic', cost: 600, days: 3, type: 'mechanic', add: 55 },
    { id: 'trans_slip',          name: 'Engine Rebuild Needed',  stat: 'engine', tier: 'catastrophic', cost: 800, days: 3, type: 'mechanic', add: 60 },
  ],
  usa: [
    { id: 'spark_plugs',         name: 'Spark Plugs Worn',       stat: 'engine', tier: 'cheap',        cost: 45,  days: 0, type: 'diy',      add: 15 },
    { id: 'alignment',           name: 'Alignment Off',          stat: 'tires',  tier: 'cheap',        cost: 60,  days: 0, type: 'diy',      add: 15 },
    { id: 'oil_leak',            name: 'Fluid Top-Off Needed',   stat: 'engine', tier: 'cheap',        cost: 30,  days: 0, type: 'diy',      add: 10 },
    { id: 'rotor_warp',          name: 'Rotors Warped',          stat: 'tires',  tier: 'moderate',     cost: 200, days: 1, type: 'delivery', add: 25 },
    { id: 'cam_sensor',          name: 'Cam Sensor Failing',     stat: 'engine', tier: 'moderate',     cost: 200, days: 1, type: 'delivery', add: 25 },
    { id: 'ball_joint',          name: 'Ball Joints Worn',       stat: 'tires',  tier: 'moderate',     cost: 180, days: 1, type: 'mechanic', add: 25 },
    { id: 'oil_pan_gasket',      name: 'Oil Pan Gasket Leak',    stat: 'engine', tier: 'moderate',     cost: 180, days: 1, type: 'mechanic', add: 20 },
    { id: 'intake_manifold',     name: 'Intake Manifold Crack',  stat: 'engine', tier: 'extensive',    cost: 380, days: 2, type: 'mechanic', add: 40 },
    { id: 'cooling_fail',        name: 'Radiator & Hoses',       stat: 'engine', tier: 'extensive',    cost: 350, days: 2, type: 'mechanic', add: 35 },
    { id: 'control_arm_rust',    name: 'Control Arms Rusted',    stat: 'tires',  tier: 'extensive',    cost: 320, days: 2, type: 'delivery', add: 35 },
    { id: 'trans_slip',          name: 'Trans Slipping',         stat: 'engine', tier: 'catastrophic', cost: 800, days: 3, type: 'mechanic', add: 55 },
    { id: 'frame_rust',          name: 'Frame Rust Repair',      stat: 'hp',     tier: 'catastrophic', cost: 1200, days: 4, type: 'mechanic', add: 50 },
    { id: 'trans_slip',          name: 'Engine Replacement',     stat: 'engine', tier: 'catastrophic', cost: 900, days: 3, type: 'mechanic', add: 60 },
  ],
  eur: [
    { id: 'spark_plugs',         name: 'Spark Plug Fouling',     stat: 'engine', tier: 'cheap',        cost: 50,  days: 0, type: 'diy',      add: 15 },
    { id: 'alignment',           name: 'Alignment Off',          stat: 'tires',  tier: 'cheap',        cost: 70,  days: 0, type: 'diy',      add: 15 },
    { id: 'trim_rattle',         name: 'Trim Rattles',           stat: 'hp',     tier: 'cheap',        cost: 80,  days: 0, type: 'diy',      add: 10 },
    { id: 'sport_brake_wear',    name: 'Sport Brake Pads Worn',  stat: 'tires',  tier: 'moderate',     cost: 250, days: 1, type: 'delivery', add: 25 },
    { id: 'electrical_sensor',   name: 'Electrical Sensor Fault', stat: 'engine', tier: 'moderate',    cost: 300, days: 1, type: 'mechanic', add: 25 },
    { id: 'bushing_clunk',       name: 'Bushing Clunk',          stat: 'tires',  tier: 'moderate',     cost: 300, days: 2, type: 'delivery', add: 30 },
    { id: 'cooling_fail',        name: 'Cooling System Failing', stat: 'engine', tier: 'extensive',    cost: 400, days: 2, type: 'mechanic', add: 35 },
    { id: 'timing_chain',        name: 'Timing Chain Stretch',   stat: 'engine', tier: 'extensive',    cost: 600, days: 3, type: 'mechanic', add: 50 },
    { id: 'air_susp_leak',       name: 'Air Suspension Leak',    stat: 'tires',  tier: 'extensive',    cost: 500, days: 3, type: 'mechanic', add: 40 },
    { id: 'electrical_gremlin',  name: 'Electrical Gremlins',    stat: 'hp',     tier: 'catastrophic', cost: 700, days: 3, type: 'mechanic', add: 40 },
    { id: 'trans_slip',          name: 'Engine Rebuild Needed',  stat: 'engine', tier: 'catastrophic', cost: 900, days: 4, type: 'mechanic', add: 60 },
  ],
};

/** Maps the monolith's 'catastrophic' tier to the modular PreFault
 *  'severe' tier label. The two tiers are gameplay-identical (same
 *  detectChance / priceMult) — the modular schema just uses 'severe'
 *  as the label key. */
function toPreFaultTier(t: PoolEntry['tier']): PreFault['tier'] {
  return t === 'catastrophic' ? 'severe' : t;
}

/** 1:1 port of monolith L43321-43350. Rolls 0..5 pre-existing faults
 *  for a used car based on cond + mileage. `origin` defaults to 'jpn'
 *  when CatalogCar doesn't carry origin (the modular catalog hasn't
 *  grown it yet — same fallback the monolith uses at L43322).
 *
 *  Returns PreFault[] ready to drop on sv.preFaults. New cars (cond ==
 *  100, isNew) should bypass this — call sites generate `[]` directly. */
export function generateUsedCarFaults(
  _carId: string,
  mileage: number,
  cond: number,
  origin: Origin = 'jpn',
): PreFault[] {
  const pool = USED_FAULTS[origin] ?? USED_FAULTS.jpn;
  const faults: PreFault[] = [];

  // Number of faults by condition. 1:1 with monolith L43326-43330.
  let maxFaults = 0;
  if (cond > 85) maxFaults = Math.random() < 0.3 ? 1 : 0;
  else if (cond > 60) maxFaults = 1 + Math.floor(Math.random() * 2);
  else if (cond > 40) maxFaults = 2 + Math.floor(Math.random() * 2);
  else maxFaults = 2 + Math.floor(Math.random() * 3);

  // Higher mileage → more severe-fault bias. L43332-43333.
  const miK = (mileage || 0) / 1000;
  const severeBias = miK > 150 ? 0.4 : miK > 80 ? 0.2 : 0.05;

  // Shuffle the origin pool and walk until we have maxFaults.
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  const usedStats = new Set<string>();
  const costMult = origin === 'jpn' ? 1.0 : origin === 'usa' ? 1.1 : 1.35;

  for (let i = 0; i < shuffled.length && faults.length < maxFaults; i++) {
    const f = shuffled[i];
    // One fault per stat usually — 30% chance to allow a duplicate.
    if (usedStats.has(f.stat) && Math.random() > 0.3) continue;
    // Tier-gating by mileage — keeps low-mile cars from rolling a
    // 'catastrophic' fault except in the severeBias % of cases.
    if (f.tier === 'catastrophic' && miK < 60 && Math.random() > severeBias) continue;
    if (f.tier === 'extensive' && miK < 30 && Math.random() > 0.15) continue;

    const tier = REPAIR_TIERS[f.tier];
    const tdOnly = TEST_DRIVE_ONLY.has(f.id);
    faults.push({
      name: f.name,
      tier: toPreFaultTier(f.tier),
      cost: Math.round(f.cost * costMult),
      detected: false,
      testDriveOnly: tdOnly,
      detectChance: tier.detect,
      id: f.id,
    });
    usedStats.add(f.stat);
  }

  return faults;
}

/** Multiplicative price discount across all DETECTED faults.
 *  Undetected faults don't discount — the seller doesn't know to
 *  budge until inspection / test-drive surfaces them. 1:1 port of
 *  monolith L43353-43359. */
export function faultPriceDiscount(faults: readonly PreFault[]): number {
  let mult = 1.0;
  for (const f of faults) {
    if (f.detected) {
      const tier = REPAIR_TIERS[f.tier];
      if (tier) mult *= tier.priceMult;
    }
  }
  return mult;
}

/** A "beater" — a rough/cheap used car. User spec: when you buy a beater
 *  (starter, newspaper ad, or dealership lot) there should be at least one
 *  fault ACTIVE from day one. A car at/below this condition counts. */
export const BEATER_COND_MAX = 55;
export function isBeaterCond(cond: number | undefined | null): boolean {
  return typeof cond === 'number' && cond <= BEATER_COND_MAX;
}

/** Mark the CHEAPEST fault detected and splice it out of `faults`,
 *  returning it. The cheapest fault is the most approachable, most
 *  obvious one — a beater telegraphs a problem you can actually start
 *  on, while its catastrophic surprises stay hidden until the miles
 *  reveal them (preserving the "this beater hides an $800 engine" beat).
 *  Returns null if the list is empty. MUTATES `faults`. */
export function surfaceCheapestFault(faults: PreFault[]): PreFault | null {
  if (!faults.length) return null;
  let bi = 0;
  for (let i = 1; i < faults.length; i++) {
    if ((faults[i].cost ?? 0) < (faults[bi].cost ?? 0)) bi = i;
  }
  const [f] = faults.splice(bi, 1);
  f.detected = true;
  return f;
}
