/**
 * H943: DIY visual inspection of the player's OWN active car.
 *
 * Mirrors the used-car seller-visit inspect (inspectSellerCar,
 * src/ui/modals/seller.ts) but operates on the active car's hidden faults
 * (life._hiddenFaults). Rolls each NON-test-drive-only hidden fault against
 * its detectChance; the ones it finds flip `detected` and surface into
 * life.faults (visible + fixable in REPAIRS).
 *
 * Gated to once per in-game day (life._lastInspectDay) so it can't be spammed
 * to reveal everything instantly — driving still surfaces the rest over miles
 * (hiddenFaultReveal), and TEST-DRIVE-ONLY faults need an actual drive, not a
 * stationary look. This is the user's "visually inspect car for faults" option
 * and closes the loop on beaters that carry hidden problems.
 *
 * H948: added a paid `thorough` mode (the garage DIAGNOSE button) that
 * reliably surfaces every reachable hidden fault for a flat fee — the
 * design's paid/fast diagnosis tier — while passive mile-reveal
 * (hiddenFaultReveal) stays the free tier.
 */

import type { LifeState } from '@/state/life';
import type { PreFault } from '@/ui/modals/inspection';
import type { XrayComponentId, XrayCondition } from '@/render/carBody/xrayDrivetrain';
import {
  INSPECT_SUBS, INSPECT_ORDER, isSubReachable, isFaultStationaryReachable,
  type InspectTools,
} from '@/sim/inspectComponents';

export interface InspectResult {
  /** Faults newly surfaced into life.faults this inspection. */
  found: number;
  /** True when the car was already inspected today (no roll happened). */
  already: boolean;
  /** Hidden faults still undiscovered after this pass. */
  remainingHidden: number;
}

export function inspectOwnCar(
  life: LifeState,
  day: number,
  opts?: { thorough?: boolean },
): InspectResult {
  const L = life as LifeState & { _lastInspectDay?: number };
  const hidden = (life._hiddenFaults ?? []) as PreFault[];
  if (L._lastInspectDay === day) {
    return { found: 0, already: true, remainingHidden: hidden.length };
  }
  L._lastInspectDay = day;

  // H948: a paid shop scan (thorough) reliably surfaces every hidden fault
  // it can reach; the free DIY look kept the per-fault detectChance roll.
  // Either way TEST-DRIVE-ONLY faults need an actual drive, not a stationary
  // scan, so they stay hidden here.
  const thorough = opts?.thorough ?? false;
  const faults = (life.faults ?? []) as PreFault[];
  const remaining: PreFault[] = [];
  let found = 0;
  for (const f of hidden) {
    const reveal = !f.testDriveOnly
      && (thorough || Math.random() < (f.detectChance ?? 0.5));
    if (reveal) {
      f.detected = true;
      faults.push({ ...f });
      found++;
    } else {
      remaining.push(f);
    }
  }
  life.faults = faults as unknown[];
  life._hiddenFaults = remaining;
  return { found, already: false, remainingHidden: remaining.length };
}

/** True when the active car hasn't been inspected/scanned yet today.
 *  Lets the paid-scan caller (home overlay) check the once-per-day gate
 *  BEFORE charging the fee, without mutating _lastInspectDay. */
export function canInspectToday(life: LifeState, day: number): boolean {
  return (life as { _lastInspectDay?: number })._lastInspectDay !== day;
}

/** H1298 (INSPECT H-A): roll a SPECIFIC set of hidden-fault ids with a
 *  caller-supplied per-fault chance — the sub-component tap's reveal
 *  engine (docs/INSPECT_SPEC.md §4). Same surface semantics as
 *  inspectOwnCar (detected=true, COPY pushed into life.faults, survivors
 *  stay hidden — REPAIRS lists life.faults verbatim) but NO day latch:
 *  the INSPECT UI owns re-roll gating. TEST-DRIVE-ONLY faults never
 *  reveal from a stationary look; callers print a hint line instead
 *  (see hasHiddenTestDriveFault). Returns the revealed fault names. */
