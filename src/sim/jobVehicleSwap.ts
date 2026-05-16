/**
 * Job-vehicle swap — temporarily replace the player's active car
 * with a job-specific vehicle for the duration of a shift.
 *
 * 1:1 port of monolith L27579-27597 (swapToJobVehicle +
 * swapBackToPersonalCar). Snapshot + restore via life.savedCar
 * instead of the monolith's carConditions[] keying (matches the
 * H187 sellerTestDrive pattern — GameContext doesn't carry a
 * carConditions Record yet).
 *
 * Job vehicles get fresh good-condition values (engine/tires 90,
 * carHP/paint 95, full fuel) so the player isn't penalized for
 * a job assignment. faults / _hiddenFaults are cleared too.
 * Body damage isn't ported yet.
 */

import type { LifeState } from '@/state/life';
import { CAR_CATALOG } from '@/config/cars/catalog';
import { JOB_VEHICLES, type JobName } from '@/config/jobs';

/** Swap the player's active car (ownedCars[0]) for the job-typed
 *  vehicle. No-op when the job type doesn't map to a vehicle
 *  (FOOD DELIVERY / AUTO PARTS RUN / OFFICE JOB drive the player's
 *  own car) or when the target vehicle is missing from the catalog.
 *  Returns true when the swap happened so the caller can notify. */
export function swapToJobVehicle(life: LifeState, jobType: string): boolean {
  if (life.savedCar) return false; // already swapped — don't double-snapshot
  const jobCarId = JOB_VEHICLES[jobType as JobName];
  if (!jobCarId) return false;
  if (!CAR_CATALOG[jobCarId]) return false;
  const prevCarId = life.ownedCars[0];
  if (!prevCarId) return false;

  // Snapshot the personal car's live condition before the swap so
  // delivery / QUIT can restore exactly what was there. Faults are
  // deep-copied so per-frame mutations on the swapped-in car can't
  // leak back into the personal snapshot.
  life.savedCar = {
    carId: prevCarId,
    engine: life.engine,
    tires: life.tires,
    carHP: life.carHP,
    paint: life.paint,
    fuel: life.fuel,
    faults: JSON.parse(JSON.stringify(life.faults ?? [])) as unknown[],
  };

  // Swap ownedCars[0] in place + write job-vehicle fresh condition.
  // 1:1 with monolith L27586-27589 (welded / supercharged / bodyDamage
  // bits skipped — bodyDamage isn't fully threaded into our render
  // pass yet; welded/supercharged don't apply to job vehicles).
  life.ownedCars[0] = jobCarId;
  life.engine = 90;
  life.tires = 90;
  life.carHP = 95;
  life.paint = 95;
  life.fuel = 100;
  life.faults = [];
  life._hiddenFaults = [];
  life._hiddenFaultOdo = 0;
  return true;
}

/** Restore the player's personal car from the savedCar snapshot.
 *  Called by delivery-arrival and QUIT JOB. No-op when no snapshot
 *  exists (e.g. the player accepted FOOD DELIVERY which doesn't
 *  swap, or already restored once). */
export function swapBackToPersonalCar(life: LifeState): boolean {
  const saved = life.savedCar;
  if (!saved) return false;
  life.ownedCars[0] = saved.carId;
  life.engine = saved.engine;
  life.tires = saved.tires;
  life.carHP = saved.carHP;
  life.paint = saved.paint;
  life.fuel = saved.fuel;
  life.faults = saved.faults;
  life.savedCar = null;
  return true;
}
