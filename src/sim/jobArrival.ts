/**
 * Per-frame job-arrival check — flips life.job.pickedUp at the
 * pickup point and finalizes the delivery at the drop-off point.
 *
 * 1:1 port of monolith L42140-42158 (pickup) and L42176-42211
 * (delivery) for the MAINLINE branch (FOOD DELIVERY / AUTO PARTS
 * RUN / PACKAGE COURIER / PARAMEDIC) plus TRUCK DRIVER (H897 — docks
 * at A/B and hooks/drops a real life.trailer). Special-case branches
 * still deferred: TOW TRUCK (loadProgress + towJob) and FUEL TANKER
 * (GAS_STATIONS depot/delivery + free-fuel perk). OFFICE JOB opens
 * the office modal at arrival rather than completing a delivery.
 *
 * Pay math: `adjPay = round(job.pay * payMultiplier * perfMult)`,
 * where perfMult derives from work-performance reputation (1.0 at
 * ≥50% else 0.85 — monolith L42185). H512 wires the real
 * getWorkPerformance helper (sleep-debt + age scalar with optional
 * coffee-buff step-down).
 */

import type { LifeState } from '@/state/life';
import type { PlayerState } from '@/state/player';
import { TILE } from '@/config/world/tiles';
import { swapBackToPersonalCar } from '@/sim/jobVehicleSwap';
import { getWorkPerformance } from '@/sim/workPerformance';

/** Pickup radius² = 2 tiles (monolith uses TILE*TILE*4 at L42154). */
const PICKUP_RADIUS_PX2 = TILE * TILE * 4;
/** Delivery radius² = 2 tiles for the mainline branch (TILE*TILE*4
 *  at L42183 when !needStop). */
const DELIVERY_RADIUS_PX2 = TILE * TILE * 4;
/** H897: TRUCK DRIVER pickup + delivery radius² — wider than the
 *  mainline (the rig has to dock the trailer, not drive through a
 *  point). 1:1 with monolith TILE*TILE*6 at L42144 (pickup) +
 *  L42183 (delivery, needStop branch). */
const TRUCK_RADIUS_PX2 = TILE * TILE * 6;
/** H897: the rig must come to a near-stop to hook the trailer at A
 *  and drop it at B. 1:1 with monolith `Math.abs(pSpeed)<3` at
 *  L42144 / L42183. */
const TRUCK_STOP_SPEED = 3;

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
  // mainline rules don't fire for TOW (needs towJob.hooked) and
  // TANKER (delivers to a GAS_STATIONS depot + free-fuel perk, not
  // yet ported). TRUCK DRIVER (H897) is handled inline below — it
  // hooks/drops a real life.trailer at A/B. TRAFFIC COP (H1126) is
  // patrol-only: the shift ends via issueTrafficTicket, never via
  // A→B arrival (pre-H1126 saves may still carry random cop coords
  // — this bail also keeps those from paying out).
  if (
    job.type === 'TOW TRUCK'
    || job.type === 'FUEL TANKER'
    || job.type === 'TRAFFIC COP'
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
      // H508: stop the Phase 0B integrator's world-frame velocity
      // too. Without this, pVx/pVy retain the pre-arrival velocity
      // and the next reprojectPSpeed tick blends pSpeed back up
      // from zero (post-office-menu, the player would start
      // rolling on their own). Setting phase0B = undefined makes
      // the next eligible frame re-seed from the freshly-zeroed
      // PlayerState pose.
      player.phase0B = undefined;
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

  // H897: TRUCK DRIVER docks at A/B (wider radius + near-stop) and
  // hooks/drops a real trailer; mainline jobs drive through on
  // proximity alone.
  const isTruck = job.type === 'TRUCK DRIVER';

  if (!job.pickedUp) {
    const dx = player.px - fromX;
    const dy = player.py - fromY;
    const d2 = dx * dx + dy * dy;
    if (isTruck) {
      // Pull up to A and (nearly) stop to hook the trailer. 1:1 with
      // monolith L42144-42153 (TRUCK DRIVER branch of isTruckPickup).
      if (d2 < TRUCK_RADIUS_PX2 && Math.abs(player.pSpeed) < TRUCK_STOP_SPEED) {
        job.pickedUp = true;
        life.trailer = {
          angle: player.pAngle,
          length: 73,
          // H898b: 17 (was 12) so the box body overhangs the semi's
          // drive tandems — at road-true scale (H805) the Peterbilt cab
          // is ~16.25 GU wide (spec wid:2591mm), and a 53' trailer is
          // about cab-width. 12 left the tandems poking out the sides.
          width: 17,
          jackknife: 0,
          trailerType: 'box',
          loadWeight: 0.3 + Math.random() * 0.7,
        };
        showNotif('🚛 TRAILER HOOKED! Deliver to drop-off point B');
        return true;
      }
      return false;
    }
    if (d2 < PICKUP_RADIUS_PX2) {
      job.pickedUp = true;
      showNotif('PICKED UP! Now deliver.');
      return true;
    }
    return false;
  }

  // Delivery.
  const dx = player.px - toX;
  const dy = player.py - toY;
  const d2 = dx * dx + dy * dy;

  if (isTruck) {
    // Dock at B and (nearly) stop to drop the trailer. 1:1 with
    // monolith L42180-42208 (isTruckJob branch). perfMult/adjPay are
    // the shared mainline pay math.
    if (d2 < TRUCK_RADIUS_PX2 && Math.abs(player.pSpeed) < TRUCK_STOP_SPEED) {
      const perfMult = getWorkPerformance(life) >= 0.5 ? 1.0 : 0.85;
      const adjPay = Math.round(job.pay * (life.payMultiplier ?? 1) * perfMult);
      life.money += adjPay;
      life.trailer = null;
      showNotif('🚛 DELIVERED! +$' + adjPay + ' — Go Home');
      life.job = null;
      life.jobDoneToday = true;
      swapBackToPersonalCar(life);
      return true;
    }
    return false;
  }

  if (d2 < DELIVERY_RADIUS_PX2) {
    // H512: real work-performance modifier — sleep debt + age scalar
    // collapses to a 0.5-threshold binary pay multiplier (1.0× when
    // rested-enough; 0.85× when sleep-deprived). 1:1 with monolith
    // L42184-L42185 `perfMult = getWorkPerformance() >= 0.5 ? 1.0 : 0.85`.
    const perfMult = getWorkPerformance(life) >= 0.5 ? 1.0 : 0.85;
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
