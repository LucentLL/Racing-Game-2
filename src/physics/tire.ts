/**
 * NFS-Blackbox-derived tire force primitives for the realistic-tier
 * `update()` port. Pulled into their own module so they can be unit-
 * tested without bringing in the rest of the 3,813-line update loop.
 *
 * Both functions are pure scalar transforms — no state, no globals,
 * no canvas access. The single tuning constant `SLIP_PEAK` is shared
 * because both curves pivot around it (lateral curve transitions
 * from linear to falloff at slipPeak; combined-slip starts cutting
 * longitudinal capacity at slipPeak).
 *
 * Monolith source:
 *   _tireCurve         (nested in update() at L25473-L25481)
 *   _combinedSlipFactor (nested in update() at L25739-L25743)
 */

/** Peak-grip slip angle for street rubber, in radians.
 *  9.7° ≈ 0.17 rad — the slip angle at which lateral force peaks
 *  before the tire starts breaking traction. Below this, the curve
 *  is linear (F = -C·slip); above, it falls off toward π/2 (90°,
 *  full sideways). Tuned for arcade feel — real motorsport tires
 *  peak nearer 6° (0.10 rad), but 0.17 gives the player enough
 *  forgiveness to catch a slide before losing the car. */
export const SLIP_PEAK = 0.17;

/** Lateral tire force as a function of slip angle. Returns the
 *  cornering force (Newtons, with sign opposite to slip direction —
 *  the tire pushes BACK against the slip). Inputs:
 *    slip — signed slip angle, radians. Positive = wheel ahead of
 *           velocity vector (understeer); negative = wheel behind
 *           (oversteer).
 *    C    — cornering stiffness, N/rad. Per-axle property derived
 *           from weight + tire spec by the caller.
 *
 *  TWO-REGION CURVE:
 *
 *    |slip| <= SLIP_PEAK (linear region):
 *      F_lat = -C · slip
 *      Standard linear tire model — force scales directly with
 *      slip until the tire reaches its grip limit.
 *
 *    |slip| > SLIP_PEAK (falloff region):
 *      peakF = C · SLIP_PEAK             (force at the peak)
 *      t     = clamp((|slip| − SLIP_PEAK) / (π/2 − SLIP_PEAK), 0, 1)
 *      attn  = 1.0 − 0.65·t              (1.0 at peak → 0.35 at π/2)
 *      F_lat = -sign(slip) · peakF · attn
 *
 *      Linear falloff from peakF at SLIP_PEAK to 0.35·peakF at
 *      π/2 (full sideways). Real tires drop more sharply
 *      (Pacejka curve, exponential-ish) but the linear approximation
 *      is computationally cheap and matches the player's perceptible
 *      "tires let go" feeling well enough for arcade play. The 35%
 *      residual at π/2 represents the kinetic friction component
 *      (tires sliding sideways still drag against the surface; they
 *      don't go to zero).
 *
 *  The friction-circle clamp at the call site (μ·Fz) provides the
 *  outer bound — whichever of {tire-curve, friction-circle} is
 *  smaller wins. The curve gives the inner envelope from slip
 *  physics; the circle gives the outer envelope from normal-load
 *  physics.
 *
 *  Ported 1:1 from monolith `_tireCurve` nested in update() at
 *  L25473-L25481.
 */
export function tireCurve(slip: number, C: number): number {
  const sMag = Math.abs(slip);
  if (sMag <= SLIP_PEAK) return -C * slip;
  const peakF = C * SLIP_PEAK;
  const t = Math.min(1, (sMag - SLIP_PEAK) / (Math.PI / 2 - SLIP_PEAK));
  const attn = 1.0 - 0.65 * t;
  return -Math.sign(slip) * peakF * attn;
}

/** Combined-slip longitudinal-capacity reduction (v8.99.124.06). When
 *  a tire is sliding sideways at a slip angle beyond SLIP_PEAK, its
 *  longitudinal grip budget (drive force / braking) shrinks. This
 *  models the friction-circle coupling without explicitly solving for
 *  the full circle:
 *
 *    |slip| <= SLIP_PEAK → 1.0 (full longitudinal capacity available).
 *    |slip| > SLIP_PEAK  → linear cut to 0.3 at π/2:
 *      t      = clamp((|slip| − SLIP_PEAK) / (π/2 − SLIP_PEAK), 0, 1)
 *      factor = 1.0 − 0.7·t           (1.0 at peak → 0.3 at π/2)
 *
 *  Caller applies the returned factor to the friction circle's
 *  longitudinal cap:
 *    F_long_cap = F_circle · combinedSlipFactor(|slip|)
 *
 *  WHY THIS MATTERS: under hard cornering AND hard throttle (e.g.
 *  RWD power oversteer), the rear tire's grip budget is already
 *  partially consumed by lateral force; the longitudinal cap must
 *  shrink correspondingly or the simulation gets the equivalent
 *  of "infinite drive force with no penalty for sliding sideways."
 *  The 30% residual at π/2 preserves enough longitudinal capacity
 *  that wheelspin physics still bites once you exceed the cap —
 *  matches the "sliding burnout" feel.
 *
 *  Symmetric on the front axle for FWD/AWD wheelspin during
 *  burnouts — less common but physically consistent.
 *
 *  Ported 1:1 from monolith `_combinedSlipFactor` nested in update()
 *  at L25739-L25743.
 */
export function combinedSlipFactor(slipMag: number): number {
  if (slipMag <= SLIP_PEAK) return 1.0;
  const t = Math.min(1, (slipMag - SLIP_PEAK) / (Math.PI / 2 - SLIP_PEAK));
  return 1.0 - 0.7 * t;
}
