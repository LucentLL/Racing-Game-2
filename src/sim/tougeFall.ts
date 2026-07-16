/**
 * H1088: touge canyon-fall state machine.
 *
 * On a map flagged offTrackFatal (the touge passes), driving off the drivable
 * surface = falling off a canyon: the car sprite shrinks + fades over a short
 * animation, input is frozen (the caller skips the physics substep loop while
 * player.fallTimer > 0), and the run ends. A brief debounce absorbs the road
 * pipeline's bezier-vs-linear edge gap so clipping an apex for a frame doesn't
 * insta-kill — you have to actually leave the road.
 *
 * State lives on player.fallTimer (0 = normal; > 0 = falling/fallen, held at a
 * tiny floor once the drop finishes so the car stays gone until RETRY/RETURN
 * resets it via resetPlayerMotion). The off-road debounce accumulator is module
 * state (one player), cleared on map switch via resetTougeFall().
 */
import type { PlayerState } from '@/state/player';

export const FALL_DURATION = 0.7;  // seconds of drop animation
const OFF_DEBOUNCE = 0.18;         // continuous off-road time before the fall fires
const FALL_HELD = 0.02;            // floor fallTimer holds at once fully dropped
const MIN_FALL_SPEED = 8;          // don't fall while essentially parked

let offAccum = 0;

export function resetTougeFall(): void {
  offAccum = 0;
}

/** Per-frame fall update. `onRoad` MUST be evaluated against the player's FINAL
 *  post-physics position. Returns true while the car is falling/fallen (the
 *  caller freezes driving). Calls `onFall` exactly once, on the frame the drop
 *  begins (to fail the run + play the crash). */
export function tickTougeFall(
  player: PlayerState,
  onRoad: boolean,
  fatal: boolean,
  dt: number,
  onFall: () => void,
): boolean {
  if (!fatal) {
    offAccum = 0;
    if (player.fallTimer > 0) player.fallTimer = 0;
    return false;
  }
  if (player.fallTimer > 0) {
    // Already dropping — run the animation down to the held floor and stay.
    if (player.fallTimer > FALL_HELD) player.fallTimer = Math.max(FALL_HELD, player.fallTimer - dt);
    return true;
  }
  if (!onRoad && Math.abs(player.pSpeed) > MIN_FALL_SPEED) {
    offAccum += dt;
    if (offAccum >= OFF_DEBOUNCE) {
      offAccum = 0;
      player.fallTimer = FALL_DURATION;
      player.fallKind = 'canyon'; // H1164: render normalizes per kind
      onFall();
      return true;
    }
  } else {
    offAccum = 0;
  }
  return false;
}