export function inspectFaultIds(
  life: LifeState,
  ids: readonly string[],
  chanceFor: (f: PreFault) => number,
  /** H1300 (INSPECT H-C): TEST-DRIVE-ONLY ids the caller may reveal
   *  anyway — the lift-override subset (torn boots and scored rotors ARE
   *  visible with the car on a lift; docs/INSPECT_SPEC.md §4). Powertrain
   *  and sensor TD ids stay drive-only regardless. */
  allowTestDrive?: readonly string[],
): string[] {
  const hidden = (life._hiddenFaults ?? []) as PreFault[];
  const faults = (life.faults ?? []) as PreFault[];
  const remaining: PreFault[] = [];
  const names: string[] = [];
  for (const f of hidden) {
    const match = !!f.id && ids.includes(f.id);
    const tdOk = !f.testDriveOnly || (!!f.id && (allowTestDrive?.includes(f.id) ?? false));
    const reveal = match && tdOk && Math.random() < chanceFor(f);
    if (reveal) {
      f.detected = true;
      faults.push({ ...f });
      names.push(f.name);
    } else {
      remaining.push(f);
    }
  }
  life.faults = faults as unknown[];
  life._hiddenFaults = remaining;
  return names;
}

/** H1298: does a hidden TEST-DRIVE-ONLY fault live among these ids? The
 *  INSPECT UI prints a "worth a test drive" hint instead of a reveal so
 *  the test-drive economy survives the new inspection. */
export function hasHiddenTestDriveFault(life: LifeState, ids: readonly string[]): boolean {
  const hidden = (life._hiddenFaults ?? []) as PreFault[];
  return hidden.some((f) => !!f.id && ids.includes(f.id) && f.testDriveOnly === true);
}

/** H1299/H1301: the per-car per-DAY inspection latch store, shared by the
 *  garage INSPECT flow (per-sub keys) and the shop inspections
 *  ('_shop_<venue>' keys). Keyed by car id; the whole map resets when the
 *  day changes; rides the wholesale save. */
export function inspectDailyLatchStore(life: LifeState, day: number, carId: string): Record<string, boolean> {
  const l = life as { _inspectDaily?: { day: number; byCar: Record<string, Record<string, boolean>> } };
  if (!l._inspectDaily || l._inspectDaily.day !== day) l._inspectDaily = { day, byCar: {} };
  const byCar = l._inspectDaily.byCar;
  if (!byCar[carId]) byCar[carId] = {};
  return byCar[carId];
}

/** H1302/H1304: per-car record of the SUB-COMPONENTS the player (or a shop)
 *  has actually checked, keyed '<component>:<subKey>'. Persistent — it rides
 *  the wholesale `life` blob in save/interim.ts, like _hiddenFaults — and
 *  deliberately NOT daily: an earned color must not evaporate at midnight.
 *
 *  H1302 stored one flag per COMPONENT, set the moment the player opened the
 *  focus panel. That was too generous: opening a panel is not inspecting it.
 *  Sub-level keys are what let componentInspectColored() tell "inspected" from
 *  "glanced at". */
export function inspectCheckedStore(life: LifeState, carId: string): Record<string, boolean> {
  const l = life as { _inspectSeen?: Record<string, Record<string, boolean>> };
  if (!l._inspectSeen) l._inspectSeen = {};
  if (!l._inspectSeen[carId]) l._inspectSeen[carId] = {};
  return l._inspectSeen[carId];
}

/** Record that a sub-check actually happened. Whether it FOUND anything is
 *  a separate question — see componentInspectColored. */
export function markSubChecked(
  life: LifeState, carId: string, comp: XrayComponentId, subKey: string,
): void {
  inspectCheckedStore(life, carId)[comp + ':' + subKey] = true;
}

/** H1304: a shop inspection goes over the whole car, so every sub counts as
 *  checked. Shops are fallible (H1301) — anything their rolls missed still
 *  holds its component gray through the `cleared` half of the rule below. */
export function markAllSubsChecked(life: LifeState, carId: string): void {
  const s = inspectCheckedStore(life, carId);
  for (const comp of INSPECT_ORDER) {
    for (const sub of INSPECT_SUBS[comp] ?? []) s[comp + ':' + sub.key] = true;
  }
}

