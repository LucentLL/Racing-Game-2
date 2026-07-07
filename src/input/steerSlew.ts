/**
 * H1061: steering release slew limiter.
 *
 * The audit behind H1059 confirmed the input-shape half of the
 * rubber-band complaint: on ALL three devices the commanded steer
 * axis stepped to center in ONE frame on release (keyboard raw
 * 0/1, gamepad EMA overwritten below the deadzone, touch wheel
 * nulled on finger-up). At 60 mph a full keyboard lock is ~0.33 rad
 * of front-wheel angle; snapping it to 0 in 16.7 ms is a ~1130°/s
 * road-wheel unwind — a real wheel self-centers via caster/SAT at
 * ~30-60°/s from that angle, i.e. the game was 20-40× too fast.
 * The one-frame step turned every release into a step input that
 * engaged every restoring term at maximum amplitude on frame 1.
 *
 * This helper rate-limits ONLY the unwind toward center:
 *  - Attack (growing |axis|, same direction) is instant — press
 *    feel and turn-in are untouched.
 *  - Direction flips are instant — drift counter-flicks keep
 *    arcade response (a driver actively moving the wheel is fast;
 *    only the LET-GO return is physically slow).
 *  - Release / easing off unwinds at STEER_RELEASE_RATE axis
 *    units per second.
 */

/** Unwind rate in axis units (full lock = 1.0) per second. 3.0/s
 *  returns full lock to center in ~0.33 s → ~57°/s at the road
 *  wheel with the 0.33 rad grip max delta — right in the real
 *  caster/SAT self-centering band. The tires still do the actual
 *  straightening (slipF grows smoothly as delta unwinds); the
 *  wheel just stops teleporting. */
export const STEER_RELEASE_RATE = 3.0;

/** Advance the merged steer axis one frame toward `target`,
 *  rate-limiting only the unwind toward center. Pure function —
 *  the caller (gameLoop mergeInputs) owns the axis state. */
export function slewSteerRelease(current: number, target: number, dt: number): number {
  // Direction change (e.g. counter-flick) → instant, arcade authority.
  if (target !== 0 && current !== 0 && Math.sign(target) !== Math.sign(current)) {
    return target;
  }
  // Attack or hold (magnitude not shrinking) → instant.
  if (Math.abs(target) >= Math.abs(current)) return target;
  // Release / easing off → finite return rate.
  const step = STEER_RELEASE_RATE * dt;
  const diff = target - current;
  if (Math.abs(diff) <= step) return target;
  return current + Math.sign(diff) * step;
}
