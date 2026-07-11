/**
 * Per-frame job-arrival check — flips life.job.pickedUp at the
 * pickup point and finalizes the delivery at the drop-off point.
 *
 * 1:1 port of monolith L42140-42158 (pickup) and L42176-42211
 * (delivery) for the MAINLINE branch (FOOD DELIVERY / AUTO PARTS
 * RUN / PACKAGE COURIER / PARAMEDIC) plus TRUCK DRIVER (H897 — docks
 * at A/B and hooks/drops a real life.trailer). H1127 rebuilt the
 * run machine around a per-job ARRIVAL_SPECS table (radii, near-stop,
 * notif copy, onPickup/onDeliver hooks) — same behavior, but a new
 * delivery job is now a data row, not new branches. H1128 added the
 * FUEL TANKER row (depot→station, tanker trailer hook/drop, delivery
 * fuel top-up). Still deferred: TOW TRUCK (loadProgress + towJob —
 * un-bails via a spec row in H1129). OFFICE JOB opens the office
 * modal at arrival rather than completing a delivery.
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

/** H1127: per-job arrival behavior — the DeliveryTask run machine.
 *  One spec drives both ends of a delivery: proximity radii, the
 *  near-stop requirement, notif copy, and the state hooks that fire
 *  on each end (TRUCK's trailer hook/drop lives here now instead of
 *  inline branches). Adding a job = adding a row; the tick below
 *  never changes. */
interface ArrivalSpec {
  pickupR2: number;
  deliverR2: number;
  /** Near-stop (|pSpeed| < TRUCK_STOP_SPEED) required at both ends. */
  needStop: boolean;
  pickupMsg: string;
  deliverMsg: (adjPay: number) => string;
  onPickup?: (life: LifeState, player: PlayerState) => void;
  onDeliver?: (life: LifeState) => void;
}

/** Drive-through pickup/drop at 2 tiles — FOOD DELIVERY / AUTO PARTS
 *  RUN / PACKAGE COURIER / PARAMEDIC (and any job without its own
 *  row). 1:1 with the monolith mainline branch. */
const MAINLINE_SPEC: ArrivalSpec = {
  pickupR2: PICKUP_RADIUS_PX2,
  deliverR2: DELIVERY_RADIUS_PX2,
  needStop: false,
  pickupMsg: 'PICKED UP! Now deliver.',
  deliverMsg: (adjPay) => 'DELIVERED! +$' + adjPay + ' — Go Home',
};

const ARRIVAL_SPECS: Record<string, ArrivalSpec> = {
  // H897 behavior, now data: dock at A/B (wider radius + near-stop),
  // hook a real life.trailer at pickup, drop it at delivery.
  'TRUCK DRIVER': {
    pickupR2: TRUCK_RADIUS_PX2,
    deliverR2: TRUCK_RADIUS_PX2,
    needStop: true,
    pickupMsg: '🚛 TRAILER HOOKED! Deliver to drop-off point B',
    deliverMsg: (adjPay) => '🚛 DELIVERED! +$' + adjPay + ' — Go Home',
    onPickup: (life, player) => {
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
    },
    onDeliver: (life) => {
      life.trailer = null;
    },
  },
  // H1128: FUEL TANKER — same dock-and-stop shape as the box truck.
  // 1:1 with monolith L42147-42151 (hook) + L42196-42200 (deliver):
  // hooks the reserved trailerType:'tanker' at the depot, drops it at
  // the station, and tops the tank to 100 (the delivery-time half of
  // the free-fuel perk; the at-pump half already lives in
  // sim/gasStation.ts `isFreePerk`).
  'FUEL TANKER': {
    pickupR2: TRUCK_RADIUS_PX2,
    deliverR2: TRUCK_RADIUS_PX2,
    needStop: true,
    pickupMsg: '⛽ TANKER HOOKED! Deliver to gas station',
    deliverMsg: (adjPay) => '⛽ STATION RESUPPLIED! +$' + adjPay + ' + FREE FUEL — Go Home',
    onPickup: (life, player) => {
      life.trailer = {
        angle: player.pAngle,
        length: 58,
        // Monolith width 11; scaled by the H898b road-true ratio the
        // box trailer got (12→17) → 11×(17/12) ≈ 16, keeping the
        // tanker-narrower-than-van proportion.
        width: 16,
        jackknife: 0,
        trailerType: 'tanker',
        loadWeight: 0.7 + Math.random() * 0.3,
      };
    },
    onDeliver: (life) => {
      life.trailer = null;
      life.fuel = 100; // free fuel perk (monolith L42198)
    },
  },
};

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
  // mainline rules don't fire for TOW (needs towJob.hooked; H1129).
  // TRUCK DRIVER (H897) + FUEL TANKER (H1128) run through the
  // ARRIVAL_SPECS rows below. TRAFFIC COP (H1126) is patrol-only:
  // the shift ends via issueTrafficTicket, never via A→B arrival
  // (pre-H1126 saves may still carry random cop coords — this bail
  // also keeps those from paying out).
  if (
    job.type === 'TOW TRUCK'
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

  // H1127: one spec-driven run machine for every delivery-shaped job
  // (was: inline isTruck branches at pickup AND delivery). Behavior
  // is 1:1 — TRUCK DRIVER's row carries the H897 radii/stop/trailer
  // hooks; everything else runs MAINLINE_SPEC.
  const spec = ARRIVAL_SPECS[job.type] ?? MAINLINE_SPEC;
  const stopOk = !spec.needStop || Math.abs(player.pSpeed) < TRUCK_STOP_SPEED;

  if (!job.pickedUp) {
    const dx = player.px - fromX;
    const dy = player.py - fromY;
    if (dx * dx + dy * dy < spec.pickupR2 && stopOk) {
      job.pickedUp = true;
      spec.onPickup?.(life, player);
      showNotif(spec.pickupMsg);
      return true;
    }
    return false;
  }

  // Delivery.
  const dx = player.px - toX;
  const dy = player.py - toY;
  if (dx * dx + dy * dy < spec.deliverR2 && stopOk) {
    // H512: real work-performance modifier — sleep debt + age scalar
    // collapses to a 0.5-threshold binary pay multiplier (1.0× when
    // rested-enough; 0.85× when sleep-deprived). 1:1 with monolith
    // L42184-L42185 `perfMult = getWorkPerformance() >= 0.5 ? 1.0 : 0.85`.
    const perfMult = getWorkPerformance(life) >= 0.5 ? 1.0 : 0.85;
    const adjPay = Math.round(job.pay * (life.payMultiplier ?? 1) * perfMult);
    life.money += adjPay;
    spec.onDeliver?.(life);
    showNotif(spec.deliverMsg(adjPay));
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
