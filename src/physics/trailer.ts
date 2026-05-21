/**
 * Articulated-trailer kinematic ODE — the single-step heading
 * integrator for a hitched trailer following a cab.
 *
 *   θ̇_trailer = [ v · sin(φ)  −  d · ω · cos(φ) ] / L₂_eff
 *
 * where φ = cab heading − trailer heading, v is signed forward
 * speed, ω is cab yaw rate, d is the hitch's signed offset behind
 * the cab's pivot center, and L₂_eff is the effective kingpin-to-
 * tandem-CENTER distance (~75% of the visual trailer length for a
 * 53-ft trailer).
 *
 * The full ODE has two terms; the v8.99.122.12 attempt to "tighten"
 * trailer behavior with a smaller L₂ multiplier was working around
 * a missing geometric term and went the wrong direction. v122.13
 * restored both terms. Without the geometric (d · ω · cos φ) term,
 * two visible bugs appear:
 *
 *   1. "Trailer doesn't pivot at low speed" — at 0 mph the v · sin φ
 *      term is zero, so the trailer's heading was frozen no matter
 *      how the driver steered. With the geometric term active, the
 *      hitch's lateral motion (driven by cab yaw) still rotates the
 *      trailer at standstill.
 *
 *   2. "Trailer slides like ice during quick steering" — during
 *      rapid wheel inputs on the highway, only the slow v · sin φ
 *      response existed, so the trailer angle lagged behind the
 *      hitch's lateral motion. Body translated with the cab while
 *      angle barely changed — planted-tire pivot motion was lost.
 *      With the geometric term, the trailer's tandem behaves like
 *      it's gripping (no-slip) at any speed, because the full ODE
 *      IS the no-slip kinematic constraint.
 *
 * Forward (v > 0): sin(φ) is restoring → trailer straightens
 * exponentially with time constant τ ≈ L₂_eff / v.
 *
 * Reverse (v < 0): sin(φ) is destabilizing → angle amplifies (law
 * of increasing offset, the well-known reason backing a trailer is
 * counterintuitive — small steering errors blow up).
 *
 * No artificial forces, no angular velocity damping — just the
 * no-lateral-slip constraint on the trailer tandem.
 *
 * Monolith source: inside updateTrailer at L27824-L27870
 * (v8.99.122.13 form with both terms restored).
 */

/** Effective L₂ as a fraction of the trailer's visible length.
 *  Kingpin-to-tandem-CENTER distance is ~75% of the visual length
 *  on a 53-ft over-the-road trailer (the tandem axle group sits a
 *  few feet ahead of the rear bumper). Caller passes trailer
 *  length; this constant scales it. Matches monolith
 *  `const L2_eff = L2 * 0.75` at L27864 (v8.99.122.13 restored). */
export const TRAILER_L2_EFFECTIVE_FACTOR = 0.75;

/** Hitch offset behind the cab's pivot center, in game units. The
 *  game's cab sprite pivots around (px, py); the fifth-wheel hitch
 *  sits at fwX = px − 6·cos(pAngle), so the hitch is +6 units
 *  behind the pivot. Matches monolith `const d_hitch = 6` at
 *  L27865. */
export const TRAILER_HITCH_BEHIND_PIVOT = 6;

/** Speed below which the v·sin(φ) term vanishes. The yaw-driven
 *  geometric term still fires at standstill so the trailer can
 *  pivot when the cab rotates in place. Matches monolith
 *  `(absSpd > 0.05) ? ... : 0` at L27866. */
const SPEED_GATE = 0.05;

/** Inputs to the single ODE step. */
export interface TrailerKinematicInputs {
  /** Cab heading angle (rad). */
  pAngle: number;
  /** Cab yaw rate (rad/s). The geometric term reads this so
   *  rotating the cab in place still pivots the trailer. */
  pAngVel: number;
  /** Signed forward speed (positive = forward, negative = reverse). */
  pSpeed: number;
  /** Current trailer heading angle (rad). The returned new angle
   *  comes from integrating this with `θ̇ · dt`. */
  trailerAngle: number;
  /** Visible trailer length (game units, ~73 for a 53-ft trailer).
   *  The ODE scales this by TRAILER_L2_EFFECTIVE_FACTOR before use. */
  trailerLength: number;
  /** Frame duration in seconds. */
  dt: number;
}

