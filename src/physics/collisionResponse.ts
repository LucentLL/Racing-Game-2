/**
 * Physics-side collision response — velocity / yaw adjustments
 * after the collision detector blocks a position update.
 *
 * Three response variants in the position-integration step
 * (monolith L26031-L26077), in order of severity:
 *
 *   1. Free move — no collision; full nx/ny accepted.
 *   2. Axis-separated slide — one of (nx, py) or (px, ny) is
 *      clear. Kill 40 % of velocity on the blocked axis;
 *      [[applyCollisionSlideLoss]] handles this.
 *   3. Full bounce — neither axis-separated move works. Reverse
 *      velocity at 20 % retention, soft-zero pSpeed, damp yaw;
 *      [[applyCollisionBounce]] handles this.
 *
 * Caller (the position-integration orchestrator) is responsible
 * for the collision-detector calls, the slide-vs-bounce
 * selection, the rear-axle tracking update, and the gamepad
 * rumble effects. This module supplies the pure velocity-math
 * primitives.
 *
 * Monolith source: inside update() at L26031-L26077.
 */

/** Velocity retention fraction after an axis-separated slide
 *  collision. 60 % retained ↔ 40 % bled to the obstacle. Tuned
 *  to give players a "slide-along-the-wall" feel without making
 *  walls free speed; too high and players never lose speed
 *  scraping walls, too low and any glancing contact stops the
 *  car dead.
 *
 *  Matches monolith `*=0.6` at L26058-L26059 and L26065-L26066. */
export const COLLISION_SLIDE_RETAIN = 0.6;

/** Velocity retention fraction (signed) after a full-bounce
 *  collision. -0.2 = reverse direction at 20 % magnitude. The
 *  negation flips the chassis around (bouncing off the wall);
 *  the 20 % retention bleeds 80 % of the kinetic energy. Tuned
 *  for "noticeable but not catastrophic" head-on impacts.
 *
 *  Matches monolith `*=-0.2` at L26069-L26070. */
export const COLLISION_BOUNCE_RETAIN = -0.2;

/** Yaw-rate retention after a full-bounce collision. 0.3 = 30 %
 *  retained ↔ 70 % damped. Yaw damps faster than translation
 *  because the body's rotational response to impact is naturally
 *  more chaotic — keeping less yaw produces a more controllable
 *  post-impact state for the player.
 *
 *  Matches monolith `pYawRate *= 0.3` at L26071. */
export const COLLISION_BOUNCE_YAW_RETAIN = 0.3;

/** Magnitude threshold (gu/s) below which pSpeed snaps to zero
 *  after a bounce. Without this, the -0.2 retention would leave
 *  the car drifting backward at tiny speeds after a hard impact
 *  — visually wrong and a source of "why am I creeping
 *  backwards" complaints. Snapping to zero gives the impact a
 *  clean "stopped" feel.
 *
 *  Matches monolith `if(Math.abs(pSpeed)<1) pSpeed=0` at L26072. */
export const COLLISION_BOUNCE_PSPEED_FLOOR = 1;

/** Result of a full-bounce collision response from
 *  [[applyCollisionBounce]]. */
export interface CollisionBounceResult {
  pSpeed: number;
  pVx: number;
  pVy: number;
  pYawRate: number;
}

/** Apply the full-bounce collision response — fires when neither
 *  axis-separated move (nx,py or px,ny) is collision-free.
 *  Reverses velocity at 20 % retention, soft-zeros tiny pSpeed,
 *  damps yaw to 30 %.
 *
 *  FORMULA (1:1 with monolith):
 *    pSpeed   × = -0.2
 *    pVx      × = -0.2
 *    pVy      × = -0.2
 *    pYawRate × = 0.3
 *    if |pSpeed| < 1: pSpeed = 0
 *
 *  WHY ALL THREE VELOCITY COMPONENTS GET THE SAME -0.2:
 *  pSpeed is the scalar magnitude (signed); pVx/pVy are the
 *  world-frame components. They must scale consistently so the
 *  velocity vector stays coherent — applying different factors
 *  would have the chassis "decoherent" (pSpeed reading one
 *  value while pVx/pVy imply another).
 *
 *  WHY YAW IS DAMPED MORE (0.3 vs 0.2): yaw response to impact
 *  is naturally more chaotic than translation. Keeping less of
 *  it produces a more controllable post-impact state — the
 *  player can recover instead of fighting an uncontrollable
 *  spin. The 0.3 vs 0.2 spread is empirically tuned.
 *
 *  WHY THE pSpeed FLOOR: the -0.2 retention leaves the car at
 *  ~20 % of impact speed in the OPPOSITE direction. At low
 *  impact speeds (< 5 gu/s) this produces creeping backward
 *  motion at < 1 gu/s — visually wrong. Snapping to zero gives
 *  the impact a clean "stopped" feel.
 *
 *  CALLER RESPONSIBILITIES (not in this function):
 *  - Calling the collision detector (collide / _bridgeBlocked)
 *    to determine that the bounce path applies
 *  - Updating rear-axle tracking (pRearX, pRearY) after the
 *    bounce
 *  - Triggering gamepad rumble (typically gpRumble(0.6, 1.0, 150)
 *    for the full bounce, matching the impact severity)
 *
 *  Returns {pSpeed, pVx, pVy, pYawRate}. Pure function.
 *
 *  Ported 1:1 from monolith L26069-L26075 (the final-fallback
 *  collision bounce in the position-integration step). */
export function applyCollisionBounce(
  pSpeed: number,
  pVx: number,
  pVy: number,
  pYawRate: number,
): CollisionBounceResult {
  let newPSpeed = pSpeed * COLLISION_BOUNCE_RETAIN;
  if (Math.abs(newPSpeed) < COLLISION_BOUNCE_PSPEED_FLOOR) newPSpeed = 0;
  return {
    pSpeed: newPSpeed,
    pVx: pVx * COLLISION_BOUNCE_RETAIN,
    pVy: pVy * COLLISION_BOUNCE_RETAIN,
    pYawRate: pYawRate * COLLISION_BOUNCE_YAW_RETAIN,
  };
}
