/**
 * H864: day-rollover resolver for the pending-parts / repair queue — the
 * load-bearing foundation of the repair difficulty/time economy
 * (see memory: repair-economy). Re-ports the monolith's tickPendingParts
 * (L42291) onto the previously-dead-but-persisted life.pendingParts field.
 *
 * A repair/part order is queued elsewhere with readyDay = clock.day +
 * venue.time (days). This resolver, run once per day-rollover, completes
 * every job whose readyDay has arrived:
 *   - a DELIVERY part lands in life.ownedParts (install happens later and
 *     costs a time slot),
 *   - any other job (mechanic/dealer repair, or a fault fix) applies its
 *     stat bump to the target car via the injected applyToCar.
 * It returns the completed jobs so the caller can surface a notification.
 *
 * H864 SCOPE: nothing WRITES to life.pendingParts yet — the order paths
 * that push jobs (and the DIY-slot / failure / backlog / deadline layers)
 * land in later commits. This resolver is wired into the rollover and
 * correct, but a no-op until the queue has entries.
 */

import type { LifeState, PendingPart, RepairStat } from '@/state/life';
import type { Clock } from '@/state/clock';

/** Apply `add` percentage points to a car's condition `stat` (clamped
 *  0..100). Injected by the caller so this module stays decoupled from the
 *  active-car-vs-garaged-car condition store. 'all' bumps every stat. */
export type ApplyToCar = (carId: string, stat: RepairStat, add: number) => void;

/** One completed queue job, for the caller's completion notif. */
export interface CompletedRepair {
  name: string;
  venue: PendingPart['venue'];
  /** true = a delivery part arrived in inventory (needs install); false =
   *  the repair/install was applied to the car. */
  delivered: boolean;
  carId: string;
  /** H866: set when this job repaired a diagnosed fault — the caller removes
   *  the matching fault from the car on completion (the stat bump is already
   *  applied via applyToCar). */
  faultId?: string;
  /** H876: set when this job installed an upgrade stage — the caller advances
   *  life.carUpgrades on completion (no stat bump was applied). */
  upgrade?: { kind: 'power' | 'weight' | 'brakes' | 'suspension' | 'tires'; stage: number };
}

/**
 * Resolve any pending jobs whose readyDay has arrived. Call once per
 * day-rollover, AFTER clock.day has advanced. Mutates life.pendingParts
 * (removes completed) and life.ownedParts (delivered parts). Returns the
 * completed jobs (empty when the queue is empty or nothing is due).
 */
export function tickPendingParts(
  life: LifeState,
  clock: Clock,
  applyToCar: ApplyToCar,
): CompletedRepair[] {
  const queue = life.pendingParts;
  if (!queue || queue.length === 0) return [];

  const done: CompletedRepair[] = [];
  const remaining: PendingPart[] = [];

  for (const p of queue) {
    if (clock.day >= p.readyDay) {
      if (p.upgrade) {
        // H876: upgrade install — no condition-stat bump; the caller advances
        // the upgrade stage from the carried payload.
        done.push({ name: p.name, venue: p.venue, delivered: false, carId: p.carId, upgrade: p.upgrade });
      } else if (p.isDelivery) {
        life.ownedParts.push({ name: p.name, stat: p.stat, add: p.add, carId: p.carId });
        done.push({ name: p.name, venue: p.venue, delivered: true, carId: p.carId, faultId: p.faultId });
      } else {
        applyToCar(p.carId, p.stat, p.add);
        done.push({ name: p.name, venue: p.venue, delivered: false, carId: p.carId, faultId: p.faultId });
      }
    } else {
      // H942: advance the DIY work meter one 8h block per day so the REPAIRS
      // screen shows hours-of-work progress (8h/block) rather than a static
      // "ready Day N". Display-only — completion stays driven by readyDay above
      // (totalHours = days×8 keeps them in sync). Mechanic/dealer have no meter.
      if (p.venue === 'diy' && typeof p.totalHours === 'number') {
        p.hoursDone = Math.min(p.totalHours, (p.hoursDone ?? 0) + 8);
      }
      remaining.push(p);
    }
  }

  life.pendingParts = remaining;
  return done;
}
