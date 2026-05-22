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

/** Fifth-wheel hitch pivot location returned by
 *  [[computeFifthWheelPivot]]. Names match the monolith's
 *  `fwX` / `fwY` local variables. */
export interface FifthWheelPivot {
  fwX: number;
  fwY: number;
}

/** Compute the fifth-wheel hitch pivot world position from the
 *  cab's CG + heading. The hitch sits [[TRAILER_HITCH_BEHIND_PIVOT]]
 *  game units BEHIND the cab's pivot point (which is `(px, py)`):
 *
 *    fwX = px - cos(pAngle) × 6
 *    fwY = py - sin(pAngle) × 6
 *
 *  This is the pivot point around which the trailer's heading is
 *  tracked. The trailer-side rendering anchors the trailer's
 *  front edge here; the trailer's tandem rolls along
 *  `tr.angle` heading away from this point.
 *
 *  WHY 6 UNITS BEHIND (NOT AT THE CAB PIVOT): real semi cabs
 *  have a fifth-wheel coupling that sits over the drive tandem,
 *  several feet behind the steering axle. Our cab sprite's
 *  pivot point (the rotational center used by the canvas
 *  rotation) is at the geometric chassis center, so the fifth
 *  wheel naturally sits behind that. 6 game units ≈ 1.2 m,
 *  matching the typical kingpin-to-cab-center offset on a
 *  US semi tractor.
 *
 *  WHY THIS MATTERS FOR ARTICULATION: see
 *  [[TRAILER_HITCH_BEHIND_PIVOT]] docstring — the d_hitch
 *  term in the full kinematic ODE adds a geometric yaw
 *  contribution from cab rotation that the simplified
 *  v·sin(φ) form misses (it assumes hitch at d=0). The
 *  computeFifthWheelPivot world position is the same d_hitch
 *  value used in the ODE, expressed as a world coordinate
 *  for rendering and trailer-state alignment.
 *
 *  CALLER USAGE: typically assigned to `tr.pivotX` / `tr.pivotY`
 *  on the trailer state object after computing, matching the
 *  monolith's `tr.pivotX = fwX; tr.pivotY = fwY` pattern at
 *  L27821-L27822.
 *
 *  Ported 1:1 from monolith L27819-L27820 (the fifth-wheel
 *  position computation inside updateTrailer). */
export function computeFifthWheelPivot(
  px: number,
  py: number,
  pAngle: number,
): FifthWheelPivot {
  return {
    fwX: px - Math.cos(pAngle) * TRAILER_HITCH_BEHIND_PIVOT,
    fwY: py - Math.sin(pAngle) * TRAILER_HITCH_BEHIND_PIVOT,
  };
}

/** World positions for the trailer's rear-axle wheels, returned
 *  by [[computeTrailerRearAxleWheels]]. Used by the skid-mark
 *  emitter (when articulation exceeds ~75° + speed gate) and
 *  by render code that draws trailer tires individually. */
export interface TrailerRearAxleWheels {
  /** Rear-axle midpoint world X (where the centerline of the
   *  tandem axle group sits). */
  centerX: number;
  /** Rear-axle midpoint world Y. */
  centerY: number;
  /** Left wheel world X (perpendicular-left of trailer heading
   *  by half-width). */
  leftX: number;
  /** Left wheel world Y. */
  leftY: number;
  /** Right wheel world X (perpendicular-right of trailer
   *  heading). */
  rightX: number;
  /** Right wheel world Y. */
  rightY: number;
}

