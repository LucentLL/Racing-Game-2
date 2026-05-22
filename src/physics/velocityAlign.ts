/**
 * Velocity-direction alignment — the per-frame exponential-relax
 * idiom that drags the velocity heading (pVelAngle) toward the
 * chassis heading (pAngle).
 *
 * Why the velocity direction can DIFFER from the chassis heading
 * at all: tires slip. In grip state the slip is small and the
 * difference relaxes quickly toward zero (high gripAlign rate).
 * In drift state the difference is the slide angle, and it
 * relaxes much more slowly (low driftAlignRate) — the body and
 * the velocity vector are pointing in genuinely different
 * directions because the rear tires are sliding sideways.
 *
 * The two angles are kept on the unit circle modulo 2π so the
 * relaxation tracks the shortest path (a 359° difference is
 * really -1°, and trying to relax across 359° would spin the
 * wrong way around).
 *
 * Used by both the drift branch (L25058-L25061) and the grip
 * branch (L25100-L25103) of the legacy velocity-direction-update
 * block in update(). The 0B Phase skips this entirely — the
 * force integrator derives pVelAngle from actual CG displacement
 * and the friction-circle handles energy loss naturally.
 *
 * Monolith source: inside update() at L25058-L25061 and
 * L25100-L25103.
 */

/** Exponentially relax `pVelAngle` toward `pAngle` at the given
 *  rate, normalizing the angular difference to the shortest
 *  wraparound path.
 *
 *  FORMULA (1:1 with monolith):
 *    diff      = pAngle - pVelAngle
 *    diff     -= 2π × floor((diff + π) / 2π)   [wrap to (-π, π]]
 *    pVelAngle = pVelAngle + diff × alignRate × dt
 *
 *  (The monolith uses a while-loop pair to wrap; the math is
 *  equivalent.)
 *
 *  INPUTS:
 *    pVelAngle   current velocity direction, radians
 *    pAngle      current chassis heading, radians
 *    alignRate   per-second relaxation rate (1/s); higher = faster
 *                snap to heading. Grip uses 6-14, drift uses
 *                ~1-3 (the actual rate values are computed by
 *                upstream helpers — see compute*AlignRate hops).
 *    dt          frame timestep, seconds
 *
 *  Returns the new pVelAngle. NOT clamped to (-π, π] in the
 *  return — the caller may add to it further or wrap as needed.
 *
 *  At alignRate × dt = 1.0 the velocity snaps exactly to heading
 *  in one step (overshoot-free for the half-plane diff is in).
 *  In practice alignRate × dt stays well below 1 so this is a
 *  proportional relaxation, not a step jump.
 *
 *  Ported 1:1 from monolith L25058-L25061 / L25100-L25103 (the
 *  shared diff-normalize-then-relax block in the velocity-
 *  direction-update branches). */
export function alignVelocityAngle(
  pVelAngle: number,
  pAngle: number,
  alignRate: number,
  dt: number,
): number {
  let diff = pAngle - pVelAngle;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return pVelAngle + diff * alignRate * dt;
}
