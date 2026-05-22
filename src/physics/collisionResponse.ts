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

/** Result of an axis-separated slide response from
 *  [[applyCollisionSlideLoss]]. */
export interface CollisionSlideResult {
  pSpeed: number;
  pVx: number;
  pVy: number;
}

/** Apply the axis-separated slide collision response — fires
 *  when one of (nx, py) or (px, ny) is collision-free. The car
 *  slides ALONG the obstacle in the unblocked direction, losing
 *  40 % of its velocity to the wall scrape.
 *
 *  FORMULA (1:1 with monolith):
 *    pSpeed × = 0.6
 *    pVx    × = 0.6
 *    pVy    × = 0.6
 *
 *  WHY THE SAME 0.6 ON ALL THREE: see [[applyCollisionBounce]]'s
 *  docstring — pSpeed and pVx/pVy must scale consistently so the
 *  velocity vector stays coherent. Applying different factors
 *  would leave the chassis "decoherent" (pSpeed reading one
 *  value while pVx/pVy imply another).
 *
 *  WHY 0.6 (NOT HIGHER): tuned to give the player a
 *  "slide-along-the-wall" feel — they keep moving but pay a
 *  meaningful cost. Too high (0.8+) and walls become free
 *  speed; too low (0.3-) and any glancing contact stops the
 *  car dead, which feels jarring on minor scrapes.
 *
 *  WHY NO YAW DAMP HERE (unlike full bounce): the axis-separated
 *  case is a glancing impact — the chassis is sliding along the
 *  wall, not bouncing off it. Yaw rate is meaningful (the
 *  chassis can be rotating while scraping along) and shouldn't
 *  be artificially damped. The full-bounce case damps yaw
 *  because the impact's chaotic and the player needs help
 *  recovering control.
 *
 *  CALLER RESPONSIBILITIES (not in this function):
 *  - Calling the collision detector to determine which axis is
 *    unblocked (caller commits the corresponding nx-only or
 *    ny-only position update)
 *  - Updating rear-axle tracking after the slide
 *  - Triggering gamepad rumble (typically gpRumble(0.3, 0.5, 80)
 *    for the slide — less severe than a full bounce)
 *
 *  Returns {pSpeed, pVx, pVy}. Pure function. pYawRate is NOT
 *  modified (and not in the return type) — caller passes it
 *  through unchanged.
 *
 *  Ported 1:1 from monolith L26058-L26059 / L26065-L26066 (the
 *  velocity reduction in both axis-separated branches of the
 *  position-integration step). */
export function applyCollisionSlideLoss(
  pSpeed: number,
  pVx: number,
  pVy: number,
): CollisionSlideResult {
  return {
    pSpeed: pSpeed * COLLISION_SLIDE_RETAIN,
    pVx: pVx * COLLISION_SLIDE_RETAIN,
    pVy: pVy * COLLISION_SLIDE_RETAIN,
  };
}

/** Minimum squared-distance threshold (game-units²) above which
 *  the movement-derived velocity heading is trusted. Below this,
 *  the frame's displacement is too small to extract a reliable
 *  atan2 direction (would amplify floating-point noise into
 *  a spurious heading), so the caller falls back to chassis
 *  heading.
 *
 *  0.0001 ↔ |displacement| > 0.01 gu. At 60 fps that's a frame
 *  velocity of 0.6 gu/s — well below any meaningful motion, so
 *  the gate only fires when the car is essentially stopped.
 *
 *  Matches monolith `dxm*dxm+dym*dym > 0.0001` at L26043. */
export const PVELANGLE_MIN_DISP_SQ = 0.0001;

/** Derive the velocity heading (pVelAngle) from the per-frame
 *  committed displacement. Used in the free-move and axis-
 *  separated branches of the position-integration step — after
 *  the position update is committed, the actual displacement
 *  direction becomes the new velocity heading.
 *
 *  FORMULA (1:1 with monolith):
 *    dxm = newPx - oldPx
 *    dym = newPy - oldPy
 *    if dxm² + dym² > 0.0001:
 *      return atan2(dym, dxm)
 *    else:
 *      return fallbackAngle   (typically pAngle)
 *
 *  WHY DERIVE FROM DISPLACEMENT (NOT pVx/pVy DIRECTLY): in the
 *  axis-separated cases, the committed displacement is the
 *  AXIS-PROJECTED move (nx,py or px,ny), not the full velocity-
 *  predicted move (nx,ny). pVelAngle should reflect WHAT
 *  ACTUALLY HAPPENED (the constrained move) rather than what
 *  the integrator wanted (the unconstrained velocity vector).
 *  This is what makes "sliding along a wall" produce a heading
 *  that follows the wall, not the original velocity direction.
 *
 *  WHY ATAN2 (NOT ATAN): atan2 produces the full (-π, π] range
 *  based on both arguments' signs, correctly disambiguating
 *  which quadrant the displacement vector lies in. atan(y/x)
 *  would lose that information (the y/x ratio is the same in
 *  opposite quadrants).
 *
 *  WHY THE FALLBACK: with displacement below the gate, the
 *  atan2 result amplifies floating-point noise into a spurious
 *  heading — for a nearly-stopped car, even sub-pixel drift in
 *  px/py would set pVelAngle to a random direction. Falling
 *  back to chassis heading (pAngle) is correct: a stopped car
 *  with the chassis pointing one way has its (effectively zero)
 *  velocity vector pointing the same way by convention.
 *
 *  INPUTS:
 *    oldPx, oldPy    pre-integration CG position
 *    newPx, newPy    post-integration CG position (after
 *                    collision-response selection)
 *    fallbackAngle   typically pAngle (chassis heading) — used
 *                    when displacement is sub-threshold
 *
 *  Returns the new pVelAngle.
 *
 *  Ported 1:1 from monolith L26042-L26047 (the pVelAngle
 *  computation in the free-move branch of the position-
 *  integration step). */
export function computePVelAngleFromMove(
  oldPx: number,
  oldPy: number,
  newPx: number,
  newPy: number,
  fallbackAngle: number,
): number {
  const dxm = newPx - oldPx;
  const dym = newPy - oldPy;
  if (dxm * dxm + dym * dym > PVELANGLE_MIN_DISP_SQ) {
    return Math.atan2(dym, dxm);
  }
  return fallbackAngle;
}
