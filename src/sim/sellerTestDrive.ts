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
 * Ported from monolith L49684-49770 (startTestDrive / updateTestDrive
 * / endTestDrive). Skipped from the monolith for now:
 *   - the L49716-49730 mid-drive symptom stream (depends on
 *     FAULT_EFFECTS which isn't ported);
 *   - the L49764 faultPriceDiscount re-application on found-faults
 *     (the discount table itself isn't ported — sv.haggled is still
 *     reset so the player can re-haggle once that lands).
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
    // Reset haggled so the player can re-haggle once the discount
    // table ports. Hagglie price stays at its pre-drive value for
    // now — re-derivation lands with faultPriceDiscount.
    sv.haggled = false;
    showNotif(
      'Test drive: ' + found + ' issue' + (found > 1 ? 's' : '') + ' felt while driving!',
    );
  } else {
    showNotif('Test drive done — drove fine');
  }
}

/** Per-frame timer decrement + auto-end when the timer expires.
 *  Mirrors the timer block of monolith L49710-49734 (updateTestDrive),
 *  minus the symptom stream + speed gate at L49716-49730. Caller
 *  passes life + sv + player so endTestDrive can restore state when
 *  the timer hits zero. */
export function tickTestDrive(
  life: LifeState,
  sv: SellerVisitState | null | undefined,
  player: PlayerState,
  dt: number,
  showNotif: (msg: string) => void,
): void {
  if (!sv || sv.phase !== 'testdrive') return;
  sv.testDriveTimer -= dt;
  if (sv.testDriveTimer <= 0) {
    endTestDrive(life, sv, player, showNotif);
  }
}