/** Compute the world positions of the trailer's rear-axle
 *  wheels, given the fifth-wheel pivot and the trailer's heading
 *  + visible length + width.
 *
 *  GEOMETRY (1:1 with monolith):
 *    centerX = fwX - cos(trailerAngle) × trailerLength
 *    centerY = fwY - sin(trailerAngle) × trailerLength
 *    perp    = trailerAngle + π/2
 *    halfW   = trailerWidth / 2
 *    leftX   = centerX + cos(perp) × halfW × (-1)
 *    leftY   = centerY + sin(perp) × halfW × (-1)
 *    rightX  = centerX + cos(perp) × halfW × (+1)
 *    rightY  = centerY + sin(perp) × halfW × (+1)
 *
 *  WHY rearAxle = fwX - cos × trailerLength (NOT minus L2_eff):
 *  the visible-tire rear-axle position uses the FULL visible
 *  length of the trailer, not the effective wheelbase
 *  ([[TRAILER_L2_EFFECTIVE_FACTOR]] × length) used by the
 *  kinematic ODE. The L2_eff value is the geometric center of
 *  the tandem axle group used for the no-slip constraint;
 *  the rear-most visible tires sit a few feet further back,
 *  at the trailer's actual rear edge. Skid marks emit at the
 *  visible tire positions because that's where the player sees
 *  the rubber on the road, even though the tandem axle's
 *  "geometric center" is slightly forward.
 *
 *  PERPENDICULAR DIRECTION: `trailerAngle + π/2` is the LEFT
 *  normal of trailer heading. Positive `side` (×+1) shifts
 *  toward the trailer's RIGHT (because the perp formula yields
 *  the left-normal, and the sign on the multiplier flips it).
 *  This sign convention matches the monolith's `for(const side
 *  of [-1, 1])` loop where the wheel pair is generated.
 *
 *  USED BY (consumer responsibility — not in this function):
 *  - Jackknife skid-mark emission (monolith L27928-L27943) when
 *    jackAngle > ~75° and |pSpeed| > 2 × SCALE_MS
 *  - Trailer-tire rendering (per-wheel sprite placement)
 *  - Skid-mark surface classification (tile lookup at the
 *    wheel position to decide road-vs-grass mark color)
 *
 *  INPUTS:
 *    fwX, fwY        fifth-wheel hitch position (from
 *                    [[computeFifthWheelPivot]])
 *    trailerAngle    trailer heading (rad)
 *    trailerLength   visible trailer length (game units)
 *    trailerWidth    trailer width (game units)
 *
 *  Returns the rear-axle center + left + right wheel world
 *  positions. Pure function.
 *
 *  Ported 1:1 from monolith L27929-L27940 (the trailer-skid
 *  wheel-position computation inside updateTrailer). */
export function computeTrailerRearAxleWheels(
  fwX: number,
  fwY: number,
  trailerAngle: number,
  trailerLength: number,
  trailerWidth: number,
): TrailerRearAxleWheels {
  const cosT = Math.cos(trailerAngle);
  const sinT = Math.sin(trailerAngle);
  const centerX = fwX - cosT * trailerLength;
  const centerY = fwY - sinT * trailerLength;
  const perp = trailerAngle + Math.PI / 2;
  const halfW = trailerWidth / 2;
  const perpX = Math.cos(perp) * halfW;
  const perpY = Math.sin(perp) * halfW;
  return {
    centerX,
    centerY,
    leftX:  centerX - perpX,
    leftY:  centerY - perpY,
    rightX: centerX + perpX,
    rightY: centerY + perpY,
  };
}

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

/** Default trailer load weight when none is set (sentinel value).
 *  Matches monolith `LIFE.trailer.loadWeight || 0.6`. Real spawns
 *  set this to a typed value: light = 0.3, medium = 0.6, heavy =
 *  1.0; the 0.6 default sits at "medium" so a malformed save still
 *  produces a reasonable feel. */
export const TRAILER_DEFAULT_LOAD_WEIGHT = 0.6;

/** Base trailer drag coefficient (per-second). Applies even when
 *  empty — the visible-body aero penalty alone matters at highway
 *  speed. Matches the constant inside monolith
 *  `const trailerDrag = 0.002 + 0.003*loadFactor` (the 0.002). */
const TRAILER_DRAG_BASE = 0.002;

/** Per-unit-load drag scale (per-second). Multiplied by load weight
 *  (0..1) and added to TRAILER_DRAG_BASE. So an empty trailer
 *  (0.0) gets 0.002, a fully-loaded one (1.0) gets 0.005 — a
 *  ~2.5× decel difference between empty and full. Matches the
 *  monolith's 0.003 coefficient at L27918. */
const TRAILER_DRAG_PER_LOAD = 0.003;

