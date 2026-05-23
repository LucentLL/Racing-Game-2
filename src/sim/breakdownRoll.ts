/**
 * Per-frame breakdown roll. Each frame inside the wear-tick guard
 * (spd>5 && !broken), the player has a small chance of suddenly
 * breaking down — stall, flat tire, or overheat. Probability scales
 * with car condition (worse stats → more likely) and mileage (high-
 * mileage cars break more), gated heavily by a new-car floor so
 * the first 5,000 miles almost never produces a roadside event.
 *
 * H536: 1:1 port of monolith breakdown roll at L42060-L42083.
 * Companion to [[tickBreakdownRecovery]] (H529) — that module
 * handles the post-roll 3-sec stall countdown and the tow-menu
 * transitions; this module is the upstream trigger.
 *
 * THE ROLL:
 *   - breakBase = odoMi < 5000 ? 0.000005 : 0.00005   (10× jump
 *     past the new-car threshold).
 *   - cond = (engine + tires + carHP) / 300  ∈ [0,1]  (lower = worse).
 *   - chance = breakBase × (1 − cond) × wearMult  per frame.
 *   - The roll uses two RNG draws: one for the chance, one for the
 *     issue picker. Both go through deps.random (defaults to
 *     Math.random) so tests can drive the picker deterministically.
 *
 * THREE BREAKDOWN TYPES — each lowers a stat, surfaces a cause-
 * tagged fault, and sets the tow / recovery state:
 *
 *   FLAT TIRE     — tires -= 20, diagnose 'tires' with cause 'impact'
 *                   (curb/hazard strike), breakdownTimer=0 +
 *                   towMenuOpen=true (can't drive on a flat).
 *
 *   ENGINE STALL  — engine -= 15, diagnose 'engine' with cause
 *                   'ignition' (spark/sensor failure), breakdownTimer=3
 *                   (the recovery tick tries restart after 3 sec —
 *                   the only path that may self-recover).
 *
 *   OVERHEATING   — engine -= 15, diagnose 'engine' with cause
 *                   'cooling' (radiator/hose/coolant), breakdownTimer=0
 *                   + towMenuOpen=true (can't keep driving while hot).
 *
 * All three emit 'BREAKDOWN: {issue}' via the notify dep.
 *
 * The cause tags drive [[diagnoseFault]]'s v8.99.104 cause-aware
 * pool filter — a flat tire produces a tire-impact fault rather
 * than a random rust spot, etc. When no entry in the active car's
 * regional pool carries the tagged cause (e.g. only the eur pool
 * has 'cooling' entries), the diagnose path falls back through
 * 'wear' so the player always gets *some* diagnosis.
 */

import type { LifeState } from '@/state/life';
import { diagnoseFault } from '@/sim/diagnoseFault';
import type { MileageTier } from '@/sim/mileageTier';
import type { CatalogCarOrigin } from '@/config/cars/origin';

/** Breakdown chance multiplier for new cars (under [[NEW_CAR_MILEAGE_THRESHOLD]]
 *  miles on the odometer). 10× lower than the mileage-aged base —
 *  prevents the player's first-job econobox from stalling out on
 *  the way to delivery. Matches monolith `0.000005` at L42060. */
export const NEW_CAR_BREAK_BASE = 0.000005;

/** Breakdown chance multiplier for mileage-aged cars. Per-frame
 *  base probability before condition + wearMult scaling. Matches
 *  monolith `0.00005` at L42060. */
export const AGED_CAR_BREAK_BASE = 0.00005;

/** Odometer cutoff (miles) for the new-car / aged-car break-base
 *  selector. Below this, the much lower NEW_CAR_BREAK_BASE applies.
 *  Matches monolith `odoMi < 5000` at L42060. */
export const NEW_CAR_MILEAGE_THRESHOLD = 5000;

/** Tires-stat penalty (subtractive) when a flat tire fires.
 *  Matches monolith `LIFE.tires -= 20` at L42073. */
export const FLAT_TIRE_TIRES_PENALTY = 20;

/** Engine-stat penalty (subtractive) when a stall or overheat
 *  fires. Matches monolith `LIFE.engine -= 15` at L42076 / L42079. */
export const STALL_OVERHEAT_ENGINE_PENALTY = 15;

/** Recovery-timer seconds for the ENGINE STALL path — the auto-
 *  restart countdown the recovery tick uses. FLAT TIRE and
 *  OVERHEATING both set timer=0 so they skip recovery and go
 *  straight to tow. Matches monolith `LIFE.breakdownTimer=3`
 *  at L42077. */
export const STALL_RECOVERY_TIMER_SEC = 3;

/** The three breakdown issue strings, in monolith order. Order
 *  matters: the picker is `issues[Math.floor(Math.random()*3)]`,
 *  so any RNG seed that hits the roll keeps picking the same
 *  issue for the same draw. */
