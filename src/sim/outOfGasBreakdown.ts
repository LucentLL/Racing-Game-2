/**
 * OUT OF GAS breakdown trigger — flips life.broken + breakdownType
 * when the runtime fuel level hits 0. Closes the gap between
 * arcadeUpdate's fuel-burn (which decrements player.fuel down to 0)
 * and tickBreakdownRecovery's out-of-gas tow gate (which requires
 * life.broken === true to fire).
 *
 * H557: 1:1 port of monolith L42021-L42027 (the `if (LIFE.fuel<=0)`
 * block inside lifeSimTick that fires once per fuel-out event).
 * Idempotent via the !life.broken gate — re-running the check on
 * subsequent frames is a no-op while the breakdown is active.
 *
 * The matching breakdownType='OUT OF GAS' (vs ENGINE STALL /
 * FLAT TIRE / OVERHEATING from the H536 wear-tick breakdown roll)
 * lets tickBreakdownRecovery (H529) route the player straight to
 * the tow menu — no restart-after-3-sec stall countdown for an
 * empty tank.
 */

import type { LifeState } from '@/state/life';
import type { PlayerState } from '@/state/player';

/** Result of [[checkOutOfGas]] — null when no breakdown fired this
 *  frame (player still has fuel OR is already broken from another
 *  cause), otherwise the notif string the caller should surface. */
export type OutOfGasResult = null | { kind: 'out-of-gas'; notif: 'OUT OF GAS!' };

/** Fire the OUT OF GAS breakdown when player.fuel has reached 0
 *  AND the player isn't already broken. Mutates life.broken /
 *  life.breakdownType / life.fuel (clamped to 0 in case of
 *  tiny negative drift from the burn). Returns the notif info
 *  so the caller can surface "OUT OF GAS!" once per event.
 *
 *  Ported 1:1 from monolith L42021-L42027. */
export function checkOutOfGas(life: LifeState, player: PlayerState): OutOfGasResult {
  if (life.broken) return null;
  if (player.fuel > 0) return null;
  // Clamp + flip. The clamp matches monolith L42022 `LIFE.fuel=0;`
  // — defensive against tiny negative values from arcadeUpdate's
  // `Math.max(0, player.fuel - ...)` if the underlying float drifts
  // a hair below zero. Modular player.fuel comes through the same
  // max-0 clamp so it's already 0 here, but mirror the write into
  // life.fuel since the H556 sync only updates life.fuel from
  // player.fuel at specific scope points (pause-menu open,
  // switchCar pre-save).
  player.fuel = 0;
  life.fuel = 0;
  life.broken = true;
  life.breakdownType = 'OUT OF GAS';
  return { kind: 'out-of-gas', notif: 'OUT OF GAS!' };
}
