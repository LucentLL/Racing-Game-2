/**
 * Wear-fault diagnosis — surfaces a matching [[FAULT_POOLS]] entry
 * into LIFE.faults when a stat threshold trips during a drive.
 *
 * Called from three call sites in the monolith:
 *   1. Per-frame wear tick at L42041-L42046 — when LIFE.engine /
 *      tires / carHP drops below 40 (normal) or 15 (severe), the
 *      crossing triggers a diagnosis on the matching stat. This is
 *      the dominant trigger source.
 *   2. Body-zone impact at L27127-L27128 — a >40 functional hit on
 *      a body zone triggers an 'impact' diagnosis on carHP.
 *   3. Breakdown sites at L42073-L42079 — flat tire (impact),
 *      stall (ignition), overheat (cooling) push a tagged cause so
 *      the diagnosis filter picks an origin-appropriate fault.
 *
 * GATE LOGIC (1:1 with monolith L43229-L43231):
 *   - Normal call: skip if THIS stat already carries any fault.
 *     One fault per stat at the soft threshold prevents fault-spam.
 *   - Severe call: skip if THIS stat already carries ≥2 faults.
 *     A second slot opens at the hard threshold for visible chrome
 *     even when a cosmetic fault has already occupied slot 1.
 *
 * CAUSE-AWARE FILTER (v8.99.104, monolith L43242-L43252):
 *   The eligible set is narrowed in this order:
 *     - Filter entries whose `sources` tag includes the caller's
 *       `cause` (default 'wear').
 *     - If that empty AND cause != 'wear', try 'wear' as fallback.
 *     - If still empty, keep the raw eligible set (no cause filter).
 *   The fallback chain guarantees *some* diagnosis fires rather than
 *   silent no-op — earlier versions would return blank for cause
 *   tags no origin had a match for (e.g. 'cooling' on jpn-only
 *   pools), feeling broken to the player.
 *
 * SEVERE GATE (v8.99.104 bug fix, L43253-L43259):
 *   When severe, prefer faults with cost>=100 ("real" faults vs
 *   cosmetic). The pre-v8.99.104 code wrote
 *   `eligible.filter(...)||eligible` which never fell back because
 *   `[]` is truthy — severe diagnosis silently returned nothing
 *   when all eligible faults cost <100. The modular port preserves
 *   the snapshot-and-conditional-replace fix.
 *
 * H533: 1:1 port of monolith diagnoseFault at L43226-L43265.
 * Pure mutator — pushes the picked entry into deps.faults and emits
 * a notification. The active-car's origin and mileage tier are
 * passed in by the call site rather than read from globals so the
 * function stays testable and the modular sim layer keeps its
 * deps-injection discipline.
 */

import { FAULT_POOLS, FAULT_ORIGIN_COST_MULT, TIER_RANK } from '@/sim/faultPools';
import type { CarOrigin, FaultCause, FaultPoolEntry, FaultPoolStat } from '@/sim/faultPools';
import type { MileageTier } from '@/sim/mileageTier';

/** Shape of a diagnosed fault as it lives in LIFE.faults — a
 *  [[FaultPoolEntry]] with the per-origin sticker bump baked into
 *  `cost`. Other consumers read id/name/stat/cost/days/type/add
 *  generically; the extra minTier/sources fields are harmless
 *  on the runtime fault list. */
export type DiagnosedFault = FaultPoolEntry;

/** Existing fault shape on LIFE.faults — any object with at minimum
 *  an id and stat (the gate logic only inspects those two fields).
 *  Matches the structural reality of the monolith's faults array
 *  (heterogeneous: wear-pool entries, body-zone entries, used-car
 *  carryovers — all sharing the {id,stat} convention). */
export interface ExistingFaultLike {
  id: string;
  stat: string;
}

/** Deps for [[diagnoseFault]] — everything the function needs about
 *  player + car state, plus the side-effect channels (notify, RNG).
 *  Call sites pass the active-car-derived values rather than the
 *  function reaching for globals. */