/** Speed below which trailer drag is skipped (game units). Stops
 *  the exponential decay from sapping the last fraction of a tile/
 *  sec when the player is essentially stopped — matches the
 *  monolith's `if (absSpd > 1)` gate at L27919. */
const TRAILER_DRAG_SPEED_GATE = 1;

/** Apply one-frame trailer drag to the player's signed speed.
 *  Exponential decay scaled by load weight: empty trailer ≈ 0.2 %
 *  /s, fully loaded ≈ 0.5 %/s. Returns the new speed; caller
 *  stores it back.
 *
 *  Modeled as a multiplicative decay (`pSpeed *= 1 - drag*dt`)
 *  rather than a subtractive deceleration so the per-frame effect
 *  is sign-preserving — backing the trailer slows the absolute
 *  speed without crossing zero unexpectedly.
 *
 *  Below TRAILER_DRAG_SPEED_GATE the drag is skipped; the caller
 *  is expected to handle full-stop transitions elsewhere
 *  (gas/brake dispatch).
 *
 *  Ported 1:1 from monolith L27915-L27921 (the trailer drag block
 *  inside updateTrailer). */
export function applyTrailerDrag(
  pSpeed: number,
  loadWeight: number | undefined,
  dt: number,
): number {
  const lw = loadWeight ?? TRAILER_DEFAULT_LOAD_WEIGHT;
  const drag = TRAILER_DRAG_BASE + TRAILER_DRAG_PER_LOAD * lw;
  if (Math.abs(pSpeed) <= TRAILER_DRAG_SPEED_GATE) return pSpeed;
  return pSpeed * (1 - drag * dt);
}

/** Speed below which traffic trailer integration is skipped (game
 *  units). Matches monolith `if (t.speed > 0.05)` at L28025 — the
 *  v·sin(φ) term decays to zero anyway at this magnitude, so
 *  skipping avoids div-by-tiny noise in the integrator. */
const TRAFFIC_TRAILER_SPEED_GATE = 0.05;

/** One frame of trailer-heading integration for an NPC traffic
 *  vehicle. SIMPLIFIED form of the player's kinematic ODE — uses
 *  only the v · sin(φ) term, NOT the d · ω · cos(φ) geometric
 *  term.
 *
 *  WHY THE SIMPLIFICATION (monolith L28031-L28034). Traffic cabs
 *  follow road polylines and yaw at < 2°/sec on typical highway
 *  curves. The geometric term contributes ~0.04°/sec at that yaw
 *  rate — visually negligible. Adding it would require tracking
 *  cab yaw rate on EVERY traffic vehicle (extra state per NPC),
 *  not worth the per-frame cost across 30+ cars for an
 *  imperceptible visual effect.
 *
 *  Pass-through (returns trailerAngle unchanged) when |speed| is
 *  at or below the gate. Caller that wants to lazy-init "first
 *  sight" (trailerAngle null → snap to cab angle) handles that
 *  branch before calling this — the function assumes a valid
 *  trailer angle in.
 *
 *  Same TRAILER_L2_EFFECTIVE_FACTOR (0.75) as the player version
 *  for consistency between the player rig and AI rigs.
 *
 *  Ported 1:1 from monolith L28020-L28041 _updateTrafficTrailerAngles
 *  (the per-NPC body, lifted out as a pure per-step function). */
export function trafficTrailerKinematicTick(
  cabAngle: number,
  trailerAngle: number,
  cabSpeed: number,
  trailerLength: number,
  dt: number,
): number {
  if (cabSpeed <= TRAFFIC_TRAILER_SPEED_GATE) return trailerAngle;
  const L2eff = trailerLength * TRAILER_L2_EFFECTIVE_FACTOR;
  let phi = cabAngle - trailerAngle;
  phi = Math.atan2(Math.sin(phi), Math.cos(phi));
  return trailerAngle + (cabSpeed / L2eff) * Math.sin(phi) * dt;
}

/** Speed multiplier applied when the jackknife hard limit fires.
 *  0.85× per frame the player sits at 90°+ — models the kinetic
 *  energy bleed into the rubbing contact between cab and trailer
 *  body. Persistent contact (player holding their input pattern
 *  past the trip-point) decays speed by ~15 %/frame until the
 *  driver pulls forward and reduces φ. Matches monolith
 *  `pSpeed *= 0.85` at L27904. */
