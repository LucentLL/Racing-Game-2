/**
 * Seller-visit test-drive transitions + tick.
 *
 * Activates the H186 testdrive HUD by flipping life.sellerVisit.phase
 * from 'menu' → 'testdrive' for 45 seconds. While the timer is alive
 * the player drives the LISTED car (swapped into ownedCars[0]) with
 * the listing's condition values; on expiry — or on an early tap on
 * the top-bar — the original car is restored and any testDriveOnly
 * faults the roll happens to surface become `detected`, refreshing
 * the H185 menu's KNOWN ISSUES section on the next paint.
 *
 * Ported from monolith L49684-L49770 (startTestDrive /
 * updateTestDrive / endTestDrive). Sub-system status:
 *   - H514 wired the L49716-L49730 mid-drive symptom stream — every
 *     3s during the drive, 25% chance to surface a hidden fault's
 *     FAULT_EFFECTS.desc as a `⚠ <hint>` notif. Gated on
 *     |pSpeed| > 5 so symptoms only fire while the player is
 *     actually driving.
 *   - The L49764 faultPriceDiscount re-application on found-faults
 *     is already wired in endTestDrive (H190) — both halves of the
 *     drive-end pipeline run as expected.
 *
 * The car-swap operates on ownedCars[0] in place. During the drive
 * the listed car is technically "in" the player's owned-cars array;
 * endTestDrive restores the original. This matches the monolith's
 * `activeCar = L.id` mutation pattern (the monolith's CAR_IDS array
 * gain is a no-op on our side because CAR_CATALOG is a static map,
 * not a runtime registry).
 */

import type { LifeState } from '@/state/life';
import type { PlayerState } from '@/state/player';
import type { SellerVisitState } from '@/ui/modals/seller';
import type { PreFault } from '@/ui/modals/inspection';
import { faultPriceDiscount } from '@/sim/usedCarFaults';
import { FAULT_EFFECTS } from '@/sim/faultEffects';

/** Test drive duration in seconds. 1:1 with monolith L49704. */
export const TEST_DRIVE_DURATION_SEC = 45;

/** Snapshot taken on test-drive start. Restored on end. Mirrors
 *  monolith L49690-49692 (`sv.tdSavedCar = {...}`) + the implicit
 *  per-field state monolith carries on LIFE.engine/tires/etc. */
export interface TdSavedCar {
  carId: string;
  px: number;
  py: number;
  pAngle: number;
  engine: number;
  tires: number;
  carHP: number;
  paint: number;
  fuel: number;
  faults: unknown[];
}

/** Begin the test drive. Swaps the player's active car for the
 *  listing's, overwrites condition stats with listing.cond, seeds a
 *  fresh fault list from sv.preFaults, sets phase + timer. 1:1 port
 *  of monolith L49684-49708. */
export function startTestDrive(
  life: LifeState,
  sv: SellerVisitState,
  player: PlayerState,
  showNotif: (msg: string) => void,
): void {
  const prevCarId = life.ownedCars[0];
  if (!prevCarId) return;
  const L = sv.listing;

  sv.tdSavedCar = {
    carId: prevCarId,
    px: player.px,
    py: player.py,
    pAngle: player.pAngle,
    engine: life.engine,
    tires: life.tires,
    carHP: life.carHP,
    paint: life.paint,
    fuel: life.fuel,
    faults: JSON.parse(JSON.stringify(life.faults ?? [])) as unknown[],
  } satisfies TdSavedCar;

  // Swap ownedCars[0] in place — matches monolith's `activeCar = L.id`.
  life.ownedCars[0] = L.id;
  life.engine = L.cond;
  life.tires = L.cond;
  life.carHP = L.cond;
  life.paint = L.isNew ? 100 : L.cond;
  life.fuel = 80;
  // Seed faults from preFaults so the player feels detected + hidden
  // issues during the drive. Deep-copy so mutating per-frame fault
  // state doesn't leak back into sv.preFaults.
  life.faults = sv.preFaults.map((f) => ({ ...f }));

  sv.phase = 'testdrive';
  sv.testDriveTimer = TEST_DRIVE_DURATION_SEC;
  player.pSpeed = 0;
  // H508: drop the Phase 0B integrator state so the test-drive
  // car doesn't inherit the previous car's pVx/pVy/pYawRate/etc.
  // See switchCar (H507) for the broader rationale; this is the
  // same fix at the test-drive entry point.
  player.phase0B = undefined;
  showNotif('Test drive — 45 seconds!');
}

/** End the test drive (called by tap-to-end OR timer-expiry). Restores
 *  the player's original car + position, rolls testDriveOnly faults
 *  for end-of-drive detection, surfaces a result notif. 1:1 port of
 *  monolith L49737-49770 minus the L49764 faultPriceDiscount call
 *  (table not ported; sv.haggled still gets reset so the player can
 *  re-haggle once that lands). */