export interface DiagnoseFaultDeps {
  /** The faults array on LIFE — the function pushes the diagnosed
   *  entry into this array. Reads existing entries via the
   *  [[ExistingFaultLike]] minimum shape. */
  faults: ExistingFaultLike[];
  /** Active car's origin. Drives both pool selection and the
   *  costMult sticker bump. Falls back to 'jpn' if the supplied
   *  origin isn't a known key (mirrors monolith
   *  `CAR().origin||'jpn'` + `FAULT_POOLS[origin]||FAULT_POOLS.jpn`). */
  origin: CarOrigin | string;
  /** Active car's mileage tier (output of [[getMileageTier]]) —
   *  used for the minTier eligibility filter on each pool entry. */
  mileageTier: MileageTier;
  /** Notification channel — receives the "DIAGNOSED" / "SEVERE"
   *  string. Most call sites pipe this to the in-game toast queue;
   *  tests can supply a no-op or recorder. */
  notify: (msg: string) => void;
  /** RNG injection point — defaults to Math.random. Tests pass a
   *  deterministic stream to control which pool entry the picker
   *  selects. */
  random?: () => number;
}

/** Roll a wear fault on the given stat and push it into deps.faults.
 *  Silent no-op when the eligibility / dedupe / gate checks reject
 *  the call (matches monolith — diagnoseFault is fire-and-forget).
 *
 *  @param deps   See [[DiagnoseFaultDeps]].
 *  @param stat   Which stat lane the fault should sit on.
 *  @param severe If true, this is the hard-threshold (≤15) call —
 *                allows a second fault on the stat AND prefers
 *                cost>=100 entries. Defaults to false.
 *  @param cause  What triggered the diagnosis — 'wear' (default),
 *                'impact' (crash / curb), 'ignition' (stall), or
 *                'cooling' (overheat). Steers the cause-aware
 *                filter so a collision diagnoses dent/bumper rather
 *                than rust.
 *
 *  Ported 1:1 from monolith L43226-L43265. */
export function diagnoseFault(
  deps: DiagnoseFaultDeps,
  stat: FaultPoolStat,
  severe?: boolean,
  cause?: FaultCause,
): void {
  const effectiveCause: FaultCause = cause ?? 'wear';

  // Gate: one fault per stat at normal, max two at severe (matches
  // monolith L43229-L43231).
  const existing = deps.faults.filter((f) => f.stat === stat);
  if (!severe && existing.length > 0) return;
  if (severe && existing.length >= 2) return;

  // Origin fallback — unknown origin → 'jpn' pool. Mirrors
  // `FAULT_POOLS[origin]||FAULT_POOLS.jpn` at L43236.
  const originKey: CarOrigin = (deps.origin in FAULT_POOLS
    ? (deps.origin as CarOrigin)
    : 'jpn');
  const pool = FAULT_POOLS[originKey][stat] ?? [];

  // Tier gate: pool entries with minTier > car's tier are rejected.
  // 1:1 with `tierVal[tier]>=tierVal[f.minTier]` at L43238.
  let eligible: ReadonlyArray<FaultPoolEntry> = pool.filter(
    (f) => TIER_RANK[deps.mileageTier] >= TIER_RANK[f.minTier],
  );

  // Dedupe by id within the existing same-stat set. The monolith
  // builds `existingIds` from `existing` (which was already
  // filtered to stat-match), so dedupe is intentionally per-stat
  // not global — preserved here verbatim.
  const existingIds = new Set(existing.map((f) => f.id));
  eligible = eligible.filter((f) => !existingIds.has(f.id));

  // Cause-aware filter with 'wear' fallback. The strict cause match
  // wins if any candidates carry the tag; otherwise non-'wear'
  // causes fall back to the 'wear' subset; otherwise the raw
  // eligible set passes through (silent fallback so the player
  // always gets *some* diagnosis when the gate would otherwise
  // produce nothing).
  const matchCause = eligible.filter((f) => f.sources.includes(effectiveCause));
  if (matchCause.length) {
    eligible = matchCause;
  } else if (effectiveCause !== 'wear') {
    const matchWear = eligible.filter((f) => f.sources.includes('wear'));
    if (matchWear.length) eligible = matchWear;
  }

  // Severe prefers cost>=100 ("real" faults). Snapshot + conditional
  // replace pattern (v8.99.104 fix — earlier `||eligible` never
  // fell back because `[]` is truthy in JS).
  if (severe) {
    const strict = eligible.filter((f) => f.cost >= 100);
    if (strict.length) eligible = strict;
  }

  if (!eligible.length) return;

  // Pick + push with per-origin sticker bump.
  const rng = deps.random ?? Math.random;
  const pick = eligible[Math.floor(rng() * eligible.length)];
  const costMult = FAULT_ORIGIN_COST_MULT[originKey];
  const diagnosed: DiagnosedFault = {
    ...pick,
    cost: Math.round(pick.cost * costMult),
  };
  deps.faults.push(diagnosed);
  deps.notify((severe ? '⚠️ SEVERE: ' : '⚠ DIAGNOSED: ') + pick.name);
}