const ISSUES = ['ENGINE STALL', 'FLAT TIRE', 'OVERHEATING'] as const;

/** Deps for [[maybeRollBreakdown]] — the wear-tick context the
 *  function needs to evaluate the roll and propagate the
 *  fault-diagnosis cause tag. */
export interface BreakdownRollDeps {
  /** Mutated when the roll fires — broken / breakdownType /
   *  breakdownTimer / towMenuOpen are flipped, plus the per-issue
   *  stat penalty is applied to engine or tires. */
  life: LifeState;
  /** Active car odometer in miles. Caller passes the already-
   *  computed value so the wear-tick doesn't double-multiply
   *  (gameLoop already has _odoMi from the H78 wearMult lookup). */
  odoMi: number;
  /** Wear multiplier from the H78 wear tick. Caller passes it in;
   *  this module doesn't re-derive from odoMi. */
  wearMult: number;
  /** Active car's origin — propagated into the diagnose call so
   *  the FAULT_POOLS pool selection matches the H535 wear-tick
   *  diagnose calls. */
  origin: CatalogCarOrigin | string;
  /** Active car's mileage tier — propagated into the diagnose call
   *  for the minTier eligibility gate. */
  mileageTier: MileageTier;
  /** Notify sink for the 'BREAKDOWN: {issue}' toast AND the inner
   *  diagnoseFault DIAGNOSED/SEVERE toast. */
  notify: (msg: string) => void;
  /** RNG injection point — defaults to Math.random. Tests pass a
   *  deterministic stream; the function draws twice (chance roll +
   *  issue picker) plus the inner diagnoseFault draws once. */
  random?: () => number;
}

/** Roll the per-frame breakdown chance and, on hit, fire one of
 *  the three breakdown types. Silent no-op when the chance misses
 *  or when life.broken is already true (caller is expected to gate
 *  on !life.broken before calling, matching the monolith's
 *  enclosing `if (spd>5 && !LIFE.broken)` block).
 *
 *  Ported 1:1 from monolith L42060-L42083. */
export function maybeRollBreakdown(deps: BreakdownRollDeps): void {
  const rng = deps.random ?? Math.random;
  const breakBase = deps.odoMi < NEW_CAR_MILEAGE_THRESHOLD
    ? NEW_CAR_BREAK_BASE
    : AGED_CAR_BREAK_BASE;
  const cond = (deps.life.engine + deps.life.tires + deps.life.carHP) / 300;
  if (rng() >= breakBase * (1 - cond) * deps.wearMult) return;

  deps.life.broken = true;
  const issue = ISSUES[Math.floor(rng() * ISSUES.length)];
  deps.life.breakdownType = issue;

  // Cause-tagged diagnose deps — built once per breakdown and
  // reused across the three branches. Mirrors the H535 wear-tick
  // wiring so both diagnose call sites construct the deps the
  // same way.
  const faultDeps = {
    faults: deps.life.faults as { id: string; stat: string }[],
    origin: deps.origin,
    mileageTier: deps.mileageTier,
    notify: deps.notify,
    random: deps.random,
  };

  if (issue === 'FLAT TIRE') {
    // Curb/hazard strike. 'impact' cause favors alignment / bumper-
    // style entries; tires-only stat lane.
    deps.life.tires = Math.max(0, deps.life.tires - FLAT_TIRE_TIRES_PENALTY);
    diagnoseFault(faultDeps, 'tires', false, 'impact');
    deps.life.breakdownTimer = 0;
    deps.life.towMenuOpen = true;
  } else if (issue === 'ENGINE STALL') {
    // Spark/sensor failure. 'ignition' cause favors plugs / o2 /
    // cam-sensor entries; engine stat lane. Only this path uses
    // the 3-sec restart countdown (tickBreakdownRecovery).
    deps.life.engine = Math.max(0, deps.life.engine - STALL_OVERHEAT_ENGINE_PENALTY);
    diagnoseFault(faultDeps, 'engine', false, 'ignition');
    deps.life.breakdownTimer = STALL_RECOVERY_TIMER_SEC;
  } else { // 'OVERHEATING'
    // Radiator/hose/coolant. 'cooling' cause favors timing-belt /
    // cooling-fail entries; engine stat lane. jpn/usa pools have
    // limited 'cooling'-tagged entries — the diagnose path silently
    // falls back to 'wear' for those origins (monolith behavior
    // preserved by [[diagnoseFault]]'s cause-fallback chain).
    deps.life.engine = Math.max(0, deps.life.engine - STALL_OVERHEAT_ENGINE_PENALTY);
    diagnoseFault(faultDeps, 'engine', false, 'cooling');
    deps.life.breakdownTimer = 0;
    deps.life.towMenuOpen = true;
  }
  deps.notify('BREAKDOWN: ' + issue);
}
