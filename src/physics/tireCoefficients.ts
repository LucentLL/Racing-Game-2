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
