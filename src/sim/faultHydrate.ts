/**
 * H1065: fault hydration — repair legacy/stripped fault objects.
 *
 * User screenshot (2026-07-06): the garage REPAIRS view rendered
 * "Restores +undefined% undefined" and "DIY ~NaNh · Mechanic NaNd".
 * Root cause: fault OBJECTS in an older save (and in per-car
 * carConditions snapshots) are missing the economy fields
 * (stat / cost / days / type / add) that today's producers all copy
 * from the pool entries. Saves persist life wholesale, so once a
 * stripped fault is in a save it stays broken forever — every
 * consumer (drawGarageRepairs, getFaultVenueOptions, repairPopup)
 * assumed the fields exist and rendered undefined/NaN.
 *
 * Fix: hydrate at LOAD time (normalizeLoadedLife) and after every
 * per-car condition restore — look the fault id up in the merged
 * catalog (FAULT_POOLS + BODY_DAMAGE_FAULTS) and fill whatever is
 * missing; unknown ids get safe generic defaults. Never overwrites
 * fields that are already present (a diagnosed fault's origin-
 * multiplied cost survives).
 */

import { FAULT_POOLS } from './faultPools';
import { BODY_DAMAGE_FAULTS } from './faults';

interface CatalogRow {
  name: string;
  stat: string;
  cost: number;
  days: number;
  type: string;
  add: number;
}

let _catalog: Map<string, CatalogRow> | null = null;

/** Merged id → reference-entry map, built once per session. */
function catalog(): Map<string, CatalogRow> {
  if (_catalog) return _catalog;
  const m = new Map<string, CatalogRow>();
  for (const origin of Object.values(FAULT_POOLS)) {
    for (const entries of Object.values(origin)) {
      for (const e of entries) {
        if (!m.has(e.id)) {
          m.set(e.id, {
            name: e.name, stat: e.stat, cost: e.cost,
            days: e.days, type: e.type, add: e.add,
          });
        }
      }
    }
  }
  for (const f of BODY_DAMAGE_FAULTS) {
    if (!m.has(f.id)) {
      m.set(f.id, {
        name: f.name, stat: f.stat, cost: f.cost,
        days: f.days, type: f.type, add: f.add,
      });
    }
  }
  _catalog = m;
  return m;
}

/** Generic fallback for ids not in any catalog (e.g. faults minted
 *  by long-gone debug builds). Chosen to be harmless: a cheap
 *  same-week mechanic job restoring a modest chunk of engine. */
const FALLBACK: CatalogRow = {
  name: 'Unknown Fault', stat: 'engine', cost: 100,
  days: 1, type: 'mechanic', add: 15,
};

/** Fill missing economy fields on every fault in the array,
 *  in place. Returns the number of faults that needed repair
 *  (0 = save was already clean). */
export function hydrateFaults(faults: unknown[] | undefined | null): number {
  if (!Array.isArray(faults)) return 0;
  let fixed = 0;
  for (const raw of faults) {
    const f = raw as Record<string, unknown>;
    if (!f || typeof f !== 'object') continue;
    const needs =
      typeof f.stat !== 'string'
      || !Number.isFinite(f.cost as number)
      || !Number.isFinite(f.days as number)
      || !Number.isFinite(f.add as number);
    if (!needs) continue;
    const ref = catalog().get(String(f.id ?? '')) ?? FALLBACK;
    if (typeof f.stat !== 'string') f.stat = ref.stat;
    if (typeof f.name !== 'string' || !f.name) f.name = ref.name;
    if (!Number.isFinite(f.cost as number)) f.cost = ref.cost;
    if (!Number.isFinite(f.days as number)) f.days = ref.days;
    if (typeof f.type !== 'string') f.type = ref.type;
    if (!Number.isFinite(f.add as number)) f.add = ref.add;
    fixed++;
  }
  return fixed;
}
