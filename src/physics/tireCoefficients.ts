/**
 * Per-axle tire-physics coefficients: peak friction μ and
 * cornering stiffness C_α. Both are inputs to the Phase 0B
 * force integrator (tire forces, friction circle) — μ caps the
 * peak lateral force at each axle and C_α controls how quickly
 * lateral force ramps with slip angle.
 *
 * Three layers stack on top of the base values:
 *
 *   1. Surface (grass / dirt / canyon) modulates μ_base.
 *   2. Driver-set knob `physMuBase` rescales the fleet-wide feel.
 *   3. Fault system (`fxFault.gripMult`) multiplies through after
 *      the surface layer.
 *
 * Phase 4 (v8.56) adds per-axle tire-width scaling on top of
 * both μ and C_α — wider tires get slightly more μ and
 * meaningfully more C_α (the cornering stiffness). Phase 4 is
 * console-flippable via `gameplaySettings.tyreData`.
 *
 * E-brake (when active) collapses ONLY the rear μ, with a
 * linear-drain over a 0.75s window — modeled separately in
 * [[applyEbrakeRearGripCollapse]] since it's a state-aware
 * modifier rather than a per-frame base.
 *
 * Monolith source: inside update() at L25250-L25299 (the
 * mu_base + per-axle μ + tire-width-scaled C_α block in the
 * Phase 0B integrator setup).
 */

/** Default mu_base when the physMuBase setting is absent or
 *  zero. 1.0 is the design baseline — every other surface and
 *  car factor scales relative to this. Players can raise the
 *  setting to 1.1-1.35 for a grippier fleet-wide feel
 *  (v8.99.83 added this knob).
 *
 *  Matches monolith fallback `||1.0` at L25252. */
export const DEFAULT_PHYS_MU_BASE = 1.0;

/** Grass μ multiplier. Reduces peak friction to 55 % of base —
 *  grass is a low-grip surface, cars slide further before
 *  recovering. Combined with the steering-side
 *  [[GRASS_STEER_MULT]] (0.5 in steering.ts) and grip-align
 *  [[GRIP_ALIGN_GRASS_MULT]] (0.45 in velocityAlign.ts) these
 *  three multipliers compose to give the full grass-handling
 *  feel; they're tuned together but live in different modules
 *  because they're three independent physics effects.
 *
 *  Matches monolith `mu_base*=0.55` at L25253. */
export const GRASS_MU_MULT = 0.55;

/** Dirt / canyon μ multiplier. Reduces peak friction to 75 % —
 *  less of a hit than grass because dirt is still semi-solid
 *  (just dustier than asphalt). Applied to tile types
 *  12, 14, 16 (dirt and canyon variants).
 *
 *  Matches monolith `mu_base*=0.75` at L25254. */
export const DIRT_MU_MULT = 0.75;

/** Compute the surface-adjusted peak friction coefficient
 *  (mu_base) — the per-axle ceiling on lateral and longitudinal
 *  force before tires saturate. Three modifier layers stack:
 *
 *  PIPELINE (1:1 with monolith):
 *    mu = physMuBaseSetting || 1.0
 *    if onGrass:        mu × 0.55
 *    elif onDirt:       mu × 0.75
 *    mu × gripMult        (fault system contribution)
 *
 *  WHY `else if` BETWEEN GRASS AND DIRT: surfaces are mutually
 *  exclusive — the caller's surface classification already
 *  picked one or the other (or neither, in which case both
 *  branches skip). The exclusivity matches the upstream tile-
 *  type lookup which returns a single classification.
 *
 *  WHY THE FAULT IS APPLIED LAST: gripMult is a multiplicative
 *  fault contribution (oil leak, tire damage). Applying it
 *  after the surface modifier composes naturally — a
 *  damaged-tire car on grass has its grip reduced by both the
 *  surface AND the fault.
 *
 *  INPUTS:
 *    physMuBase     LIFE.gameplaySettings.physMuBase; pass
 *                   undefined or 0 for default 1.0
 *    onGrass        from [[PlayerSurfaceState]] — surface is
 *                   grass
 *    onDirt         caller resolves from raw tile (tile === 12
 *                   || 14 || 16); future hop may extract this
 *                   to a helper
 *    gripMult       fxFault.gripMult — fault system's grip
 *                   modifier; pass 1.0 when no fault active
 *
 *  Returns the per-axle mu_base. Both mu_F and mu_R initially
 *  equal this — Phase 4 tire-width scaling and e-brake collapse
 *  diverge them per-axle in subsequent hops.
 *
 *  Ported 1:1 from monolith L25252-L25255 (the mu_base
 *  composition block in the Phase 0B integrator's tire-physics
 *  setup). */
