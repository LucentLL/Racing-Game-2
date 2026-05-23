/**
 * Per-car upgrade tracker — surfaces the list of installed-over-stock
 * mods for any owned car. Returns an empty list for a stock car so
 * callers can short-circuit chrome rendering with a `.length>0` test.
 *
 * H538: 1:1 port of monolith getCarMods at L42272-L42280
 * (v8.99.32 "per-car upgrade tracker"). Pure function — picks
 * between the active-car LIFE.{welded,supercharged} live flags
 * and the at-rest CarConditionData record per the carId argument,
 * then projects each enabled mod into a uniform [[CarMod]] entry.
 *
 * The split between LIFE flags + CarConditionData is the
 * monolith's persistence convention — LIFE.* mirrors the active
 * car's condition row for hot-path reads; on car-switch, the
 * pre-switch LIFE state is written back to carConditions[oldId]
 * and the new car's row is loaded into LIFE. Reading the active
 * car always goes through LIFE; reading any other car goes
 * through carConditions[].
 *
 * EXTENSION POINT: when a new mod ships (e.g. v8.99.140 brake
 * upgrade), add a new boolean to LifeState + CarConditionData
 * AND a new push entry in [[getCarMods]] — every UI surface
 * (pause-menu STATUS row, parts-tab indicator, etc.) stays in
 * sync via this single source of truth, matching the monolith
 * comment: "Extensible — add new mods here so every UI surface
 * stays in sync automatically."
 */

import type { LifeState } from '@/state/life';
import type { CarConditionData } from '@/save/carCondition';

/** Mod-key discriminator — matches the LifeState / CarConditionData
 *  field names so an exhaustive switch is straightforward when a
 *  consumer needs to act per-mod. */
export type CarModKey = 'welded' | 'supercharged';

/** Per-mod display entry. `label` is the chrome string the pause-
 *  menu / parts-tab show; `desc` is the longer hover/help blurb.
 *  Both strings match the monolith literally so a UI port can
 *  string-equal against known names. */
export interface CarMod {
  key: CarModKey;
  label: string;
  desc: string;
}

/** Static lookup of mod label/desc by key — keeps the projection
 *  table out of the function body so it's editable in one place
 *  when a new mod lands. */
const MOD_DEFS: Readonly<Record<CarModKey, { label: string; desc: string }>> = {
  welded:       { label: 'Welded Diff',  desc: '100% diff lock' },
  supercharged: { label: 'Supercharger', desc: '+25-40% torque' },
};

/** Return the list of upgrades-over-stock installed on the given
 *  car. Empty array for a stock car.
 *
 *  Source of truth split:
 *    - carId === activeCarId  → reads life.{welded,supercharged}
 *      (the hot-path live flags)
 *    - otherwise              → reads carConditions[carId]?.{welded,
 *      supercharged} (the at-rest persistence record)
 *
 *  Mirrors monolith L42274-42276 — the active-car branch uses LIFE
 *  flags because they may have changed since the carConditions row
 *  was last written (e.g. a part installed mid-day before the next
 *  car-switch flushes the row).
 *
 *  Ported 1:1 from monolith L42272-L42280. */
export function getCarMods(
  carId: string,
  life: LifeState,
  activeCarId: string,
  carConditions: Record<string, CarConditionData>,
): CarMod[] {
  const isActive = carId === activeCarId;
  const welded = isActive
    ? !!life.welded
    : !!carConditions[carId]?.welded;
  const supercharged = isActive
    ? !!life.supercharged
    : !!carConditions[carId]?.supercharged;

  const out: CarMod[] = [];
  if (welded) out.push({ key: 'welded', ...MOD_DEFS.welded });
  if (supercharged) out.push({ key: 'supercharged', ...MOD_DEFS.supercharged });
  return out;
}
