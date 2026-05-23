/**
 * In-game wear-fault pool — the source data for `diagnoseFault`
 * (port pending), which fires when LIFE.{engine|tires|carHP} crosses
 * 40 / 15 thresholds during a drive and surfaces a matching
 * fault into LIFE.faults.
 *
 * SHAPE: keyed by car origin (jpn / usa / eur), each origin holds
 * three stat sub-pools (engine / tires / hp). Each entry is a
 * candidate fault carrying: id, display name, the stat it sits on,
 * monetary cost, days at shop, repair routing (diy / delivery /
 * mechanic — which sub-screen the player visits), the `add` stat
 * boost on completion, the `minTier` eligibility gate ('new' / 'mid'
 * / 'high' — checked against the active car's [[getMileageTier]]
 * bucket so a low-mileage car can't roll a 150k-mi-exclusive fault),
 * and a `sources` tag array driving the cause-aware diagnosis
 * filter (v8.99.104).
 *
 * Sources tag meanings (1:1 with monolith L43217-43221):
 *   'wear'     — default; slow stat decay from driving
 *   'impact'   — crash damage or flat-tire curb strike
 *   'ignition' — engine stall breakdown
 *   'cooling'  — overheating breakdown
 *
 * The diagnoseFault chain prefers exact-cause matches, falls back to
 * 'wear', then to the raw eligible set — so every threshold cross
 * produces *some* diagnosis (no silent no-op) even when no tagged
 * fault fits the cause.
 *
 * Per-origin sticker bump (`costMult` jpn 1.0 / usa 1.1 / eur 1.35)
 * is applied at diagnose time at the call site, not baked into the
 * pool — keeping pool entries as a canonical price list.
 *
 * H532: 1:1 data port of monolith FAULT_POOLS at L42867-L42939.
 * Pure data — no logic, no diagnoseFault function yet (lands in
 * a follow-up hop). Distinct from [[usedCarFaults]] USED_FAULTS,
 * which is the pre-existing-fault pool at *purchase* time (different
 * tier values, different repair sub-routing).
 */

import type { MileageTier } from '@/sim/mileageTier';

/** The three stat lanes a wear fault can sit on. `hp` covers body
 *  / underbody / cosmetic — same key the monolith uses on the
 *  pool's stat field even though `LIFE.carHP` is the runtime stat. */
export type FaultPoolStat = 'engine' | 'tires' | 'hp';

/** Cause tags on each pool entry, gating the cause-aware diagnose
 *  filter (v8.99.104). An entry can carry multiple tags — e.g.
 *  spark plugs are tagged both 'wear' and 'ignition' so an
 *  ignition stall AND a low-engine-from-driving can both surface
 *  them. */
export type FaultCause = 'wear' | 'impact' | 'ignition' | 'cooling';

/** Repair routing — picks which sub-screen the player visits to
 *  fix the fault. 'diy' is in-garage instant, 'delivery' is the
 *  parts-shop courier, 'mechanic' is the shop-visit modal. 1:1
 *  with monolith L42870-L42937 `type:` field. */
export type FaultRepairType = 'diy' | 'delivery' | 'mechanic';

/** Car origin — keys into [[FAULT_POOLS]] for which regional pool
 *  applies. Matches the catalog's `origin` field (the monolith
 *  reads `CAR().origin||'jpn'` so jpn is the silent default for
 *  any unrecognized origin). */
export type CarOrigin = 'jpn' | 'usa' | 'eur';

/** A single pool entry. Same shape across all 9 sub-pools
 *  (3 origins × 3 stats). */
