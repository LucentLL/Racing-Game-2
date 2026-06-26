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

export function inspectOwnCar(life: LifeState, day: number): InspectResult {
  const L = life as LifeState & { _lastInspectDay?: number };
  const hidden = (life._hiddenFaults ?? []) as PreFault[];
  if (L._lastInspectDay === day) {
    return { found: 0, already: true, remainingHidden: hidden.length };
  }
  L._lastInspectDay = day;

  const faults = (life.faults ?? []) as PreFault[];
  const remaining: PreFault[] = [];
  let found = 0;
  for (const f of hidden) {
    if (!f.testDriveOnly && Math.random() < (f.detectChance ?? 0.5)) {
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
