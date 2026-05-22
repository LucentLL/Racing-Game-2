/**
 * Chassis frame setup — the physical-property derivations that
 * happen at the top of the Phase 0B force integrator before the
 * tire-force, friction-circle, and yaw-torque computations
 * begin.
 *
 * Centralizes the sanitizers (mass floor, weight-distribution
 * fallback) and the derived geometry (CG → axle lever arms,
 * yaw inertia, static normal loads) so each is a named function
 * with one source of truth.
 *
 * Monolith source: inside update() at L25135-L25181 + the
 * Phase-7 chassis-dimension yaw-inertia block at L25145-L25177.
 */

/** Minimum chassis mass in kg. Floors the input mass so a
 *  degenerate car config (mass missing or absurdly low) can't
 *  blow up the force integrator. 400 kg is below any reasonable
 *  road car — most cars in the GT4 database are 800-1800 kg —
 *  so the floor only engages on malformed input.
 *
 *  Matches monolith `Math.max(400, ...)` at L25136. */
export const CHASSIS_MASS_MIN = 400;

/** Default chassis mass in kg when the input is missing/0.
 *  1200 kg is a midsize-sedan archetype — defensive fallback
 *  that produces sensible behavior for cars whose config
 *  somehow lacks a mass field.
 *
 *  Matches monolith fallback `||1200` at L25136. */
export const CHASSIS_MASS_DEFAULT = 1200;

/** Sanitize a raw chassis-mass input: apply the default-when-
 *  missing fallback and then floor at the minimum.
 *
 *  FORMULA (1:1 with monolith):
 *    mass = max(400, rawMass || 1200)
 *
 *  OR-FALLBACK semantics: treats 0 and undefined identically.
 *  A real car never has mass exactly 0, so this collapse is
 *  benign and matches the monolith's `cc.mass||1200` idiom.
 *
 *  INPUTS:
 *    rawMass    CAR().mass — may be undefined or 0 if config
 *               is incomplete; the GT4 database always provides
 *               this, but defensive guard for partial configs.
 *
 *  Ported 1:1 from monolith L25136 (the mass line at the head
 *  of the Phase 0B integrator). */
export function sanitizeChassisMass(rawMass: number | undefined): number {
  return Math.max(CHASSIS_MASS_MIN, rawMass || CHASSIS_MASS_DEFAULT);
}
