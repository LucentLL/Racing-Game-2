/**
 * Per-frame job-arrival check — flips life.job.pickedUp at the
 * pickup point and finalizes the delivery at the drop-off point.
 *
 * 1:1 port of monolith L42140-42158 (pickup) and L42176-42211
 * (delivery) for the MAINLINE branch (FOOD DELIVERY / AUTO PARTS
 * RUN / PACKAGE COURIER / PARAMEDIC). Special-case branches that
 * depend on un-ported state — TOW TRUCK (loadProgress + towJob),
 * TRUCK DRIVER / FUEL TANKER (LIFE.trailer hook-up), OFFICE JOB
 * (officeMenu state) — defer to a follow-up.
 *
 * Pay math: `adjPay = round(job.pay * payMultiplier * perfMult)`,
 * where perfMult derives from work-performance reputation (1.0 at
 * ≥50% else 0.85 — monolith L42185). H202 defers perfMult to a
 * flat 1.0 since getWorkPerformance isn't ported.
 */

import type { LifeState } from '@/state/life';
import type { PlayerState } from '@/state/player';
import { TILE } from '@/config/world/tiles';

/** Pickup radius² = 2 tiles (monolith uses TILE*TILE*4 at L42154). */
const PICKUP_RADIUS_PX2 = TILE * TILE * 4;
/** Delivery radius² = 2 tiles for the mainline branch (TILE*TILE*4
 *  at L42183 when !needStop). */
const DELIVERY_RADIUS_PX2 = TILE * TILE * 4;

/** Per-frame arrival check. Mutates life.job + life.money + life
 *  .jobDoneToday based on player proximity. No-op when no job is
 *  active or the job's a special-case type (returns early so the
 *  un-ported branches don't accidentally fire under the mainline
 *  rules).
 *
 *  Returns true when state changed (pickup or delivery fired) so
 *  the caller can react — currently only used for telemetry. */
export function tickJobArrival(
  life: LifeState,
  player: PlayerState,
  showNotif: (msg: string) => void,
): boolean {
  const job = life.job;
  if (!job) return false;
  // Special-case branches sit on un-ported state — bail out so
  // mainline rules don't fire for TOW (needs towJob.hooked), TRUCK
  // (needs life.trailer), TANKER (same), or OFFICE (needs
  // officeMenu init).
  if (
    job.type === 'TOW TRUCK'
    || job.type === 'TRUCK DRIVER'
    || job.type === 'FUEL TANKER'
    || job.type === 'OFFICE JOB'
  ) return false;
  // Mainline jobs always carry pickup/delivery coords — guard
  // against missing values from a save schema mismatch.
  const fromX = job.fromX ?? 0;
  const fromY = job.fromY ?? 0;
  const toX = job.toX ?? 0;
  const toY = job.toY ?? 0;
  if (!fromX || !toX) return false;

  if (!job.pickedUp) {
    const dx = player.px - fromX;
    const dy = player.py - fromY;
    if (dx * dx + dy * dy < PICKUP_RADIUS_PX2) {
      job.pickedUp = true;
      showNotif('PICKED UP! Now deliver.');
      return true;
    }
    return false;
  }

  // Delivery.
  const dx = player.px - toX;
  const dy = player.py - toY;
  if (dx * dx + dy * dy < DELIVERY_RADIUS_PX2) {
    // perfMult would be getWorkPerformance() >= 0.5 ? 1.0 : 0.85.
    // getWorkPerformance isn't ported; use 1.0 for now.
    const perfMult = 1.0;
    const adjPay = Math.round(job.pay * (life.payMultiplier ?? 1) * perfMult);
    life.money += adjPay;
    showNotif('DELIVERED! +$' + adjPay + ' — Go Home');
    life.job = null;
    life.jobDoneToday = true;
    return true;
  }
  return false;
}