export function computeMuBase(
  physMuBase: number | undefined,
  onGrass: boolean,
  onDirt: boolean,
  gripMult: number,
): number {
  let mu = physMuBase || DEFAULT_PHYS_MU_BASE;
  if (onGrass) mu *= GRASS_MU_MULT;
  else if (onDirt) mu *= DIRT_MU_MULT;
  return mu * gripMult;
}

/** Baseline tire width in mm. Phase 4 (v8.56) tire-width
 *  scaling is centered on this value — a 225 mm tire produces
 *  the original (pre-v8.56) μ and C_α; wider tires get more,
 *  narrower less.
 *
 *  WHY 225 mm: it's roughly the median front-tire width across
 *  the GT4 fleet (typical road cars 195-225, sports 235-265,
 *  race-track 275-325). Centering the formula on the median
 *  makes the average car unchanged and only the extremes feel
 *  the Phase 4 differentiation.
 *
 *  Matches monolith fallback `:225` at L25268-L25269 and the
 *  `-225` baseline subtraction at L25271-L25272 and L25298. */
export const TIRE_WIDTH_BASELINE_MM = 225;

/** Phase 4 μ scaling slope per mm of deviation from baseline.
 *  1/1000 ↔ a 100 mm wider tire (a 325 vs 225 baseline) gets
 *  10 % more μ; a 50 mm wider tire (typical sport setup) gets
 *  5 %. Across the GT4 fleet this is roughly ±5 %.
 *
 *  WHY GENTLE: intentionally a much smaller effect than the
 *  per-axle C_α scaling (which is linear ×width/225, giving
 *  ~±25 % across fleet). μ scaling stays gentle so weight
 *  distribution (wdF) remains the dominant balance lever.
 *
 *  Matches monolith `(width - 225) / 1000` at L25271-L25272. */
export const TIRE_WIDTH_MU_SLOPE = 1 / 1000;

/** Per-axle μ tuple from [[applyTireWidthMu]]. */
export interface PerAxleMu {
  mu_F: number;
  mu_R: number;
}

/** Apply Phase 4 (v8.56) per-axle tire-width scaling to the
 *  base μ. Wider tires get slightly more peak friction.
 *
 *  FORMULA (1:1 with monolith):
 *    twF = (tyreActive && gt4TwF) ? gt4TwF : 225
 *    twR = (tyreActive && gt4TwR) ? gt4TwR : 225
 *    if tyreActive:
 *      mu_F = muBase × (1 + (twF - 225) / 1000)
 *      mu_R = muBase × (1 + (twR - 225) / 1000)
 *    else:
 *      mu_F = mu_R = muBase
 *
 *  TIRE-WIDTH SOURCES:
 *  - cc.gt4.twF / cc.gt4.twR — per-axle widths from the GT4
 *    spec, in mm (e.g. 245 front, 275 rear staggered setup).
 *  - When tyreActive is false OR the GT4 spec lacks twF/twR,
 *    falls back to baseline 225 mm (effectively unchanged).
 *
 *  WHY STAGGERED SETUPS UNDERSTEER AT THE LIMIT: a 245F/275R
 *  setup has mu_F = muBase × 1.020 and mu_R = muBase × 1.050 —
 *  the rear has more peak grip, so the FRONT saturates first
 *  under cornering. Natural understeer-at-the-limit, exactly
 *  what real-world race-prep setups produce.
 *
 *  WHY GENTLER THAN C_α: μ scaling at ~±5 % across the fleet is
 *  intentionally a smaller effect than C_α scaling (±25 %). μ
 *  controls peak force; C_α controls slip sensitivity (steering
 *  response sharpness). The narrative is "wider tires feel
 *  sharper" more than "wider tires grip way more."
 *
 *  Console-flippable: `gameplaySettings.tyreData=false` returns
 *  μ_F = μ_R = muBase (v8.55 behavior).
 *
 *  INPUTS:
 *    muBase         post-surface, post-fault μ from
 *                   [[computeMuBase]]
 *    gt4TwF         cc.gt4.twF in mm; undefined → fallback to
 *                   baseline 225
 *    gt4TwR         cc.gt4.twR in mm; undefined → fallback
 *    tyreActive     LIFE.gameplaySettings.tyreData !== false
 *
 *  Ported 1:1 from monolith L25267-L25273 (the Phase 4
 *  per-axle μ scaling block in the Phase 0B integrator). */
