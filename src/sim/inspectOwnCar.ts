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