export interface FaultPoolEntry {
  /** Stable string id; matches between USED_FAULTS and FAULT_POOLS
   *  where appropriate so the dedupe filter at diagnose time can
   *  reject already-known faults across both surfaces. */
  id: string;
  /** Player-facing display name (already title-cased; matches
   *  monolith literally for save-compat). */
  name: string;
  /** Which stat lane this fault sits on. */
  stat: FaultPoolStat;
  /** Repair cost in dollars before the per-origin costMult bump. */
  cost: number;
  /** Days the car spends in the shop on repair. 0 = same-day. */
  days: number;
  /** Repair routing — see [[FaultRepairType]]. */
  type: FaultRepairType;
  /** Stat boost applied to LIFE.{engine|tires|carHP} on repair
   *  completion. Caller clamps the result to <=100. */
  add: number;
  /** Mileage-tier eligibility gate. A 'new' tier entry can roll on
   *  any car; a 'mid' entry needs ≥60k mi; a 'high' entry needs
   *  ≥150k mi. Filter at diagnose time:
   *  `tierVal[carTier] >= tierVal[entry.minTier]`. */
  minTier: MileageTier;
  /** Cause tag(s) — entries with a matching cause are preferred
   *  by the cause-aware diagnosis filter. */
  sources: ReadonlyArray<FaultCause>;
}

/** Per-origin, per-stat fault pool. Each leaf array is a candidate
 *  set the diagnoseFault path filters and samples from.
 *
 *  Origins use ROUGHLY-stereotyped failure modes:
 *    jpn — clean wear items (timing belt, o2 sensor, struts)
 *    usa — rust + transmission (frame_rust, trans_slip, control arms)
 *    eur — electrical + air suspension (electrical_sensor, air_susp_leak)
 *
 *  Ported 1:1 from monolith FAULT_POOLS at L42867-L42939. Any edit
 *  here should preserve the monolith ordering so any RNG seed that
 *  hits this pool keeps producing the same picks for the same
 *  Math.random() sequence (the diagnose path uses
 *  Math.floor(Math.random()*eligible.length) — order matters). */