/** H1304: THE RULE (user): "No part should be green, yellow, or red until
 *  after it has been inspected. If a player fails to accurately inspect a
 *  component, the component should remain gray."
 *
 *  A component earns its condition color only when BOTH hold:
 *    1. every sub-check the player can currently reach has been done, and
 *    2. no hidden fault that such a check COULD have caught is still hiding.
 *
 *  (2) is the "failed to inspect accurately" half — a missed roll leaves the
 *  component gray. It is evaluated live rather than latched, so it self-heals:
 *  when the fault later surfaces (miles, a test drive, a shop), the component
 *  colors on its own without a second inspection. */
export function componentInspectColored(
  life: LifeState,
  carId: string,
  comp: XrayComponentId,
  hidden: readonly PreFault[],
  tools: InspectTools,
): boolean {
  const checked = inspectCheckedStore(life, carId);
  const subs = INSPECT_SUBS[comp] ?? [];
  for (const sub of subs) {
    if (!isSubReachable(sub, tools)) continue;   // can't reach it => can't require it
    if (!checked[comp + ':' + sub.key]) return false;
  }
  for (const f of hidden) {
    if (isFaultStationaryReachable(f, comp, tools)) return false;
  }
  return true;
}

/** H1304: the per-lane gray override for an own car's X-ray. ONE place maps
 *  components onto the drawn lanes, so every X-ray surface tells the same
 *  story. `hidden` is the car's undetected fault list (life._hiddenFaults for
 *  the active car, the carConditions record for a garaged one). */
export function buildInspectGray(
  life: LifeState,
  carId: string,
  hidden: readonly unknown[] | undefined,
  tools: InspectTools,
): NonNullable<XrayCondition['gray']> {
  const h = (hidden ?? []) as PreFault[];
  const gray = (comp: XrayComponentId): boolean => !componentInspectColored(life, carId, comp, h, tools);
  return {
    engine: gray('engine'),
    trans: gray('transmission'),
    drive: gray('driveline'),
    steer: gray('steering'),
    cool: gray('cooling'),
    susp: gray('suspension'),
    tires: gray('wheels'),
  };
}

/** H1301 (INSPECT H-D): shop inspection fees + the HIRED mechanic's skill
 *  (docs/INSPECT_SPEC.md §5, user decision: shops are fallible too — they
 *  roll like the player does, just better). Dealer costs 3× and hires the
 *  master tech. */
export const SHOP_INSPECT = {
  mechanic: { fee: 120, skill: 65 },
  dealer: { fee: 360, skill: 90 },
} as const;

/** True when this venue hasn't inspected this car today (check BEFORE
 *  charging — the latch is only set by shopInspect itself). */
export function canShopInspectToday(
  life: LifeState, day: number, carId: string, venue: keyof typeof SHOP_INSPECT,
): boolean {
  return !inspectDailyLatchStore(life, day, carId)['_shop_' + venue];
}

/** H1301: the shop inspection. The hired mechanic rolls EVERY hidden
 *  fault — shops have a lift (the +0.15 access bonus is baked in) and
 *  take the car around the block, so TEST-DRIVE-ONLY faults are rollable
 *  here too (the only stationary surface that can catch them). Fallible:
 *  the same clamp as the player's rolls, nothing is guaranteed. Reveal
 *  semantics identical to inspectFaultIds. Once per car per day per
 *  venue via the shared daily latch. */
export function shopInspect(
  life: LifeState,
  day: number,
  carId: string,
  venue: keyof typeof SHOP_INSPECT,
): { already: boolean; names: string[]; remainingHidden: number } {
  const latch = inspectDailyLatchStore(life, day, carId);
  const key = '_shop_' + venue;
  const hidden = (life._hiddenFaults ?? []) as PreFault[];
  if (latch[key]) return { already: true, names: [], remainingHidden: hidden.length };
  latch[key] = true;
  markAllSubsChecked(life, carId); // H1304: the shop went over everything
  const skill = SHOP_INSPECT[venue].skill;
  const faults = (life.faults ?? []) as PreFault[];
  const remaining: PreFault[] = [];
  const names: string[] = [];
  for (const f of hidden) {
    const p = Math.max(0.05, Math.min(0.95, (f.detectChance ?? 0.5) + skill * 0.003 + 0.15));
    if (Math.random() < p) {
      f.detected = true;
      faults.push({ ...f });
      names.push(f.name);
    } else {
      remaining.push(f);
    }
  }
  life.faults = faults as unknown[];
  life._hiddenFaults = remaining;
  return { already: false, names, remainingHidden: remaining.length };
}