export function applyTireWidthMu(
  muBase: number,
  gt4TwF: number | undefined,
  gt4TwR: number | undefined,
  tyreActive: boolean,
): PerAxleMu {
  if (!tyreActive) return { mu_F: muBase, mu_R: muBase };
  const twF = gt4TwF || TIRE_WIDTH_BASELINE_MM;
  const twR = gt4TwR || TIRE_WIDTH_BASELINE_MM;
  return {
    mu_F: muBase * (1 + (twF - TIRE_WIDTH_BASELINE_MM) * TIRE_WIDTH_MU_SLOPE),
    mu_R: muBase * (1 + (twR - TIRE_WIDTH_BASELINE_MM) * TIRE_WIDTH_MU_SLOPE),
  };
}

/** E-brake rear-grip collapse window, in seconds. The collapse
 *  ramps from full (at pEbrakeTimer = 0.75) down to zero (at
 *  pEbrakeTimer = 0) — linear drain.
 *
 *  HISTORY:
 *    v8.49:    0.35s — too shallow, slides died immediately
 *    v8.50:    0.6s — too deep, Civic snap-rotated on one tap
 *    v8.98.52: 0.75s — longer runway for throttle to commit
 *
 *  Matches monolith `pEbrakeTimer/0.75` at L25285. */
export const EBRAKE_REAR_GRIP_WINDOW = 0.75;

/** Peak rear-μ reduction from e-brake. At full strength (timer
 *  fresh) the rear μ collapses to 30 % of normal (1 - 0.70 =
 *  0.30). At end of window timer → 0, collapse contribution → 0.
 *
 *  WHY 0.70:
 *    v8.49: 0.35 collapse — too shallow; slides ended quickly
 *    v8.50: 0.85 collapse — too deep; one-tap snap rotation
 *    Final: 0.70 — sustainable but not abusable
 *
 *  Sustains rotation: at 30 % normal rear grip the rear axle
 *  saturates readily under any modest yaw → real rear-slip
 *  yaw torque from the integrator → drift develops naturally.
 *
 *  Matches monolith `0.70*collapseStrength` at L25286. */
export const EBRAKE_REAR_GRIP_COLLAPSE = 0.70;

/** Apply rear-only μ collapse during the e-brake window. The
 *  handbrake locks the rear wheels; their grip drops sharply for
 *  the remainder of [[EBRAKE_REAR_GRIP_WINDOW]] seconds, then
 *  recovers as the timer drains.
 *
 *  FORMULA (1:1 with monolith):
 *    if pEbrakeTimer > 0:
 *      collapseStrength = min(1, pEbrakeTimer / 0.75)
 *      mu_R *= (1 - 0.70 × collapseStrength)
 *    else:
 *      mu_R unchanged
 *
 *  COLLAPSE PROFILE (at pEbrakeTimer values):
 *    0.75 (fresh)  → mu_R × 0.30   peak collapse
 *    0.50          → mu_R × 0.53
 *    0.25          → mu_R × 0.77
 *    0.0  (expired)→ mu_R × 1.00   full grip restored
 *
 *  FRONT μ UNCHANGED: the handbrake only locks the rear wheels.
 *  The front retains full grip throughout, which is what gives
 *  e-brake drifts their forward-pointing rotation — front pulls
 *  into the corner while the rear's loose.
 *
 *  PHASE 0B FORCE-CIRCLE INTERACTION: with rear μ at 30 %, the
 *  rear friction circle (μ × Fz) shrinks proportionally. The
 *  integrator then naturally saturates the rear at the lower
 *  cap, producing real-physics drift initiation: lateral force
 *  hits the smaller cap → slip angle grows → yaw torque
 *  develops → drift state engages via the hysteresis gate.
 *
 *  Caller is responsible for the timer state (pEbrakeTimer is a
 *  countdown decremented elsewhere). This function consumes a
 *  snapshot, returns the modified mu_R.
 *
 *  Ported 1:1 from monolith L25284-L25287 (the e-brake rear-grip
 *  collapse block in the Phase 0B integrator's tire-physics
 *  setup). */
export function applyEbrakeRearMu(
  mu_R: number,
  pEbrakeTimer: number,
): number {
  if (pEbrakeTimer <= 0) return mu_R;
  const collapseStrength = Math.min(1, pEbrakeTimer / EBRAKE_REAR_GRIP_WINDOW);
  return mu_R * (1 - EBRAKE_REAR_GRIP_COLLAPSE * collapseStrength);
}