export const FAULT_POOLS: Readonly<Record<CarOrigin, Readonly<Record<FaultPoolStat, ReadonlyArray<FaultPoolEntry>>>>> = {
  jpn: {
    engine: [
      { id: 'timing_belt',         name: 'Timing Belt/Water Pump',  stat: 'engine', cost: 450, days: 2, type: 'mechanic', add: 45, minTier: 'mid',  sources: ['wear', 'cooling'] },
      { id: 'valve_cover_gasket',  name: 'Valve Cover Gasket Leak', stat: 'engine', cost: 120, days: 1, type: 'mechanic', add: 20, minTier: 'mid',  sources: ['wear', 'cooling'] },
      { id: 'o2_sensor',           name: 'O2 Sensor Failure',       stat: 'engine', cost: 180, days: 1, type: 'delivery', add: 25, minTier: 'new',  sources: ['wear'] },
      { id: 'oil_leak',            name: 'Oil Pan Gasket Leak',     stat: 'engine', cost: 160, days: 1, type: 'mechanic', add: 20, minTier: 'high', sources: ['wear', 'cooling'] },
      { id: 'trans_hesitation',    name: 'Auto Trans Solenoid',     stat: 'engine', cost: 350, days: 2, type: 'mechanic', add: 35, minTier: 'mid',  sources: ['wear'] },
      { id: 'spark_plugs',         name: 'Spark Plug Fouling',      stat: 'engine', cost: 40,  days: 0, type: 'diy',      add: 15, minTier: 'new',  sources: ['wear', 'ignition'] },
    ],
    tires: [
      { id: 'strut_bushings',      name: 'Strut Bushings Worn',     stat: 'tires',  cost: 200, days: 2, type: 'delivery', add: 30, minTier: 'mid',  sources: ['wear'] },
      { id: 'control_arm_bush',    name: 'Control Arm Bushings',    stat: 'tires',  cost: 280, days: 2, type: 'delivery', add: 35, minTier: 'mid',  sources: ['wear'] },
      { id: 'ps_leak',             name: 'Power Steering Leak',     stat: 'tires',  cost: 220, days: 1, type: 'mechanic', add: 25, minTier: 'high', sources: ['wear'] },
      { id: 'alignment',           name: 'Wheel Alignment Off',     stat: 'tires',  cost: 60,  days: 0, type: 'diy',      add: 15, minTier: 'new',  sources: ['wear', 'impact'] },
      { id: 'tire_wear',           name: 'Uneven Tire Wear',        stat: 'tires',  cost: 180, days: 1, type: 'delivery', add: 40, minTier: 'new',  sources: ['wear'] },
    ],
    hp: [
      { id: 'minor_rust',          name: 'Surface Rust Spots',      stat: 'hp',     cost: 100, days: 0, type: 'diy',      add: 15, minTier: 'mid',  sources: ['wear'] },
      { id: 'paint_fade',          name: 'Clear Coat Peeling',      stat: 'hp',     cost: 250, days: 2, type: 'mechanic', add: 25, minTier: 'high', sources: ['wear'] },
      { id: 'bumper_crack',        name: 'Cracked Bumper Cover',    stat: 'hp',     cost: 150, days: 1, type: 'delivery', add: 20, minTier: 'new',  sources: ['impact'] },
      { id: 'exhaust_rust',        name: 'Exhaust Pipe Rust',       stat: 'hp',     cost: 180, days: 1, type: 'mechanic', add: 20, minTier: 'mid',  sources: ['wear'] },
    ],
  },
  usa: {
    engine: [
      { id: 'intake_manifold',     name: 'Intake Manifold Crack',   stat: 'engine', cost: 380, days: 2, type: 'mechanic', add: 40, minTier: 'mid',  sources: ['wear'] },
      { id: 'cam_sensor',          name: 'Cam Sensor Failure',      stat: 'engine', cost: 200, days: 1, type: 'delivery', add: 25, minTier: 'new',  sources: ['wear', 'ignition'] },
      { id: 'oil_pan_gasket',      name: 'Oil Pan Gasket Leak',     stat: 'engine', cost: 180, days: 1, type: 'mechanic', add: 20, minTier: 'mid',  sources: ['wear', 'cooling'] },
      { id: 'trans_slip',          name: 'Trans Slipping/Failure',  stat: 'engine', cost: 800, days: 3, type: 'mechanic', add: 55, minTier: 'mid',  sources: ['wear'] },
      { id: 'spark_plugs',         name: 'Spark Plug Fouling',      stat: 'engine', cost: 45,  days: 0, type: 'diy',      add: 15, minTier: 'new',  sources: ['wear', 'ignition'] },
      { id: 'alternator',          name: 'Alternator Failing',      stat: 'engine', cost: 250, days: 1, type: 'delivery', add: 25, minTier: 'mid',  sources: ['wear', 'ignition'] },
    ],
    tires: [
      { id: 'strut_wear',          name: 'Struts Worn Out',         stat: 'tires',  cost: 240, days: 2, type: 'delivery', add: 30, minTier: 'mid',  sources: ['wear'] },
      { id: 'control_arm_rust',    name: 'Control Arms Rusted',     stat: 'tires',  cost: 320, days: 2, type: 'delivery', add: 35, minTier: 'high', sources: ['wear'] },
      { id: 'rotor_warp',          name: 'Rotors Warped',           stat: 'tires',  cost: 200, days: 1, type: 'delivery', add: 25, minTier: 'new',  sources: ['wear'] },
      { id: 'alignment',           name: 'Wheel Alignment Off',     stat: 'tires',  cost: 60,  days: 0, type: 'diy',      add: 15, minTier: 'new',  sources: ['wear', 'impact'] },
      { id: 'ball_joint',          name: 'Ball Joint Worn',         stat: 'tires',  cost: 180, days: 1, type: 'mechanic', add: 25, minTier: 'mid',  sources: ['wear'] },
    ],
    hp: [
      { id: 'frame_rust',          name: 'Frame/Underbody Rust',    stat: 'hp',     cost: 400, days: 3, type: 'mechanic', add: 35, minTier: 'high', sources: ['wear'] },
      { id: 'panel_rust',          name: 'Body Panel Rust',         stat: 'hp',     cost: 280, days: 2, type: 'mechanic', add: 25, minTier: 'mid',  sources: ['wear'] },
      { id: 'bumper_dent',         name: 'Bumper Dent/Crack',       stat: 'hp',     cost: 120, days: 1, type: 'delivery', add: 20, minTier: 'new',  sources: ['impact'] },
      { id: 'exhaust_rot',         name: 'Exhaust System Rotted',   stat: 'hp',     cost: 220, days: 2, type: 'mechanic', add: 20, minTier: 'mid',  sources: ['wear'] },
    ],
  },
  eur: {
    engine: [
      { id: 'electrical_sensor',   name: 'Electrical Sensor Fault', stat: 'engine', cost: 300, days: 1, type: 'mechanic', add: 25, minTier: 'new',  sources: ['wear', 'ignition'] },
      { id: 'timing_chain',        name: 'Timing Chain Stretch',    stat: 'engine', cost: 600, days: 3, type: 'mechanic', add: 50, minTier: 'mid',  sources: ['wear', 'cooling'] },
      { id: 'cooling_fail',        name: 'Cooling System Failure',  stat: 'engine', cost: 350, days: 2, type: 'mechanic', add: 35, minTier: 'mid',  sources: ['wear', 'cooling'] },
      { id: 'carbon_buildup',      name: 'Carbon Buildup',          stat: 'engine', cost: 280, days: 2, type: 'mechanic', add: 30, minTier: 'high', sources: ['wear'] },
      { id: 'battery_drain',       name: 'Parasitic Battery Drain', stat: 'engine', cost: 180, days: 1, type: 'mechanic', add: 20, minTier: 'new',  sources: ['wear', 'ignition'] },
      { id: 'spark_plugs',         name: 'Spark Plug Fouling',      stat: 'engine', cost: 50,  days: 0, type: 'diy',      add: 15, minTier: 'new',  sources: ['wear', 'ignition'] },
    ],
    tires: [
      { id: 'control_arm_bush',    name: 'Control Arm Bushings',    stat: 'tires',  cost: 380, days: 2, type: 'delivery', add: 35, minTier: 'new',  sources: ['wear'] },
      { id: 'air_susp_leak',       name: 'Air Suspension Leak',     stat: 'tires',  cost: 500, days: 3, type: 'mechanic', add: 40, minTier: 'mid',  sources: ['wear'] },
      { id: 'sport_brake_wear',    name: 'Sport Brake Pads Worn',   stat: 'tires',  cost: 250, days: 1, type: 'delivery', add: 25, minTier: 'new',  sources: ['wear'] },
      { id: 'alignment',           name: 'Wheel Alignment Off',     stat: 'tires',  cost: 70,  days: 0, type: 'diy',      add: 15, minTier: 'new',  sources: ['wear', 'impact'] },
      { id: 'bushing_clunk',       name: 'Suspension Bushing Clunk', stat: 'tires', cost: 300, days: 2, type: 'delivery', add: 30, minTier: 'mid',  sources: ['wear'] },
    ],
    hp: [
      { id: 'electrical_gremlin',  name: 'Electrical Gremlins',     stat: 'hp',     cost: 350, days: 2, type: 'mechanic', add: 25, minTier: 'new',  sources: ['wear', 'impact'] },
      { id: 'display_failure',     name: 'Gauge/Display Failure',   stat: 'hp',     cost: 280, days: 2, type: 'mechanic', add: 20, minTier: 'mid',  sources: ['wear', 'impact'] },
      { id: 'paint_bubble',        name: 'Paint Bubbling/Rust',     stat: 'hp',     cost: 300, days: 2, type: 'mechanic', add: 25, minTier: 'mid',  sources: ['wear'] },
      { id: 'trim_rattle',         name: 'Interior Trim Rattles',   stat: 'hp',     cost: 80,  days: 0, type: 'diy',      add: 10, minTier: 'new',  sources: ['wear', 'impact'] },
    ],
  },
};

/** Per-origin sticker bump applied to repair cost at diagnose time
 *  (the pool stores canonical jpn-1.0 prices; usa/eur cars pay more
 *  for the same nominal repair). Matches monolith L43262
 *  (`costMult=origin==='jpn'?1.0:origin==='usa'?1.1:1.35`). */
export const FAULT_ORIGIN_COST_MULT: Readonly<Record<CarOrigin, number>> = {
  jpn: 1.0,
  usa: 1.1,
  eur: 1.35,
};

/** Numeric rank for mileage-tier comparison —
 *  `TIER_RANK[carTier] >= TIER_RANK[entry.minTier]` is the
 *  eligibility test the diagnose path runs against each pool entry.
 *  Matches monolith `tierVal={new:0,mid:1,high:2}` at L43235. */
export const TIER_RANK: Readonly<Record<MileageTier, number>> = {
  new: 0,
  mid: 1,
  high: 2,
};