export const TRAILER_JACKKNIFE_SPEED_PENALTY = 0.85;

/** Apply the jackknife hard-limit clamp. Fires when |articulation|
 *  has exceeded TRAILER_JACKKNIFE_THRESHOLD (90°) — cab and trailer
 *  bodies are now physically in contact and CAN'T fold any further.
 *
 *  Two effects per frame at this depth:
 *
 *    1. ANGLE CLAMP — recompute trailerAngle so |φ| = exactly 90°.
 *       Side is preserved (driver doesn't suddenly flip to the
 *       other side of the cab). The clamp is the no-penetration
 *       constraint between rigid bodies; without it, integrator
 *       drift would keep growing φ and the trailer sprite would
 *       walk through the cab sprite.
 *
 *    2. SPEED PENALTY — pSpeed *= 0.85. Rubbing contact between
 *       cab and trailer bleeds kinetic energy each frame. Drops
 *       to ~12 %/2-sec while the driver sits at the limit; the
 *       intended response is to pull forward (which reduces φ and
 *       releases the contact).
 *
 *  Pass-through when articulation hasn't reached the threshold —
 *  caller can call this unconditionally each frame and it's a no-op
 *  outside the jackknife zone, but the cleaner pattern is to gate
 *  on `trailerJackknifeZone(art) === 'jackknife'` first.
 *
 *  Returns the (possibly clamped) trailer angle + the (possibly
 *  reduced) speed. Caller stores both back. Notification is NOT
 *  fired here — that's a side-effect the caller composes with the
 *  zone classifier so the audio / HUD layer can decouple.
 *
 *  Ported 1:1 from monolith L27898-L27906 (the 90°+ hard-limit
 *  block inside updateTrailer). */
export function applyTrailerJackknifeClamp(
  pAngle: number,
  trailerAngle: number,
  pSpeed: number,
  articulationAngle: number,
): { trailerAngle: number; pSpeed: number } {
  if (Math.abs(articulationAngle) <= TRAILER_JACKKNIFE_THRESHOLD) {
    return { trailerAngle, pSpeed };
  }
  const sign = articulationAngle > 0 ? 1 : -1;
  const clampedAngle = pAngle - sign * TRAILER_JACKKNIFE_THRESHOLD;
  return {
    trailerAngle: clampedAngle,
    pSpeed: pSpeed * TRAILER_JACKKNIFE_SPEED_PENALTY,
  };
}

/** Articulation angle (rad) above which hard braking starts to
 *  swing the cab. ~20° — below this the drive tandem keeps the cab
 *  pointed forward even under hard brake lockup. Above this, even a
 *  small drive-wheel lateral force gets levered by the deep
 *  articulation into a noticeable cab-yaw rotation.
 *
 *  Matches monolith `if (isHardBrake && jackAngle > 0.35)` at
 *  L27909. */
const HARD_BRAKE_SWING_MIN_ART = 0.35;

/** Speed (m/s) above which braking counts as "hard" for the
 *  cab-swing effect. ~10 m/s ≈ 22 mph. Below this, the
 *  lateral-grip loss from locked drive tires isn't dramatic enough
 *  to swing the cab perceptibly.
 *
 *  Matches monolith `const isHardBrake = isBraking && absSpd > 10
 *  * SCALE_MS` at L27884. */
export const TRAILER_HARD_BRAKE_MIN_SPEED_MS = 10;

/** Peak cab-swing rate (rad/s). The actual rate scales with
 *  articulation depth via clamp(jackAngle / 1.2, 0, 1); at 90°
 *  articulation the cab swings at the full 0.25 rad/s, ramping
 *  linearly down to zero below the HARD_BRAKE_SWING_MIN_ART
 *  threshold.
 *
 *  Matches monolith `swingForce = 0.25 * Math.min(1, jackAngle /
 *  1.2)` at L27911. */
const HARD_BRAKE_SWING_RATE_MAX = 0.25;

