/**
 * Gear shifting + RPM tracking. Manual + auto transmissions, engine-brake
 * RPM rise, manual rev-limit cut, gear shift cooldown, RPM flutter from
 * faults. Ported from monolith L26449-26599.
 *
 * SCAFFOLD status: typed entries; bodies stubbed.
 */

import type { PlayerPhysicsState, FaultEffects, FrameInputs, CarSpec } from './types';

/** Up-shift / down-shift trigger. Called from input.ts when the player
 *  presses gear up/down (manual mode) or from auto-shift logic. */
export function doShift(
  _state: PlayerPhysicsState,
  _car: CarSpec,
  _direction: 1 | -1,
  _isManual: boolean,
): boolean {
  // TODO(C22-followup): port from monolith L23597 (doShift function).
  return false;
}

/** Per-frame gear + RPM update. Auto-shifts based on RPM / speed when not
 *  in manual mode, decays the gear-shift cooldown, applies engine brake
 *  RPM rise, and propagates fault rpmFlutter into the pRPM signal.
 *
 *  TODO(C22-followup): port monolith L26449-26599. */
export function updateGearAndRpm(
  _state: PlayerPhysicsState,
  _car: CarSpec,
  _fx: FaultEffects,
  _inputs: FrameInputs,
  _isManual: boolean,
  _dt: number,
): void {
  // TODO: L26449-26599.
}