/** Advance the trailer's heading by one frame via the full
 *  kinematic ODE. Pure function — returns the new trailer angle;
 *  caller stores it back wherever they keep trailer state.
 *
 *  Output is NOT normalized to [-π, π]. The monolith leaves
 *  trailer.angle un-normalized through the integration and only
 *  wraps the articulation angle φ when reading it back for
 *  jackknife detection. Preserving that 1:1 — over hours of
 *  driving the trailer.angle can drift far outside [-π, π] and
 *  the math still works because every read wraps locally.
 *
 *  Ported 1:1 from monolith L27824-L27870 (the kinematic block
 *  inside updateTrailer). */
export function trailerKinematicTick(inputs: TrailerKinematicInputs): number {
  const { pAngle, pAngVel, pSpeed, trailerAngle, trailerLength, dt } = inputs;
  let phi = pAngle - trailerAngle;
  phi = Math.atan2(Math.sin(phi), Math.cos(phi));
  const L2eff = trailerLength * TRAILER_L2_EFFECTIVE_FACTOR;
  const absSpd = Math.abs(pSpeed);
  const vTerm = absSpd > SPEED_GATE ? (pSpeed * Math.sin(phi)) : 0;
  const yawTerm = -TRAILER_HITCH_BEHIND_PIVOT * pAngVel * Math.cos(phi);
  const thetaDot = (vTerm + yawTerm) / L2eff;
  return trailerAngle + thetaDot * dt;
}

/** Jackknife severity zone. Reflects four physical regimes of cab/
 *  trailer articulation:
 *
 *    'normal'   — 0 to 60°. Routine driving: lane changes, normal
 *                 turns, the approach phase of a dock back-in.
 *    'caution'  — 60 to 75°. Tight maneuvering territory. Still
 *                 fully recoverable by pulling forward OR by
 *                 continuing the backing maneuver — the driver is
 *                 deep in articulation but not yet past the line.
 *    'warning'  — 75 to 90°. Beyond reverse recovery. The trailer
 *                 has bent too far for reverse-correction to
 *                 reduce φ; the driver must pull forward to
 *                 straighten out. Continued backing here drives the
 *                 jackknife to completion.
 *    'jackknife'— 90°+. Cab and trailer bodies physically collide.
 *                 Caller's hard-limit logic clamps φ here and
 *                 applies a speed penalty for the rubbing contact. */
export type TrailerJackknifeZone = 'normal' | 'caution' | 'warning' | 'jackknife';

/** Zone-boundary thresholds in radians. Exposed so consumers can
 *  reuse them for HUD warning ramps, audio gain curves, or
 *  rendering tints without re-hardcoding. */
export const TRAILER_CAUTION_THRESHOLD = 1.05;    // ~60°
export const TRAILER_WARNING_THRESHOLD = 1.31;    // ~75°
export const TRAILER_JACKKNIFE_THRESHOLD = 1.57;  // ~90°

/** Classify the articulation severity. Caller passes the wrapped
 *  articulation angle from trailerArticulationAngle (or the
 *  monolith's `artAngle`); the absolute value is taken here so
 *  signed φ from either side returns the same zone.
 *
 *  Ported 1:1 from monolith L27875-L27905 (the zone-test cascade
 *  inside updateTrailer). */
export function trailerJackknifeZone(articulationAngle: number): TrailerJackknifeZone {
  const a = Math.abs(articulationAngle);
  if (a > TRAILER_JACKKNIFE_THRESHOLD) return 'jackknife';
  if (a > TRAILER_WARNING_THRESHOLD) return 'warning';
  if (a > TRAILER_CAUTION_THRESHOLD) return 'caution';
  return 'normal';
}

/** Compute the articulation angle φ = pAngle − trailerAngle wrapped
 *  to [-π, π]. Used for jackknife-zone detection (the absolute
 *  value of this angle is compared against 60° / 75° / 90° zone
 *  thresholds). Stand-alone helper so consumers that need φ but
 *  not the integrator step can read it without re-computing the
 *  atan2.
 *
 *  Ported 1:1 from monolith L27872-L27873 (the post-integration
 *  re-compute for jackknife detection). */
export function trailerArticulationAngle(pAngle: number, trailerAngle: number): number {
  const phi = pAngle - trailerAngle;
  return Math.atan2(Math.sin(phi), Math.cos(phi));
}
