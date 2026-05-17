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
import { swapBackToPersonalCar } from '@/sim/jobVehicleSwap';

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
  // H240: pause job-arrival checks while the player is in a
  // test drive. Otherwise pickup/delivery could fire mid-drive
  // and conflict with the test-drive restore: swapBackToPersonalCar
  // would null out life.savedCar before endTestDrive's tdSavedCar
  // restore lands, leaving the player stuck in the ambulance/etc.
  // with the personal car unrecoverable. Test drive owns the car
  // for its 45-second window — pause everything else that touches
  // ownedCars[0] until phase flips back to 'menu'.
  if (life.sellerVisit?.phase === 'testdrive') return false;
  // Special-case branches sit on un-ported state — bail out so
  // mainline rules don't fire for TOW (needs towJob.hooked), TRUCK
  // (needs life.trailer), TANKER (same).
  if (
    job.type === 'TOW TRUCK'
    || job.type === 'TRUCK DRIVER'
    || job.type === 'FUEL TANKER'
  ) return false;

  // H216: OFFICE JOB arrival opens the office modal instead of
  // completing the delivery. The modal owns the rest of the day
  // (coffee / work / lunch / continue or leave-early) and calls
  // completeOfficeDay on close. We still flag pickedUp here so the
  // modal's "afternoon check-in" can re-fire if the player tabs
  // away mid-day (cancel → drive away → drive back).
  if (job.type === 'OFFICE JOB') {
    const dx = player.px - (job.toX ?? 0);
    const dy = player.py - (job.toY ?? 0);
    if (dx * dx + dy * dy < DELIVERY_RADIUS_PX2 && !life.officeMenu) {
      life.officeMenu = { phase: 'arrive', coffeeTaken: false, lunchTaken: false };
      player.pSpeed = 0;
      showNotif('🏢 Arrived at the office!');
      return true;
    }
    return false;
  }
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
    // H206: restore personal car when the shift ends. No-op when
    // the job didn't swap vehicles (FOOD DELIVERY / AUTO PARTS RUN).
    // 1:1 with monolith L42219 delivery-restore.
    swapBackToPersonalCar(life);
    return true;
  }
  return false;
}