export function endTestDrive(
  life: LifeState,
  sv: SellerVisitState,
  player: PlayerState,
  showNotif: (msg: string) => void,
): void {
  const saved = sv.tdSavedCar as TdSavedCar | null;
  if (!saved) return;

  life.ownedCars[0] = saved.carId;
  life.engine = saved.engine;
  life.tires = saved.tires;
  life.carHP = saved.carHP;
  life.paint = saved.paint;
  life.fuel = saved.fuel;
  life.faults = saved.faults;
  player.px = saved.px;
  player.py = saved.py;
  player.pAngle = saved.pAngle;
  player.pSpeed = 0;
  // H508: drop the Phase 0B integrator state on test-drive exit
  // for the same reason as the test-drive entry — the original car
  // is back, position teleported, integrator pVx/pVy and rear-axle
  // tracking would otherwise carry the test car's mid-motion state
  // into the restored car.
  player.phase0B = undefined;

  sv.phase = 'menu';
  sv.tdSavedCar = null;
  sv._testDriven = true;

  // End-of-drive testDriveOnly fault reveal. Each undetected
  // testDriveOnly fault gets one Math.random() roll against
  // detectChance (default 0.4 — monolith L49759).
  let found = 0;
  for (const f of sv.preFaults as PreFault[]) {
    if (!f.detected && f.testDriveOnly && Math.random() < (f.detectChance ?? 0.4)) {
      f.detected = true;
      found++;
    }
  }
  if (found > 0) {
    // H190: re-derive hagglePrice from the new detected-fault set,
    // and reset haggled so the player can re-haggle with the
    // updated info. 1:1 with monolith L49764-49766.
    const disc = faultPriceDiscount(sv.preFaults);
    sv.hagglePrice = Math.round(sv.listing.price * disc);
    sv.haggled = false;
    showNotif(
      'Test drive: ' + found + ' issue' + (found > 1 ? 's' : '') + ' felt while driving!',
    );
  } else {
    showNotif('Test drive done — drove fine');
  }
}

/** Symptom-stream reveal-check cadence (seconds). Every time the
 *  accumulator crosses this we roll for a hidden-fault hint. 3s is
 *  slow enough that the player has a chance to feel the symptom
 *  through driving before the notif fires, but fast enough that the
 *  45s test drive can surface several hidden faults if the listing
 *  has many. Matches monolith `sv._revealTimer > 3` at L49718. */
export const SYMPTOM_REVEAL_INTERVAL_SEC = 3;

/** Per-tick chance to surface a hidden fault symptom when the
 *  3-second check fires. The player has to be moving (|pSpeed| > 5)
 *  AND lucky for any given check to hit. Matches monolith
 *  `Math.random() < 0.25` at L49725. */
export const SYMPTOM_REVEAL_CHANCE = 0.25;

/** Minimum |pSpeed| (gu/s) for the symptom stream to fire. Slower
 *  than this and the player can't feel anything wrong — the symptom
 *  is supposed to surface through DRIVING, not idling. Matches
 *  monolith `Math.abs(pSpeed) > 5` at L49721. */
export const SYMPTOM_REVEAL_SPEED_GATE = 5;

/** Fallback hint text when a fault has no FAULT_EFFECTS desc string.
 *  Defensive: every fault id in the modular tree's FAULT_EFFECTS
 *  table has a desc, but if a save carries a fault id from a future
 *  monolith version we don't recognize, this generic line keeps the
 *  symptom stream observable. Matches monolith fallback at L49729. */
export const SYMPTOM_REVEAL_GENERIC_HINT = 'Something feels off...';

/** Per-frame timer decrement + symptom stream + auto-end on timer
 *  expiry. Mirrors monolith updateTestDrive at L49710-L49734.
 *
 *  SYMPTOM STREAM (H514): every 3 seconds, while the player is
 *  driving above the 5 gu/s gate, roll 25% for a hidden-fault
 *  reveal. On a hit, pick a random undetected+unrevealed fault from
 *  life.faults, mark `_revealed = true` so it doesn't double-fire,
 *  and surface its FAULT_EFFECTS desc as a `⚠ <hint>` notif.
 *
 *  WHY READ life.faults (not sv.preFaults): startTestDrive copies
 *  sv.preFaults into life.faults at test-drive entry (so the test
 *  car's faults drive the live physics + audio + render effects
 *  during the drive). The symptom stream reads from life.faults to
 *  catch THOSE active fault entries; the _revealed mutations write
 *  to the copy and get discarded when endTestDrive restores
 *  saved.faults. Matches the monolith's `LIFE.faults.filter(...)`
 *  at L49720.
 *
 *  Caller passes life + sv + player so endTestDrive can restore
 *  state when the timer hits zero. */
export function tickTestDrive(
  life: LifeState,
  sv: SellerVisitState | null | undefined,
  player: PlayerState,
  dt: number,
  showNotif: (msg: string) => void,
): void {
  if (!sv || sv.phase !== 'testdrive') return;
  sv.testDriveTimer -= dt;

  // Symptom-stream tick.
  sv._revealTimer = (sv._revealTimer ?? 0) + dt;
  if (sv._revealTimer > SYMPTOM_REVEAL_INTERVAL_SEC) {
    sv._revealTimer = 0;
    if (Math.abs(player.pSpeed) > SYMPTOM_REVEAL_SPEED_GATE) {
      const hiddenActive = (life.faults ?? []).filter(
        (f) => !(f as PreFault).detected && !(f as PreFault)._revealed,
      ) as PreFault[];
      if (hiddenActive.length > 0 && Math.random() < SYMPTOM_REVEAL_CHANCE) {
        const hf = hiddenActive[Math.floor(Math.random() * hiddenActive.length)];
        hf._revealed = true;
        const eff = hf.id ? FAULT_EFFECTS[hf.id] : undefined;
        const hint = eff?.desc ?? SYMPTOM_REVEAL_GENERIC_HINT;
        showNotif('⚠ ' + hint);
      }
    }
  }

  if (sv.testDriveTimer <= 0) {
    endTestDrive(life, sv, player, showNotif);
  }
}
