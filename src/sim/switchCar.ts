/**
 * switchCar — make a different owned car the active one.
 *
 * The monolith carries a top-level `activeCar` id and reads everything
 * for the live drive (HP, fuel, faults, tires) off LIFE.*. switchCar
 * (L20329-20346) snapshots LIFE.* into carConditions[oldId], swaps
 * activeCar to the new id, restores carConditions[newId] back onto
 * LIFE.*, then resets the player physics state so the new car doesn't
 * inherit the old one's pSpeed / pRPM / drift / gear.
 *
 * Modular structure differs in two places:
 *
 *   1. There is no separate `activeCar` global. The active car id is
 *      `life.ownedCars[0]`. switchCar moves the new id to slot 0 and
 *      shuffles the previously-active id back into the array (so the
 *      same set of owned cars remains, just in a different order).
 *
 *   2. Player.fuel is a 0..1 runtime field, life.fuel is the 0..100
 *      stored snapshot. After loadCarCondition writes life.fuel from
 *      the carConditions entry, sync `player.fuel = life.fuel / 100`
 *      so the HUD reflects the new car's stored level. The monolith
 *      has no such duality.
 *
 * Out of scope (monolith fields modular doesn't carry yet):
 *   pVelAngle / pVelAngleFiltered, camPX/camPY (camera reads
 *   player.px/py directly), pBicycleInit / pDyn0BInit / pVx / pVy /
 *   pYawRate (no full bicycle-model physics), pEbrakeTimer /
 *   pEbrakeCooldown (no e-brake cooldown port), pFzTransfer /
 *   pPrevSpeed (no weight-transfer). Each ports back into this
 *   reset block when its owning physics module lands.
 */

import type { LifeState } from '@/state/life';
import type { GameContext } from '@/state/gameState';
import { CAR_CATALOG } from '@/config/cars/catalog';
import { saveCarCondition, loadCarCondition } from '@/save/carCondition';
import { makeFreshBodyDamage } from '@/sim/faults';

export type SwitchCarResult =
  | { kind: 'swapped'; toCarId: string }
  | { kind: 'noop'; reason: 'savedCar' | 'unknownCar' | 'sameCar' | 'notOwned' };

/** Make `newCarId` the active car. Returns 'noop' when:
 *   - life.savedCar is set (a job/test-drive swap is in flight —
 *     the player must return the job vehicle first).
 *   - newCarId isn't in the CAR_CATALOG (defensive — shouldn't
 *     happen via the modal).
 *   - newCarId equals the current active car (already there).
 *   - newCarId isn't in life.ownedCars (defensive — modal only
 *     lists owned cars, but switchCar is called from a few places).
 *
 *  Otherwise mutates life + ctx.carConditions + ctx.player and
 *  returns 'swapped'. Caller emits any notif. */
export function switchCar(
  life: LifeState,
  ctx: GameContext,
  newCarId: string,
): SwitchCarResult {
  if (life.savedCar) return { kind: 'noop', reason: 'savedCar' };
  if (!CAR_CATALOG[newCarId]) return { kind: 'noop', reason: 'unknownCar' };
  const prevCarId = life.ownedCars[0];
  if (prevCarId === newCarId) return { kind: 'noop', reason: 'sameCar' };
  const newIdx = life.ownedCars.indexOf(newCarId);
  if (newIdx < 0) return { kind: 'noop', reason: 'notOwned' };

  if (prevCarId) {
    // H556: sync life.fuel from the live player.fuel BEFORE the
    // snapshot. arcadeUpdate burns player.fuel each frame without
    // touching life.fuel, so the un-synced life.fuel reflects only
    // the last writer (purchase, race, etc.) — driving for a while
    // and then switching cars would persist the pre-drive fuel
    // value, losing real burn state. saveCarCondition reads
    // life.fuel directly so the sync has to happen on life, not
    // bypass via a helper.
    life.fuel = ctx.player.fuel * 100;
    saveCarCondition(prevCarId, life, prevCarId, ctx.carConditions, makeFreshBodyDamage);
  }

  // Move new id into slot 0; previously-active id takes the new id's
  // old slot so the ownedCars array stays the same set, just rotated.
  life.ownedCars[newIdx] = prevCarId;
  life.ownedCars[0] = newCarId;

  loadCarCondition(
    newCarId,
    life,
    ctx.carConditions,
    life.carOdometers,
    CAR_CATALOG,
    makeFreshBodyDamage,
  );

  // Sync player.fuel (0..1) from the loaded life.fuel (0..100).
  // See module doc — modular's fuel duality has no monolith analog.
  ctx.player.fuel = Math.max(0, Math.min(1, life.fuel / 100));

  // Physics state reset — 1:1 with monolith L20335-20342 (subset:
  // only fields modular's PlayerState actually carries).
  const newCar = CAR_CATALOG[newCarId];
  ctx.player.pSpeed = 0;
  ctx.player.pRpm = newCar.idleRPM ?? 800;
  ctx.player.drifting = false;
  ctx.player.slipAngle = 0;
  ctx.player.wheelspinRatio = 0;
  ctx.player.wheelGap = 0;
  ctx.player.gearShiftTimer = 0;
  ctx.player.pRevIntent = false;
  ctx.player.prevGear = 1;
  ctx.player.manualGear = null;
  ctx.player.manualGearTimer = 0;
  // Camera snaps to heading so it doesn't lag the old car's pose.
  ctx.player.pCamAngle = ctx.player.pAngle;

  // H507: drop the Phase 0B integrator state on car-switch so its
  // ~20 persistent fields (pVx/pVy world velocity, pYawRate, rear-
  // axle tracking, weight-transfer scalar, drift state-machine
  // timers, init flags, etc.) don't carry the old car's motion
  // into the new car. The adapter (runPhase0BTick) lazy-rebuilds
  // player.phase0B from the post-switch PlayerState pose on the
  // next eligible frame — the same code path that runs on first-
  // time game start, so no special-case is needed. Matches the
  // monolith's L20335-20342 block clearing the same conceptual
  // physics state on a car swap.
  ctx.player.phase0B = undefined;

  return { kind: 'swapped', toCarId: newCarId };
}