/** Articulation at which the swing rate hits its maximum
 *  (rad). 1.2 rad ≈ 69° — past this depth the swing is
 *  already at its peak rate and stays there until the 90° hard
 *  clamp kicks in elsewhere. */
const HARD_BRAKE_SWING_SATURATION_ART = 1.2;

/** Apply one frame of hard-brake cab swing. Returns the new cab
 *  heading angle.
 *
 *  PHYSICAL MODEL: when the player brakes hard with the trailer
 *  already deep in articulation, the locked drive tires lose
 *  lateral grip → the cab pivots around the fifth wheel under
 *  the load's inertia. This is the precursor to a full jackknife
 *  (and an experienced driver will release the brake the moment
 *  they feel it start). Direction follows the existing
 *  articulation sign — the cab rotates the way the trailer is
 *  already pulling.
 *
 *  PASS-THROUGH when any of:
 *    - not braking (gate handled by caller; isBraking is required)
 *    - speed below TRAILER_HARD_BRAKE_MIN_SPEED_MS (10 m/s)
 *    - articulation below HARD_BRAKE_SWING_MIN_ART (0.35 rad)
 *
 *  `scaleMs` is the wpx/sec ↔ m/s scaling factor injected so the
 *  hard-brake speed threshold compares correctly against the
 *  caller's pSpeed in game units. Same injection convention as
 *  applyTrailerSpeedGovernor.
 *
 *  Ported 1:1 from monolith L27883-L27913 (the hard-brake cab-
 *  swing block inside updateTrailer). */
export function applyTrailerHardBrakeSwing(
  pAngle: number,
  pSpeed: number,
  articulationAngle: number,
  isBraking: boolean,
  scaleMs: number,
  dt: number,
): number {
  if (!isBraking) return pAngle;
  if (Math.abs(pSpeed) <= TRAILER_HARD_BRAKE_MIN_SPEED_MS * scaleMs) return pAngle;
  const jackAngle = Math.abs(articulationAngle);
  if (jackAngle <= HARD_BRAKE_SWING_MIN_ART) return pAngle;
  const ramp = Math.min(1, jackAngle / HARD_BRAKE_SWING_SATURATION_ART);
  const swingForce = HARD_BRAKE_SWING_RATE_MAX * ramp;
  const sign = articulationAngle > 0 ? 1 : -1;
  return pAngle + sign * swingForce * dt;
}

/** Trailer governed top speed (m/s). ~31 m/s ≈ 70 mph — matches a
 *  realistic fleet governor for a loaded over-the-road semi. Real
 *  US Class-8 fleet governors land between 65 and 75 mph; 70 is
 *  the canonical middle value (Walmart, Schneider, J.B. Hunt all
 *  run thereabouts in practice).
 *
 *  Constant is the GOVERNED speed regardless of load — the load
 *  affects ACCELERATION (handled in the accel block's
 *  trailerMassFactor) but not terminal velocity, matching how
 *  real diesels have enough torque to maintain governed speed
 *  even loaded.
 *
 *  Matches monolith `const maxTrailerSpd = 31*SCALE_MS` at L27924
 *  (the leading 31 is m/s; the SCALE_MS factor converts to game
 *  units at use time). */
export const TRAILER_GOVERNED_TOP_SPEED_MS = 31;

/** Cap player speed at the trailer's governed top. Symmetric on
 *  forward + reverse — backing up too fast also slams into the
 *  cap. Returns the (possibly clamped) speed; pass-through when
 *  the player is below the cap.
 *
 *  `scaleMs` is the wpx/sec ↔ m/s scaling factor — the eventual
 *  central definition is 4.864 (1 wpx ≈ 0.2056 m). Taken as a
 *  parameter to keep this module agnostic of where that constant
 *  lives.
 *
 *  Ported 1:1 from monolith L27923-L27925 (the trailer speed
 *  governor inside updateTrailer). */
export function applyTrailerSpeedGovernor(pSpeed: number, scaleMs: number): number {
  const maxWpx = TRAILER_GOVERNED_TOP_SPEED_MS * scaleMs;
  if (Math.abs(pSpeed) > maxWpx) return Math.sign(pSpeed) * maxWpx;
  return pSpeed;
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
